/**
 * `role_subscriptions` repo (Phase 79).
 *
 * Each row = "this role should be kept in sync with a remote bundle URL".
 * The sync engine (src/subscriptions/sync.ts) consults `listDueForSync`
 * each cron tick to decide which subscriptions need a HEAD/GET pass.
 */

import type Database from 'better-sqlite3';
import type { RoleSubscription, SubscriptionStatus } from '../types.js';

function rowToSubscription(row: Record<string, unknown>): RoleSubscription {
  const s: RoleSubscription = {
    id: String(row['id']),
    roleId: String(row['role_id']),
    sourceType: String(row['source_type']),
    sourceUrl: String(row['source_url']),
    syncIntervalMinutes: Number(row['sync_interval_minutes']),
    autoApply: Boolean(row['auto_apply']),
    status: String(row['status']) as SubscriptionStatus,
    createdAt: String(row['created_at']),
  };
  if (row['last_etag'] != null) s.lastEtag = String(row['last_etag']);
  if (row['last_content_hash'] != null) s.lastContentHash = String(row['last_content_hash']);
  if (row['last_sync_at'] != null) s.lastSyncAt = String(row['last_sync_at']);
  if (row['last_error'] != null) s.lastError = String(row['last_error']);
  if (row['last_pulled_version'] != null) s.lastPulledVersion = Number(row['last_pulled_version']);
  return s;
}

export function insertSubscription(db: Database.Database, s: RoleSubscription): void {
  db.prepare(`
    INSERT INTO role_subscriptions
      (id, role_id, source_type, source_url, last_etag, last_content_hash,
       last_sync_at, last_error, sync_interval_minutes, auto_apply, status, created_at)
    VALUES
      (@id, @role_id, @source_type, @source_url, @last_etag, @last_content_hash,
       @last_sync_at, @last_error, @sync_interval_minutes, @auto_apply, @status, @created_at)
  `).run({
    id: s.id,
    role_id: s.roleId,
    source_type: s.sourceType,
    source_url: s.sourceUrl,
    last_etag: s.lastEtag ?? null,
    last_content_hash: s.lastContentHash ?? null,
    last_sync_at: s.lastSyncAt ?? null,
    last_error: s.lastError ?? null,
    sync_interval_minutes: s.syncIntervalMinutes,
    auto_apply: s.autoApply ? 1 : 0,
    status: s.status,
    created_at: s.createdAt,
  });
}

export function getSubscription(db: Database.Database, id: string): RoleSubscription | undefined {
  const row = db.prepare(`SELECT * FROM role_subscriptions WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToSubscription(row) : undefined;
}

export function getSubscriptionByRole(db: Database.Database, roleId: string): RoleSubscription | undefined {
  const row = db.prepare(`SELECT * FROM role_subscriptions WHERE role_id = ?`).get(roleId) as Record<string, unknown> | undefined;
  return row ? rowToSubscription(row) : undefined;
}

export function listSubscriptions(db: Database.Database): RoleSubscription[] {
  return (db.prepare(`SELECT * FROM role_subscriptions ORDER BY created_at DESC`).all() as Record<string, unknown>[])
    .map(rowToSubscription);
}

/**
 * Rows the cron should poll on this tick: status='active', and either
 * never synced (`last_sync_at IS NULL`) or last sync was more than the
 * row's own interval ago. ORDER BY oldest-first so even backlog catches
 * up evenly.
 */
export function listDueForSync(db: Database.Database, now: Date): RoleSubscription[] {
  const nowIso = now.toISOString();
  return (db.prepare(`
    SELECT *
    FROM role_subscriptions
    WHERE status = 'active'
      AND (
        last_sync_at IS NULL
        OR datetime(last_sync_at, '+' || sync_interval_minutes || ' minutes') <= datetime(?)
      )
    ORDER BY last_sync_at ASC NULLS FIRST
  `).all(nowIso) as Record<string, unknown>[]).map(rowToSubscription);
}

/**
 * Update after a successful HEAD/GET cycle.
 *
 * Phase 80 (PR C): when an apply landed, callers pass `pulledVersion`
 * to advance `last_pulled_version`. When the bundle didn't ship a
 * `roleVersion` (pre-PR-A peer), callers omit it and the column stays
 * at its previous value — the next sync will re-evaluate the change
 * detection via contentHash.
 */
export function markSubscriptionSynced(
  db: Database.Database,
  id: string,
  fields: { etag?: string; contentHash?: string; pulledVersion?: number; at: string },
): void {
  db.prepare(`
    UPDATE role_subscriptions
    SET last_etag = COALESCE(?, last_etag),
        last_content_hash = COALESCE(?, last_content_hash),
        last_pulled_version = COALESCE(?, last_pulled_version),
        last_sync_at = ?,
        last_error = NULL,
        status = 'active'
    WHERE id = ?
  `).run(
    fields.etag ?? null,
    fields.contentHash ?? null,
    fields.pulledVersion ?? null,
    fields.at,
    id,
  );
}

/**
 * Phase 80 (PR C): the sync engine detected that both the local role
 * and the remote bundle moved past `last_pulled_version`. Mark the
 * subscription as conflicted so the cron stops re-trying (the user
 * must resolve via /resolve-conflict). `lastError` carries a
 * human-readable summary that the UI surfaces.
 *
 * We deliberately do NOT advance `last_pulled_version` here: the
 * resolve endpoint either applies the latest remote (setting
 * last_pulled_version = remoteVer) or keeps local (resolve endpoint
 * re-fetches HEAD to learn the current remote version and copies it
 * in). Storing it now would lock the user into a stale view.
 */
export function markSubscriptionConflict(
  db: Database.Database,
  id: string,
  error: string,
  at: string,
): void {
  db.prepare(`
    UPDATE role_subscriptions
    SET status = 'conflict', last_error = ?, last_sync_at = ?
    WHERE id = ?
  `).run(error, at, id);
}

/** Mark this subscription as failing. UI shows `lastError`. */
export function markSubscriptionError(
  db: Database.Database,
  id: string,
  error: string,
  at: string,
): void {
  db.prepare(`
    UPDATE role_subscriptions
    SET status = 'error', last_error = ?, last_sync_at = ?
    WHERE id = ?
  `).run(error, at, id);
}

/**
 * Reviewer should-fix: when the user resumes (status → 'active') we
 * also clear `last_error`. Otherwise the row stays decorated with a
 * stale error label until the next cron tick happens to fail again with
 * the same message — confusing UX. Pause leaves last_error alone (the
 * error is real; it's just deliberately not being polled).
 */
export function setSubscriptionStatus(
  db: Database.Database,
  id: string,
  status: SubscriptionStatus,
): boolean {
  const sql = status === 'active'
    ? `UPDATE role_subscriptions SET status = ?, last_error = NULL WHERE id = ?`
    : `UPDATE role_subscriptions SET status = ? WHERE id = ?`;
  const info = db.prepare(sql).run(status, id);
  return info.changes > 0;
}

export function deleteSubscription(db: Database.Database, id: string): boolean {
  const info = db.prepare(`DELETE FROM role_subscriptions WHERE id = ?`).run(id);
  return info.changes > 0;
}
