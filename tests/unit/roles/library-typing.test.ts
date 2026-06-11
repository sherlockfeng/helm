/**
 * roles/library — typing + lineage (Phase 73).
 *
 * Confirms the integration between trainRole / updateRole / searchKnowledge
 * and the new source + kind columns:
 *   - trainRole creates one source per document, propagates kind to chunks
 *   - identical (filename, content) under the same role → same source reused
 *     (one row, not two) when updateRole appends
 *   - searchKnowledge respects the `kind` filter
 *   - full-replace via trainRole wipes BOTH chunks AND sources (no orphans)
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { trainRole, updateRole, searchKnowledge } from '../../../src/roles/library.js';
import {
  getChunksForRole,
  listSourcesForRole,
} from '../../../src/storage/repos/roles.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

// Deterministic stub embedder so tests don't depend on the pseudo char-bin
// implementation. Length 4 vector, slot indexed by length-mod-4 → cosine
// hits 1.0 only on identical-length texts; orthogonal otherwise. Doesn't
// matter much for these tests — we're not asserting ranking quality, just
// that the filter / source plumbing works.
async function stubEmbed(text: string): Promise<Float32Array> {
  const v = new Float32Array(4);
  v[text.length % 4] = 1;
  return v;
}

describe('trainRole — source rows + chunk kinds', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); });
  afterEach(() => { db.close(); });

  it('creates one source per document and stamps every chunk with its kind', async () => {
    await trainRole(db, {
      roleId: 'r1',
      name: 'Role 1',
      documents: [
        { filename: 'spec.md', content: 'spec body', kind: 'spec' },
        { filename: 'example.md', content: 'example body', kind: 'example' },
      ],
      embedFn: stubEmbed,
    });
    const sources = listSourcesForRole(db, 'r1');
    expect(sources).toHaveLength(2);
    const chunks = getChunksForRole(db, 'r1');
    expect(chunks).toHaveLength(2);
    expect(chunks.map((c) => c.kind).sort()).toEqual(['example', 'spec']);
    // Every chunk has a non-null source_id (clean-slate post-migration contract).
    expect(chunks.every((c) => c.sourceId !== undefined)).toBe(true);
  });

  it("defaults each chunk's kind to 'other' when the doc has no `kind`", async () => {
    await trainRole(db, {
      roleId: 'r1', name: 'Role 1',
      documents: [{ filename: 'untyped.md', content: 'random' }],
      embedFn: stubEmbed,
    });
    expect(getChunksForRole(db, 'r1')[0]?.kind).toBe('other');
  });

  it('full-replace wipes both chunks AND source rows from prior trainings', async () => {
    await trainRole(db, {
      roleId: 'r1', name: 'Role 1',
      documents: [{ filename: 'old.md', content: 'old', kind: 'spec' }],
      embedFn: stubEmbed,
    });
    expect(listSourcesForRole(db, 'r1')).toHaveLength(1);

    await trainRole(db, {
      roleId: 'r1', name: 'Role 1',
      documents: [{ filename: 'new.md', content: 'new', kind: 'spec' }],
      embedFn: stubEmbed,
    });
    const sources = listSourcesForRole(db, 'r1');
    expect(sources).toHaveLength(1);
    expect(sources[0]?.origin).toBe('new.md');
  });

  it('infers sourceKind from filename shape when omitted', async () => {
    await trainRole(db, {
      roleId: 'r1', name: 'Role 1',
      documents: [
        { filename: 'https://lark.example.com/docx/abc', content: '...' },
        { filename: '/abs/path/spec.md', content: '...' },
        { filename: 'paste', content: '...' },
      ],
      embedFn: stubEmbed,
    });
    const sources = listSourcesForRole(db, 'r1');
    const byOrigin = Object.fromEntries(sources.map((s) => [s.origin, s.kind]));
    expect(byOrigin['https://lark.example.com/docx/abc']).toBe('lark-doc');
    expect(byOrigin['/abs/path/spec.md']).toBe('file');
    expect(byOrigin['paste']).toBe('inline');
  });
});

describe('updateRole — fingerprint dedup', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); });
  afterEach(() => { db.close(); });

  it('re-ingesting identical filename+content reuses the existing source row', async () => {
    await trainRole(db, {
      roleId: 'r1', name: 'Role 1',
      documents: [{ filename: 'spec.md', content: 'body', kind: 'spec' }],
      embedFn: stubEmbed,
    });
    expect(listSourcesForRole(db, 'r1')).toHaveLength(1);

    await updateRole(db, {
      roleId: 'r1',
      appendDocuments: [{ filename: 'spec.md', content: 'body', kind: 'spec' }],
      embedFn: stubEmbed,
      force: true, // skip conflict detection — same content would otherwise self-conflict
    });
    // ONE source row still, but per Decision §C chunks are NOT dedup'd —
    // the duplicated append creates a second chunk under the same source.
    const sources = listSourcesForRole(db, 'r1');
    expect(sources).toHaveLength(1);
    expect(sources[0]?.chunkCount).toBe(2);
  });

  it('different content under the same filename creates a NEW source row', async () => {
    await trainRole(db, {
      roleId: 'r1', name: 'Role 1',
      documents: [{ filename: 'spec.md', content: 'v1', kind: 'spec' }],
      embedFn: stubEmbed,
    });
    await updateRole(db, {
      roleId: 'r1',
      appendDocuments: [{ filename: 'spec.md', content: 'v2 (edited)', kind: 'spec' }],
      embedFn: stubEmbed,
    });
    expect(listSourcesForRole(db, 'r1')).toHaveLength(2);
  });
});

describe('updateRole — pointIdBase (files-as-truth PR-2)', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); });
  afterEach(() => { db.close(); });

  it('uses the slug as the chunk id and reports it in chunkIds', async () => {
    await trainRole(db, {
      roleId: 'r1', name: 'Role 1',
      documents: [{ filename: 'seed.md', content: 'seed' }],
      embedFn: stubEmbed,
    });
    const result = await updateRole(db, {
      roleId: 'r1',
      appendDocuments: [{
        filename: 'capture-x', content: 'OG v5 mismatch body',
        pointIdBase: 'og-v5-mismatch',
      }],
      embedFn: stubEmbed,
      force: true,
    });
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') return;
    expect(result.chunkIds).toEqual(['og-v5-mismatch']);
    const row = db.prepare(
      `SELECT id FROM knowledge_chunks WHERE id = 'og-v5-mismatch'`,
    ).get();
    expect(row).toBeDefined();
  });

  it('falls back to a UUID when the wanted id already exists', async () => {
    await trainRole(db, {
      roleId: 'r1', name: 'Role 1',
      documents: [{ filename: 'seed.md', content: 'seed' }],
      embedFn: stubEmbed,
    });
    const first = await updateRole(db, {
      roleId: 'r1',
      appendDocuments: [{ filename: 'a', content: 'body one', pointIdBase: 'dup-id' }],
      embedFn: stubEmbed, force: true,
    });
    const second = await updateRole(db, {
      roleId: 'r1',
      appendDocuments: [{ filename: 'b', content: 'body two', pointIdBase: 'dup-id' }],
      embedFn: stubEmbed, force: true,
    });
    expect(first.status).toBe('applied');
    expect(second.status).toBe('applied');
    if (first.status !== 'applied' || second.status !== 'applied') return;
    expect(first.chunkIds).toEqual(['dup-id']);
    expect(second.chunkIds).toHaveLength(1);
    expect(second.chunkIds[0]).not.toBe('dup-id');
    // Backstop produced a UUID-shaped id, not dup-id-2 (the caller owns
    // readable dedup; the library only guarantees no collision).
    expect(second.chunkIds[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('without pointIdBase chunk ids stay UUIDs (legacy path unchanged)', async () => {
    await trainRole(db, {
      roleId: 'r1', name: 'Role 1',
      documents: [{ filename: 'seed.md', content: 'seed' }],
      embedFn: stubEmbed,
    });
    const result = await updateRole(db, {
      roleId: 'r1',
      appendDocuments: [{ filename: 'c', content: 'plain append' }],
      embedFn: stubEmbed, force: true,
    });
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') return;
    expect(result.chunkIds).toHaveLength(1);
    expect(result.chunkIds[0]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('searchKnowledge — kind filter', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); });
  afterEach(() => { db.close(); });

  it('omitting kind returns hits across every chunk type', async () => {
    // PR-4: retrieval is BM25 + entity — fixtures need a lexically
    // matchable shared token (the old ones leaned on the cosine leg
    // matching any text).
    await trainRole(db, {
      roleId: 'r1', name: 'Role 1',
      documents: [
        { filename: 'a.md', content: 'alpha spec body', kind: 'spec' },
        { filename: 'b.md', content: 'alpha example body', kind: 'example' },
        { filename: 'c.md', content: 'alpha warning body', kind: 'warning' },
      ],
      embedFn: stubEmbed,
    });
    const all = await searchKnowledge(db, 'r1', 'alpha', stubEmbed, { topK: 10 });
    expect(all).toHaveLength(3);
    expect(new Set(all.map((h) => h.kind))).toEqual(new Set(['spec', 'example', 'warning']));
  });

  it('passing kind restricts the candidate pool to that kind only', async () => {
    await trainRole(db, {
      roleId: 'r1', name: 'Role 1',
      documents: [
        { filename: 'spec.md', content: 'alpha spec body', kind: 'spec' },
        { filename: 'ex.md', content: 'alpha example body', kind: 'example' },
        { filename: 'run.md', content: 'alpha runbook body', kind: 'runbook' },
      ],
      embedFn: stubEmbed,
    });
    const onlyRunbook = await searchKnowledge(db, 'r1', 'alpha', stubEmbed, {
      kind: 'runbook', topK: 10,
    });
    expect(onlyRunbook.map((h) => h.kind)).toEqual(['runbook']);
  });

  it('legacy positional topK still works (backward-compat with old callers)', async () => {
    await trainRole(db, {
      roleId: 'r1', name: 'Role 1',
      documents: [
        { filename: 'a.md', content: 'alpha first body', kind: 'spec' },
        { filename: 'b.md', content: 'alpha second body', kind: 'spec' },
      ],
      embedFn: stubEmbed,
    });
    const hits = await searchKnowledge(db, 'r1', 'alpha', stubEmbed, 1);
    expect(hits).toHaveLength(1);
  });

  it('every returned hit carries kind + sourceId (provenance round-trip)', async () => {
    await trainRole(db, {
      roleId: 'r1', name: 'Role 1',
      documents: [{ filename: 'spec.md', content: 'alpha spec body', kind: 'spec' }],
      embedFn: stubEmbed,
    });
    const hits = await searchKnowledge(db, 'r1', 'alpha', stubEmbed);
    expect(hits[0]?.kind).toBe('spec');
    expect(typeof hits[0]?.sourceId).toBe('string');
    expect((hits[0]?.sourceId ?? '').length).toBeGreaterThan(0);
  });
});
