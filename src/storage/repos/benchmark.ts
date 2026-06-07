/**
 * `benchmark_case` + `benchmark_run` + `regression_alert` +
 * `benchmark_cost_audit` repo (PR 5 / migration v21).
 *
 * Split by concern:
 *   - case lifecycle (create / get / list / status flip)
 *   - golden + targetRole joins (PR 2-style normalized N..N)
 *   - run persistence (write-once with repoState atomic)
 *   - regression alert insertion / status updates
 *   - cost audit upsert + daily totals
 *
 * Writers are transactional whenever there's a parent-child split so
 * a half-applied row never survives a power-cut.
 */

import type Database from 'better-sqlite3';
import type {
  AgentKind,
  BenchmarkCase,
  BenchmarkCaseProposedEvent,
  BenchmarkCaseProposedSource,
  BenchmarkCaseStatus,
  BenchmarkCostAuditRow,
  BenchmarkRun,
  BenchmarkRunRepoState,
  BenchmarkTriggeringEventKind,
  RegressionAlert,
  RegressionAlertStatus,
} from '../types.js';

// ── benchmark_case ─────────────────────────────────────────────────────────

export interface InsertCaseInput {
  id: string;
  name: string;
  question: string;
  expectedTruth: string;
  goldenPointIds?: readonly string[];
  targetRoleIds?: readonly string[];
  agentKindHint?: AgentKind;
  notes?: string;
  sourceRepoUrl?: string;
  sourceRevision?: string;
  proposedSource?: BenchmarkCaseProposedSource;
  proposedAt?: number;
  proposedFromPointId?: string;
  proposedFromEvent?: BenchmarkCaseProposedEvent;
  proposedQuestionHash?: string;
  status?: BenchmarkCaseStatus;
  confirmedBy?: string;
  confirmedAt?: number;
}

export function insertCase(db: Database.Database, input: InsertCaseInput): void {
  const now = Date.now();
  const proposedAt = input.proposedAt ?? now;
  const proposedSource = input.proposedSource ?? 'manual';
  // Default status: 'confirmed' for manual writes, 'proposed' for LLM
  // suggestions. R-5 enforces that 'proposed' rows stay invisible to
  // regression / coverage stats until the user flips them.
  const status = input.status ?? (proposedSource === 'llm-on-edit' ? 'proposed' : 'confirmed');

  db.transaction(() => {
    db.prepare(`
      INSERT INTO benchmark_case (
        id, name, question, expected_truth, agent_kind_hint, notes,
        source_repo_url, source_revision,
        proposed_source, proposed_at, proposed_from_point_id,
        proposed_from_event, proposed_question_hash,
        status, confirmed_by, confirmed_at,
        created_at, updated_at
      ) VALUES (
        @id, @name, @question, @expected_truth, @agent_kind_hint, @notes,
        @source_repo_url, @source_revision,
        @proposed_source, @proposed_at, @proposed_from_point_id,
        @proposed_from_event, @proposed_question_hash,
        @status, @confirmed_by, @confirmed_at,
        @created_at, @updated_at
      )
    `).run({
      id: input.id, name: input.name, question: input.question,
      expected_truth: input.expectedTruth,
      agent_kind_hint: input.agentKindHint ?? null,
      notes: input.notes ?? null,
      source_repo_url: input.sourceRepoUrl ?? null,
      source_revision: input.sourceRevision ?? null,
      proposed_source: proposedSource, proposed_at: proposedAt,
      proposed_from_point_id: input.proposedFromPointId ?? null,
      proposed_from_event: input.proposedFromEvent ?? null,
      proposed_question_hash: input.proposedQuestionHash ?? null,
      status,
      confirmed_by: input.confirmedBy ?? null,
      confirmed_at: input.confirmedAt ?? null,
      created_at: now, updated_at: now,
    });
    if (input.goldenPointIds?.length) {
      const insert = db.prepare(
        `INSERT INTO benchmark_case_golden (case_id, point_id) VALUES (?, ?)`,
      );
      for (const pid of input.goldenPointIds) insert.run(input.id, pid);
    }
    if (input.targetRoleIds?.length) {
      const insert = db.prepare(
        `INSERT INTO benchmark_case_target_role (case_id, role_id) VALUES (?, ?)`,
      );
      for (const rid of input.targetRoleIds) insert.run(input.id, rid);
    }
  })();
}

