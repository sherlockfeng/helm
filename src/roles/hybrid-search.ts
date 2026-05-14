/**
 * Multipath retrieval with RRF fusion (Phase 76).
 *
 * Three parallel retrieval legs:
 *   1. BM25 over `knowledge_chunks_fts` (FTS5 virtual table) — token-level
 *      lexical recall, good for named entities and explicit terms.
 *   2. Cosine over the existing embedding column — semantic recall, good
 *      for paraphrases and conceptual queries.
 *   3. Entity match — exact-string hits on rule-extracted entities
 *      (acronyms / camelCase / URLs / filenames). Cheap precision boost
 *      when the query mentions a specific named thing.
 *
 * Each leg returns its own top-K * 2 candidates with a per-leg score. We
 * combine via Reciprocal Rank Fusion (Cormack et al., 2009):
 *
 *     RRF(d) = Σ_leg  w_leg / (K + rank_leg(d))
 *
 * where K=60 is the standard constant (agentmemory uses the same; not
 * worth tuning until benchmark dictates otherwise) and `w_leg` are the
 * default weights below. When a leg returns nothing (its rank list is
 * empty), its weight is dropped and the survivors renormalize to sum=1
 * so a single-leg degenerate case still gets sensible scores.
 *
 * After fusion we diversify by `source_id` (max 3 hits per source) so a
 * single dominant source can't crowd out smaller ones.
 */

import type Database from 'better-sqlite3';
import {
  getChunksForRole,
  searchChunksByBm25,
  searchChunksByEntity,
} from '../storage/repos/roles.js';
import type {
  KnowledgeChunk,
  KnowledgeChunkKind,
} from '../storage/types.js';
import { extractEntitiesFromQuery } from './entity-extract.js';
import { cosineSimilarity } from './library-math.js';

/** Standard RRF constant. Adjust only with benchmark evidence. */
export const RRF_K = 60;

/**
 * Default per-leg weights. agentmemory's values, replayed here as the
 * starting point. Sum doesn't need to be 1 — RRF only cares about
 * relative magnitudes, but values within [0, 1] keep the head-room
 * obvious. drop-then-renormalize logic uses these absolute values.
 */
export interface RrfWeights { bm25: number; cosine: number; entity: number }
export const DEFAULT_RRF_WEIGHTS: RrfWeights = { bm25: 0.4, cosine: 0.6, entity: 0.3 };

/** Per-source cap during diversification. agentmemory uses 3 per session. */
export const MAX_HITS_PER_SOURCE = 3;

export type SearchStrategy = 'fusion' | 'bm25' | 'cosine' | 'entity';

export interface HybridSearchHit {
  chunkText: string;
  kind: KnowledgeChunkKind;
  sourceFile?: string;
  sourceId?: string;
  /** Final fused score (or single-leg score when strategy ≠ fusion). */
  score: number;
  /** Per-leg raw scores for debugging / introspection. */
  bm25Score?: number;
  cosineScore?: number;
  entityScore?: number;
  /**
   * Which legs actually contributed a rank for this chunk. Empty array
   * shouldn't happen in fusion mode (a chunk with no leg ranks wouldn't
   * be in the candidate set), but the field is here for the debug
   * surface.
   */
  contributingLegs: Array<'bm25' | 'cosine' | 'entity'>;
}

export interface HybridSearchInput {
  db: Database.Database;
  roleId: string;
  query: string;
  embedFn: (text: string) => Promise<Float32Array>;
  topK: number;
  /** Phase 73 kind pre-filter. Applied to all legs before scoring. */
  kind?: KnowledgeChunkKind;
  /** Override default weights — used by benchmark + tests. */
  weights?: RrfWeights;
  /**
   * Override RRF_K — defaults to module constant. Exposed so tests can
   * verify the formula with smaller K values for clarity.
   */
  rrfK?: number;
}

/**
 * Top-level dispatch. Strategy router for `searchKnowledge`.
 */
