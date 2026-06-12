/**
 * Entity-bucket capture (knowledge tiers PR-α).
 *
 * Until now capture only ran for chats BOUND to a role — a conversation
 * mentioning "og 的一小部分知识" with no role bound produced nothing,
 * and the only alternative was spawning a whole role for one fragment.
 *
 * This module captures from UNBOUND chats into entity buckets: when the
 * agent's response mentions an entity helm doesn't know yet (no role's
 * entity index covers it) often enough, the containing segments become
 * candidates targeted at a namespace collection named after the entity
 * (e.g. bucket id `og`). On accept, the existing pipeline takes over
 * unchanged — the chunk lands in the bucket and (when a wiki repo +
 * username are configured) materializes as
 * `chat-captured/<user>/og/<slug>.md`, the personal-tier layout from
 * the knowledge-tiers design.
 *
 * Buckets ARE rows in `roles` (empty prompt) so the candidates FK, the
 * accept path and the captured-file layout all reuse the role plumbing;
 * PR-δ's `bindable` flag will keep them out of the chat-binding UI.
 */

import type Database from 'better-sqlite3';
import { splitAgentResponse, kindFromSegment } from './splitter.js';
import { writeCandidateIfNew } from './candidate-writer.js';
import { extractEntities } from '../roles/entity-extract.js';
import { STOP_ENTITIES } from '../knowledge/chat-unknown-entities.js';
import { getRole, upsertRole } from '../storage/repos/roles.js';
import type { CaptureSweepResult } from './index.js';

export interface EntityBucketCaptureInput {
  db: Database.Database;
  hostSessionId: string;
  responseText: string;
  /** Min case-insensitive mentions in the response. Default 2. */
  minMentions?: number;
  /** Max distinct buckets per response. Default 3 (most-mentioned win). */
  maxBuckets?: number;
  /** Max candidates per bucket per response. Default 2. */
  maxPerBucket?: number;
}

const DEFAULT_MIN_MENTIONS = 2;
const DEFAULT_MAX_BUCKETS = 3;
const DEFAULT_MAX_PER_BUCKET = 2;

/**
 * extractEntities' acronym tier requires 3+ caps, but real fragment
 * topics are often 2-char ('OG'). Supplement with 2-char all-caps
 * tokens at a HIGHER mention bar (handled by caller) and a stoplist of
 * English/UI noise that happens to be 2 uppercase letters.
 */
const TWO_CHAR_STOP: ReadonlySet<string> = new Set([
  'an', 'as', 'at', 'be', 'by', 'do', 'go', 'he', 'if', 'in', 'is', 'it',
  'me', 'my', 'no', 'of', 'ok', 'on', 'or', 'so', 'to', 'up', 'us', 'we',
  'id', 'ui', 'ux', 'ip', 'io',
]);
const TWO_CHAR_ACRONYM_RE = /\b[A-Z]{2}\d{0,2}\b/g;
/** 2-char tokens need to be clearly recurring, not incidental. */
const TWO_CHAR_MIN_MENTIONS = 3;

/** Entity → bucket id: lowercase kebab, no leading/trailing dashes. */
export function entityBucketId(entity: string): string {
  return entity
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function countMentions(text: string, entity: string): number {
  const escaped = entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Word boundaries only make sense for word-like entities; URLs and
  // filenames match verbatim.
  const pattern = /^[A-Za-z0-9]+$/.test(entity) ? `\\b${escaped}\\b` : escaped;
  return (text.match(new RegExp(pattern, 'gi')) ?? []).length;
}

/**
 * Capture sweep for unbound chats. Returns the same result shape as
 * `captureFromAgentResponse` (bucket ids in `byRole`) so the
 * orchestrator's event emission + logging work unchanged.
 */
export function captureToEntityBuckets(
  input: EntityBucketCaptureInput,
): CaptureSweepResult {
  const { db, hostSessionId, responseText } = input;
  const minMentions = input.minMentions ?? DEFAULT_MIN_MENTIONS;
  const maxBuckets = input.maxBuckets ?? DEFAULT_MAX_BUCKETS;
  const maxPerBucket = input.maxPerBucket ?? DEFAULT_MAX_PER_BUCKET;
  const now = new Date().toISOString();
  const inserted: CaptureSweepResult['inserted'] = [];
  const byRole: CaptureSweepResult['byRole'] = [];

  const segments = splitAgentResponse(responseText);
  if (segments.length === 0) {
    return { segments: 0, candidatesCreated: 0, byRole, inserted };
  }

  // Entity universe of the response, minus UI noise. extractEntities
  // dedups internally; the filename arg only feeds Tier-5 context.
  const standard = extractEntities(responseText, 'agent-response')
    .map((e) => ({ entity: e.entity, minMentions }));
  // 2-char acronym supplement ('OG') at a stricter mention bar.
  const twoChar = [...new Set(responseText.match(TWO_CHAR_ACRONYM_RE) ?? [])]
    .filter((e) => !TWO_CHAR_STOP.has(e.toLowerCase()))
    .map((e) => ({ entity: e, minMentions: Math.max(minMentions, TWO_CHAR_MIN_MENTIONS) }));
  const seen = new Set(standard.map((e) => e.entity.toLowerCase()));
  const entities = [
    ...standard,
    ...twoChar.filter((e) => !seen.has(e.entity.toLowerCase())),
  ].filter((e) => !STOP_ENTITIES.has(e.entity.toLowerCase()));

  const knownStmt = db.prepare(
    `SELECT 1 FROM knowledge_chunk_entities WHERE entity = ? LIMIT 1`,
  );
  const qualifying: Array<{ entity: string; bucketId: string; mentions: number }> = [];
  for (const { entity, minMentions: bar } of entities) {
    const bucketId = entityBucketId(entity);
    if (!bucketId) continue;
    // Entities some role already knows belong to that role's flow — an
    // unbound chat shouldn't fork a parallel bucket for them. Mirrors
    // the PR-C "unknown entity" definition.
    if (knownStmt.get(entity)) continue;
    const mentions = countMentions(responseText, entity);
    if (mentions < bar) continue;
    qualifying.push({ entity, bucketId, mentions });
  }
  qualifying.sort((a, b) => b.mentions - a.mentions);
  const picked = qualifying.slice(0, maxBuckets);

  for (const { entity, bucketId, mentions } of picked) {
    // Lazily materialize the namespace collection. Never clobber an
    // existing role (same preserve rule as the importer).
    if (!getRole(db, bucketId)) {
      upsertRole(db, {
        id: bucketId,
        name: entity,
        systemPrompt: '',
        isBuiltin: false,
        bindable: false, // PR-δ: buckets are Collections, not Experts
        createdAt: now,
      });
    }
    let insertedCount = 0;
    let qualified = 0;
    for (const seg of segments) {
      if (insertedCount >= maxPerBucket) break;
      if (countMentions(seg.text, entity) === 0) continue;
      qualified += 1;
      const result = writeCandidateIfNew(db, {
        roleId: bucketId,
        hostSessionId,
        chunkText: seg.text,
        sourceSegmentIndex: seg.index,
        kind: kindFromSegment(seg.kind),
        scoreEntity: mentions,
        scoreCosine: 0,
        createdAt: now,
      });
      if (result.inserted) {
        insertedCount += 1;
        inserted.push(result.candidate);
      }
    }
    byRole.push({
      roleId: bucketId,
      inserted: insertedCount,
      qualified,
      scanned: segments.length,
    });
  }

  return {
    segments: segments.length,
    candidatesCreated: inserted.length,
    byRole,
    inserted,
  };
}
