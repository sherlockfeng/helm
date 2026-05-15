/**
 * Capture scorer (Phase 78).
 *
 * Given one agent-response segment + one role's knowledge base, decides
 * whether the segment is a "candidate" — i.e. plausibly something we'd
 * want the user to consider adding to the role's chunks.
 *
 * Two parallel signals, OR'd (Decision §1):
 *
 *   1. **Entity overlap** — run the Phase 76 rule-based extractor over the
 *      segment, count how many of those entities exist in the role's
 *      `knowledge_chunk_entities` index. ≥ `minEntityOverlap` (default 2)
 *      qualifies. Cheap (SQL `IN` query); high precision when the agent
 *      uses domain jargon already known to the role.
 *
 *   2. **Cosine similarity** — embed the segment with the same embedder
 *      that trained the role; compute max cosine vs every non-archived
 *      chunk. ≥ `minCosine` (default 0.6) qualifies. Catches paraphrases
 *      the entity index misses.
 *
 * "OR'd" means either signal triggers; both scores are still computed +
 * returned so the UI can show "why this surfaced" and so we can back-test
 * thresholds later. If both signals fail, `qualifies: false` and the
 * orchestrator drops the segment without writing a candidate row.
 *
 * The scorer is a PURE function of (db state, segment text, role id) — no
 * side effects. The writer + orchestrator handle persistence.
 */

import type Database from 'better-sqlite3';
import { extractEntities } from '../roles/entity-extract.js';
import { cosineSimilarity } from '../roles/library-math.js';
import { getChunksForRole } from '../storage/repos/roles.js';

export interface CaptureThresholds {
  minEntityOverlap: number;
  minCosine: number;
}

/**
 * Decision §12: hard-coded for v1, lifted into helm Settings only if real
 * usage shows we need to retune frequently. Exported so tests can dial
 * them in either direction.
 */
export const DEFAULT_CAPTURE_THRESHOLDS: CaptureThresholds = {
  minEntityOverlap: 2,
  minCosine: 0.6,
};

export interface ScoreResult {
  scoreEntity: number;
  scoreCosine: number;
  qualifies: boolean;
}

export interface ScoreSegmentInput {
  db: Database.Database;
  roleId: string;
  segmentText: string;
  embedFn: (text: string) => Promise<Float32Array>;
  thresholds?: Partial<CaptureThresholds>;
}

/**
 * Score one segment against one role. Async because of `embedFn`. Both
 * sides of the OR run unconditionally — we want both scores in the row
 * even when only one triggers, so the UI can render an honest "entity=4,
 * cosine=0.31" badge.
 */
export async function scoreSegment(
  input: ScoreSegmentInput,
): Promise<ScoreResult> {
  const { db, roleId, segmentText, embedFn } = input;
  const thresholds = { ...DEFAULT_CAPTURE_THRESHOLDS, ...input.thresholds };

  // -- Entity overlap --------------------------------------------------
  // Dedup with a Set; bound at 64 so a giant code dump that confuses the
  // entity extractor can't blow up the IN-clause parameter count (SQLite
  // caps SQLITE_MAX_VARIABLE_NUMBER at 32k but we should not be anywhere
  // near that — 64 is plenty for any real segment).
  const allEntities = [...new Set(extractEntities(segmentText).map((e) => e.entity))];
  const segmentEntities = allEntities.slice(0, 64);
  let scoreEntity = 0;
  if (segmentEntities.length > 0) {
    // Ask the index directly which of `segmentEntities` exist for this
    // role. We run this unconditionally — there's no point gating on a
    // separate searchChunksByEntity call (its includeArchived default
    // would also disagree with the cosine leg, which deliberately
    // includes archived chunks for "this is a re-paraphrase of cold
    // knowledge" detection).
    //
    // DISTINCT entity gives us the intersection size — the number of
    // segment-entities that show up anywhere in the role's index,
    // regardless of how many chunks reference each.
    const placeholders = segmentEntities.map(() => 'LOWER(?)').join(',');
    const rows = db.prepare(`
      SELECT DISTINCT entity FROM knowledge_chunk_entities
      WHERE role_id = ? AND LOWER(entity) IN (${placeholders})
    `).all(roleId, ...segmentEntities.map((e) => e.toLowerCase())) as Array<{ entity: string }>;
    scoreEntity = rows.length;
  }

  // -- Cosine similarity ----------------------------------------------
  // We need the role's chunks with embeddings. Skip the kind / archived
  // filters intentionally — even archived chunks contribute to "is this
  // a paraphrase?". Including archived guards against the case where the
  // sweep just demoted the canonical version and the agent paraphrased
  // it back; that's still a known-knowledge match, not a candidate.
  const chunks = getChunksForRole(db, roleId, { includeArchived: true })
    .filter((c) => c.embedding != null);
  let scoreCosine = 0;
  if (chunks.length > 0) {
    const segmentVec = await embedFn(segmentText);
    for (const c of chunks) {
      const s = cosineSimilarity(segmentVec, c.embedding!);
      if (s > scoreCosine) scoreCosine = s;
    }
  }

  const qualifies =
    scoreEntity >= thresholds.minEntityOverlap ||
    scoreCosine >= thresholds.minCosine;

  return { scoreEntity, scoreCosine, qualifies };
}
