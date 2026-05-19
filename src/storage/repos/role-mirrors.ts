/**
 * `role_mirrors` repo (Phase 80 / helm-design PR B).
 *
 * Each row = "this role should auto-push its .helmrole bundle to a
 * remote URL whenever its content changes." UNIQUE on `role_id` —
 * v1 supports at most one mirror per role.
 *
 * Lifecycle:
 *   - User writes the row via PUT /api/roles/:id/mirror
 *   - Every roles.version bump (PR A) calls a module-level trigger
 *     (see src/mirrors/trigger.ts) → MirrorRunner debounces N seconds
 *     → packRole + plugin.upload → writes last_pushed_version + etag
 *   - On failure, last_error is set; last_pushed_version is left alone
 *     so the catch-up sweep retries on the next tick
 *
 * Catch-up sweep:
 *   `listDueForPush()` returns enabled mirrors where the role has
 *   advanced past the last-pushed version (or was never pushed).
 *   Drives the safety-net interval that handles missed events
 *   (process restart with a debounce pending, transient errors).
 */

import type Database from 'better-sqlite3';
import type { RoleMirror } from '../types.js';

function rowToMirror(row: Record<string, unknown>): RoleMirror {
  const m: RoleMirror = {
    roleId: String(row['role_id']),
    targetUrl: String(row['target_url']),
    enabled: Boolean(row['enabled']),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
  if (row['last_pushed_version'] != null) m.lastPushedVersion = Number(row['last_pushed_version']);
  if (row['last_pushed_etag'] != null) m.lastPushedEtag = String(row['last_pushed_etag']);
  if (row['last_pushed_at'] != null) m.lastPushedAt = String(row['last_pushed_at']);
  if (row['last_error'] != null) m.lastError = String(row['last_error']);
  return m;
}

/**
 * UPSERT a mirror for a role. Used both by initial create (PUT with no
 * prior row) and by edit (PUT with new targetUrl / enabled). Resets
 * `last_error` to NULL on every write — the user explicitly changed
 * something, treat it as a fresh attempt.
 *
 * Does NOT touch last_pushed_version: when targetUrl changes, the next
 * push will still see "version > last_pushed_version" and re-upload to
 * the new target. (Switching target_url is rare; resetting the version
 * marker would lose the "already pushed v3" knowledge for nothing.)
 */
export function upsertMirror(
  db: Database.Database,
  input: { roleId: string; targetUrl: string; enabled?: boolean; now?: string },
): RoleMirror {
  const now = input.now ?? new Date().toISOString();
  const enabled = input.enabled ?? true;
  db.prepare(`
    INSERT INTO role_mirrors
      (role_id, target_url, enabled, last_pushed_version, last_pushed_etag,
       last_pushed_at, last_error, created_at, updated_at)
    VALUES
      (@role_id, @target_url, @enabled, NULL, NULL, NULL, NULL, @now, @now)
    ON CONFLICT(role_id) DO UPDATE SET
      target_url = excluded.target_url,
      enabled    = excluded.enabled,
      last_error = NULL,
      updated_at = excluded.updated_at
  `).run({
    role_id: input.roleId,
    target_url: input.targetUrl,
    enabled: enabled ? 1 : 0,
    now,
  });
  const got = getMirror(db, input.roleId);
  if (!got) throw new Error(`upsertMirror: row disappeared after upsert: ${input.roleId}`);
  return got;
}

export function getMirror(db: Database.Database, roleId: string): RoleMirror | undefined {
  const row = db.prepare(`SELECT * FROM role_mirrors WHERE role_id = ?`).get(roleId) as Record<string, unknown> | undefined;
  return row ? rowToMirror(row) : undefined;
}

export function deleteMirror(db: Database.Database, roleId: string): boolean {
  const info = db.prepare(`DELETE FROM role_mirrors WHERE role_id = ?`).run(roleId);
  return info.changes > 0;
}

export function listMirrors(db: Database.Database): RoleMirror[] {
  return (db.prepare(`SELECT * FROM role_mirrors ORDER BY role_id ASC`).all() as Record<string, unknown>[])
    .map(rowToMirror);
}

/**
 * Mirrors that need a push: enabled + (never pushed OR role version
 * advanced past last push). Drives the catch-up sweep — does NOT
 * include mirrors where last_error is set (those will retry on the
 * next bump or via "Push now" from the UI; sweeping them every tick
 * would hammer a permanently-broken target).
 *
 * Implementation note: SQLite supports JOIN in SELECT but better-sqlite3
 * sometimes prefers explicit string-built queries; keeping it
 * declarative for clarity.
 */
export function listDueForPush(db: Database.Database): Array<RoleMirror & { roleVersion: number }> {
  const rows = db.prepare(`
    SELECT m.*, r.version AS role_version
    FROM role_mirrors m
    INNER JOIN roles r ON r.id = m.role_id
    WHERE m.enabled = 1
      AND m.last_error IS NULL
      AND (m.last_pushed_version IS NULL OR m.last_pushed_version < r.version)
    ORDER BY m.role_id ASC
  `).all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    ...rowToMirror(row),
    roleVersion: Number(row['role_version']),
  }));
}

/**
 * Record a successful push. Bumps last_pushed_version (so the catch-up
 * sweep knows we're caught up), stamps the time + etag, and clears any
 * lingering last_error.
 */
export function recordPushSuccess(
  db: Database.Database,
  input: { roleId: string; pushedVersion: number; etag?: string; at?: string },
): void {
  const at = input.at ?? new Date().toISOString();
  db.prepare(`
    UPDATE role_mirrors
    SET last_pushed_version = @v,
        last_pushed_etag    = @etag,
        last_pushed_at      = @at,
        last_error          = NULL,
        updated_at          = @at
    WHERE role_id = @role_id
  `).run({
    role_id: input.roleId,
    v: input.pushedVersion,
    etag: input.etag ?? null,
    at,
  });
}

/**
 * Record a failed push. Writes last_error + updated_at. Leaves
 * last_pushed_version alone so the catch-up sweep — and the next
 * bump-driven trigger — will retry once the user clears the error
 * (either by editing the target_url, toggling enabled, or via an
 * explicit "Push now" call which clears errors before retrying).
 */
export function recordPushFailure(
  db: Database.Database,
  input: { roleId: string; error: string; at?: string },
): void {
  const at = input.at ?? new Date().toISOString();
  db.prepare(`
    UPDATE role_mirrors
    SET last_error = @err, updated_at = @at
    WHERE role_id = @role_id
  `).run({
    role_id: input.roleId,
    err: input.error,
    at,
  });
}

/** Clear any pending error — used before manual "Push now" retries. */
export function clearMirrorError(db: Database.Database, roleId: string): void {
  db.prepare(`
    UPDATE role_mirrors
    SET last_error = NULL, updated_at = ?
    WHERE role_id = ?
  `).run(new Date().toISOString(), roleId);
}
