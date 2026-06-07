/**
 * Auto-trigger orchestration (PR 6).
 *
 * The §4.7 flow says "every knowledge write enqueues affected cases for
 * rerun + regression detection." This module is the glue that connects
 * the write-side hooks (candidate accept, point edit, subscription pull)
 * to the runner + regression detector.
 *
 * It's intentionally thin:
 *   - `enqueueAffectedRuns()` accepts a change-event + the runner
 *     factory and returns the set of triggered case ids (does NOT
 *     wait for runs to finish — callers can poll / subscribe to the
 *     finished signal via the existing event bus once wired)
 *   - the actual case execution is delegated to an injected
 *     `RunnerFn` so tests can substitute a no-op or a faking runner
 *     without rebooting an HTTP LLM client
 *
 * Cost guardrails (§4.7.6) are not enforced here yet — that lives in
 * the cost_audit table and gets wired into the runner queue in a
 * follow-up PR. This file's job is the trigger mechanics only.
 */

import type Database from 'better-sqlite3';
import {
  detectRegression,
  selectAffectedCases,
  type AffectedCaseInput,
  type DetectAlertInput,
} from './regression.js';
import { listRunsForCase } from '../storage/repos/benchmark.js';
import type { BenchmarkRun, BenchmarkTriggeringEventKind } from '../storage/types.js';

/**
 * Runner contract. Returns the just-written run so the trigger can
 * compare it against the prior baseline. Implementations are expected
 * to persist via `insertRun` themselves; the trigger does not re-read
 * the DB to discover whether anything ran.
 */
export type RunnerFn = (caseId: string) => Promise<BenchmarkRun | null>;

export interface AutoTriggerInput extends AffectedCaseInput {
  /** What write caused this trigger? Carried into any alert. */
  triggeringEventKind: BenchmarkTriggeringEventKind;
  triggeringEventRefId: string;
  runner: RunnerFn;
  /** Optional override of the regression delta threshold. */
  regressionThreshold?: number;
  /**
   * Cap on cases auto-rerun per trigger. Beyond this, cases are added
   * to a "deferred" set callers can surface to the user. Default 5
   * matches §4.7.5 per-trigger throttle.
   */
  maxRunsPerTrigger?: number;
}

export interface AutoTriggerResult {
  /** Cases that were synchronously rerun this trigger. */
  rerun: string[];
  /** Cases the cap pushed past — surface to the user as a backlog. */
  deferred: string[];
  /** Alerts inserted as a side-effect of rerun comparisons. */
  alertIds: string[];
  /** Per-case error messages from the runner, keyed by caseId. */
  errors: Record<string, string>;
}

const DEFAULT_MAX_RUNS = 5;

/**
 * Synchronous entrypoint. Awaits every selected runner call so the
 * caller can decide whether to background-fire-and-forget. Errors from
 * one runner do not abort the others — each is captured in
 * `result.errors`.
 */
export async function enqueueAffectedRuns(
  db: Database.Database,
  input: AutoTriggerInput,
): Promise<AutoTriggerResult> {
  const affected = selectAffectedCases(db, input);
  const cap = input.maxRunsPerTrigger ?? DEFAULT_MAX_RUNS;
  const targets = affected.slice(0, cap).map((c) => c.id);
  const deferred = affected.slice(cap).map((c) => c.id);
  const out: AutoTriggerResult = {
    rerun: [], deferred, alertIds: [], errors: {},
  };
  for (const caseId of targets) {
    try {
      const run = await input.runner(caseId);
      if (!run) {
        out.errors[caseId] = 'runner returned null';
        continue;
      }
      out.rerun.push(caseId);
      const alert = detectRegression(db, makeDetectInput(run, input));
      if (alert) out.alertIds.push(alert.alertId);
    } catch (err) {
      out.errors[caseId] = (err as Error).message;
    }
  }
  return out;
}

function makeDetectInput(
  currentRun: BenchmarkRun,
  input: AutoTriggerInput,
): DetectAlertInput {
  const out: DetectAlertInput = {
    currentRun,
    triggeringEventKind: input.triggeringEventKind,
    triggeringEventRefId: input.triggeringEventRefId,
  };
  if (input.regressionThreshold !== undefined) {
    out.threshold = input.regressionThreshold;
  }
  return out;
}

/**
 * Helper: enumerate the per-case baseline-vs-latest delta for surfacing
 * in the UI without firing a new run. Used by the Verification Insights
 * panel to chart "where are we drifting?" — strictly read-only.
 */
export function caseAlignmentDeltas(
  db: Database.Database,
  caseIds: readonly string[],
): Array<{ caseId: string; latest?: number; baseline?: number; delta?: number }> {
  return caseIds.map((caseId) => {
    const runs = listRunsForCase(db, caseId, 5);
    const real = runs.filter((r) => !r.reproducedFromRunId);
    if (real.length === 0) return { caseId };
    if (real.length === 1) return { caseId, latest: real[0]!.alignmentPct };
    const latest = real[0]!.alignmentPct;
    const baseline = real[1]!.alignmentPct;
    return { caseId, latest, baseline, delta: latest - baseline };
  });
}