export function getCase(db: Database.Database, id: string): BenchmarkCase | undefined {
  const row = db.prepare(`SELECT * FROM benchmark_case WHERE id = ?`).get(id) as
    Record<string, unknown> | undefined;
  if (!row) return undefined;
  return rowToCase(db, row);
}

export interface ListCasesOptions {
  status?: BenchmarkCaseStatus | 'all';
  roleId?: string;
  limit?: number;
}

export function listCases(
  db: Database.Database,
  opts: ListCasesOptions = {},
): BenchmarkCase[] {
  const status = opts.status ?? 'confirmed';
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  // When filtering by role, join through the target-role table.
  const baseSelect = opts.roleId
    ? `SELECT DISTINCT bc.* FROM benchmark_case bc
         JOIN benchmark_case_target_role tr ON tr.case_id = bc.id`
    : `SELECT * FROM benchmark_case bc`;
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (status !== 'all') { where.push(`bc.status = ?`); params.push(status); }
  if (opts.roleId)      { where.push(`tr.role_id  = ?`); params.push(opts.roleId); }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return (db.prepare(`
    ${baseSelect}
    ${whereClause}
    ORDER BY bc.proposed_at DESC
    LIMIT ?
  `).all(...params, limit) as Record<string, unknown>[]).map((r) => rowToCase(db, r));
}

/**
 * Flip a proposed case to a terminal status. Returns true on success,
 * false when the case is missing or already terminal (R-5 enforced at
 * the SQL boundary).
 */
export function flipCaseStatus(
  db: Database.Database,
  caseId: string,
  newStatus: Exclude<BenchmarkCaseStatus, 'proposed'>,
  confirmedBy?: string,
  rejectedReason?: string,
): boolean {
  const now = Date.now();
  const info = db.prepare(`
    UPDATE benchmark_case
       SET status = ?,
           confirmed_by = COALESCE(?, confirmed_by),
           confirmed_at = CASE WHEN ? = 'confirmed' THEN ? ELSE confirmed_at END,
           rejected_reason = CASE WHEN ? = 'rejected' THEN ? ELSE rejected_reason END,
           updated_at = ?
     WHERE id = ? AND status = 'proposed'
  `).run(
    newStatus,
    confirmedBy ?? null,
    newStatus, now,
    newStatus, rejectedReason ?? null,
    now,
    caseId,
  );
  return info.changes > 0;
}

// ── benchmark_run ──────────────────────────────────────────────────────────

export interface InsertRunInput {
  id: string;
  caseId: string;
  runAt: number;
  answerProviderId: string;
  judgeProviderId: string;
  recallPct: number;
  alignmentPct: number;
  answerText: string;
  judgeVerdictText: string;
  judgeVerdictJson: string;
  durationMs: number;
  estimatedCostUsd?: number;
  llmCallCount?: number;
  knowledgeStateSha: string;
  isReproducible: boolean;
  reproducedFromRunId?: string;
  triggeringEventKind?: BenchmarkTriggeringEventKind;
  triggeringEventRefId?: string;
  baselineRunId?: string;
  /** Pairs that compose the knowledgeStateSha. Written atomically. */
  repoState?: ReadonlyArray<{ repoUrl: string; repoSha: string }>;
}

