import type Database from 'better-sqlite3';
import type { DocAuditEntry } from '../types.js';

export function insertDocAudit(db: Database.Database, entry: DocAuditEntry): void {
  db.prepare(`
    INSERT INTO doc_audit_log (token, task_id, file_path, content_hash, created_at)
    VALUES (@token, @task_id, @file_path, @content_hash, @created_at)
  `).run({
    token: entry.token, task_id: entry.taskId ?? null,
    file_path: entry.filePath, content_hash: entry.contentHash, created_at: entry.createdAt,
  });
}

export function getDocAudit(db: Database.Database, token: string): DocAuditEntry | undefined {
  const row = db.prepare(`SELECT * FROM doc_audit_log WHERE token = ?`).get(token) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    token: String(row['token']),
    taskId: row['task_id'] != null ? String(row['task_id']) : undefined,
    filePath: String(row['file_path']),
    contentHash: String(row['content_hash']),
    createdAt: String(row['created_at']),
  };
}

export function listDocAuditsByTask(db: Database.Database, taskId: string): DocAuditEntry[] {
  return (db.prepare(`SELECT * FROM doc_audit_log WHERE task_id = ? ORDER BY created_at DESC`).all(taskId) as Record<string, unknown>[])
    .map((row) => ({
      token: String(row['token']),
      taskId: String(row['task_id']),
      filePath: String(row['file_path']),
      contentHash: String(row['content_hash']),
      createdAt: String(row['created_at']),
    }));
}
