import type Database from 'better-sqlite3';
import type { HostSession } from '../types.js';

function rowToHostSession(row: Record<string, unknown>): HostSession {
  return {
    id: String(row['id']),
    host: String(row['host']),
    cwd: row['cwd'] != null ? String(row['cwd']) : undefined,
    composerMode: row['composer_mode'] != null ? String(row['composer_mode']) : undefined,
    campaignId: row['campaign_id'] != null ? String(row['campaign_id']) : undefined,
    cycleId: row['cycle_id'] != null ? String(row['cycle_id']) : undefined,
    status: row['status'] as HostSession['status'],
    firstSeenAt: String(row['first_seen_at']),
    lastSeenAt: String(row['last_seen_at']),
  };
}

export function upsertHostSession(db: Database.Database, s: HostSession): void {
  db.prepare(`
    INSERT INTO host_sessions (id, host, cwd, composer_mode, campaign_id, cycle_id, status, first_seen_at, last_seen_at)
    VALUES (@id, @host, @cwd, @composer_mode, @campaign_id, @cycle_id, @status, @first_seen_at, @last_seen_at)
    ON CONFLICT(id) DO UPDATE SET
      cwd           = excluded.cwd,
      composer_mode = excluded.composer_mode,
      campaign_id   = excluded.campaign_id,
      cycle_id      = excluded.cycle_id,
      status        = excluded.status,
      last_seen_at  = excluded.last_seen_at
  `).run({
    id: s.id, host: s.host, cwd: s.cwd ?? null, composer_mode: s.composerMode ?? null,
    campaign_id: s.campaignId ?? null, cycle_id: s.cycleId ?? null, status: s.status,
    first_seen_at: s.firstSeenAt, last_seen_at: s.lastSeenAt,
  });
}

export function getHostSession(db: Database.Database, id: string): HostSession | undefined {
  const row = db.prepare(`SELECT * FROM host_sessions WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToHostSession(row) : undefined;
}

export function listActiveSessions(db: Database.Database): HostSession[] {
  return (db.prepare(`SELECT * FROM host_sessions WHERE status = 'active' ORDER BY last_seen_at DESC`).all() as Record<string, unknown>[]).map(rowToHostSession);
}

export function updateHostSession(
  db: Database.Database,
  id: string,
  patch: Partial<Pick<HostSession, 'status' | 'campaignId' | 'cycleId' | 'lastSeenAt'>>,
): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
  if (patch.campaignId !== undefined) { sets.push('campaign_id = ?'); params.push(patch.campaignId); }
  if (patch.cycleId !== undefined) { sets.push('cycle_id = ?'); params.push(patch.cycleId); }
  if (patch.lastSeenAt !== undefined) { sets.push('last_seen_at = ?'); params.push(patch.lastSeenAt); }
  if (sets.length === 0) return;
  params.push(id);
  db.prepare(`UPDATE host_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}
