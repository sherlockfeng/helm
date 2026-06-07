/**
 * Verification runner (PR 5).
 *
 * Executes a single benchmark case in the two-phase shape llm-wiki
 * established: Phase 1 retrieves relevant knowledge and asks an
 * "answer" LLM the case's question; Phase 2 hands the answer + the
 * case's expectedTruth to a "judge" LLM that returns a JSON verdict.
 * The verdict score lands in benchmark_run alongside the
 * knowledgeStateSha that pinned the input state.
 *
 * The LLM caller is injected (`CompletionClient`) so unit tests can
 * exercise the runner without real API keys. Production paths bind
 * this to a thin HTTP wrapper around the provider's chat completions
 * endpoint.
 */

import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  getCase,
  getCostForDate,
  getRepoStateForRun,
  insertRun,
  listRunsForCase,
  recordCostDelta,
} from '../storage/repos/benchmark.js';
import type { BenchmarkRun, BenchmarkTriggeringEventKind } from '../storage/types.js';
import type { ResolvedConfig, ResolvedProvider } from './provider-config.js';

/**
 * Minimal completions surface — one prompt in, one text out. The runner
 * stays JSON-mode-agnostic: the judge prompt asks for JSON and the
 * runner parses out; if the model returns trailing prose we trim with
 * a permissive heuristic.
 */
export interface CompletionClient {
  complete(args: {
    provider: ResolvedProvider;
    systemPrompt?: string;
    userPrompt: string;
    /** Optional cap; clamped down to model.maxTokens. */
    maxOutputTokens?: number;
  }): Promise<{ text: string; costUsd?: number }>;
}

export interface RetrieveSnippet {
  pointId: string;
  text: string;
}

/**
 * Resolves the knowledge snippets the answer model sees. In production
 * this delegates to LocalRolesProvider; here it's injected so tests
 * don't need an embedder.
 */
export type Retriever = (caseGoldenPointIds: readonly string[]) => Promise<RetrieveSnippet[]>;

export interface RepoStateProbe {
  /**
   * Return the (repoUrl, repoSha) tuples that pin the input state. For
   * points local to this Helm install with no upstream repo, return
   * `null` so the runner falls back to a content-hash sentinel.
   */
  probe(pointIds: readonly string[]): Promise<ReadonlyArray<{ repoUrl: string; repoSha: string }>>;
  /** SHA-256 of (body + editVersion) for purely local points. */
  localFingerprint(pointIds: readonly string[]): Promise<string | null>;
}

export interface RunCaseOptions {
  triggeringEventKind?: BenchmarkTriggeringEventKind;
  triggeringEventRefId?: string;
  reproducedFromRunId?: string;
  /**
   * Daily spend ceiling (USD). When today's recorded spend is at or
   * above this, the run is refused with `RunCaseError('cost-cap', ...)`.
   * The default keeps the cap off so existing callers behave the same.
   */
  costCapUsd?: number;
  /**
   * Per design §0 R-5: only confirmed cases run automatically. The
   * runner refuses anything else (proposed / rejected / archived)
   * unless the caller explicitly overrides for debug. Tests of the
   * runner itself set this; production paths do not.
   */
  allowUnconfirmed?: boolean;
}

export interface RunCaseResult {
  runId: string;
  recallPct: number;
  alignmentPct: number;
  knowledgeStateSha: string;
  isReproducible: boolean;
}

const ANSWER_SYSTEM_PROMPT =
  'You are answering a knowledge-check question. Use only the provided '
  + 'knowledge snippets. If they do not cover the question, say so honestly.';

const JUDGE_SYSTEM_PROMPT =
  'You are a judge. Score whether the candidate answer is semantically aligned '
  + 'with the expected truth. Reply with a single JSON object: '
  + '{"aligned": boolean, "score": number-0-100, "summary": "one sentence"}.';

export class RunCaseError extends Error {
  constructor(
    public readonly stage: 'retrieve' | 'answer' | 'judge' | 'parse' | 'status' | 'cost-cap',
    msg: string,
  ) {
    super(`[${stage}] ${msg}`);
  }
}

