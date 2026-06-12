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
import { extractEntities, KNOWN_HELM_ENTITIES } from '../roles/entity-extract.js';
import { listHostEvents } from '../storage/repos/host-event-log.js';

/** Default thresholds. */
const DEFAULT_MIN_MENTIONS = 3;
const DEFAULT_MIN_DISTINCT = 1;
const DEFAULT_TOP_N = 8;
const DEFAULT_EVENT_LIMIT = 200;

/**
 * Entities that must NEVER drive a "create a role for this?" prompt.
 * Live dogfooding produced suggestions like `PR ×72 / CI ×21 /
 * KNOWLEDGE ×15 / OUT ×13` — generic dev vocabulary and helm's own UI
 * labels, not domain concepts. Three buckets:
 *
 *   1. The extractEntities whitelist (PR / CI / MR / API …) — those are
 *      deliberately indexed as retrieval anchors, but they appear in
 *      EVERY coding chat, so as "unknown entity" signals they're pure
 *      noise.
 *   2. Generic format / protocol / tooling tokens that pass the 3-caps
 *      regex but describe the medium, not the domain (JSON, HTML, …).
 *   3. Ordinary English words that show up ALL-CAPS in UI copy and
 *      headings (OUT, NEW, KNOWLEDGE, TIMELINE, …) — chats about helm
 *      itself kept resurfacing helm's own section labels.
 */
export const STOP_ENTITIES: ReadonlySet<string> = new Set([
  ...KNOWN_HELM_ENTITIES.map((e) => e.toLowerCase()),
  // bucket 2 — formats / protocols / file types
  'json', 'html', 'htm', 'http', 'https', 'url', 'uri', 'xml', 'yaml',
  'toml', 'csv', 'pdf', 'png', 'jpg', 'jpeg', 'svg', 'gif', 'css',
  'tsx', 'jsx', 'utf', 'ascii', 'uuid', 'guid',
  // bucket 3 — caps-cased English words from UI copy / headings
  'out', 'new', 'all', 'get', 'set', 'put', 'post', 'delete', 'add',
  'use', 'run', 'end', 'top', 'max', 'min', 'yes', 'not', 'and', 'the',
  'for', 'with', 'this', 'that', 'note', 'todo', 'readme', 'warning',
  'error', 'info', 'debug', 'knowledge', 'timeline', 'turn', 'turns',
  'helm',
]);

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

  // Fold URL-ish duplicates into their bare form: `github.com` merges
  // into `github` when both were extracted, so the user doesn't see two
  // chips for the same thing.
  for (const key of Array.from(counts.keys())) {
    const dot = key.indexOf('.');
    if (dot <= 0) continue;
    const bare = key.slice(0, dot);
    const bareEntry = counts.get(bare);
    const dotted = counts.get(key);
    if (bareEntry && dotted) {
      bareEntry.mentions += dotted.mentions;
      counts.delete(key);
    }
  }

  // Apply stoplist + thresholds + sort. Digits-only tokens (PR / issue
  // numbers like "152" surfaced by the URL last-segment tier) are never
  // knowledge entities.
  const unknowns = Array.from(counts.values())
    .filter((c) => !/^\d+$/.test(c.entity))
    .filter((c) => !STOP_ENTITIES.has(c.entity.toLowerCase()))
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