export async function hybridSearch(
  input: HybridSearchInput & { strategy: SearchStrategy },
): Promise<HybridSearchHit[]> {
  switch (input.strategy) {
    case 'fusion':  return runFusion(input);
    case 'bm25':    return runBm25Only(input);
    case 'cosine':  return runCosineOnly(input);
    case 'entity':  return runEntityOnly(input);
    default: {
      // Exhaustiveness — TS will complain on a new strategy.
      const _exhaustive: never = input.strategy;
      throw new Error(`hybridSearch: unknown strategy ${_exhaustive as string}`);
    }
  }
}

// ── Fusion path ──────────────────────────────────────────────────────────

async function runFusion(input: HybridSearchInput): Promise<HybridSearchHit[]> {
  const { db, roleId, query, embedFn, topK, kind } = input;
  const weights = input.weights ?? DEFAULT_RRF_WEIGHTS;
  const k = input.rrfK ?? RRF_K;
  // Each leg fetches more candidates than `topK` so RRF has overlap to
  // work with. agentmemory uses 2x; for small role corpora (< 200 chunks
  // typical) that's already most of the table — cheap.
  const candidateDepth = Math.max(topK * 2, 20);

  // -- Leg 1: BM25 ----------------------------------------------------
  const bm25Raw = searchChunksByBm25(db, roleId, query, candidateDepth);
  const bm25Ranks = ranksFromOrderedList(bm25Raw.map((r) => r.chunkId));

  // -- Leg 2: Cosine --------------------------------------------------
  // For cosine we still need to load the chunks (we need the embedding
  // blob). Apply kind filter at the SQL layer to avoid loading the
  // whole table when only a slice is searchable.
  const chunks = getChunksForRole(db, roleId, kind ? { kind } : {});
  const queryVec = chunks.length > 0 ? await embedFn(query) : null;
  const cosineRanked: Array<{ chunkId: string; score: number }> = [];
  if (queryVec) {
    for (const c of chunks) {
      if (!c.embedding) continue;
      cosineRanked.push({ chunkId: c.id, score: cosineSimilarity(queryVec, c.embedding) });
    }
    cosineRanked.sort((a, b) => b.score - a.score);
  }
  const cosineTop = cosineRanked.slice(0, candidateDepth);
  const cosineRanks = ranksFromOrderedList(cosineTop.map((r) => r.chunkId));

  // -- Leg 3: Entity --------------------------------------------------
  const queryEntities = extractEntitiesFromQuery(query);
  const entityRaw = searchChunksByEntity(db, roleId, queryEntities, candidateDepth);
  const entityRanks = ranksFromOrderedList(entityRaw.map((r) => r.chunkId));

  // -- Effective weights — drop empty legs and renormalize -----------
  const effective = computeEffectiveWeights(weights, {
    bm25: bm25Raw.length > 0,
    cosine: cosineTop.length > 0,
    entity: entityRaw.length > 0,
  });

  // No leg returned anything — query has no signal at all.
  if (effective.bm25 === 0 && effective.cosine === 0 && effective.entity === 0) {
    return [];
  }

  // -- Score every chunk that appeared in at least one leg -----------
  const allChunkIds = new Set<string>([
    ...bm25Ranks.keys(),
    ...cosineRanks.keys(),
    ...entityRanks.keys(),
  ]);

  const bm25Scores = new Map(bm25Raw.map((r) => [r.chunkId, r.score]));
  const cosineScores = new Map(cosineTop.map((r) => [r.chunkId, r.score]));
  const entityScores = new Map(entityRaw.map((r) => [r.chunkId, r.score]));

  // Pre-fetch chunks we'll need to enrich into hits. Single bulk read
  // beats N round-trips through the repo.
  const chunkById = new Map<string, KnowledgeChunk>();
  // If we already loaded chunks for cosine, reuse that pass.
  if (chunks.length > 0) {
    for (const c of chunks) chunkById.set(c.id, c);
  }
  // Pull any chunks the BM25 / entity legs surfaced that weren't in the
  // cosine pool (post-kind-filter divergence is the realistic case).
  const missingIds = Array.from(allChunkIds).filter((id) => !chunkById.has(id));
  if (missingIds.length > 0) {
    // We don't have a getChunkById bulk repo function; fall back to
    // loading the role's chunks again WITHOUT the kind filter. That's a
    // small over-read but keeps the surface area minimal for v1.
    const allForRole = getChunksForRole(db, roleId);
    for (const c of allForRole) {
      if (missingIds.includes(c.id)) chunkById.set(c.id, c);
    }
  }

  const fused: Array<{ chunkId: string; fusedScore: number; hit: HybridSearchHit }> = [];
  for (const chunkId of allChunkIds) {
    const chunk = chunkById.get(chunkId);
    if (!chunk) continue; // shouldn't happen — BM25 / entity surfaced an id that doesn't exist
    // When kind filter is in effect, drop hits whose chunk has a
    // different kind (the BM25 / entity legs don't see the kind filter
    // because they query other tables).
    if (kind && chunk.kind !== kind) continue;

    const rBm25 = bm25Ranks.get(chunkId);
    const rCos  = cosineRanks.get(chunkId);
    const rEnt  = entityRanks.get(chunkId);

    const fusedScore =
      (rBm25 != null ? effective.bm25 / (k + rBm25) : 0) +
      (rCos  != null ? effective.cosine / (k + rCos)  : 0) +
      (rEnt  != null ? effective.entity / (k + rEnt)  : 0);

    const contributing: Array<'bm25' | 'cosine' | 'entity'> = [];
    if (rBm25 != null) contributing.push('bm25');
    if (rCos  != null) contributing.push('cosine');
    if (rEnt  != null) contributing.push('entity');

    const hit: HybridSearchHit = {
      chunkText: chunk.chunkText,
      kind: chunk.kind,
      score: fusedScore,
      contributingLegs: contributing,
    };
    if (chunk.sourceFile !== undefined) hit.sourceFile = chunk.sourceFile;
    if (chunk.sourceId !== undefined) hit.sourceId = chunk.sourceId;
    const bm25Raw_ = bm25Scores.get(chunkId);
    const cosineRaw_ = cosineScores.get(chunkId);
    const entityRaw_ = entityScores.get(chunkId);
    if (bm25Raw_ !== undefined) hit.bm25Score = bm25Raw_;
    if (cosineRaw_ !== undefined) hit.cosineScore = cosineRaw_;
    if (entityRaw_ !== undefined) hit.entityScore = entityRaw_;

    fused.push({ chunkId, fusedScore, hit });
  }

  fused.sort((a, b) => b.fusedScore - a.fusedScore);
  return diversifyBySource(fused.map((f) => f.hit), topK);
}

