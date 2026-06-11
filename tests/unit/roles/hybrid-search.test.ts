/**
 * Hybrid search — RRF fusion of BM25 + entity legs (Phase 76; cosine
 * leg retired in files-as-truth PR-4 — pseudo-embeddings carried no
 * semantic signal).
 *
 * Pins:
 *   - Both legs contributing → fused score combines via RRF
 *   - One leg empty → drop-then-renormalize gives the survivor full
 *     "probability mass"
 *   - All legs empty → empty result (not crash)
 *   - Diversify by source_id caps at MAX_HITS_PER_SOURCE (3)
 *   - kind filter is honored across all legs
 *   - Single-leg strategies route to the right leg
 *   - computeEffectiveWeights math is correct (pure unit-level)
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import {
  hybridSearch,
  computeEffectiveWeights,
  DEFAULT_RRF_WEIGHTS,
  MAX_HITS_PER_SOURCE,
  RRF_K,
} from '../../../src/roles/hybrid-search.js';
import { trainRole } from '../../../src/roles/library.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

/** trainRole still demands an embedder for chunk storage; retrieval ignores it. */
async function noopEmbed(_text: string): Promise<Float32Array> {
  return new Float32Array(4);
}

describe('computeEffectiveWeights — drop-then-renormalize', () => {
  it('both legs present → returns base normalized to sum=1', () => {
    const w = computeEffectiveWeights(
      { bm25: 0.4, entity: 0.3 },
      { bm25: true, entity: true },
    );
    expect(w.bm25 + w.entity).toBeCloseTo(1.0, 5);
    // Ratios preserved: bm25 stays the larger leg.
    expect(w.bm25).toBeGreaterThan(w.entity);
    expect(w.bm25 / w.entity).toBeCloseTo(0.4 / 0.3, 5);
  });

  it('one leg empty → its weight becomes 0; survivor renormalizes to 1', () => {
    const w = computeEffectiveWeights(
      { bm25: 0.4, entity: 0.3 },
      { bm25: true, entity: false },
    );
    expect(w.entity).toBe(0);
    expect(w.bm25).toBeCloseTo(1.0, 5);
  });

  it('both empty → all zeros (caller should bail to empty result)', () => {
    const w = computeEffectiveWeights(
      DEFAULT_RRF_WEIGHTS,
      { bm25: false, entity: false },
    );
    expect(w).toEqual({ bm25: 0, entity: 0 });
  });

  it('only entity present → entity takes full weight 1', () => {
    const w = computeEffectiveWeights(
      DEFAULT_RRF_WEIGHTS,
      { bm25: false, entity: true },
    );
    expect(w.entity).toBeCloseTo(1.0, 5);
    expect(w.bm25).toBe(0);
  });
});

