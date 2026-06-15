/**
 * chat_knowledge_points repo (v35).
 *
 * LLM-extracted knowledge points for a conversation. Each point proposes a
 * home topic — an existing one (suggestedRoleId) or a new one to create
 * (suggestedTopicName). Decoupled from knowledge_candidates so the new
 * LLM-extraction flow can't disturb the live capture pipeline.
 */

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { getRole, listRoles, upsertRole } from './roles.js';

export type ChatKnowledgeKind =
  | 'spec' | 'example' | 'warning' | 'runbook' | 'glossary' | 'other';
export type ChatKnowledgeStatus = 'pending' | 'accepted' | 'dismissed';

export interface ChatKnowledgePoint {
  id: string;
  hostSessionId: string;
  title: string;
  body: string;
  kind: ChatKnowledgeKind;
  /** Existing topic the LLM matched this point to (null when proposing new). */
  suggestedRoleId: string | null;
  /** Proposed new topic name when no existing topic fits (null otherwise). */
  suggestedTopicName: string | null;
  status: ChatKnowledgeStatus;
  createdAt: string;
}

function rowToPoint(r: Record<string, unknown>): ChatKnowledgePoint {
  return {
    id: String(r['id']),
    hostSessionId: String(r['host_session_id']),
    title: String(r['title']),
    body: String(r['body']),
    kind: r['kind'] as ChatKnowledgeKind,
    suggestedRoleId: r['suggested_role_id'] == null ? null : String(r['suggested_role_id']),
    suggestedTopicName: r['suggested_topic_name'] == null ? null : String(r['suggested_topic_name']),
    status: r['status'] as ChatKnowledgeStatus,
    createdAt: String(r['created_at']),
  };
}

export function textHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 32);
}

/**
 * Derive a topic (role) id from a human topic name. Unlike slugifyPointId
 * (ASCII-only, for doc-lsp concept ids), this KEEPS CJK and other Unicode
 * letters — so "helm 采集架构" → "helm-采集架构" instead of collapsing to
 * "helm". role_id is safe with CJK (DB key, path segments go through the
 * path sanitizer, URLs are encodeURIComponent'd). Falls back when the name
 * has no usable letters/digits.
 */
export function topicIdFromName(name: string, fallback: string): string {
  const id = name
    .trim()
    .toLowerCase()
    .replace(/[\s/\\]+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return id.length >= 1 ? id : fallback;
}

/**
 * Resolve the home topic (role id) for accepting a knowledge point.
 * Precedence: explicit existing id → suggested existing id → a topic by
 * NAME (explicit newTopicName, else suggestedTopicName).
 *
 * The name path REUSES an existing topic with the same name
 * (case-insensitive) — so several points routed to the same suggested/typed
 * "归类" land together instead of spawning name-duplicate roles
 * (og-…/-2/-3). Only when no same-name topic exists is a new one created
 * (plain, non-bindable). Returns null when nothing resolves a name.
 */
export function resolveOrCreateTopic(
  db: Database.Database,
  input: {
    targetRoleId?: string | null;
    suggestedRoleId?: string | null;
    newTopicName?: string | null;
    suggestedTopicName?: string | null;
    now: string;
    fallbackSeed: string;
  },
): string | null {
  const explicit = input.targetRoleId?.trim();
  if (explicit) return explicit;
  if (input.suggestedRoleId) return input.suggestedRoleId;

  const name = (input.newTopicName?.trim() || input.suggestedTopicName?.trim() || '');
  if (!name) return null;

  const existing = listRoles(db).find(
    (r) => r.name.trim().toLowerCase() === name.toLowerCase(),
  );
  if (existing) return existing.id;

  const base = topicIdFromName(name, `topic-${input.fallbackSeed.slice(0, 8)}`);
  let id = base;
  for (let n = 2; getRole(db, id); n += 1) {
    if (n > 99) { id = `topic-${input.fallbackSeed.slice(0, 8)}`; break; }
    id = `${base}-${n}`;
  }
  upsertRole(db, {
    id, name, systemPrompt: '', isBuiltin: false, bindable: false, createdAt: input.now,
  });
  return id;
}

/**
 * Insert a point unless an identical (session, text) one is already pending or
 * dismissed (the partial unique index). Returns true when inserted.
 */
export function insertChatKnowledgePoint(
  db: Database.Database,
  p: Omit<ChatKnowledgePoint, 'status' | 'createdAt'> & { createdAt: string },
): boolean {
  const res = db.prepare(`
    INSERT OR IGNORE INTO chat_knowledge_points
      (id, host_session_id, title, body, kind, suggested_role_id,
       suggested_topic_name, text_hash, status, created_at)
    VALUES (@id, @hostSessionId, @title, @body, @kind, @suggestedRoleId,
            @suggestedTopicName, @textHash, 'pending', @createdAt)
  `).run({
    id: p.id,
    hostSessionId: p.hostSessionId,
    title: p.title,
    body: p.body,
    kind: p.kind,
    suggestedRoleId: p.suggestedRoleId,
    suggestedTopicName: p.suggestedTopicName,
    textHash: textHash(`${p.title}\n${p.body}`),
    createdAt: p.createdAt,
  });
  return res.changes > 0;
}

export function listChatKnowledgePoints(
  db: Database.Database,
  hostSessionId: string,
  status: ChatKnowledgeStatus = 'pending',
): ChatKnowledgePoint[] {
  return (db.prepare(
    `SELECT * FROM chat_knowledge_points
       WHERE host_session_id = ? AND status = ?
       ORDER BY created_at ASC`,
  ).all(hostSessionId, status) as Record<string, unknown>[]).map(rowToPoint);
}

export function getChatKnowledgePoint(
  db: Database.Database,
  id: string,
): ChatKnowledgePoint | undefined {
  const r = db.prepare(`SELECT * FROM chat_knowledge_points WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return r ? rowToPoint(r) : undefined;
}

export function setChatKnowledgePointStatus(
  db: Database.Database,
  id: string,
  status: ChatKnowledgeStatus,
  decidedAt: string,
): void {
  db.prepare(
    `UPDATE chat_knowledge_points SET status = ?, decided_at = ? WHERE id = ?`,
  ).run(status, decidedAt, id);
}

// ── extraction throttle marker (host_sessions.last_extracted_agent_chars) ───
// We gate on accumulated ASSISTANT output chars, not turn count — that's the
// best proxy for "how much new extractable knowledge appeared" (knowledge
// lives in agent answers, not in the user's short prompts or raw turn count).

export function getLastExtractedAgentChars(db: Database.Database, hostSessionId: string): number {
  const r = db.prepare(
    `SELECT last_extracted_agent_chars AS n FROM host_sessions WHERE id = ?`,
  ).get(hostSessionId) as { n: number } | undefined;
  return r?.n ?? 0;
}

export function setLastExtractedAgentChars(
  db: Database.Database,
  hostSessionId: string,
  chars: number,
): void {
  db.prepare(`UPDATE host_sessions SET last_extracted_agent_chars = ? WHERE id = ?`)
    .run(chars, hostSessionId);
}
