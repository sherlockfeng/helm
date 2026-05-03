import type Database from 'better-sqlite3';
import type { ChannelBinding, ChannelMessageQueueItem, PendingBind } from '../types.js';

function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw == null || raw === '') return fallback;
  try { return JSON.parse(String(raw)) as T; } catch { return fallback; }
}

function rowToBinding(row: Record<string, unknown>): ChannelBinding {
  return {
    id: String(row['id']),
    channel: String(row['channel']),
    hostSessionId: String(row['host_session_id']),
    externalChat: row['external_chat'] != null ? String(row['external_chat']) : undefined,
    externalThread: row['external_thread'] != null ? String(row['external_thread']) : undefined,
    externalRoot: row['external_root'] != null ? String(row['external_root']) : undefined,
    waitEnabled: Boolean(row['wait_enabled']),
    metadata: parseJson<Record<string, unknown>>(row['metadata'], {}),
    createdAt: String(row['created_at']),
  };
}

// ── ChannelBinding ─────────────────────────────────────────────────────────

export function insertChannelBinding(db: Database.Database, b: ChannelBinding): void {
  db.prepare(`
    INSERT INTO channel_bindings (id, channel, host_session_id, external_chat, external_thread, external_root, wait_enabled, metadata, created_at)
    VALUES (@id, @channel, @host_session_id, @external_chat, @external_thread, @external_root, @wait_enabled, @metadata, @created_at)
  `).run({
    id: b.id, channel: b.channel, host_session_id: b.hostSessionId,
    external_chat: b.externalChat ?? null, external_thread: b.externalThread ?? null,
    external_root: b.externalRoot ?? null, wait_enabled: b.waitEnabled ? 1 : 0,
    metadata: b.metadata ? JSON.stringify(b.metadata) : null, created_at: b.createdAt,
  });
}

export function getChannelBinding(db: Database.Database, id: string): ChannelBinding | undefined {
  const row = db.prepare(`SELECT * FROM channel_bindings WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToBinding(row) : undefined;
}

export function getBindingByThread(
  db: Database.Database,
  channel: string,
  externalChat: string,
  externalThread: string,
): ChannelBinding | undefined {
  const row = db.prepare(
    `SELECT * FROM channel_bindings WHERE channel = ? AND external_chat = ? AND external_thread = ?`,
  ).get(channel, externalChat, externalThread) as Record<string, unknown> | undefined;
  return row ? rowToBinding(row) : undefined;
}

export function listBindingsForSession(db: Database.Database, hostSessionId: string): ChannelBinding[] {
  return (db.prepare(`SELECT * FROM channel_bindings WHERE host_session_id = ? ORDER BY created_at ASC`).all(hostSessionId) as Record<string, unknown>[]).map(rowToBinding);
}

export function updateChannelBinding(
  db: Database.Database,
  id: string,
  patch: Partial<Pick<ChannelBinding, 'waitEnabled' | 'metadata' | 'externalRoot'>>,
): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.waitEnabled !== undefined) { sets.push('wait_enabled = ?'); params.push(patch.waitEnabled ? 1 : 0); }
  if (patch.metadata !== undefined) { sets.push('metadata = ?'); params.push(JSON.stringify(patch.metadata)); }
  if (patch.externalRoot !== undefined) { sets.push('external_root = ?'); params.push(patch.externalRoot); }
  if (sets.length === 0) return;
  params.push(id);
  db.prepare(`UPDATE channel_bindings SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

// ── ChannelMessageQueue ────────────────────────────────────────────────────

export function enqueueMessage(
  db: Database.Database,
  item: Omit<ChannelMessageQueueItem, 'id'>,
): number {
  const result = db.prepare(`
    INSERT INTO channel_message_queue (binding_id, external_id, text, created_at, consumed_at)
    VALUES (@binding_id, @external_id, @text, @created_at, @consumed_at)
  `).run({
    binding_id: item.bindingId, external_id: item.externalId ?? null,
    text: item.text, created_at: item.createdAt, consumed_at: item.consumedAt ?? null,
  });
  return Number(result.lastInsertRowid);
}

export function dequeueMessages(db: Database.Database, bindingId: string): ChannelMessageQueueItem[] {
  const rows = db.prepare(
    `SELECT * FROM channel_message_queue WHERE binding_id = ? AND consumed_at IS NULL ORDER BY id ASC`,
  ).all(bindingId) as Record<string, unknown>[];

  if (rows.length === 0) return [];

  const ids = rows.map((r) => (r['id'] as number));
  const now = new Date().toISOString();
  db.prepare(`UPDATE channel_message_queue SET consumed_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(now, ...ids);

  return rows.map((row) => ({
    id: Number(row['id']),
    bindingId: String(row['binding_id']),
    externalId: row['external_id'] != null ? String(row['external_id']) : undefined,
    text: String(row['text']),
    createdAt: String(row['created_at']),
    consumedAt: row['consumed_at'] != null ? String(row['consumed_at']) : undefined,
  }));
}

export function pendingMessageCount(db: Database.Database, bindingId: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM channel_message_queue WHERE binding_id = ? AND consumed_at IS NULL`,
  ).get(bindingId) as { cnt: number };
  return row.cnt;
}

// ── PendingBind ────────────────────────────────────────────────────────────

export function insertPendingBind(db: Database.Database, p: PendingBind): void {
  db.prepare(`
    INSERT INTO pending_binds (code, channel, external_chat, external_thread, external_root, expires_at)
    VALUES (@code, @channel, @external_chat, @external_thread, @external_root, @expires_at)
  `).run({
    code: p.code, channel: p.channel, external_chat: p.externalChat ?? null,
    external_thread: p.externalThread ?? null, external_root: p.externalRoot ?? null,
    expires_at: p.expiresAt,
  });
}

export function getPendingBind(db: Database.Database, code: string): PendingBind | undefined {
  const row = db.prepare(
    `SELECT * FROM pending_binds WHERE code = ? AND expires_at > ?`,
  ).get(code, new Date().toISOString()) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    code: String(row['code']), channel: String(row['channel']),
    externalChat: row['external_chat'] != null ? String(row['external_chat']) : undefined,
    externalThread: row['external_thread'] != null ? String(row['external_thread']) : undefined,
    externalRoot: row['external_root'] != null ? String(row['external_root']) : undefined,
    expiresAt: String(row['expires_at']),
  };
}

export function deletePendingBind(db: Database.Database, code: string): void {
  db.prepare(`DELETE FROM pending_binds WHERE code = ?`).run(code);
}

export function purgeExpiredPendingBinds(db: Database.Database): number {
  const result = db.prepare(`DELETE FROM pending_binds WHERE expires_at <= ?`).run(new Date().toISOString());
  return result.changes;
}
