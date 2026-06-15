/**
 * Multipath retrieval with RRF fusion (Phase 76; cosine leg retired in
 * files-as-truth PR-4 — the embedding column only ever held
 * `makePseudoEmbedFn` bag-of-codepoints vectors with no semantic value,
 * so the leg added noise, not recall. Real semantic retrieval can come
 * back later as a derived index without touching the source of truth).
 *
 * Two parallel retrieval legs:
 *   1. BM25 over `knowledge_chunks_fts` (FTS5 virtual table) — token-level
 *      lexical recall, good for named entities and explicit terms.
 *   2. Entity match — exact-string hits on rule-extracted entities
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
  bumpChunkAccess,
  getChunksForRole,
  searchChunksByBm25,
  searchChunksByEntity,
} from '../storage/repos/roles.js';
import type {
  KnowledgeChunk,
  KnowledgeChunkKind,
} from '../storage/types.js';
import { extractEntitiesFromQuery } from './entity-extract.js';

/** Standard RRF constant. Adjust only with benchmark evidence. */
export const RRF_K = 60;

/**
 * Default per-leg weights. agentmemory's values, replayed here as the
 * starting point. Sum doesn't need to be 1 — RRF only cares about
 * relative magnitudes, but values within [0, 1] keep the head-room
 * obvious. drop-then-renormalize logic uses these absolute values.
 */
export interface RrfWeights { bm25: number; entity: number }
// PR-4: same relative magnitudes as before minus the retired cosine leg.
export const DEFAULT_RRF_WEIGHTS: RrfWeights = { bm25: 0.4, entity: 0.3 };

/** Per-source cap during diversification. agentmemory uses 3 per session. */
export const MAX_HITS_PER_SOURCE = 3;

export type SearchStrategy = 'fusion' | 'bm25' | 'entity';

export interface HybridSearchHit {
  /** Phase 77: id of the chunk row this hit came from. Used by the
   * post-search access-bump path; also useful for the renderer to point
   * an "unarchive" or "see source" action at a specific row. */
  chunkId: string;
  chunkText: string;
  kind: KnowledgeChunkKind;
  sourceFile?: string;
  sourceId?: string;
  /** Final fused score (or single-leg score when strategy ≠ fusion). */
  score: number;
  /** Per-leg raw scores for debugging / introspection. */
  bm25Score?: number;
  entityScore?: number;
  /**
   * Which legs actually contributed a rank for this chunk. Empty array
   * shouldn't happen in fusion mode (a chunk with no leg ranks wouldn't
   * be in the candidate set), but the field is here for the debug
   * surface.
   */
  contributingLegs: Array<'bm25' | 'entity'>;
}

export interface HybridSearchInput {
  db: Database.Database;
  roleId: string;
  query: string;
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
  /**
   * Phase 77: when true, archived chunks are included in every retrieval
   * leg AND skip the async access-bump after returning. Defaults to
   * false (live-corpus search). Search callers should leave this off —
   * the only legitimate `true` case is "agent has explicitly opted in via
   * `includeArchived: true` on the search_knowledge MCP tool".
   */
  includeArchived?: boolean;
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
  const { db, roleId, query, topK, kind } = input;
  const weights = input.weights ?? DEFAULT_RRF_WEIGHTS;
  const k = input.rrfK ?? RRF_K;
  const includeArchived = input.includeArchived ?? false;
  // Each leg fetches more candidates than `topK` so RRF has overlap to
  // work with. agentmemory uses 2x; for small role corpora (< 200 chunks
  // typical) that's already most of the table — cheap.
  const candidateDepth = Math.max(topK * 2, 20);

  // -- Leg 1: BM25 ----------------------------------------------------
  const bm25Raw = searchChunksByBm25(db, roleId, query, candidateDepth, { includeArchived });
  const bm25Ranks = ranksFromOrderedList(bm25Raw.map((r) => r.chunkId));

