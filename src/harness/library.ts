/**
 * Harness toolchain core (Phase 67).
 *
 * Domain operations for the Harness workflow:
 *   - createTask        : new task → write task.md + DB row + auto-related-search
 *   - getTask           : read DB-backed view of the task
 *   - updateField       : patch a single section (intent / structure / decisions / risks / planned_files)
 *   - appendStageLog    : durable timeline append
 *   - advanceStage      : monotonic stage transition (refuses to go backwards)
 *   - archiveTask       : freeze archive card + .harness/archive markdown
 *   - searchArchive     : exact-match retrieval over archive index
 *
 * The runReview path lives in review-runner.ts because it spawns a child
 * process and is best decoupled.
 *
 * Sync direction: every write goes file FIRST (source of truth), then DB
 * (index). On read, we read from DB by default; the `reindex` path
 * (re-parses task.md and writes to DB) is the recovery hatch when the user
 * hand-edits files outside helm's tools.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  archiveRelativePointer,
  readTaskFile,
  serializeArchive,
  writeArchiveFile,
  writeTaskFile,
} from './file-io.js';
import {
  getArchiveCard as getArchiveCardRow,
  getHarnessTask as getTaskRow,
  getReview as getReviewRow,
  listHarnessTasks as listTaskRows,
  listArchiveCards as listArchiveCardRows,
  searchArchiveCardsByTokens,
  upsertArchiveCard,
  upsertHarnessTask,
} from '../storage/repos/harness.js';
import type {
  ChannelBinding,
  HarnessArchiveCard,
  HarnessIntent,
  HarnessRelatedTask,
  HarnessStage,
  HarnessStageLogEntry,
  HarnessStructure,
  HarnessTask,
} from '../storage/types.js';
import {
  enqueueMessage,
  insertChannelBinding,
  listBindingsForSession,
} from '../storage/repos/channel-bindings.js';

// ── stage transitions ──────────────────────────────────────────────────────

/** Allowed forward transitions. Used by advanceStage to refuse backwards moves. */
const ALLOWED_TRANSITIONS: Record<HarnessStage, HarnessStage[]> = {
  new_feature: ['implement'],
  implement: ['archived'],
  archived: [],
};

export function canAdvance(from: HarnessStage, to: HarnessStage): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

// ── createTask ─────────────────────────────────────────────────────────────

export interface CreateTaskInput {
  taskId: string;        // YYYY-MM-DD-<kebab-slug>
  title: string;
  projectPath: string;
  hostSessionId?: string;
  intent?: Partial<HarnessIntent>;
}

export interface CreateTaskResult {
  task: HarnessTask;
  /** Archive cards picked up by token search over the intent text. */
  relatedFound: HarnessRelatedTask[];
}

export function createTask(db: Database.Database, input: CreateTaskInput): CreateTaskResult {
  if (getTaskRow(db, input.taskId)) {
    throw new Error(`createTask: task already exists: ${input.taskId}. Use harness_update_field to change it.`);
  }

  const now = new Date().toISOString();
  const intent: HarnessIntent | undefined = input.intent
    ? {
        background: input.intent.background ?? '',
        objective: input.intent.objective ?? '',
        scopeIn: input.intent.scopeIn ?? [],
        scopeOut: input.intent.scopeOut ?? [],
      }
    : undefined;

  // Archive search: tokens come from title + intent fields. Token = whitespace-
  // split, len ≥ 3 to skip junk like "a / the / is". This is the single
  // archive lookup we do automatically — subsequent hits require an explicit
  // harness_search_archive call.
  const tokens = extractTokens([
    input.title,
    intent?.background ?? '',
    intent?.objective ?? '',
    ...(intent?.scopeIn ?? []),
  ].join(' '));
  const matches = searchArchiveCardsByTokens(db, tokens, {
    projectPath: input.projectPath,
    limit: 10,
  });
  const related: HarnessRelatedTask[] = matches.map((m) => ({
    taskId: m.taskId,
    oneLiner: m.oneLiner,
    archivePath: m.fullDocPointer,
  }));

  const task: HarnessTask = {
    id: input.taskId,
    title: input.title,
    currentStage: 'new_feature',
    projectPath: input.projectPath,
    decisions: [],
    risks: [],
    relatedTasks: related,
    stageLog: [{
      at: now,
      stage: 'new_feature',
      message: 'task created',
    }],
    createdAt: now,
    updatedAt: now,
  };
  if (input.hostSessionId) task.hostSessionId = input.hostSessionId;
  if (intent) task.intent = intent;

  // File first, DB second. If the file write fails we never get a stale DB row.
  writeTaskFile(task);
  upsertHarnessTask(db, task);

  return { task, relatedFound: related };
}

