/**
 * Harness toolchain repos (Phase 67).
 *
 * Function-style — same idiom as roles.ts. Each row in `harness_tasks` mirrors
 * a `.harness/tasks/<id>/task.md` file; the file is the source of truth, this
 * table is the searchable index.
 *
 * JSON columns: most rich fields (intent, structure, decisions, risks,
 * related_tasks, stage_log) are stored as JSON text rather than normalized
 * out into child tables. Reasoning:
 *   - they're written + read together (a HarnessTask is always loaded whole)
 *   - none of them are queried by structured predicate (no "find tasks where
 *     entity X is in structure.entities" — that comes through the archive_cards
 *     table which DOES have its own column-level index)
 *   - keeping them as JSON keeps the on-disk markdown ↔ DB serialization
 *     simple (`JSON.stringify` round-trip)
 */

import type Database from 'better-sqlite3';
import type {
  HarnessArchiveCard,
  HarnessIntent,
  HarnessRelatedTask,
  HarnessReview,
  HarnessReviewStatus,
  HarnessStageLogEntry,
  HarnessStructure,
  HarnessTask,
} from '../types.js';

// ── HarnessTask ────────────────────────────────────────────────────────────

function parseJsonOrDefault<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback;
  try { return JSON.parse(String(raw)) as T; } catch { return fallback; }
}

