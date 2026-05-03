import type Database from 'better-sqlite3';
import type { HostEventLogEntry } from '../types.js';

function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw == null || raw === '') return fallback;
  try { return JSON.parse(String(raw)) as T; } catch { return fallback; }
}

function rowToEntry(row: Record<string, unknown>): HostEventLogEntry {
  return {
    id: Number(row['id']),
    hostSessionId: String(row['host_session_id']),
    kind: row['kind'] as HostEventLogEntry['kind'],
    payload: parseJson<Record<string, unknown>>(row['payload'], {}),
    createdAt: String(row['created_at']),
  };
}

export function appendHostEvent(
  db: Database.Database,
  entry: Omit<HostEventLogEntry, 'id'>,
): number {
  const result = db.prepare(`
    INSERT INTO host_event_log (host_session_id, kind, payload, created_at)
    VALUES (@host_session_id, @kind, @payload, @created_at)
  `).run({
    host_session_id: entry.hostSessionId,
    kind: entry.kind,
    payload: JSON.stringify(entry.payload),
    created_at: entry.createdAt,
  });
  return Number(result.lastInsertRowid);
}

export function listHostEvents(
  db: Database.Database,
  hostSessionId: string,
  opts?: { limit?: number; afterId?: number },
): HostEventLogEntry[] {
  const limit = opts?.limit ?? 500;
  if (opts?.afterId != null) {
    return (db.prepare(
      `SELECT * FROM host_event_log WHERE host_session_id = ? AND id > ? ORDER BY id ASC LIMIT ?`,
    ).all(hostSessionId, opts.afterId, limit) as Record<string, unknown>[]).map(rowToEntry);
  }
  return (db.prepare(
    `SELECT * FROM host_event_log WHERE host_session_id = ? ORDER BY id ASC LIMIT ?`,
  ).all(hostSessionId, limit) as Record<string, unknown>[]).map(rowToEntry);
}

export function countHostEvents(db: Database.Database, hostSessionId: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM host_event_log WHERE host_session_id = ?`,
  ).get(hostSessionId) as { cnt: number };
  return row.cnt;
}

export function deleteHostEvents(db: Database.Database, hostSessionId: string): number {
  const result = db.prepare(`DELETE FROM host_event_log WHERE host_session_id = ?`).run(hostSessionId);
  return result.changes;
}

export function pruneHostEvents(
  db: Database.Database,
  hostSessionId: string,
  maxEvents: number,
): number {
  const countRow = db.prepare(
    `SELECT COUNT(*) as cnt FROM host_event_log WHERE host_session_id = ?`,
  ).get(hostSessionId) as { cnt: number };
  const excess = countRow.cnt - maxEvents;
  if (excess <= 0) return 0;

  const result = db.prepare(`
    DELETE FROM host_event_log
    WHERE host_session_id = ?
      AND id IN (
        SELECT id FROM host_event_log WHERE host_session_id = ? ORDER BY id ASC LIMIT ?
      )
  `).run(hostSessionId, hostSessionId, excess);
  return result.changes;
}