export function insertRun(db: Database.Database, input: InsertRunInput): void {
  db.transaction(() => {
    db.prepare(`
      INSERT INTO benchmark_run (
        id, case_id, run_at, answer_provider_id, judge_provider_id,
        recall_pct, alignment_pct, answer_text,
        judge_verdict_text, judge_verdict_json, duration_ms,
        estimated_cost_usd, llm_call_count,
        knowledge_state_sha, is_reproducible, reproduced_from_run_id,
        triggering_event_kind, triggering_event_ref_id, baseline_run_id
      ) VALUES (
        @id, @case_id, @run_at, @answer_provider_id, @judge_provider_id,
        @recall_pct, @alignment_pct, @answer_text,
        @judge_verdict_text, @judge_verdict_json, @duration_ms,
        @estimated_cost_usd, @llm_call_count,
        @knowledge_state_sha, @is_reproducible, @reproduced_from_run_id,
        @triggering_event_kind, @triggering_event_ref_id, @baseline_run_id
      )
    `).run({
      id: input.id, case_id: input.caseId, run_at: input.runAt,
      answer_provider_id: input.answerProviderId,
      judge_provider_id: input.judgeProviderId,
      recall_pct: input.recallPct, alignment_pct: input.alignmentPct,
      answer_text: input.answerText,
      judge_verdict_text: input.judgeVerdictText,
      judge_verdict_json: input.judgeVerdictJson,
      duration_ms: input.durationMs,
      estimated_cost_usd: input.estimatedCostUsd ?? null,
      llm_call_count: input.llmCallCount ?? null,
      knowledge_state_sha: input.knowledgeStateSha,
      is_reproducible: input.isReproducible ? 1 : 0,
      reproduced_from_run_id: input.reproducedFromRunId ?? null,
      triggering_event_kind: input.triggeringEventKind ?? null,
      triggering_event_ref_id: input.triggeringEventRefId ?? null,
      baseline_run_id: input.baselineRunId ?? null,
    });
    if (input.repoState?.length) {
      const insert = db.prepare(`
        INSERT INTO benchmark_run_repo_state (run_id, repo_url, repo_sha)
        VALUES (?, ?, ?)
      `);
      for (const s of input.repoState) insert.run(input.id, s.repoUrl, s.repoSha);
    }
  })();
}

export function listRunsForCase(
  db: Database.Database,
  caseId: string,
  limit = 50,
): BenchmarkRun[] {
  return (db.prepare(`
    SELECT * FROM benchmark_run WHERE case_id = ? ORDER BY run_at DESC LIMIT ?
  `).all(caseId, limit) as Record<string, unknown>[]).map(rowToRun);
}

export function getRepoStateForRun(
  db: Database.Database,
  runId: string,
): BenchmarkRunRepoState[] {
  return (db.prepare(`
    SELECT run_id, repo_url, repo_sha
    FROM benchmark_run_repo_state WHERE run_id = ?
    ORDER BY repo_url ASC
  `).all(runId) as Record<string, unknown>[]).map((r) => ({
    runId: String(r['run_id']),
    repoUrl: String(r['repo_url']),
    repoSha: String(r['repo_sha']),
  }));
}

// ── regression_alert ───────────────────────────────────────────────────────

export interface InsertAlertInput {
  id: string;
  caseId: string;
  prevRunId: string;
  currentRunId: string;
  prevScore: number;
  currentScore: number;
  delta: number;
  triggeringEventKind: BenchmarkTriggeringEventKind;
  triggeringEventRefId: string;
}

