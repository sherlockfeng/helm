/**
 * `knowledge_merge_conflict` repo (PR 5.5c / migration v23).
 */

import type Database from 'better-sqlite3';
import type {
  KnowledgeMergeConflict,
  KnowledgeMergeConflictStatus,
} from '../types.js';

export interface InsertMergeConflictInput {
  id: string;
  repoId: string;
  pointId: string;
  localBody: string;
  remoteBody: string;
  localVersion: number;
  remoteRevision: string;
}

export function insertMergeConflict(
  db: Database.Database,
  input: InsertMergeConflictInput,
): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO knowledge_merge_conflict
      (id, repo_id, point_id, local_body, remote_body, local_version,
       remote_revision, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
  `).run(
    input.id, input.repoId, input.pointId,
    input.localBody, input.remoteBody,
    input.localVersion, input.remoteRevision,
    now, now,
  );
}

export interface ListMergeConflictsOptions {
  status?: KnowledgeMergeConflictStatus | 'all';
  repoId?: string;
  limit?: number;
}

export function listMergeConflicts(
  db: Database.Database,
  opts: ListMergeConflictsOptions = {},
): KnowledgeMergeConflict[] {
  const status = opts.status ?? 'open';
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (status !== 'all') { where.push('status = ?'); params.push(status); }
  if (opts.repoId)      { where.push('repo_id = ?'); params.push(opts.repoId); }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT * FROM knowledge_merge_conflict
    ${whereClause}
    ORDER BY created_at DESC LIMIT ?
  `).all(...params, limit) as Record<string, unknown>[];
  return rows.map(rowToConflict);
}

export function getMergeConflict(
  db: Database.Database,
  id: string,
): KnowledgeMergeConflict | undefined {
  const row = db.prepare(`SELECT * FROM knowledge_merge_conflict WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToConflict(row) : undefined;
}

export function resolveMergeConflict(
  db: Database.Database,
  id: string,
  resolvedBody: string,
): boolean {
  const info = db.prepare(`
    UPDATE knowledge_merge_conflict
       SET status = 'resolved', resolved_body = ?, resolved_at = ?, updated_at = ?
     WHERE id = ? AND status = 'open'
  `).run(resolvedBody, Date.now(), Date.now(), id);
  return info.changes > 0;
}

function rowToConflict(row: Record<string, unknown>): KnowledgeMergeConflict {
  const c: KnowledgeMergeConflict = {
    id: String(row['id']),
    repoId: String(row['repo_id']),
    pointId: String(row['point_id']),
    localBody: String(row['local_body']),
    remoteBody: String(row['remote_body']),
    localVersion: Number(row['local_version']),
    remoteRevision: String(row['remote_revision']),
    status: String(row['status']) as KnowledgeMergeConflictStatus,
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
  };
  if (row['resolved_body'] != null) c.resolvedBody = String(row['resolved_body']);
  if (row['resolved_at']   != null) c.resolvedAt   = Number(row['resolved_at']);
  return c;
}