/** Today's date as the canonical YYYY-MM-DD key cost rows store. */
function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function runCase(args: {
  db: Database.Database;
  caseId: string;
  providers: ResolvedConfig;
  llm: CompletionClient;
  retrieve: Retriever;
  repoProbe: RepoStateProbe;
  options?: RunCaseOptions;
}): Promise<RunCaseResult> {
  const { db, caseId, providers, llm, retrieve, repoProbe, options = {} } = args;
  const caseRow = getCase(db, caseId);
  if (!caseRow) throw new RunCaseError('retrieve', `case "${caseId}" does not exist`);

  // R-5: only confirmed cases run unless the caller is explicit. This
  // guards the direct /api/verification/cases/:id/run path so a
  // proposed (LLM-suggested, not yet human-confirmed) case can't
  // execute by mistake.
  if (!options.allowUnconfirmed && caseRow.status !== 'confirmed') {
    throw new RunCaseError(
      'status',
      `case "${caseId}" is "${caseRow.status}"; only confirmed cases run automatically (R-5).`,
    );
  }

  // §4.7.6 cost cap precheck. We check today's *aggregate* spend
  // (role_id = null) so the cap is global; per-role caps are a future
  // refinement.
  if (options.costCapUsd !== undefined && options.costCapUsd >= 0) {
    const today = todayKey();
    const spent = getCostForDate(db, today, null);
    const spentUsd = spent?.estimatedCostUsd ?? 0;
    if (spentUsd >= options.costCapUsd) {
      throw new RunCaseError(
        'cost-cap',
        `daily benchmark spend $${spentUsd.toFixed(4)} >= cap $${options.costCapUsd.toFixed(4)}.`,
      );
    }
  }

  // Phase 0: retrieve knowledge snippets for the answer prompt.
  let snippets: RetrieveSnippet[];
  try {
    snippets = await retrieve(caseRow.goldenPointIds);
  } catch (err) {
    throw new RunCaseError('retrieve', (err as Error).message);
  }

  const recoveredPointIds = new Set(snippets.map((s) => s.pointId));
  const goldenSet = new Set(caseRow.goldenPointIds);
  const hits = [...goldenSet].filter((id) => recoveredPointIds.has(id)).length;
  const recallPct = goldenSet.size === 0 ? 100 : (hits / goldenSet.size) * 100;

  const startMs = Date.now();
  let costUsd = 0;
  let llmCalls = 0;

  // Phase 1: answer.
  let answerText: string;
  try {
    const r = await llm.complete({
      provider: providers.answer,
      systemPrompt: ANSWER_SYSTEM_PROMPT,
      userPrompt: composeAnswerPrompt(caseRow.question, snippets),
    });
    answerText = r.text;
    if (r.costUsd) costUsd += r.costUsd;
    llmCalls += 1;
  } catch (err) {
    throw new RunCaseError('answer', (err as Error).message);
  }

  // Phase 2: judge.
  let judgeText: string;
  try {
    const r = await llm.complete({
      provider: providers.judge,
      systemPrompt: JUDGE_SYSTEM_PROMPT,
      userPrompt: composeJudgePrompt(caseRow.question, caseRow.expectedTruth, answerText),
    });
    judgeText = r.text;
    if (r.costUsd) costUsd += r.costUsd;
    llmCalls += 1;
  } catch (err) {
    throw new RunCaseError('judge', (err as Error).message);
  }

  const verdict = parseJudgeVerdict(judgeText);

  // knowledgeStateSha — pin the input state via the repo probe; fall
  // back to the local content fingerprint when no upstream repo exists.
  const repoState = await repoProbe.probe(caseRow.goldenPointIds);
  let knowledgeStateSha: string;
  let isReproducible: boolean;
  if (repoState.length > 0) {
    const sorted = [...repoState].sort((a, b) => a.repoUrl.localeCompare(b.repoUrl));
    const composite = sorted.map((r) => `${r.repoUrl}@${r.repoSha}`).join('|');
    knowledgeStateSha = createHash('sha256').update(composite).digest('hex');
    isReproducible = true;
  } else {
    const fp = await repoProbe.localFingerprint(caseRow.goldenPointIds);
    knowledgeStateSha = `local-${fp ?? createHash('sha256').update(caseId).digest('hex')}`;
    isReproducible = false;
  }

  // Record the spend even on success-with-zero-cost runs so the cap
  // sees `llm_calls` accrue. The (date, NULL) row is the global tally.
  if (llmCalls > 0) {
    recordCostDelta(db, todayKey(), null, llmCalls, costUsd);
  }

  const runId = randomUUID();
  insertRun(db, {
    id: runId,
    caseId: caseRow.id,
    runAt: Date.now(),
    answerProviderId: providers.answer.id,
    judgeProviderId: providers.judge.id,
    recallPct,
    alignmentPct: verdict.score,
    answerText,
    judgeVerdictText: judgeText,
    judgeVerdictJson: JSON.stringify(verdict),
    durationMs: Date.now() - startMs,
    ...(costUsd > 0 ? { estimatedCostUsd: costUsd } : {}),
    llmCallCount: llmCalls,
    knowledgeStateSha,
    isReproducible,
    ...(options.reproducedFromRunId ? { reproducedFromRunId: options.reproducedFromRunId } : {}),
    ...(options.triggeringEventKind ? { triggeringEventKind: options.triggeringEventKind } : {}),
    ...(options.triggeringEventRefId ? { triggeringEventRefId: options.triggeringEventRefId } : {}),
    repoState,
  });

  return { runId, recallPct, alignmentPct: verdict.score, knowledgeStateSha, isReproducible };
}

