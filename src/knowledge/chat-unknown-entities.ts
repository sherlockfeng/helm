/**
 * Unknown-entity detection (Path B — "this chat is about something
 * helm has no role for, want to create one?").
 *
 * The role-suggester (PR-A) finds matches between chat entities and
 * existing role indexes. This detector is its complement: it surfaces
 * entities that recur in the chat but NO role's index covers, so the
 * developer can promote them to a new role's seed knowledge instead
 * of being silently dropped.
 *
 * Pure SQL — runs on every conversation-detail fetch alongside the
 * role suggester.
 */

import type Database from 'better-sqlite3';
import { extractEntities } from '../roles/entity-extract.js';
import { listHostEvents } from '../storage/repos/host-event-log.js';

/** Default thresholds. */
const DEFAULT_MIN_MENTIONS = 3;
const DEFAULT_MIN_DISTINCT = 1;
const DEFAULT_TOP_N = 8;
const DEFAULT_EVENT_LIMIT = 200;

export interface UnknownEntity {
  /** Surface form preserved from the chat — display this. */
  entity: string;
  /** Occurrence count across the chat's text. */
  mentions: number;
}

export interface UnknownEntitiesOptions {
  /** Threshold: an entity must show up at least this many times to qualify. */
  minMentions?: number;
  /** Threshold: drop entire result if fewer than this many distinct
   *  unknown entities clear minMentions. Avoids a 1-entity prompt. */
  minDistinct?: number;
  /** Cap on returned entities (sorted by mention count desc). */
  topN?: number;
  /** Cap on host_event_log scan. */
  eventLimit?: number;
}

/**
 * Returns unknown entities for one chat. Empty when nothing recurs, or
 * when too few distinct unknowns clear the threshold.
 */
export function unknownEntitiesForChat(
  db: Database.Database,
  hostSessionId: string,
  opts: UnknownEntitiesOptions = {},
): UnknownEntity[] {
  const minMentions = opts.minMentions ?? DEFAULT_MIN_MENTIONS;
  const minDistinct = opts.minDistinct ?? DEFAULT_MIN_DISTINCT;
  const topN = opts.topN ?? DEFAULT_TOP_N;
  const limit = opts.eventLimit ?? DEFAULT_EVENT_LIMIT;

  const events = listHostEvents(db, hostSessionId, { limit });
  if (events.length === 0) return [];

  const chunks: string[] = [];
  for (const ev of events) {
    if (ev.kind !== 'prompt' && ev.kind !== 'response') continue;
    const text = typeof ev.payload['text'] === 'string'
      ? (ev.payload['text'] as string)
      : '';
    if (text) chunks.push(text);
  }
  if (chunks.length === 0) return [];

  // entity → { surface form, mention count }
  const counts = new Map<string, { entity: string; mentions: number }>();
  for (const text of chunks) {
    for (const e of extractEntities(text)) {
      const key = e.entity.toLowerCase();
      const occurrences = Math.max(1, countOccurrences(text, e.entity));
      const existing = counts.get(key);
      if (existing) {
        existing.mentions += occurrences;
      } else {
        counts.set(key, { entity: e.entity, mentions: occurrences });
      }
    }
  }
  if (counts.size === 0) return [];

  // Which of the chat's entities are ALREADY covered by some role?
  const lowerEntities = Array.from(counts.keys());
  const placeholders = lowerEntities.map(() => '?').join(',');
  const knownRows = db.prepare(`
    SELECT DISTINCT LOWER(entity) AS entity_lower
      FROM knowledge_chunk_entities
     WHERE LOWER(entity) IN (${placeholders})
  `).all(...lowerEntities) as Array<{ entity_lower: string }>;
  const knownSet = new Set(knownRows.map((r) => r.entity_lower));

  // Apply thresholds + sort.
  const unknowns = Array.from(counts.values())
    .filter((c) => !knownSet.has(c.entity.toLowerCase()))
    .filter((c) => c.mentions >= minMentions)
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, topN);

  if (unknowns.length < minDistinct) return [];
  return unknowns;
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
