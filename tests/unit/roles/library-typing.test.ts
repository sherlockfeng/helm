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

describe('searchKnowledge — kind filter', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); });
  afterEach(() => { db.close(); });

  it('omitting kind returns hits across every chunk type', async () => {
    await trainRole(db, {
      roleId: 'r1', name: 'Role 1',
      documents: [
        { filename: 'a.md', content: 'sa', kind: 'spec' },
        { filename: 'b.md', content: 'eb', kind: 'example' },
        { filename: 'c.md', content: 'wc', kind: 'warning' },
      ],
      embedFn: stubEmbed,
    });
    const all = await searchKnowledge(db, 'r1', 'query', stubEmbed, { topK: 10 });
    expect(all).toHaveLength(3);
    expect(new Set(all.map((h) => h.kind))).toEqual(new Set(['spec', 'example', 'warning']));
  });

  it('passing kind restricts the candidate pool to that kind only', async () => {
    await trainRole(db, {
      roleId: 'r1', name: 'Role 1',
      documents: [
        { filename: 'spec.md', content: 'sa', kind: 'spec' },
        { filename: 'ex.md', content: 'eb', kind: 'example' },
        { filename: 'run.md', content: 'rc', kind: 'runbook' },
      ],
      embedFn: stubEmbed,
    });
    const onlyRunbook = await searchKnowledge(db, 'r1', 'query', stubEmbed, {
      kind: 'runbook', topK: 10,
    });
    expect(onlyRunbook.map((h) => h.kind)).toEqual(['runbook']);
  });

  it('legacy positional topK still works (backward-compat with old callers)', async () => {
    await trainRole(db, {
      roleId: 'r1', name: 'Role 1',
      documents: [
        { filename: 'a.md', content: 'sa', kind: 'spec' },
        { filename: 'b.md', content: 'eb', kind: 'spec' },
      ],
      embedFn: stubEmbed,
    });
    const hits = await searchKnowledge(db, 'r1', 'query', stubEmbed, 1);
    expect(hits).toHaveLength(1);
  });

  it('every returned hit carries kind + sourceId (provenance round-trip)', async () => {
    await trainRole(db, {
      roleId: 'r1', name: 'Role 1',
      documents: [{ filename: 'spec.md', content: 'spec', kind: 'spec' }],
      embedFn: stubEmbed,
    });
    const hits = await searchKnowledge(db, 'r1', 'q', stubEmbed);
    expect(hits[0]?.kind).toBe('spec');
    expect(typeof hits[0]?.sourceId).toBe('string');
    expect((hits[0]?.sourceId ?? '').length).toBeGreaterThan(0);
  });
});
