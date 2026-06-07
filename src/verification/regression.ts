/**
 * Regression detection (PR 6).
 *
 * Two responsibilities split across small helpers:
 *
 *   1. Affected-case selection — given a change to a KnowledgePoint
 *      or a Role, identify the benchmark cases that should be rerun.
 *      A case is affected when ANY of its goldenPointIds matches the
 *      changed point, OR when its targetRoleIds contains the changed
 *      role. Only `confirmed` cases participate (R-5: proposed cases
 *      have no baseline to regress against).
 *
 *   2. Regression alert detection — when a new run lands, compare its
 *      alignment_pct against the most recent prior run of the same
 *      case. If the drop crosses the configurable threshold AND the
 *      previous run was not itself the result of a reproduce, insert
 *      a `regression_alert` row.
 *
 * The auto-trigger orchestration that consumes both helpers lives in
 * `auto-trigger.ts` so this file stays free of side-effects on the
 * candidate / capture pipelines.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  insertAlert,
  listRunsForCase,
} from '../storage/repos/benchmark.js';
import type {
  BenchmarkCase,
  BenchmarkRun,
  BenchmarkTriggeringEventKind,
} from '../storage/types.js';

/** Score drop (currentScore - prevScore) considered a regression. Negative. */
export const REGRESSION_DELTA_THRESHOLD = -5;

export interface AffectedCaseInput {
  /** Point ids that were changed (edit / candidate accept / pull). */
  pointIds?: readonly string[];
  /** Role ids whose membership or briefing changed. */
  roleIds?: readonly string[];
}

/**
 * Find every confirmed case affected by a knowledge change.
 *
 * Strategy:
 *   - Match by goldenPointIds via the benchmark_case_golden index
 *     (`idx_case_golden_point`).
 *   - Match by targetRoleIds via benchmark_case_target_role.
 *   - DISTINCT to dedupe; only return `status='confirmed'` cases
 *     since `proposed` rows do not have a baseline run yet (R-5).
 */
export function selectAffectedCases(
  db: Database.Database,
  input: AffectedCaseInput,
): BenchmarkCase[] {
  const pointIds = input.pointIds ?? [];
  const roleIds = input.roleIds ?? [];
  if (pointIds.length === 0 && roleIds.length === 0) return [];

  // Stitch two cheap SELECTs together rather than build a giant
  // dynamic IN clause; SQLite's planner handles each independently.
  const ids = new Set<string>();
  if (pointIds.length > 0) {
    const placeholders = pointIds.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT DISTINCT bc.id
      FROM benchmark_case bc
      JOIN benchmark_case_golden bcg ON bcg.case_id = bc.id
      WHERE bcg.point_id IN (${placeholders})
        AND bc.status = 'confirmed'
    `).all(...pointIds) as { id: string }[];
    for (const r of rows) ids.add(r.id);
  }
  if (roleIds.length > 0) {
    const placeholders = roleIds.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT DISTINCT bc.id
      FROM benchmark_case bc
      JOIN benchmark_case_target_role bctr ON bctr.case_id = bc.id
      WHERE bctr.role_id IN (${placeholders})
        AND bc.status = 'confirmed'
    `).all(...roleIds) as { id: string }[];
    for (const r of rows) ids.add(r.id);
  }

  if (ids.size === 0) return [];
  const placeholders = [...ids].map(() => '?').join(', ');
  return (db.prepare(`
    SELECT * FROM benchmark_case
     WHERE id IN (${placeholders})
     ORDER BY proposed_at DESC
  `).all(...ids) as Record<string, unknown>[]).map((row) => ({
    id: String(row['id']),
    name: String(row['name']),
    question: String(row['question']),
    expectedTruth: String(row['expected_truth']),
    goldenPointIds: [],
    targetRoleIds: [],
    proposedSource: String(row['proposed_source']) as BenchmarkCase['proposedSource'],
    proposedAt: Number(row['proposed_at']),
    status: String(row['status']) as BenchmarkCase['status'],
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
  }));
}

export interface DetectAlertInput {
  /** The newly-written run row. */
  currentRun: BenchmarkRun;
  /** Event that triggered the run (carried into the alert for forensics). */
  triggeringEventKind: BenchmarkTriggeringEventKind;
  triggeringEventRefId: string;
  /** Override the default delta threshold (negative number). */
  threshold?: number;
}

/**
 * Compare `currentRun` to the most recent prior run of the same case
 * and insert a regression_alert if the alignment dropped past the
 * threshold. Returns the alertId when inserted, null otherwise.
 *
 * Reproduce runs (those with `reproducedFromRunId` set) NEVER trigger
 * an alert — they're explicit user replays, not new evidence. They
 * also are NOT used as the baseline for subsequent runs, so a
 * reproduce that scores low doesn't poison the next regression check.
 */
export function detectRegression(
  db: Database.Database,
  input: DetectAlertInput,
): { alertId: string } | null {
  if (input.currentRun.reproducedFromRunId) return null;
  const threshold = input.threshold ?? REGRESSION_DELTA_THRESHOLD;

  // Walk back through the run history looking for the most recent
  // non-reproduce run that isn't the current one. listRunsForCase
  // is ordered run_at DESC so the first match is the baseline.
  const history = listRunsForCase(db, input.currentRun.caseId, 20);
  const prior = history.find((r) =>
    r.id !== input.currentRun.id && !r.reproducedFromRunId,
  );
  if (!prior) return null;

  const delta = input.currentRun.alignmentPct - prior.alignmentPct;
  if (delta > threshold) return null;

  const alertId = `alert-${randomUUID()}`;
  insertAlert(db, {
    id: alertId,
    caseId: input.currentRun.caseId,
    prevRunId: prior.id,
    currentRunId: input.currentRun.id,
    prevScore: prior.alignmentPct,
    currentScore: input.currentRun.alignmentPct,
    delta,
    triggeringEventKind: input.triggeringEventKind,
    triggeringEventRefId: input.triggeringEventRefId,
  });
  return { alertId };
}
