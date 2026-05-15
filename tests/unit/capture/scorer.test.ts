/**
 * Capture scorer (Phase 78).
 *
 * Pins:
 *   - entity overlap ≥ 2 OR cosine ≥ 0.6 → qualifies
 *   - both 0 → does not qualify
 *   - both scores are always populated, regardless of qualification
 *   - empty / unknown role → both scores 0, qualifies false
 *   - threshold override changes the decision
 *   - cosine looks at archived chunks too (a re-paraphrase of a just-archived
 *     chunk is still "known", not "novel")
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import {
  archiveChunks,
  insertChunk,
  insertChunkEntity,
  insertSource,
  upsertRole,
} from '../../../src/storage/repos/roles.js';
import { scoreSegment, DEFAULT_CAPTURE_THRESHOLDS } from '../../../src/capture/scorer.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

/** Marker-keyword embedder so tests can pin cosine deterministically. */
const MARKERS = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA'];
async function markerEmbed(text: string): Promise<Float32Array> {
  const v = new Float32Array(MARKERS.length);
  for (let i = 0; i < MARKERS.length; i++) {
    if (text.toUpperCase().includes(MARKERS[i]!)) v[i] = 1;
  }
  let n = 0; for (const x of v) n += x * x;
  const d = Math.sqrt(n);
  if (d > 0) for (let i = 0; i < v.length; i++) v[i] /= d;
  return v;
}

function seed(db: BetterSqlite3.Database): void {
  const now = new Date().toISOString();
  upsertRole(db, { id: 'r1', name: 'r1', systemPrompt: 'p', isBuiltin: false, createdAt: now });
  insertSource(db, {
    id: 'src1', roleId: 'r1', kind: 'file', origin: 'spec.md',
    fingerprint: 'fp', createdAt: now,
  });
}

describe('scoreSegment — entity overlap leg', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); seed(db); });
  afterEach(() => { db.close(); });

  it('qualifies when ≥2 entities from segment match the role index', async () => {
    const now = new Date().toISOString();
    const ALPHA_EMBED = await markerEmbed('ALPHA');
    insertChunk(db, {
      id: 'c1', roleId: 'r1', chunkText: 'about RBAC and CSR',
      kind: 'spec', sourceId: 'src1', embedding: ALPHA_EMBED, createdAt: now,
    });
    insertChunkEntity(db, { chunkId: 'c1', roleId: 'r1', entity: 'RBAC', createdAt: now });
    insertChunkEntity(db, { chunkId: 'c1', roleId: 'r1', entity: 'CSR',  createdAt: now });
    insertChunkEntity(db, { chunkId: 'c1', roleId: 'r1', entity: 'TCE',  createdAt: now });

    const result = await scoreSegment({
      db, roleId: 'r1',
      segmentText: 'Reviewing RBAC config and CSR rollout for the TCE cluster.',
      embedFn: markerEmbed,
    });
    expect(result.scoreEntity).toBe(3); // RBAC, CSR, TCE all matched
    expect(result.qualifies).toBe(true);
  });

  it('does NOT qualify on entity leg when only 1 entity matches', async () => {
    const now = new Date().toISOString();
    insertChunk(db, {
      id: 'c1', roleId: 'r1', chunkText: 'about RBAC only',
      kind: 'spec', sourceId: 'src1', createdAt: now,
    });
    insertChunkEntity(db, { chunkId: 'c1', roleId: 'r1', entity: 'RBAC', createdAt: now });

    // Segment mentions RBAC but no other known entities; entity leg should
    // give 1, below the default minEntityOverlap=2.
    const result = await scoreSegment({
      db, roleId: 'r1',
      segmentText: 'Just talking about RBAC in passing here. No other terms.',
      embedFn: markerEmbed,
    });
    expect(result.scoreEntity).toBe(1);
    // Cosine signal also 0 (no embeddings in role with marker overlap).
    expect(result.qualifies).toBe(false);
  });
});