// ── Single-leg fallbacks (debug / benchmark) ────────────────────────────

async function runBm25Only(input: HybridSearchInput): Promise<HybridSearchHit[]> {
  const { db, roleId, query, topK, kind } = input;
  const raw = searchChunksByBm25(db, roleId, query, topK * 2);
  const chunkById = new Map(getChunksForRole(db, roleId).map((c) => [c.id, c]));
  const hits: HybridSearchHit[] = [];
  for (const r of raw) {
    const chunk = chunkById.get(r.chunkId);
    if (!chunk) continue;
    if (kind && chunk.kind !== kind) continue;
    const hit: HybridSearchHit = {
      chunkText: chunk.chunkText,
      kind: chunk.kind,
      score: r.score,
      bm25Score: r.score,
      contributingLegs: ['bm25'],
    };
    if (chunk.sourceFile !== undefined) hit.sourceFile = chunk.sourceFile;
    if (chunk.sourceId !== undefined) hit.sourceId = chunk.sourceId;
    hits.push(hit);
  }
  return diversifyBySource(hits, topK);
}

async function runCosineOnly(input: HybridSearchInput): Promise<HybridSearchHit[]> {
  const { db, roleId, query, embedFn, topK, kind } = input;
  const chunks = getChunksForRole(db, roleId, kind ? { kind } : {});
  if (chunks.length === 0) return [];
  const queryVec = await embedFn(query);
  const scored = chunks
    .filter((c) => c.embedding != null)
    .map((c) => ({ chunk: c, score: cosineSimilarity(queryVec, c.embedding!) }))
    .sort((a, b) => b.score - a.score);
  const hits: HybridSearchHit[] = scored.map(({ chunk, score }) => {
    const h: HybridSearchHit = {
      chunkText: chunk.chunkText,
      kind: chunk.kind,
      score,
      cosineScore: score,
      contributingLegs: ['cosine'],
    };
    if (chunk.sourceFile !== undefined) h.sourceFile = chunk.sourceFile;
    if (chunk.sourceId !== undefined) h.sourceId = chunk.sourceId;
    return h;
  });
  return diversifyBySource(hits, topK);
}

