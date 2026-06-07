/**
 * `knowledge_repo` repo (PR 5.5a / migration v22).
 *
 * Insert / read / update for the subscribed git repositories. Writers
 * are intentionally small — the manager (src/knowledge-repo/manager.ts)
 * does the orchestration around them. The schema is additive enough
 * that we can land richer columns (publish_provenance / signing_key /
 * etc) without refactoring this file.
 */

import type Database from 'better-sqlite3';
import type {
  KnowledgeRepo,
  KnowledgeRepoClassification,
  KnowledgeRepoStatus,
} from '../types.js';

export interface InsertKnowledgeRepoInput {
  id: string;
  url: string;
  branch?: string;
  localPath: string;
  syncIntervalMinutes?: number;
  autoApply?: boolean;
  classification: KnowledgeRepoClassification;
  status?: KnowledgeRepoStatus;
}

const DEFAULT_SYNC_INTERVAL_MIN = 30;

export function insertKnowledgeRepo(
  db: Database.Database,
  input: InsertKnowledgeRepoInput,
): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO knowledge_repo (
      id, url, branch, local_path,
      sync_interval_minutes, auto_apply, classification, status,
      created_at, updated_at
    ) VALUES (
      @id, @url, @branch, @local_path,
      @sync_interval_minutes, @auto_apply, @classification, @status,
      @created_at, @updated_at
    )
  `).run({
    id: input.id,
    url: input.url,
    branch: input.branch ?? 'main',
    local_path: input.localPath,
    sync_interval_minutes: input.syncIntervalMinutes ?? DEFAULT_SYNC_INTERVAL_MIN,
    auto_apply: input.autoApply ? 1 : 0,
    classification: input.classification,
    status: input.status ?? 'active',
    created_at: now, updated_at: now,
  });
}

export function getKnowledgeRepo(
  db: Database.Database,
  id: string,
): KnowledgeRepo | undefined {
  const row = db.prepare(`SELECT * FROM knowledge_repo WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToRepo(row) : undefined;
}

export function getKnowledgeRepoByUrl(
  db: Database.Database,
  url: string,
): KnowledgeRepo | undefined {
  const row = db.prepare(`SELECT * FROM knowledge_repo WHERE url = ?`)
    .get(url) as Record<string, unknown> | undefined;
  return row ? rowToRepo(row) : undefined;
}

export interface ListKnowledgeReposOptions {
  status?: KnowledgeRepoStatus | 'all';
  limit?: number;
}

export function listKnowledgeRepos(
  db: Database.Database,
  opts: ListKnowledgeReposOptions = {},
): KnowledgeRepo[] {
  const status = opts.status ?? 'all';
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = status === 'all'
    ? db.prepare(
      `SELECT * FROM knowledge_repo ORDER BY created_at DESC LIMIT ?`,
    ).all(limit)
    : db.prepare(
      `SELECT * FROM knowledge_repo WHERE status = ? ORDER BY created_at DESC LIMIT ?`,
    ).all(status, limit);
  return (rows as Record<string, unknown>[]).map(rowToRepo);
}

export interface UpdateKnowledgeRepoFetchInput {
  lastFetchedSha: string;
  lastFetchedAt: number;
  /** Set explicitly so the caller can flip back to 'active' after a recovery. */
  status?: KnowledgeRepoStatus;
  /** Pass `null` to clear a previously-stored error. */
  lastError?: string | null;
}

export function recordRepoFetch(
  db: Database.Database,
  id: string,
  input: UpdateKnowledgeRepoFetchInput,
): void {
  const stmt = db.prepare(`
    UPDATE knowledge_repo
       SET last_fetched_sha = ?,
           last_fetched_at  = ?,
           status           = COALESCE(?, status),
           last_error       = ?,
           updated_at       = ?
     WHERE id = ?
  `);
  stmt.run(
    input.lastFetchedSha,
    input.lastFetchedAt,
    input.status ?? null,
    input.lastError === null ? null : input.lastError ?? null,
    Date.now(),
    id,
  );
}

export function recordRepoError(
  db: Database.Database,
  id: string,
  message: string,
): void {
  db.prepare(`
    UPDATE knowledge_repo
       SET status = 'error', last_error = ?, updated_at = ?
     WHERE id = ?
  `).run(message, Date.now(), id);
}

export function setRepoStatus(
  db: Database.Database,
  id: string,
  status: KnowledgeRepoStatus,
): void {
  db.prepare(`
    UPDATE knowledge_repo SET status = ?, updated_at = ? WHERE id = ?
  `).run(status, Date.now(), id);
}

export function deleteKnowledgeRepo(db: Database.Database, id: string): boolean {
  const info = db.prepare(`DELETE FROM knowledge_repo WHERE id = ?`).run(id);
  return info.changes > 0;
}

// ── row mapper ─────────────────────────────────────────────────────────────

function rowToRepo(row: Record<string, unknown>): KnowledgeRepo {
  const r: KnowledgeRepo = {
    id: String(row['id']),
    url: String(row['url']),
    branch: String(row['branch']),
    localPath: String(row['local_path']),
    syncIntervalMinutes: Number(row['sync_interval_minutes']),
    autoApply: Boolean(row['auto_apply']),
    classification: String(row['classification']) as KnowledgeRepoClassification,
    status: String(row['status']) as KnowledgeRepoStatus,
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
  };
  if (row['last_fetched_sha'] != null) r.lastFetchedSha = String(row['last_fetched_sha']);
  if (row['last_fetched_at']  != null) r.lastFetchedAt  = Number(row['last_fetched_at']);
  if (row['last_error']       != null) r.lastError      = String(row['last_error']);
  return r;
}