describe('hybridSearch — end-to-end with a tiny seeded role', () => {
  let db: BetterSqlite3.Database;
  beforeEach(async () => {
    db = openDb();
    await trainRole(db, {
      roleId: 'rA', name: 'A',
      documents: [
        { filename: 'spec.md',     content: 'ALPHA platform spec. RBAC RBAC RBAC.',        kind: 'spec' },
        { filename: 'runbook.md',  content: 'BRAVO incident runbook. tce rollback steps.', kind: 'runbook' },
        { filename: 'gloss.md',    content: 'CHARLIE glossary entry.',                     kind: 'glossary' },
        { filename: 'example.md',  content: 'DELTA example: getCycleState() call site.',   kind: 'example' },
      ],
      embedFn: noopEmbed,
    });
  });
  afterEach(() => { db.close(); });

  it('fusion strategy returns hits and surfaces multi-leg matches first', async () => {
    // Query "RBAC" should rank the spec.md chunk first — BM25 hits hard
    // (3× "RBAC") and the entity leg matches the RBAC acronym.
    const hits = await hybridSearch({
      db, roleId: 'rA', query: 'RBAC', topK: 4, strategy: 'fusion',
    });
    expect(hits.length).toBeGreaterThan(0);
    const top = hits[0]!;
    expect(top.chunkText).toContain('ALPHA platform spec');
    // Multi-leg contribution proved by per-leg scores being defined.
    expect(top.contributingLegs.length).toBeGreaterThanOrEqual(2);
  });

  it('bm25-only strategy returns hits ranked by BM25', async () => {
    const hits = await hybridSearch({
      db, roleId: 'rA', query: 'tce rollback', topK: 3, strategy: 'bm25',
    });
    expect(hits[0]?.chunkText).toContain('tce rollback');
    expect(hits[0]?.contributingLegs).toEqual(['bm25']);
  });

  it('multi-token query with a non-occurring word still matches (BM25 OR semantics)', async () => {
    // PR-4: with implicit-AND FTS5 this returned zero rows (the cosine
    // leg used to paper over it); OR-joined tokens make BM25 a real
    // recall leg.
    const hits = await hybridSearch({
      db, roleId: 'rA', query: 'tce rollback escalation zzznope', topK: 3, strategy: 'bm25',
    });
    expect(hits[0]?.chunkText).toContain('tce rollback');
  });

  it('entity-only strategy returns hits when query contains a known entity', async () => {
    const hits = await hybridSearch({
      db, roleId: 'rA', query: 'getCycleState function', topK: 3, strategy: 'entity',
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.chunkText).toContain('getCycleState');
    expect(hits[0]?.contributingLegs).toEqual(['entity']);
  });

  it('entity-only returns empty when query has no extractable entities', async () => {
    const hits = await hybridSearch({
      db, roleId: 'rA', query: 'general words about stuff', topK: 3, strategy: 'entity',
    });
    expect(hits).toEqual([]);
  });

  it('fusion is robust when query has only entity signal', async () => {
    const hits = await hybridSearch({
      db, roleId: 'rA', query: 'getCycleState', topK: 3, strategy: 'fusion',
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.chunkText).toContain('getCycleState');
  });

  it('kind filter narrows ALL legs (only runbook chunk surfaces)', async () => {
    const hits = await hybridSearch({
      db, roleId: 'rA', query: 'BRAVO', topK: 5, strategy: 'fusion', kind: 'runbook',
    });
    expect(hits.every((h) => h.kind === 'runbook')).toBe(true);
  });

  it('all-empty query returns empty result, never throws', async () => {
    // Whitespace-only query: BM25 tokens drop, entities empty.
    const hits = await hybridSearch({
      db, roleId: 'rA', query: '   ', topK: 5, strategy: 'fusion',
    });
    expect(Array.isArray(hits)).toBe(true);
  });

  it('unknown role returns empty (no crash)', async () => {
    const hits = await hybridSearch({
      db, roleId: 'role-ghost', query: 'anything', topK: 5, strategy: 'fusion',
    });
    expect(hits).toEqual([]);
  });
});

describe('hybridSearch — diversify by source_id', () => {
  let db: BetterSqlite3.Database;
  beforeEach(async () => {
    db = openDb();
    // ~5000-char body so chunkDocument's 800-char window splits into 6+ chunks
    // all under one filename → all share a source_id. Each chunk individually
    // mentions ALPHA so the BM25 leg matches the whole pile.
    const longBody = Array.from({ length: 60 },
      (_, i) => `ALPHA line ${i}: ${'word '.repeat(15)}`).join('\n');
    await trainRole(db, {
      roleId: 'rB', name: 'B',
      documents: [{ filename: 'big.md', content: longBody, kind: 'spec' }],
      embedFn: noopEmbed,
    });
  });
  afterEach(() => { db.close(); });

  it(`caps hits from one source at MAX_HITS_PER_SOURCE (${MAX_HITS_PER_SOURCE}) when other sources exist`, async () => {
    await trainRole(db, {
      roleId: 'rC', name: 'C',
      documents: [
        // 6 chunks from one source
        { filename: 'big.md', content: 'ALPHA one\n\nALPHA two\n\nALPHA three\n\nALPHA four\n\nALPHA five\n\nALPHA six', kind: 'spec' },
        // 1 chunk from another
        { filename: 'small.md', content: 'ALPHA seven', kind: 'spec' },
      ],
      embedFn: noopEmbed,
    });
    const hits = await hybridSearch({
      db, roleId: 'rC', query: 'ALPHA', topK: 10, strategy: 'bm25',
    });
    const bySource = new Map<string, number>();
    for (const h of hits) {
      const k = h.sourceId ?? 'none';
      bySource.set(k, (bySource.get(k) ?? 0) + 1);
    }
    // At least one source should be capped at MAX_HITS_PER_SOURCE; topK=10
    // would otherwise produce 6 from the big source.
    const maxOneSource = Math.max(...bySource.values());
    expect(maxOneSource).toBeLessThanOrEqual(MAX_HITS_PER_SOURCE);
  });

  it('top-up pass: small corpus all from one source still returns up to topK (no diversification possible)', async () => {
    const hits = await hybridSearch({
      db, roleId: 'rB', query: 'ALPHA', topK: 10, strategy: 'bm25',
    });
    // Only one source; should return as many as exist even though it
    // exceeds MAX_HITS_PER_SOURCE for that single source.
    expect(hits.length).toBeGreaterThan(MAX_HITS_PER_SOURCE);
  });
});

describe('RRF math sanity', () => {
  it('RRF_K is the standard 60', () => {
    expect(RRF_K).toBe(60);
  });

  it('DEFAULT_RRF_WEIGHTS keeps the documented 0.4 / 0.3 relative magnitudes', () => {
    expect(DEFAULT_RRF_WEIGHTS).toEqual({ bm25: 0.4, entity: 0.3 });
  });
});