// ── helpers ─────────────────────────────────────────────────────────────────

interface ParsedVerdict {
  aligned: boolean;
  score: number;
  summary: string;
}

/**
 * Parse `{aligned, score, summary}` from the judge text. The model
 * sometimes wraps the JSON in markdown fence; we strip those before
 * `JSON.parse`. If the parse fails we fall back to a permissive regex
 * that extracts each field independently — never throws, always
 * produces a usable verdict shape so the run row is recoverable.
 */
export function parseJudgeVerdict(text: string): ParsedVerdict {
  const cleaned = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    const v = JSON.parse(cleaned) as Partial<ParsedVerdict>;
    if (typeof v.aligned !== 'boolean' || typeof v.score !== 'number' || typeof v.summary !== 'string') {
      throw new Error('verdict shape mismatch');
    }
    return { aligned: v.aligned, score: clamp(v.score, 0, 100), summary: v.summary };
  } catch {
    // Permissive fallback. Better an imperfect summary than a thrown
    // exception that loses the run row.
    const score = Number((cleaned.match(/"score"\s*:\s*([0-9]+(?:\.[0-9]+)?)/) ?? [])[1] ?? 0);
    const summary = (cleaned.match(/"summary"\s*:\s*"([^"]*)"/) ?? [])[1] ?? 'judge verdict unparseable';
    const aligned = /\"aligned\"\s*:\s*true/.test(cleaned);
    return { aligned, score: clamp(score, 0, 100), summary };
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function composeAnswerPrompt(question: string, snippets: RetrieveSnippet[]): string {
  const body = snippets.length
    ? snippets.map((s, i) => `[Snippet ${i + 1} · point=${s.pointId}]\n${s.text}`).join('\n\n')
    : '(no snippets retrieved)';
  return [`Question:`, question, ``, `Knowledge snippets:`, body].join('\n');
}

function composeJudgePrompt(question: string, expectedTruth: string, answer: string): string {
  return [
    `Question:`, question, ``,
    `Expected truth:`, expectedTruth, ``,
    `Candidate answer:`, answer, ``,
    `Respond with the JSON verdict described in the system prompt.`,
  ].join('\n');
}

/** Convenience for the API layer + tests: most recent N runs for a case. */
export function recentRunsForCase(db: Database.Database, caseId: string, limit = 10): BenchmarkRun[] {
  return listRunsForCase(db, caseId, limit);
}

/** Convenience: re-hydrate the repo-state tuples that built a run's sha. */
export function repoStateForRun(db: Database.Database, runId: string) {
  return getRepoStateForRun(db, runId);
}