export function insertAlert(db: Database.Database, input: InsertAlertInput): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO regression_alert (
      id, case_id, prev_run_id, current_run_id,
      prev_score, current_score, delta,
      triggering_event_kind, triggering_event_ref_id,
      status, created_at, updated_at
    ) VALUES (
      @id, @case_id, @prev_run_id, @current_run_id,
      @prev_score, @current_score, @delta,
      @triggering_event_kind, @triggering_event_ref_id,
      'open', @created_at, @updated_at
    )
  `).run({
    id: input.id, case_id: input.caseId,
    prev_run_id: input.prevRunId, current_run_id: input.currentRunId,
    prev_score: input.prevScore, current_score: input.currentScore,
    delta: input.delta,
    triggering_event_kind: input.triggeringEventKind,
    triggering_event_ref_id: input.triggeringEventRefId,
    created_at: now, updated_at: now,
  });
}

export function listAlerts(
  db: Database.Database,
  status: RegressionAlertStatus | 'all' = 'open',
  limit = 100,
): RegressionAlert[] {
  const q = status === 'all'
    ? `SELECT * FROM regression_alert ORDER BY created_at DESC LIMIT ?`
    : `SELECT * FROM regression_alert WHERE status = ? ORDER BY created_at DESC LIMIT ?`;
  const rows = status === 'all'
    ? db.prepare(q).all(limit)
    : db.prepare(q).all(status, limit);
  return (rows as Record<string, unknown>[]).map(rowToAlert);
}

export function updateAlertStatus(
  db: Database.Database,
  alertId: string,
  newStatus: Exclude<RegressionAlertStatus, 'open'>,
  resolvedNote?: string,
): boolean {
  const info = db.prepare(`
    UPDATE regression_alert
       SET status = ?, resolved_note = COALESCE(?, resolved_note), updated_at = ?
     WHERE id = ? AND status != 'resolved'
  `).run(newStatus, resolvedNote ?? null, Date.now(), alertId);
  return info.changes > 0;
}

// ── benchmark_cost_audit ───────────────────────────────────────────────────

/**
 * Upsert today's cost roll-up for `roleId` (or NULL = global). Adds the
 * deltas (calls / cost) onto whatever was there. Returns the new totals.
 */
export function recordCostDelta(
  db: Database.Database,
  date: string,
  roleId: string | null,
  llmCalls: number,
  estimatedCostUsd: number,
): { llmCalls: number; estimatedCostUsd: number } {
  const now = Date.now();
  // INSERT ON CONFLICT — the unique index (date, role_id) catches the
  // hot path so we don't race-create two rows. NULL role_id is a
  // special case the writer guards via SELECT first.
  const existing = (roleId === null
    ? db.prepare(`SELECT id, llm_calls, estimated_cost_usd FROM benchmark_cost_audit WHERE date = ? AND role_id IS NULL`).get(date)
    : db.prepare(`SELECT id, llm_calls, estimated_cost_usd FROM benchmark_cost_audit WHERE date = ? AND role_id = ?`).get(date, roleId)
  ) as { id: string; llm_calls: number; estimated_cost_usd: number } | undefined;

  if (existing) {
    const newCalls = existing.llm_calls + llmCalls;
    const newCost = existing.estimated_cost_usd + estimatedCostUsd;
    db.prepare(`
      UPDATE benchmark_cost_audit
         SET llm_calls = ?, estimated_cost_usd = ?, updated_at = ?
       WHERE id = ?
    `).run(newCalls, newCost, now, existing.id);
    return { llmCalls: newCalls, estimatedCostUsd: newCost };
  }
  const id = `cost-${date}-${roleId ?? 'global'}-${now}`;
  db.prepare(`
    INSERT INTO benchmark_cost_audit (id, date, role_id, llm_calls, estimated_cost_usd, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, date, roleId, llmCalls, estimatedCostUsd, now);
  return { llmCalls, estimatedCostUsd };
}

export function getCostForDate(
  db: Database.Database,
  date: string,
  roleId: string | null = null,
): BenchmarkCostAuditRow | undefined {
  const row = (roleId === null
    ? db.prepare(`SELECT * FROM benchmark_cost_audit WHERE date = ? AND role_id IS NULL`).get(date)
    : db.prepare(`SELECT * FROM benchmark_cost_audit WHERE date = ? AND role_id = ?`).get(date, roleId)
  ) as Record<string, unknown> | undefined;
  return row ? rowToCostAudit(row) : undefined;
}

// ── row mappers ────────────────────────────────────────────────────────────