function rowToHarnessTask(row: Record<string, unknown>): HarnessTask {
  const task: HarnessTask = {
    id: String(row['id']),
    title: String(row['title']),
    currentStage: String(row['current_stage']) as HarnessTask['currentStage'],
    projectPath: String(row['project_path']),
    decisions: parseJsonOrDefault<string[]>(row['decisions_json'], []),
    risks: parseJsonOrDefault<string[]>(row['risks_json'], []),
    relatedTasks: parseJsonOrDefault<HarnessRelatedTask[]>(row['related_tasks_json'], []),
    stageLog: parseJsonOrDefault<HarnessStageLogEntry[]>(row['stage_log_json'], []),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
  if (row['host_session_id'] != null) task.hostSessionId = String(row['host_session_id']);
  if (row['intent_json'] != null) {
    const intent = parseJsonOrDefault<HarnessIntent | null>(row['intent_json'], null);
    if (intent) task.intent = intent;
  }
  if (row['structure_json'] != null) {
    const structure = parseJsonOrDefault<HarnessStructure | null>(row['structure_json'], null);
    if (structure) task.structure = structure;
  }
  if (row['implement_base_commit'] != null) task.implementBaseCommit = String(row['implement_base_commit']);
  return task;
}

export function upsertHarnessTask(db: Database.Database, t: HarnessTask): void {
  db.prepare(`
    INSERT INTO harness_tasks (
      id, title, current_stage, project_path, host_session_id,
      intent_json, structure_json, decisions_json, risks_json,
      related_tasks_json, stage_log_json, implement_base_commit,
      created_at, updated_at
    )
    VALUES (
      @id, @title, @current_stage, @project_path, @host_session_id,
      @intent_json, @structure_json, @decisions_json, @risks_json,
      @related_tasks_json, @stage_log_json, @implement_base_commit,
      @created_at, @updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      title                 = excluded.title,
      current_stage         = excluded.current_stage,
      project_path          = excluded.project_path,
      host_session_id       = excluded.host_session_id,
      intent_json           = excluded.intent_json,
      structure_json        = excluded.structure_json,
      decisions_json        = excluded.decisions_json,
      risks_json            = excluded.risks_json,
      related_tasks_json    = excluded.related_tasks_json,
      stage_log_json        = excluded.stage_log_json,
      implement_base_commit = excluded.implement_base_commit,
      updated_at            = excluded.updated_at
  `).run({
    id: t.id,
    title: t.title,
    current_stage: t.currentStage,
    project_path: t.projectPath,
    host_session_id: t.hostSessionId ?? null,
    intent_json: t.intent ? JSON.stringify(t.intent) : null,
    structure_json: t.structure ? JSON.stringify(t.structure) : null,
    decisions_json: JSON.stringify(t.decisions ?? []),
    risks_json: JSON.stringify(t.risks ?? []),
    related_tasks_json: JSON.stringify(t.relatedTasks ?? []),
    stage_log_json: JSON.stringify(t.stageLog ?? []),
    implement_base_commit: t.implementBaseCommit ?? null,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
  });
}

export function getHarnessTask(db: Database.Database, id: string): HarnessTask | undefined {
  const row = db.prepare(`SELECT * FROM harness_tasks WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToHarnessTask(row) : undefined;
}

export function listHarnessTasks(
  db: Database.Database,
  opts: { projectPath?: string } = {},
): HarnessTask[] {
  const rows = opts.projectPath
    ? db.prepare(`SELECT * FROM harness_tasks WHERE project_path = ? ORDER BY created_at DESC`).all(opts.projectPath)
    : db.prepare(`SELECT * FROM harness_tasks ORDER BY created_at DESC`).all();
  return (rows as Record<string, unknown>[]).map(rowToHarnessTask);
}

/**
 * Find the (at most one) Harness task currently bound to this Cursor host
 * session. Used by sessionStart injection to look up which stage prompt
 * (if any) to layer on top of the existing role context. Returns the most
 * recently updated row when multiple match (defensive — the UI shouldn't
 * let two tasks share a host_session_id, but the schema doesn't enforce it).
 */
export function getHarnessTaskByHostSession(
  db: Database.Database,
  hostSessionId: string,
): HarnessTask | undefined {
  const row = db.prepare(
    `SELECT * FROM harness_tasks WHERE host_session_id = ? ORDER BY updated_at DESC LIMIT 1`,
  ).get(hostSessionId) as Record<string, unknown> | undefined;
  return row ? rowToHarnessTask(row) : undefined;
}

export function deleteHarnessTask(db: Database.Database, id: string): void {
  db.prepare(`DELETE FROM harness_tasks WHERE id = ?`).run(id);
}

// ── HarnessArchiveCard ─────────────────────────────────────────────────────

function rowToArchiveCard(row: Record<string, unknown>): HarnessArchiveCard {
  return {
    taskId: String(row['task_id']),
    entities: parseJsonOrDefault<string[]>(row['entities_json'], []),
    filesTouched: parseJsonOrDefault<string[]>(row['files_touched_json'], []),
    modules: parseJsonOrDefault<string[]>(row['modules_json'], []),
    patterns: parseJsonOrDefault<string[]>(row['patterns_json'], []),
    downstream: parseJsonOrDefault<string[]>(row['downstream_json'], []),
    rulesApplied: parseJsonOrDefault<string[]>(row['rules_applied_json'], []),
    oneLiner: String(row['one_liner']),
    fullDocPointer: String(row['full_doc_pointer']),
    projectPath: String(row['project_path']),
    archivedAt: String(row['archived_at']),
  };
}

export function upsertArchiveCard(db: Database.Database, c: HarnessArchiveCard): void {
  db.prepare(`
    INSERT INTO harness_archive_cards (
      task_id, entities_json, files_touched_json, modules_json,
      patterns_json, downstream_json, rules_applied_json,
      one_liner, full_doc_pointer, project_path, archived_at
    )
    VALUES (
      @task_id, @entities_json, @files_touched_json, @modules_json,
      @patterns_json, @downstream_json, @rules_applied_json,
      @one_liner, @full_doc_pointer, @project_path, @archived_at
    )
    ON CONFLICT(task_id) DO UPDATE SET
      entities_json      = excluded.entities_json,
      files_touched_json = excluded.files_touched_json,
      modules_json       = excluded.modules_json,
      patterns_json      = excluded.patterns_json,
      downstream_json    = excluded.downstream_json,
      rules_applied_json = excluded.rules_applied_json,
      one_liner          = excluded.one_liner,
      full_doc_pointer   = excluded.full_doc_pointer,
      project_path       = excluded.project_path,
      archived_at        = excluded.archived_at
  `).run({
    task_id: c.taskId,
    entities_json: JSON.stringify(c.entities ?? []),
    files_touched_json: JSON.stringify(c.filesTouched ?? []),
    modules_json: JSON.stringify(c.modules ?? []),
    patterns_json: JSON.stringify(c.patterns ?? []),
    downstream_json: JSON.stringify(c.downstream ?? []),
    rules_applied_json: JSON.stringify(c.rulesApplied ?? []),
    one_liner: c.oneLiner,
    full_doc_pointer: c.fullDocPointer,
    project_path: c.projectPath,
    archived_at: c.archivedAt,
  });
}

export function getArchiveCard(db: Database.Database, taskId: string): HarnessArchiveCard | undefined {
  const row = db.prepare(`SELECT * FROM harness_archive_cards WHERE task_id = ?`).get(taskId) as Record<string, unknown> | undefined;
  return row ? rowToArchiveCard(row) : undefined;
}

export function listArchiveCards(
  db: Database.Database,
  opts: { projectPath?: string } = {},
): HarnessArchiveCard[] {
  const rows = opts.projectPath
    ? db.prepare(`SELECT * FROM harness_archive_cards WHERE project_path = ? ORDER BY archived_at DESC`).all(opts.projectPath)
    : db.prepare(`SELECT * FROM harness_archive_cards ORDER BY archived_at DESC`).all();
  return (rows as Record<string, unknown>[]).map(rowToArchiveCard);
}

/**
 * Token-based exact-match search over archive cards.
 *
 * The archive's design doc is explicit: retrieval should be exact match on
 * entities / files / module names, not semantic similarity. So this is just
 * a substring scan over the JSON columns + one_liner. Cheap, deterministic,
 * predictable.
 *
 * `tokens` is treated case-insensitively. A card matches if ANY token appears
 * in ANY of the searchable fields. Project_path scopes the result to one
 * project (a feature in repo A shouldn't surface for a query in repo B).
 */
export function searchArchiveCardsByTokens(
  db: Database.Database,
  tokens: string[],
  opts: { projectPath?: string; limit?: number } = {},
): HarnessArchiveCard[] {
  if (tokens.length === 0) return [];
  const all = listArchiveCards(db, opts);
  const lowered = tokens.map((t) => t.toLowerCase()).filter((t) => t.length > 0);
  if (lowered.length === 0) return [];

  const matches = all.filter((c) => {
    const hay = [
      c.oneLiner,
      ...c.entities, ...c.filesTouched, ...c.modules,
      ...c.patterns, ...c.downstream, ...c.rulesApplied,
    ].join('\n').toLowerCase();
    return lowered.some((tok) => hay.includes(tok));
  });
  return opts.limit ? matches.slice(0, opts.limit) : matches;
}

// ── HarnessReview ──────────────────────────────────────────────────────────

function rowToReview(row: Record<string, unknown>): HarnessReview {
  const review: HarnessReview = {
    id: String(row['id']),
    taskId: String(row['task_id']),
    status: String(row['status']) as HarnessReviewStatus,
    spawnedAt: String(row['spawned_at']),
  };
  if (row['report_text'] != null) review.reportText = String(row['report_text']);
  if (row['base_commit'] != null) review.baseCommit = String(row['base_commit']);
  if (row['head_commit'] != null) review.headCommit = String(row['head_commit']);
  if (row['error'] != null) review.error = String(row['error']);
  if (row['completed_at'] != null) review.completedAt = String(row['completed_at']);
  return review;
}

export function insertReview(db: Database.Database, r: HarnessReview): void {
  db.prepare(`
    INSERT INTO harness_reviews (id, task_id, status, report_text, base_commit, head_commit, error, spawned_at, completed_at)
    VALUES (@id, @task_id, @status, @report_text, @base_commit, @head_commit, @error, @spawned_at, @completed_at)
  `).run({
    id: r.id,
    task_id: r.taskId,
    status: r.status,
    report_text: r.reportText ?? null,
    base_commit: r.baseCommit ?? null,
    head_commit: r.headCommit ?? null,
    error: r.error ?? null,
    spawned_at: r.spawnedAt,
    completed_at: r.completedAt ?? null,
  });
}

export function updateReview(db: Database.Database, r: HarnessReview): void {
  db.prepare(`
    UPDATE harness_reviews
    SET status = @status,
        report_text = @report_text,
        base_commit = @base_commit,
        head_commit = @head_commit,
        error = @error,
        completed_at = @completed_at
    WHERE id = @id
  `).run({
    id: r.id,
    status: r.status,
    report_text: r.reportText ?? null,
    base_commit: r.baseCommit ?? null,
    head_commit: r.headCommit ?? null,
    error: r.error ?? null,
    completed_at: r.completedAt ?? null,
  });
}

export function getReview(db: Database.Database, id: string): HarnessReview | undefined {
  const row = db.prepare(`SELECT * FROM harness_reviews WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToReview(row) : undefined;
}

export function listReviewsForTask(db: Database.Database, taskId: string): HarnessReview[] {
  const rows = db.prepare(`SELECT * FROM harness_reviews WHERE task_id = ? ORDER BY spawned_at DESC`).all(taskId);
  return (rows as Record<string, unknown>[]).map(rowToReview);
}
