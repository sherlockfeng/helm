/**
 * Chat × Role suggester (KNOWLEDGE OUT — discovery layer).
 *
 * Walk a chat's user prompts + assistant responses, extract entities,
 * cross-reference against the per-role entity index, and return any role
 * whose entities show up enough times to be worth a "this chat is about
 * X, want to extract knowledge for Y 专家?" suggestion.
 *
 * Pure SQL — no LLM. Cheap enough to run on every conversation-detail
 * fetch. The LLM-driven curation pass (update vs new) sits one layer up.
 */

import type Database from 'better-sqlite3';
import { extractEntities } from '../roles/entity-extract.js';
import { listHostEvents } from '../storage/repos/host-event-log.js';

/**
 * Default thresholds. A role is suggested when the chat mentions ≥
 * `minDistinctEntities` of the role's entities at least `minTotalHits`
 * times total. Tuned to suppress single-mention coincidences while still
 * catching short chats that touch one entity heavily.
 */
const DEFAULT_MIN_DISTINCT = 2;
const DEFAULT_MIN_TOTAL = 3;
const DEFAULT_EVENT_LIMIT = 200;

export interface RoleSuggestion {
  roleId: string;
  roleName: string;
  /** Entities the chat mentions that are also part of this role's index. */
  hitEntities: string[];
  /** Total mention count across hitEntities (sum of per-entity occurrences). */
  totalHits: number;
  /** Whether this role is currently bound to the chat (filters out
   *  redundant suggestions for the renderer). */
  isBound: boolean;
}

export interface SuggestRolesOptions {
  minDistinctEntities?: number;
  minTotalHits?: number;
  eventLimit?: number;
}

/**
 * Returns role suggestions for a chat, sorted by relevance (distinct
 * entity count desc, then total hits desc). Empty array when the chat
 * has no events or no role-entity overlap above the thresholds.
 */
export function suggestRolesForChat(
  db: Database.Database,
  hostSessionId: string,
  opts: SuggestRolesOptions = {},
): RoleSuggestion[] {
  const minDistinct = opts.minDistinctEntities ?? DEFAULT_MIN_DISTINCT;
  const minTotal = opts.minTotalHits ?? DEFAULT_MIN_TOTAL;
  const limit = opts.eventLimit ?? DEFAULT_EVENT_LIMIT;

  const events = listHostEvents(db, hostSessionId, { limit });
  if (events.length === 0) return [];

  // Combine all human-readable text from the chat — both user prompts
  // and assistant responses contribute to the entity vocabulary the user
  // might want to capture.
  const chunks: string[] = [];
  for (const ev of events) {
    if (ev.kind !== 'prompt' && ev.kind !== 'response') continue;
    const text = typeof ev.payload['text'] === 'string'
      ? (ev.payload['text'] as string)
      : '';
    if (text) chunks.push(text);
  }
  if (chunks.length === 0) return [];

  // Per-entity occurrence count across all chat text. We count the raw
  // case-insensitive token frequency, not extractEntities() output count
  // (that one dedups per call).
  const mentionCounts = countMentions(chunks);
  if (mentionCounts.size === 0) return [];

  // Join the chat-mentioned entities against the per-role entity index.
  // SQLite-side aggregation keeps this one round-trip even for chats
  // mentioning hundreds of distinct entities.
  const lowerEntities = Array.from(mentionCounts.keys());
  const placeholders = lowerEntities.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT
      r.id          AS role_id,
      r.name        AS role_name,
      LOWER(kce.entity) AS entity_lower,
      kce.entity        AS entity_raw
    FROM knowledge_chunk_entities kce
    JOIN roles r ON r.id = kce.role_id
    WHERE LOWER(kce.entity) IN (${placeholders})
    GROUP BY r.id, LOWER(kce.entity)
  `).all(...lowerEntities) as Array<{
    role_id: string;
    role_name: string;
    entity_lower: string;
    entity_raw: string;
  }>;

  // Aggregate: per role, distinct entities hit + sum of chat mention
  // counts for those entities.
  const byRole = new Map<string, RoleSuggestion>();
  for (const r of rows) {
    const mentions = mentionCounts.get(r.entity_lower) ?? 0;
    const existing = byRole.get(r.role_id);
    if (existing) {
      if (!existing.hitEntities.includes(r.entity_raw)) {
        existing.hitEntities.push(r.entity_raw);
        existing.totalHits += mentions;
      }
    } else {
      byRole.set(r.role_id, {
        roleId: r.role_id,
        roleName: r.role_name,
        hitEntities: [r.entity_raw],
        totalHits: mentions,
        isBound: false, // filled below
      });
    }
  }

  // Mark which suggested roles are already bound to this chat so the
  // renderer can demote them ("knowledge is already flowing in this
  // direction") rather than suppress.
  const boundIds = new Set(
    (db.prepare(`SELECT role_id FROM host_session_roles WHERE host_session_id = ?`)
      .all(hostSessionId) as Array<{ role_id: string }>)
      .map((r) => r.role_id),
  );
  for (const s of byRole.values()) s.isBound = boundIds.has(s.roleId);

  // Apply thresholds + sort.
  return Array.from(byRole.values())
    .filter((s) => s.hitEntities.length >= minDistinct && s.totalHits >= minTotal)
    .sort((a, b) => {
      if (b.hitEntities.length !== a.hitEntities.length) {
        return b.hitEntities.length - a.hitEntities.length;
      }
      return b.totalHits - a.totalHits;
    });
}

/**
 * Build a map of entity → mention count from the chat's text chunks.
 * Uses the same extractEntities() the capture pipeline uses (so the
 * extracted tokens match what roles' entity indexes contain), but
 * counts raw occurrences in the source text so a popular entity
 * outweighs a one-off match. Case-insensitive keys to match the
 * `knowledge_chunk_entities` query above.
 */
function countMentions(chunks: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const text of chunks) {
    const extracted = extractEntities(text);
    for (const e of extracted) {
      const lower = e.entity.toLowerCase();
      // Count actual occurrences in this chunk (not just presence) so
      // a chat that mentions "TCE" 5 times outweighs one that mentions
      // it once. Simple substring count — accurate enough for ranking.
      const occurrences = countOccurrences(text, e.entity);
      counts.set(lower, (counts.get(lower) ?? 0) + Math.max(1, occurrences));
    }
  }
  return counts;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  const hay = haystack.toLowerCase();
  const ned = needle.toLowerCase();
  let idx = 0;
  while ((idx = hay.indexOf(ned, idx)) !== -1) {
    count += 1;
    idx += ned.length;
  }
  return count;
}
