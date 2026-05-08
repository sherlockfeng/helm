import type Database from 'better-sqlite3';
import type { HostSession } from '../types.js';

function rowToHostSession(row: Record<string, unknown>, roleIds: readonly string[] = []): HostSession {
  return {
    id: String(row['id']),
    host: String(row['host']),
    cwd: row['cwd'] != null ? String(row['cwd']) : undefined,
    composerMode: row['composer_mode'] != null ? String(row['composer_mode']) : undefined,
    campaignId: row['campaign_id'] != null ? String(row['campaign_id']) : undefined,
    cycleId: row['cycle_id'] != null ? String(row['cycle_id']) : undefined,
    roleId: row['role_id'] != null ? String(row['role_id']) : undefined,
    roleIds,
    firstPrompt: row['first_prompt'] != null ? String(row['first_prompt']) : undefined,
    displayName: row['display_name'] != null ? String(row['display_name']) : undefined,
    lastInjectedRoleIds: parseInjectedRoleIds(row['last_injected_role_ids']),
    status: row['status'] as HostSession['status'],
    firstSeenAt: String(row['first_seen_at']),
    lastSeenAt: String(row['last_seen_at']),
  };
}

function fetchRoleIds(db: Database.Database, sessionId: string): string[] {
  return (db.prepare(
    `SELECT role_id FROM host_session_roles WHERE host_session_id = ? ORDER BY created_at ASC`,
  ).all(sessionId) as { role_id: string }[]).map((r) => r.role_id);
}

/** Phase 56: defensively decode the JSON snapshot. Bad data = treat as null. */
function parseInjectedRoleIds(raw: unknown): readonly string[] | undefined {
  if (raw == null) return undefined;
  try {
    const parsed = JSON.parse(String(raw));
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
      return parsed as string[];
    }
  } catch { /* fall through */ }
  return undefined;
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
  if (!row) return undefined;
  return rowToHostSession(row, fetchRoleIds(db, id));
}