function extractTokens(text: string): string[] {
  return text
    .split(/[^\p{Letter}\p{Number}_-]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
}

// ── reads ──────────────────────────────────────────────────────────────────

export function getTask(db: Database.Database, taskId: string): HarnessTask {
  const row = getTaskRow(db, taskId);
  if (!row) throw new Error(`Harness task not found: ${taskId}`);
  return row;
}

export function listTasks(
  db: Database.Database,
  opts: { projectPath?: string } = {},
): HarnessTask[] {
  return listTaskRows(db, opts);
}

// ── updates (file + DB) ────────────────────────────────────────────────────

export type UpdateFieldName =
  | 'title'
  | 'intent'
  | 'structure'
  | 'decisions'
  | 'risks'
  | 'planned_files'  // shorthand for structure.plannedFiles
  | 'host_session_id'
  | 'related_tasks';

export type UpdateFieldValue =
  | string
  | string[]
  | Partial<HarnessIntent>
  | Partial<HarnessStructure>
  | HarnessRelatedTask[]
  | null;

export function updateField(
  db: Database.Database,
  taskId: string,
  field: UpdateFieldName,
  value: UpdateFieldValue,
): HarnessTask {
  const task = getTask(db, taskId);
  applyFieldUpdate(task, field, value);
  task.updatedAt = new Date().toISOString();
  writeTaskFile(task);
  upsertHarnessTask(db, task);
  return task;
}

function applyFieldUpdate(
  task: HarnessTask,
  field: UpdateFieldName,
  value: UpdateFieldValue,
): void {
  switch (field) {
    case 'title':
      if (typeof value !== 'string') throw new Error('title expects string');
      task.title = value;
      return;
    case 'intent': {
      const v = (value ?? {}) as Partial<HarnessIntent>;
      task.intent = {
        background: v.background ?? task.intent?.background ?? '',
        objective: v.objective ?? task.intent?.objective ?? '',
        scopeIn: v.scopeIn ?? task.intent?.scopeIn ?? [],
        scopeOut: v.scopeOut ?? task.intent?.scopeOut ?? [],
      };
      return;
    }
    case 'structure': {
      const v = (value ?? {}) as Partial<HarnessStructure>;
      task.structure = {
        entities: v.entities ?? task.structure?.entities ?? [],
        relations: v.relations ?? task.structure?.relations ?? [],
        plannedFiles: v.plannedFiles ?? task.structure?.plannedFiles ?? [],
      };
      return;
    }
    case 'planned_files': {
      if (!Array.isArray(value)) throw new Error('planned_files expects string[]');
      const existing = task.structure ?? { entities: [], relations: [], plannedFiles: [] };
      task.structure = { ...existing, plannedFiles: value as string[] };
      return;
    }
    case 'decisions':
      if (!Array.isArray(value)) throw new Error('decisions expects string[]');
      task.decisions = value as string[];
      return;
    case 'risks':
      if (!Array.isArray(value)) throw new Error('risks expects string[]');
      task.risks = value as string[];
      return;
    case 'host_session_id':
      if (value === null || value === undefined) {
        delete task.hostSessionId;
      } else if (typeof value === 'string') {
        task.hostSessionId = value;
      } else {
        throw new Error('host_session_id expects string or null');
      }
      return;
    case 'related_tasks':
      if (!Array.isArray(value)) throw new Error('related_tasks expects HarnessRelatedTask[]');
      task.relatedTasks = value as HarnessRelatedTask[];
      return;
    default: {
      const _exhaustive: never = field;
      throw new Error(`unknown field: ${_exhaustive as string}`);
    }
  }
}

export function appendStageLog(
  db: Database.Database,
  taskId: string,
  message: string,
): HarnessTask {
  const task = getTask(db, taskId);
  const entry: HarnessStageLogEntry = {
    at: new Date().toISOString(),
    stage: task.currentStage,
    message,
  };
  task.stageLog = [...task.stageLog, entry];
  task.updatedAt = entry.at;
  writeTaskFile(task);
  upsertHarnessTask(db, task);
  return task;
}

// ── advanceStage ───────────────────────────────────────────────────────────

export interface AdvanceStageInput {
  taskId: string;
  toStage: HarnessStage;
  /**
   * When transitioning to implement, the caller MUST supply the current git
   * HEAD as the diff base. We do NOT shell out from helm to compute it —
   * that's the renderer / MCP call site's responsibility, so the caller can
   * choose the project's actual root (which may differ from helm's cwd).
   */
  implementBaseCommit?: string;
  /** Optional human note appended to the stage log alongside the transition. */
  message?: string;
}

export function advanceStage(db: Database.Database, input: AdvanceStageInput): HarnessTask {
  const task = getTask(db, input.taskId);
  if (!canAdvance(task.currentStage, input.toStage)) {
    throw new Error(
      `advanceStage: invalid transition ${task.currentStage} → ${input.toStage}. `
      + `Stages are forward-only; allowed next from ${task.currentStage}: ${ALLOWED_TRANSITIONS[task.currentStage].join(', ') || '(none)'}.`,
    );
  }
  if (input.toStage === 'implement') {
    if (!input.implementBaseCommit) {
      throw new Error('advanceStage to implement requires implementBaseCommit (the current git HEAD).');
    }
    task.implementBaseCommit = input.implementBaseCommit;
  }
  task.currentStage = input.toStage;
  const at = new Date().toISOString();
  task.stageLog = [
    ...task.stageLog,
    {
      at,
      stage: input.toStage,
      message: input.message ?? `transitioned to ${input.toStage}`,
    },
  ];
  task.updatedAt = at;
  writeTaskFile(task);
  upsertHarnessTask(db, task);
  return task;
}

// ── archive ────────────────────────────────────────────────────────────────

export interface ArchiveTaskInput {
  taskId: string;
  oneLiner: string;
  entities?: string[];
  filesTouched?: string[];
  modules?: string[];
  patterns?: string[];
  downstream?: string[];
  rulesApplied?: string[];
}

export interface ArchiveTaskResult {
  task: HarnessTask;
  card: HarnessArchiveCard;
}

export function archiveTask(db: Database.Database, input: ArchiveTaskInput): ArchiveTaskResult {
  const task = getTask(db, input.taskId);
  if (task.currentStage === 'archived') {
    // Idempotent — re-archiving regenerates the card from the latest task.md.
    // Useful when the user updates oneLiner / entities after the fact.
  } else if (!canAdvance(task.currentStage, 'archived')) {
    throw new Error(`archiveTask: cannot archive from stage ${task.currentStage}.`);
  }

  const archivedAt = new Date().toISOString();
  const card: HarnessArchiveCard = {
    taskId: task.id,
    entities: input.entities ?? [],
    filesTouched: input.filesTouched ?? [],
    modules: input.modules ?? [],
    patterns: input.patterns ?? [],
    downstream: input.downstream ?? [],
    rulesApplied: input.rulesApplied ?? [],
    oneLiner: input.oneLiner,
    fullDocPointer: archiveRelativePointer(task.id),
    projectPath: task.projectPath,
    archivedAt,
  };

  // Bump the task into archived stage if it wasn't already.
  if (task.currentStage !== 'archived') {
    task.currentStage = 'archived';
    task.stageLog = [
      ...task.stageLog,
      { at: archivedAt, stage: 'archived', message: `archived: ${input.oneLiner}` },
    ];
  }
  task.updatedAt = archivedAt;

  // File-system writes first (so a DB hiccup doesn't leave us with no archive
  // markdown), then DB.
  writeArchiveFile(card);
  writeTaskFile(task);
  upsertArchiveCard(db, card);
  upsertHarnessTask(db, task);

  return { task, card };
}

// ── searchArchive ──────────────────────────────────────────────────────────

export function searchArchive(
  db: Database.Database,
  opts: { tokens: string[]; projectPath?: string; limit?: number },
): HarnessArchiveCard[] {
  return searchArchiveCardsByTokens(db, opts.tokens, opts);
}

// ── reindex (file → DB recovery) ───────────────────────────────────────────

/**
 * Re-load `.harness/tasks/<id>/task.md` from disk and write the DB row.
 * Used when the user hand-edits the file and wants helm's index to catch up.
 *
 * Returns null when the file doesn't exist (caller decides to delete or
 * surface).
 */
export function reindexTask(
  db: Database.Database,
  projectPath: string,
  taskId: string,
): HarnessTask | null {
  const task = readTaskFile(projectPath, taskId);
  if (!task) return null;
  upsertHarnessTask(db, task);
  return task;
}

/** Re-load every `.harness/archive/<id>.md` in the project (best-effort scan). */
export function reindexArchives(_db: Database.Database, _projectPath: string): number {
  // MVP: archive cards are only created via archiveTask(), so a hand-edited
  // archive markdown file wouldn't normally need a reindex. We expose the
  // hook so the renderer's "Reindex" button has a complete answer; future
  // versions can scan the directory and re-parse each card.
  return 0;
}

/** Helper for the API surface — "is there a task.md for this id at this project?" */
export function taskFileExists(projectPath: string, taskId: string): boolean {
  return existsSync(join(projectPath, '.harness', 'tasks', taskId, 'task.md'));
}

// ── push review to implement chat ─────────────────────────────────────────
//
// MVP delivery path: piggyback on the existing host_stop / channel_message_queue
// pipeline. We synthesize a single per-task `channel='harness'` binding (one
// row per task; idempotent on subsequent pushes) and enqueue the review
// report text against it. host_stop's drain (`runHostStopLongPoll`) already
// loops over every binding for the session and merges queued messages, so
// the report lands the next time the implement-chat agent stops to think.
//
// Reasoning: avoids inventing a new "host_session-only" queue + a parallel
// drain path in the orchestrator. Costs us a slightly noisier
// /api/bindings list (a fake "harness" channel), which we accept for MVP.

const HARNESS_CHANNEL = 'harness';

export function findOrCreateHarnessBinding(
  db: Database.Database,
  task: HarnessTask,
): ChannelBinding {
  if (!task.hostSessionId) {
    throw new Error(`Task ${task.id} has no host_session_id; cannot push review (bind a Cursor chat first).`);
  }
  const existing = listBindingsForSession(db, task.hostSessionId)
    .find((b) => b.channel === HARNESS_CHANNEL && b.externalThread === task.id);
  if (existing) return existing;

  const binding: ChannelBinding = {
    id: randomUUID(),
    channel: HARNESS_CHANNEL,
    hostSessionId: task.hostSessionId,
    externalChat: task.id,    // re-use task id so the row has stable ids
    externalThread: task.id,
    waitEnabled: false,
    label: `Harness · ${task.title.slice(0, 40)}`,
    createdAt: new Date().toISOString(),
  };
  insertChannelBinding(db, binding);
  return binding;
}

export interface PushReviewToImplementInput {
  taskId: string;
  reviewId: string;
}

export interface PushReviewResult {
  bindingId: string;
  messageId: number;
  delivered: boolean; // currently always true if no throw — included for future-proofing.
}

export interface MessageEnqueuedEmitter {
  emit: (e: { type: 'channel.message_enqueued'; bindingId: string; messageId: number }) => void;
}

export function pushReviewToImplementChat(
  db: Database.Database,
  input: PushReviewToImplementInput,
  events?: MessageEnqueuedEmitter,
): PushReviewResult {
  const task = getTask(db, input.taskId);
  const review = getReviewRow(db, input.reviewId);
  if (!review) throw new Error(`Review not found: ${input.reviewId}`);
  if (review.taskId !== task.id) {
    throw new Error(`Review ${input.reviewId} does not belong to task ${task.id}`);
  }
  if (review.status !== 'completed' || !review.reportText) {
    throw new Error(`Review ${input.reviewId} not completed (status=${review.status}); nothing to push.`);
  }
  const binding = findOrCreateHarnessBinding(db, task);

  const text = [
    '【Harness review report — auto-injected, treat as advisory】',
    '',
    review.reportText,
    '',
    '— end of review —',
  ].join('\n');

  const messageId = enqueueMessage(db, {
    bindingId: binding.id,
    text,
    createdAt: new Date().toISOString(),
  });
  events?.emit({ type: 'channel.message_enqueued', bindingId: binding.id, messageId });

  return { bindingId: binding.id, messageId, delivered: true };
}

// ── re-exports used by callers that want raw access ────────────────────────

export {
  serializeArchive,
  getArchiveCardRow as getArchiveCard,
  listArchiveCardRows as listArchiveCards,
};