  // Chunk pool for hit enrichment (text / kind / source fields). The
  // cosine leg used to need this for embeddings; we still load it to
  // build hits without N point reads.
  const chunkOpts: Parameters<typeof getChunksForRole>[2] = { includeArchived };
  if (kind) chunkOpts.kind = kind;
  const chunks = getChunksForRole(db, roleId, chunkOpts);

  // -- Leg 2: Entity --------------------------------------------------
  const queryEntities = extractEntitiesFromQuery(query);
  const entityRaw = searchChunksByEntity(db, roleId, queryEntities, candidateDepth, { includeArchived });
  const entityRanks = ranksFromOrderedList(entityRaw.map((r) => r.chunkId));

  // -- Effective weights — drop empty legs and renormalize -----------
  const effective = computeEffectiveWeights(weights, {
    bm25: bm25Raw.length > 0,
    entity: entityRaw.length > 0,
  });

  // No leg returned anything — query has no signal at all.
  if (effective.bm25 === 0 && effective.entity === 0) {
    return [];
  }

  // -- Score every chunk that appeared in at least one leg -----------
  const allChunkIds = new Set<string>([
    ...bm25Ranks.keys(),
    ...entityRanks.keys(),
  ]);

  const bm25Scores = new Map(bm25Raw.map((r) => [r.chunkId, r.score]));
  const entityScores = new Map(entityRaw.map((r) => [r.chunkId, r.score]));

  // Pre-fetch chunks we'll need to enrich into hits. Single bulk read
  // beats N round-trips through the repo.
  const chunkById = new Map<string, KnowledgeChunk>();
  if (chunks.length > 0) {
    for (const c of chunks) chunkById.set(c.id, c);
  }
  // Pull any chunks the BM25 / entity legs surfaced that weren't in the
  // kind-filtered pool above.
  const missingIds = Array.from(allChunkIds).filter((id) => !chunkById.has(id));
  if (missingIds.length > 0) {
    // We don't have a getChunkById bulk repo function; fall back to
    // loading the role's chunks again WITHOUT the kind filter. That's a
    // small over-read but keeps the surface area minimal for v1.
    // Phase 77: preserve the includeArchived bit so we don't accidentally
    // skip archived chunks the BM25 leg surfaced under includeArchived=true.
    const allForRole = getChunksForRole(db, roleId, { includeArchived });
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
    const rEnt  = entityRanks.get(chunkId);

    const fusedScore =
      (rBm25 != null ? effective.bm25 / (k + rBm25) : 0) +
      (rEnt  != null ? effective.entity / (k + rEnt)  : 0);

    const contributing: Array<'bm25' | 'entity'> = [];
    if (rBm25 != null) contributing.push('bm25');
    if (rEnt  != null) contributing.push('entity');

    const hit: HybridSearchHit = {
      chunkId,
      chunkText: chunk.chunkText,
      kind: chunk.kind,
      score: fusedScore,
      contributingLegs: contributing,
    };
    if (chunk.sourceFile !== undefined) hit.sourceFile = chunk.sourceFile;
    if (chunk.sourceId !== undefined) hit.sourceId = chunk.sourceId;
    const bm25Raw_ = bm25Scores.get(chunkId);
    const entityRaw_ = entityScores.get(chunkId);
    if (bm25Raw_ !== undefined) hit.bm25Score = bm25Raw_;
    if (entityRaw_ !== undefined) hit.entityScore = entityRaw_;

    fused.push({ chunkId, fusedScore, hit });
  }

  fused.sort((a, b) => b.fusedScore - a.fusedScore);
  const diversified = diversifyBySource(fused.map((f) => f.hit), topK);
  // Phase 77: fire-and-forget access bump after we've decided what we're
  // returning. Skipped when includeArchived=true so the agent reviewing
  // archived content doesn't "rescue" cold chunks just by reading them.
  scheduleAccessBump(db, diversified, includeArchived);
  return diversified;
}

