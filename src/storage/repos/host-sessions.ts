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
    roleId: row['role_id'] != null ? String(row['role_id']) : undefined,
    firstPrompt: row['first_prompt'] != null ? String(row['first_prompt']) : undefined,
    status: row['status'] as HostSession['status'],
    firstSeenAt: String(row['first_seen_at']),
    lastSeenAt: String(row['last_seen_at']),
  };
}

export function upsertHostSession(db: Database.Database, s: HostSession): void {
  // role_id and first_prompt are intentionally omitted from the ON CONFLICT
  // update list — Phase 25's chat→role binding and Phase 32's captured first
  // prompt must both survive the next session_start hook bumping last_seen_at.
  // Use setHostSessionRole / setHostSessionFirstPrompt / updateHostSession to
  // change them.
  //
  // Note: cwd is updated on conflict because Cursor's sessionStart only
  // started carrying workspace_roots in 3.3+; older session rows captured
  // before that fix can have an empty cwd that the next hook can fill in.
  db.prepare(`
    INSERT INTO host_sessions (id, host, cwd, composer_mode, campaign_id, cycle_id, role_id, first_prompt, status, first_seen_at, last_seen_at)
    VALUES (@id, @host, @cwd, @composer_mode, @campaign_id, @cycle_id, @role_id, @first_prompt, @status, @first_seen_at, @last_seen_at)
    ON CONFLICT(id) DO UPDATE SET
      cwd           = excluded.cwd,
      composer_mode = excluded.composer_mode,
      campaign_id   = excluded.campaign_id,
      cycle_id      = excluded.cycle_id,
      status        = excluded.status,
      last_seen_at  = excluded.last_seen_at
  `).run({
    id: s.id, host: s.host, cwd: s.cwd ?? null, composer_mode: s.composerMode ?? null,
    campaign_id: s.campaignId ?? null, cycle_id: s.cycleId ?? null,
    role_id: s.roleId ?? null,
    first_prompt: s.firstPrompt ?? null,
    status: s.status,
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
  patch: Partial<Pick<HostSession, 'status' | 'campaignId' | 'cycleId' | 'roleId' | 'lastSeenAt'>>,
): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
  if (patch.campaignId !== undefined) { sets.push('campaign_id = ?'); params.push(patch.campaignId); }
  if (patch.cycleId !== undefined) { sets.push('cycle_id = ?'); params.push(patch.cycleId); }
  if (patch.roleId !== undefined) { sets.push('role_id = ?'); params.push(patch.roleId ?? null); }
  if (patch.lastSeenAt !== undefined) { sets.push('last_seen_at = ?'); params.push(patch.lastSeenAt); }
  if (sets.length === 0) return;
  params.push(id);
  db.prepare(`UPDATE host_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

/**
 * Phase 25: bind a chat session to a role (or pass null to unbind). The
 * LocalRolesProvider's resolveRoleId callback reads this column at
 * sessionStart to decide whose system prompt + chunks get auto-injected.
 */
export function setHostSessionRole(
  db: Database.Database,
  id: string,
  roleId: string | null,
): void {
  db.prepare(`UPDATE host_sessions SET role_id = ? WHERE id = ?`).run(roleId, id);
}

/**
 * Phase 32: record the chat's opening user message — but only on the FIRST
 * call (subsequent prompts are no-ops via `WHERE first_prompt IS NULL`). The
 * UI uses this as a stable human-readable label per chat (Cursor's auto-
 * generated chat title isn't available in any hook payload, so the first
 * prompt is the next-best signal we can capture).
 */
export function setHostSessionFirstPrompt(
  db: Database.Database,
  id: string,
  prompt: string,
): void {
  db.prepare(
    `UPDATE host_sessions SET first_prompt = ? WHERE id = ? AND first_prompt IS NULL`,
  ).run(prompt, id);
}

/**
 * Phase 36: hard-delete a host_session row. FK `ON DELETE CASCADE` on
 * `channel_bindings.host_session_id` (and its child message queue) takes
 * care of dependents in one shot — provided `PRAGMA foreign_keys=ON`,
 * which the helm DB connection always sets.
 *
 * Returns true when a row was actually removed; false when the id was
 * unknown — lets the caller send 404 vs 200.
 */
export function deleteHostSession(db: Database.Database, id: string): boolean {
  const result = db.prepare(`DELETE FROM host_sessions WHERE id = ?`).run(id);
  return result.changes > 0;
}
