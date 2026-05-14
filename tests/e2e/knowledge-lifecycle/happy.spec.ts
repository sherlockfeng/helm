/**
 * Knowledge lifecycle — end-to-end (Phase 77).
 *
 * Walks the user-visible flow:
 *   1. Train a role with two source docs (one is hand-aged to "very old").
 *   2. Run a search — verify the live chunk gets bumped (access_count > 0).
 *   3. Run the archival sweep — verify the old + cold chunk gets archived.
 *   4. Run search again — verify the archived chunk does NOT surface in
 *      default mode but DOES surface when includeArchived=true.
 *   5. Unarchive the chunk via the repo (mirrors the API/UI path) — verify
 *      it re-enters the default search pool.
 *
 * Uses an in-memory SQLite + the real library / search modules — no HTTP
 * round-trips needed for the lifecycle invariants.
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import {
  searchKnowledge,
  trainRole,
} from '../../../src/roles/library.js';
import {
  archiveChunks,
  getChunksForRole,
  unarchiveChunk,
} from '../../../src/storage/repos/roles.js';
import { runArchivalSweep } from '../../../src/roles/lifecycle.js';
import { makePseudoEmbedFn } from '../../../src/mcp/embed.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('knowledge-lifecycle e2e — train → search → sweep → unarchive', () => {
  let db: BetterSqlite3.Database;
  const embedFn = makePseudoEmbedFn();

  beforeEach(() => { db = openDb(); });
  afterEach(() => { db.close(); });

  it('full round-trip: archived chunks vanish from default search and reappear after unarchive', async () => {
    // Train two docs. We'll backdate one in the DB to make it "old + cold".
    await trainRole(db, {
      roleId: 'rA',
      name: 'A',
      documents: [
        { filename: 'fresh.md', content: 'FRESH content about TCE incidents.', kind: 'runbook' },
        { filename: 'stale.md', content: 'STALE content about TCE incidents.', kind: 'runbook' },
      ],
      embedFn,
    });

    const all = getChunksForRole(db, 'rA', { includeArchived: true });
    expect(all.length).toBeGreaterThanOrEqual(2);
    const freshChunk = all.find((c) => c.chunkText.includes('FRESH'))!;
    const staleChunk = all.find((c) => c.chunkText.includes('STALE'))!;

    // Backdate the stale chunk: created_at 120 days ago, never accessed.
    // We run the sweep BEFORE any search so the stale chunk's
    // last_accessed_at stays NULL (a search would touch it and disqualify
    // it from the "old + cold" candidate filter).
    const oldIso = new Date(Date.now() - 120 * MS_PER_DAY).toISOString();
    db.prepare(`UPDATE knowledge_chunks SET created_at = ? WHERE id = ?`).run(oldIso, staleChunk.id);

    // 1. Run the archival sweep. The stale chunk (120d old, access=0) gets
    // archived; the fresh chunk does NOT (created just now).
    const sweep = runArchivalSweep(db);
    expect(sweep.archived).toBe(1);

    // 2. Search the fresh content — verify the access-bump runs on the
    // fresh chunk. We flush the microtask queue with setImmediate after
    // the search promise resolves.
    const hits1 = await searchKnowledge(db, 'rA', 'FRESH TCE', embedFn, { topK: 5 });
    expect(hits1.length).toBeGreaterThan(0);
    await new Promise<void>((r) => setImmediate(r));
    const freshAfter = getChunksForRole(db, 'rA').find((c) => c.id === freshChunk.id)!;
    expect(freshAfter.accessCount).toBeGreaterThanOrEqual(1);

    const liveOnly = getChunksForRole(db, 'rA');
    expect(liveOnly.map((c) => c.id)).not.toContain(staleChunk.id);
    expect(liveOnly.map((c) => c.id)).toContain(freshChunk.id);

    // 3. Default search must NOT surface the archived chunk.
    const hits2 = await searchKnowledge(db, 'rA', 'STALE TCE', embedFn, { topK: 5 });
    expect(hits2.some((h) => h.chunkText.includes('STALE'))).toBe(false);

    // 4. With includeArchived=true, the archived chunk does surface.
    const hits3 = await searchKnowledge(db, 'rA', 'STALE TCE', embedFn, {
      topK: 5,
      includeArchived: true,
    });
    expect(hits3.some((h) => h.chunkText.includes('STALE'))).toBe(true);

    // 5. Unarchive — chunk re-enters the default pool.
    const restored = unarchiveChunk(db, staleChunk.id, new Date().toISOString());
    expect(restored).toBe(true);
    const liveAfter = getChunksForRole(db, 'rA');
    expect(liveAfter.map((c) => c.id)).toContain(staleChunk.id);
  });

  it('sweep is idempotent — second run after archiving finds nothing new', async () => {
    await trainRole(db, {
      roleId: 'rA',
      name: 'A',
      documents: [{ filename: 'old.md', content: 'OLD chunk text', kind: 'other' }],
      embedFn,
    });
    const oldIso = new Date(Date.now() - 200 * MS_PER_DAY).toISOString();
    db.prepare(`UPDATE knowledge_chunks SET created_at = ?`).run(oldIso);

    const first = runArchivalSweep(db);
    expect(first.archived).toBeGreaterThanOrEqual(1);
    const second = runArchivalSweep(db);
    expect(second.archived).toBe(0);
  });

  it('manual archive does not get auto-bumped just by being searched (includeArchived)', async () => {
    await trainRole(db, {
      roleId: 'rA',
      name: 'A',
      documents: [{ filename: 'note.md', content: 'sticky NOTE about TCE', kind: 'other' }],
      embedFn,
    });
    const [chunk] = getChunksForRole(db, 'rA');
    expect(chunk).toBeDefined();
    archiveChunks(db, [chunk!.id]);
    expect(chunk!.accessCount ?? 0).toBe(0);

    // Search with includeArchived=true to surface the archived chunk.
    await searchKnowledge(db, 'rA', 'NOTE TCE', embedFn, {
      topK: 5,
      includeArchived: true,
    });
    await new Promise<void>((r) => setImmediate(r));

    // Access count for an archived hit should NOT bump — the user
    // explicitly opted into seeing archived content; reading it shouldn't
    // rescue it from the next sweep.
    const afterRow = db.prepare(
      `SELECT access_count FROM knowledge_chunks WHERE id = ?`,
    ).get(chunk!.id) as { access_count: number };
    expect(afterRow.access_count).toBe(0);
  });
});