// ── Single-leg fallbacks (debug / benchmark) ────────────────────────────

async function runBm25Only(input: HybridSearchInput): Promise<HybridSearchHit[]> {
  const { db, roleId, query, topK, kind } = input;
  const includeArchived = input.includeArchived ?? false;
  const raw = searchChunksByBm25(db, roleId, query, topK * 2, { includeArchived });
  const chunkById = new Map(
    getChunksForRole(db, roleId, { includeArchived }).map((c) => [c.id, c]),
  );
  const hits: HybridSearchHit[] = [];
  for (const r of raw) {
    const chunk = chunkById.get(r.chunkId);
    if (!chunk) continue;
    if (kind && chunk.kind !== kind) continue;
    const hit: HybridSearchHit = {
      chunkId: chunk.id,
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
  const diversified = diversifyBySource(hits, topK);
  scheduleAccessBump(db, diversified, includeArchived);
  return diversified;
}

async function runEntityOnly(input: HybridSearchInput): Promise<HybridSearchHit[]> {
  const { db, roleId, query, topK, kind } = input;
  const includeArchived = input.includeArchived ?? false;
  const entities = extractEntitiesFromQuery(query);
  const raw = searchChunksByEntity(db, roleId, entities, topK * 2, { includeArchived });
  const chunkById = new Map(
    getChunksForRole(db, roleId, { includeArchived }).map((c) => [c.id, c]),
  );
  const hits: HybridSearchHit[] = [];
  for (const r of raw) {
    const chunk = chunkById.get(r.chunkId);
    if (!chunk) continue;
    if (kind && chunk.kind !== kind) continue;
    const hit: HybridSearchHit = {
      chunkId: chunk.id,
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
  const diversified = diversifyBySource(hits, topK);
  scheduleAccessBump(db, diversified, includeArchived);
  return diversified;
}

/**
 * R-21: optional module-level logger. Same pattern as
 * `roles/library.ts` — leaf modules shouldn't reach for console
 * directly when production has a structured logger available, but
 * unit tests that drive these functions don't need to wire one up.
 */
type SearchLogger = { warn(msg: string, fields?: { data?: unknown }): void };
let searchLogger: SearchLogger | null = null;
export function setHybridSearchLogger(logger: SearchLogger | null): void {
  searchLogger = logger;
}

/**
 * Phase 77: fire-and-forget access bump. Scheduled on the microtask queue
 * via `queueMicrotask` so the caller's `await searchKnowledge(...)`
 * resolves before the DB write. Failures are routed through the
 * injected logger when one is wired, or swallowed onto stderr via
 * console.warn — a stale access_count is not worth crashing search
 * over.
 *
 * Skipped entirely when `includeArchived` is true: an agent paging
 * through archived chunks shouldn't accidentally rescue them from the
 * sweep just by reading.
 */
function scheduleAccessBump(
  db: Database.Database,
  hits: readonly HybridSearchHit[],
  includeArchived: boolean,
): void {
  if (includeArchived) return;
  if (hits.length === 0) return;
  const ids = hits.map((h) => h.chunkId);
  const now = new Date().toISOString();
  queueMicrotask(() => {
    try {
      bumpChunkAccess(db, ids, now);
    } catch (err) {
      const message = (err as Error).message;
      if (searchLogger) {
        searchLogger.warn('access_bump_failed', { data: { count: ids.length, message } });
      } else {
        // eslint-disable-next-line no-console
        console.warn('[hybrid-search] access-bump failed:', message);
      }
    }
  });
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
  hasResults: { bm25: boolean; entity: boolean },
): RrfWeights {
  const w = {
    bm25:   hasResults.bm25   ? base.bm25   : 0,
    entity: hasResults.entity ? base.entity : 0,
  };
  const total = w.bm25 + w.entity;
  if (total === 0) return w;
  return { bm25: w.bm25 / total, entity: w.entity / total };
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