function rowToCase(db: Database.Database, row: Record<string, unknown>): BenchmarkCase {
  const id = String(row['id']);
  const goldenPointIds = (db.prepare(
    `SELECT point_id FROM benchmark_case_golden WHERE case_id = ?`,
  ).all(id) as { point_id: string }[]).map((r) => r.point_id);
  const targetRoleIds = (db.prepare(
    `SELECT role_id FROM benchmark_case_target_role WHERE case_id = ?`,
  ).all(id) as { role_id: string }[]).map((r) => r.role_id);
  const c: BenchmarkCase = {
    id, name: String(row['name']),
    question: String(row['question']),
    expectedTruth: String(row['expected_truth']),
    goldenPointIds, targetRoleIds,
    proposedSource: String(row['proposed_source']) as BenchmarkCaseProposedSource,
    proposedAt: Number(row['proposed_at']),
    status: String(row['status']) as BenchmarkCaseStatus,
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
  };
  if (row['agent_kind_hint'] != null) c.agentKindHint = String(row['agent_kind_hint']) as AgentKind;
  if (row['notes']                != null) c.notes               = String(row['notes']);
  if (row['source_repo_url']      != null) c.sourceRepoUrl       = String(row['source_repo_url']);
  if (row['source_revision']      != null) c.sourceRevision      = String(row['source_revision']);
  if (row['proposed_from_point_id'] != null) c.proposedFromPointId = String(row['proposed_from_point_id']);
  if (row['proposed_from_event']  != null) c.proposedFromEvent   = String(row['proposed_from_event']) as BenchmarkCaseProposedEvent;
  if (row['proposed_question_hash'] != null) c.proposedQuestionHash = String(row['proposed_question_hash']);
  if (row['confirmed_by']         != null) c.confirmedBy         = String(row['confirmed_by']);
  if (row['confirmed_at']         != null) c.confirmedAt         = Number(row['confirmed_at']);
  if (row['rejected_reason']      != null) c.rejectedReason      = String(row['rejected_reason']);
  return c;
}

function rowToRun(row: Record<string, unknown>): BenchmarkRun {
  const r: BenchmarkRun = {
    id: String(row['id']),
    caseId: String(row['case_id']),
    runAt: Number(row['run_at']),
    answerProviderId: String(row['answer_provider_id']),
    judgeProviderId: String(row['judge_provider_id']),
    recallPct: Number(row['recall_pct']),
    alignmentPct: Number(row['alignment_pct']),
    answerText: String(row['answer_text']),
    judgeVerdictText: String(row['judge_verdict_text']),
    judgeVerdictJson: String(row['judge_verdict_json']),
    durationMs: Number(row['duration_ms']),
    knowledgeStateSha: String(row['knowledge_state_sha']),
    isReproducible: Boolean(row['is_reproducible']),
  };
  if (row['estimated_cost_usd']    != null) r.estimatedCostUsd   = Number(row['estimated_cost_usd']);
  if (row['llm_call_count']        != null) r.llmCallCount       = Number(row['llm_call_count']);
  if (row['reproduced_from_run_id'] != null) r.reproducedFromRunId = String(row['reproduced_from_run_id']);
  if (row['triggering_event_kind']  != null) r.triggeringEventKind = String(row['triggering_event_kind']) as BenchmarkTriggeringEventKind;
  if (row['triggering_event_ref_id'] != null) r.triggeringEventRefId = String(row['triggering_event_ref_id']);
  if (row['baseline_run_id']        != null) r.baselineRunId = String(row['baseline_run_id']);
  return r;
}

function rowToAlert(row: Record<string, unknown>): RegressionAlert {
  const a: RegressionAlert = {
    id: String(row['id']),
    caseId: String(row['case_id']),
    prevRunId: String(row['prev_run_id']),
    currentRunId: String(row['current_run_id']),
    prevScore: Number(row['prev_score']),
    currentScore: Number(row['current_score']),
    delta: Number(row['delta']),
    triggeringEventKind: String(row['triggering_event_kind']) as BenchmarkTriggeringEventKind,
    triggeringEventRefId: String(row['triggering_event_ref_id']),
    status: String(row['status']) as RegressionAlertStatus,
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
  };
  if (row['resolved_note'] != null) a.resolvedNote = String(row['resolved_note']);
  return a;
}

function rowToCostAudit(row: Record<string, unknown>): BenchmarkCostAuditRow {
  const r: BenchmarkCostAuditRow = {
    id: String(row['id']),
    date: String(row['date']),
    llmCalls: Number(row['llm_calls']),
    estimatedCostUsd: Number(row['estimated_cost_usd']),
    updatedAt: Number(row['updated_at']),
  };
  if (row['role_id'] != null) r.roleId = String(row['role_id']);
  return r;
}