async function runEntityOnly(input: HybridSearchInput): Promise<HybridSearchHit[]> {
  const { db, roleId, query, topK, kind } = input;
  const entities = extractEntitiesFromQuery(query);
  const raw = searchChunksByEntity(db, roleId, entities, topK * 2);
  const chunkById = new Map(getChunksForRole(db, roleId).map((c) => [c.id, c]));
  const hits: HybridSearchHit[] = [];
  for (const r of raw) {
    const chunk = chunkById.get(r.chunkId);
    if (!chunk) continue;
    if (kind && chunk.kind !== kind) continue;
    const hit: HybridSearchHit = {
      chunkText: chunk.chunkText,
      kind: chunk.kind,
      score: r.score,
      entityScore: r.score,
      contributingLegs: ['entity'],
    };
    if (chunk.sourceFile !== undefined) hit.sourceFile = chunk.sourceFile;
    if (chunk.sourceId !== undefined) hit.sourceId = chunk.sourceId;
    hits.push(hit);
  }
  return diversifyBySource(hits, topK);
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Turn an ordered list of chunk ids into a `Map<id, rank>` where rank is
 * 1-based. Lower rank = better. The 1-based offset matters: RRF's
 * `1/(K + rank)` makes rank=1 distinctly better than rank=2, but
 * 1/(60+0)=0.0167 vs 1/(60+1)=0.0164 — fine either way; we use 1-based
 * to match agentmemory + the original paper.
 */
function ranksFromOrderedList(orderedIds: string[]): Map<string, number> {
  const ranks = new Map<string, number>();
  for (let i = 0; i < orderedIds.length; i++) {
    ranks.set(orderedIds[i]!, i + 1);
  }
  return ranks;
}

/**
 * Drop-then-renormalize. When a leg returned zero hits, its weight is
 * removed from the sum so the remaining legs cover the full
 * "probability mass". An all-empty input returns all-zero weights.
 */
export function computeEffectiveWeights(
  base: RrfWeights,
  hasResults: { bm25: boolean; cosine: boolean; entity: boolean },
): RrfWeights {
  const w = {
    bm25:   hasResults.bm25   ? base.bm25   : 0,
    cosine: hasResults.cosine ? base.cosine : 0,
    entity: hasResults.entity ? base.entity : 0,
  };
  const total = w.bm25 + w.cosine + w.entity;
  if (total === 0) return w;
  return { bm25: w.bm25 / total, cosine: w.cosine / total, entity: w.entity / total };
}

/**
 * Take a sorted hit list and trim it to `limit` hits, capping any single
 * `sourceId` at MAX_HITS_PER_SOURCE. Hits with no sourceId are treated
 * as belonging to a single virtual "(no source)" bucket — same cap
 * applies. Order within the source bucket is preserved.
 *
 * If after capping we still have fewer than `limit` hits AND there are
 * unselected hits left, we top up by appending unselected hits in their
 * original order (so a small corpus where every chunk is from one source
 * still returns `limit` results).
 */
function diversifyBySource(sorted: HybridSearchHit[], limit: number): HybridSearchHit[] {
  const out: HybridSearchHit[] = [];
  const counts = new Map<string, number>();
  for (const h of sorted) {
    const key = h.sourceId ?? '__no_source__';
    const c = counts.get(key) ?? 0;
    if (c >= MAX_HITS_PER_SOURCE) continue;
    out.push(h);
    counts.set(key, c + 1);
    if (out.length >= limit) return out;
  }
  // Top-up pass — only when no source diversification could fill `limit`.
  if (out.length < limit) {
    const seen = new Set(out);
    for (const h of sorted) {
      if (seen.has(h)) continue;
      out.push(h);
      if (out.length >= limit) break;
    }
  }
  return out;
}