describe('scoreSegment — cosine leg', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); seed(db); });
  afterEach(() => { db.close(); });

  it('qualifies on cosine alone when entity leg is empty', async () => {
    const now = new Date().toISOString();
    const ALPHA = await markerEmbed('ALPHA');
    insertChunk(db, {
      id: 'c1', roleId: 'r1', chunkText: 'irrelevant text',
      kind: 'spec', sourceId: 'src1', embedding: ALPHA, createdAt: now,
    });
    // Segment shares the ALPHA marker → cosine = 1; no entity index population.
    const result = await scoreSegment({
      db, roleId: 'r1',
      segmentText: 'ALPHA something paraphrased here',
      embedFn: markerEmbed,
    });
    expect(result.scoreCosine).toBeCloseTo(1, 5);
    expect(result.scoreEntity).toBe(0);
    expect(result.qualifies).toBe(true);
  });

  it('cosine takes max over multiple chunks (including archived)', async () => {
    const now = new Date().toISOString();
    const ALPHA = await markerEmbed('ALPHA');
    const BRAVO = await markerEmbed('BRAVO');
    insertChunk(db, {
      id: 'c1', roleId: 'r1', chunkText: 'alpha doc',
      kind: 'spec', sourceId: 'src1', embedding: ALPHA, createdAt: now,
    });
    insertChunk(db, {
      id: 'c2', roleId: 'r1', chunkText: 'bravo doc',
      kind: 'spec', sourceId: 'src1', embedding: BRAVO, createdAt: now,
    });
    archiveChunks(db, ['c1']); // archived chunk still counts for cosine
    // Segment matches ALPHA — max cosine should still be ~1 from the
    // archived c1 (Decision in scorer.ts: includeArchived=true on the
    // cosine pool so re-paraphrases of just-archived chunks aren't
    // mistaken for novel content).
    const result = await scoreSegment({
      db, roleId: 'r1',
      segmentText: 'ALPHA reminder',
      embedFn: markerEmbed,
    });
    expect(result.scoreCosine).toBeCloseTo(1, 5);
  });
});

describe('scoreSegment — archived consistency (reviewer must-fix #2)', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); seed(db); });
  afterEach(() => { db.close(); });

  it('entity leg counts matches even when ALL matching chunks are archived', async () => {
    // The cosine leg deliberately includes archived chunks ("re-paraphrase
    // of cold knowledge is still known knowledge"). The entity leg must
    // agree — archiving a chunk shouldn't make its entities disappear from
    // the role's index for capture purposes.
    const now = new Date().toISOString();
    insertChunk(db, {
      id: 'c1', roleId: 'r1', chunkText: 'about RBAC and CSR',
      kind: 'spec', sourceId: 'src1', createdAt: now,
    });
    insertChunkEntity(db, { chunkId: 'c1', roleId: 'r1', entity: 'RBAC', createdAt: now });
    insertChunkEntity(db, { chunkId: 'c1', roleId: 'r1', entity: 'CSR',  createdAt: now });
    archiveChunks(db, ['c1']);

    const result = await scoreSegment({
      db, roleId: 'r1',
      segmentText: 'Reviewing RBAC config and CSR rollout.',
      embedFn: markerEmbed,
    });
    expect(result.scoreEntity).toBe(2);
  });
});

describe('scoreSegment — qualification gate', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); seed(db); });
  afterEach(() => { db.close(); });

  it('does NOT qualify when both signals are below threshold', async () => {
    // Empty role — no chunks, no entities. Anything segment-wise scores 0.
    const result = await scoreSegment({
      db, roleId: 'r1',
      segmentText: 'totally unrelated UNKNOWN content',
      embedFn: markerEmbed,
    });
    expect(result.scoreEntity).toBe(0);
    expect(result.scoreCosine).toBe(0);
    expect(result.qualifies).toBe(false);
  });

  it('threshold override flips the decision', async () => {
    const now = new Date().toISOString();
    insertChunk(db, {
      id: 'c1', roleId: 'r1', chunkText: 'only RBAC',
      kind: 'spec', sourceId: 'src1', createdAt: now,
    });
    insertChunkEntity(db, { chunkId: 'c1', roleId: 'r1', entity: 'RBAC', createdAt: now });

    // Default (minEntityOverlap=2) → does NOT qualify with 1 hit.
    const strict = await scoreSegment({
      db, roleId: 'r1',
      segmentText: 'RBAC in isolation.',
      embedFn: markerEmbed,
    });
    expect(strict.qualifies).toBe(false);

    // Loosened threshold → 1 hit suffices.
    const loose = await scoreSegment({
      db, roleId: 'r1',
      segmentText: 'RBAC in isolation.',
      embedFn: markerEmbed,
      thresholds: { minEntityOverlap: 1 },
    });
    expect(loose.qualifies).toBe(true);
  });

  it('DEFAULT_CAPTURE_THRESHOLDS matches the documented values', () => {
    expect(DEFAULT_CAPTURE_THRESHOLDS).toEqual({ minEntityOverlap: 2, minCosine: 0.6 });
  });
});