export function listActiveSessions(db: Database.Database): HostSession[] {
  // Single round-trip: pre-fetch role bindings for every active session and
  // build an in-memory map keyed by host_session_id. Avoids N+1 lookups when
  // the dashboard renders dozens of chats.
  const rows = db.prepare(
    `SELECT * FROM host_sessions WHERE status = 'active' ORDER BY last_seen_at DESC`,
  ).all() as Record<string, unknown>[];
  const ids = rows.map((r) => String(r['id']));
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const roleRows = db.prepare(
    `SELECT host_session_id, role_id FROM host_session_roles
     WHERE host_session_id IN (${placeholders}) ORDER BY created_at ASC`,
  ).all(...ids) as { host_session_id: string; role_id: string }[];
  const byId = new Map<string, string[]>();
  for (const { host_session_id, role_id } of roleRows) {
    const list = byId.get(host_session_id);
    if (list) list.push(role_id); else byId.set(host_session_id, [role_id]);
  }
  return rows.map((r) => rowToHostSession(r, byId.get(String(r['id'])) ?? []));
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
 * @deprecated Phase 25 single-role API. Phase 42 replaced this with the
 * `host_session_roles` join table; new code should use `addHostSessionRole`,
 * `removeHostSessionRole`, or `setHostSessionRoles`. Kept as a thin shim
 * over the new table so the existing PUT /api/active-chats/:id/role
 * endpoint keeps working ("set the chat's role list to exactly this one
 * role", or empty when null).
 */
export function setHostSessionRole(
  db: Database.Database,
  id: string,
  roleId: string | null,
): void {
  // Stay consistent with the join table. The legacy `role_id` column is
  // also updated for any external tooling still reading it directly.
  db.prepare(`UPDATE host_sessions SET role_id = ? WHERE id = ?`).run(roleId, id);
  setHostSessionRoles(db, id, roleId ? [roleId] : []);
}

/**
 * Phase 42: add a single role to a chat. Idempotent — if the role is
 * already attached, no-op. Returns true when something was inserted.
 */
export function addHostSessionRole(
  db: Database.Database,
  sessionId: string,
  roleId: string,
): boolean {
  const result = db.prepare(`
    INSERT OR IGNORE INTO host_session_roles (host_session_id, role_id, created_at)
    VALUES (?, ?, ?)
  `).run(sessionId, roleId, new Date().toISOString());
  return result.changes > 0;
}

/**
 * Phase 42: remove a single role from a chat. Returns true when a row
 * actually existed.
 */
export function removeHostSessionRole(
  db: Database.Database,
  sessionId: string,
  roleId: string,
): boolean {
  const result = db.prepare(
    `DELETE FROM host_session_roles WHERE host_session_id = ? AND role_id = ?`,
  ).run(sessionId, roleId);
  return result.changes > 0;
}

/**
 * Phase 42: replace the chat's entire role set with the given list. Atomic
 * via transaction; existing-but-not-in-list rows get dropped, new ones
 * inserted. Caller is responsible for FK validity (each roleId must exist
 * in the `roles` table — otherwise the INSERT throws).
 */
export function setHostSessionRoles(
  db: Database.Database,
  sessionId: string,
  roleIds: readonly string[],
): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO host_session_roles (host_session_id, role_id, created_at)
    VALUES (?, ?, ?)
  `);
  const unique = [...new Set(roleIds)];
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`DELETE FROM host_session_roles WHERE host_session_id = ?`).run(sessionId);
    for (const roleId of unique) {
      insert.run(sessionId, roleId, now);
    }
  })();
}

export function listHostSessionRoles(db: Database.Database, sessionId: string): string[] {
  return fetchRoleIds(db, sessionId);
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
 * Phase 55: set / clear the user-facing chat label. Pass null/empty to
 * clear back to the firstPrompt-based fallback. Trims surrounding
 * whitespace; rejects multi-line input (the label is meant to be a single
 * inline string).
 *
 * Returns the persisted value (or undefined when cleared) so the API
 * handler can echo it back without a second SELECT.
 */
export function setHostSessionDisplayName(
  db: Database.Database,
  id: string,
  raw: string | null,
): string | undefined {
  const trimmed = raw == null ? '' : raw.replace(/[\r\n]+/g, ' ').trim();
  // Soft cap: long labels make the sidebar break. Hard limit at 120 chars
  // — well past any reasonable label, short enough to keep the row layout
  // tidy. Truncate rather than reject so paste-from-anywhere works.
  const value = trimmed.length === 0 ? null : trimmed.slice(0, 120);
  db.prepare(`UPDATE host_sessions SET display_name = ? WHERE id = ?`).run(value, id);
  return value ?? undefined;
}

/**
 * Phase 47: mark sessions whose `last_seen_at` is older than `cutoffIso` as
 * closed. Cursor never fires a `chat ended` hook when the user Cmd-W's a
 * tab, so without this every chat ever opened sits as 'active' forever and
 * inflates the menubar tray's "active chats" count + the Active Chats list.
 * Returns the number of rows flipped to closed.
 *
 * Called by the orchestrator on boot. The cutoff defaults to 24h ago, which
 * comfortably covers any reasonable working session while pruning anything
 * that's clearly been abandoned (laptop closed overnight / restart / etc.).
 */
export function closeStaleHostSessions(
  db: Database.Database,
  cutoffIso: string,
): number {
  const result = db.prepare(
    `UPDATE host_sessions SET status = 'closed' WHERE status = 'active' AND last_seen_at < ?`,
  ).run(cutoffIso);
  return result.changes;
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

/**
 * Phase 56: record the role-id set we just injected into a chat. Stored
 * as a JSON-encoded sorted array so the orchestrator can compare with
 * `JSON.stringify(currentRoleIds.sort())` for an O(1) "did the binding
 * change?" check on every prompt-submit.
 *
 * Empty array is meaningful (`"[]"` = "we synced the empty state, don't
 * re-inject when there are still no roles bound"). Pass null to clear,
 * which forces the next prompt-submit to re-inject if any roles ARE bound.
 */
export function setLastInjectedRoleIds(
  db: Database.Database,
  id: string,
  roleIds: readonly string[] | null,
): void {
  const encoded = roleIds == null
    ? null
    : JSON.stringify([...roleIds].sort());
  db.prepare(`UPDATE host_sessions SET last_injected_role_ids = ? WHERE id = ?`)
    .run(encoded, id);
}
