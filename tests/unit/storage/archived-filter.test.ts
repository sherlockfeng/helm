/**
 * archived-flag filtering on every reader (Phase 77).
 *
 * The default behavior is "do NOT return archived chunks" — search calls
 * us via getChunksForRole / searchChunksByBm25 / searchChunksByEntity and
 * expect cold knowledge to be invisible. Passing { includeArchived: true }
 * is how the Roles UI / agent's archive-aware search path opts in.
 *
 * Pins:
 *   - getChunksForRole default → archived excluded
 *   - getChunksForRole { includeArchived: true } → archived returned
 *   - searchChunksByBm25 default → archived excluded from FTS5 hits
 *   - searchChunksByEntity default → archived excluded from entity hits
 *   - archiveChunks flips rows; unarchiveChunk flips them back
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import {
  archiveChunks,
  bumpChunkAccess,
  getChunkById,
  getChunksForRole,
  insertChunk,
  insertChunkEntity,
  insertSource,
  searchChunksByBm25,
  searchChunksByEntity,
  unarchiveChunk,
  upsertRole,
} from '../../../src/storage/repos/roles.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seed(db: BetterSqlite3.Database): void {
  const now = new Date().toISOString();
  upsertRole(db, { id: 'r1', name: 'r1', systemPrompt: 'p', isBuiltin: false, createdAt: now });
  insertSource(db, {
    id: 'src1', roleId: 'r1', kind: 'file', origin: 'spec.md',
    fingerprint: 'fp', createdAt: now,
  });
  // Two chunks: c-live stays live, c-archived gets archived after insert.
  insertChunk(db, {
    id: 'c-live', roleId: 'r1', chunkText: 'TCE rollback live runbook', kind: 'runbook',
    sourceId: 'src1', createdAt: now,
  });
  insertChunk(db, {
    id: 'c-archived', roleId: 'r1', chunkText: 'TCE rollback archived runbook', kind: 'runbook',
    sourceId: 'src1', createdAt: now,
  });
  // Entity indexing so searchChunksByEntity has something to find.
  insertChunkEntity(db, { chunkId: 'c-live', roleId: 'r1', entity: 'TCE', createdAt: now });
  insertChunkEntity(db, { chunkId: 'c-archived', roleId: 'r1', entity: 'TCE', createdAt: now });
  archiveChunks(db, ['c-archived']);
}

describe('getChunksForRole — includeArchived behavior', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); seed(db); });
  afterEach(() => { db.close(); });

  it('default (includeArchived omitted) excludes archived rows', () => {
    const chunks = getChunksForRole(db, 'r1');
    expect(chunks.map((c) => c.id)).toEqual(['c-live']);
  });

  it('includeArchived: true returns both live and archived', () => {
    const chunks = getChunksForRole(db, 'r1', { includeArchived: true });
    const ids = chunks.map((c) => c.id).sort();
    expect(ids).toEqual(['c-archived', 'c-live']);
  });

  it('reader populates accessCount / archived fields', () => {
    bumpChunkAccess(db, ['c-live'], '2026-05-14T12:00:00.000Z');
    const [live] = getChunksForRole(db, 'r1');
    expect(live!.accessCount).toBe(1);
    expect(live!.archived).toBe(false);
    expect(live!.lastAccessedAt).toBe('2026-05-14T12:00:00.000Z');
  });
});

describe('searchChunksByBm25 — archived-flag filtering', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); seed(db); });
  afterEach(() => { db.close(); });

  it('default excludes archived chunks from BM25 hits', () => {
    const hits = searchChunksByBm25(db, 'r1', 'rollback', 10);
    expect(hits.map((h) => h.chunkId)).toEqual(['c-live']);
  });

  it('includeArchived: true returns both live and archived', () => {
    const hits = searchChunksByBm25(db, 'r1', 'rollback', 10, { includeArchived: true });
    const ids = hits.map((h) => h.chunkId).sort();
    expect(ids).toEqual(['c-archived', 'c-live']);
  });
});

describe('searchChunksByEntity — archived-flag filtering', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); seed(db); });
  afterEach(() => { db.close(); });

  it('default excludes archived chunks from entity hits', () => {
    const hits = searchChunksByEntity(db, 'r1', ['TCE'], 10);
    expect(hits.map((h) => h.chunkId)).toEqual(['c-live']);
  });

  it('includeArchived: true returns both', () => {
    const hits = searchChunksByEntity(db, 'r1', ['TCE'], 10, { includeArchived: true });
    const ids = hits.map((h) => h.chunkId).sort();
    expect(ids).toEqual(['c-archived', 'c-live']);
  });
});

describe('archive / unarchive round trip', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); seed(db); });
  afterEach(() => { db.close(); });

  it('archiveChunks flips archived → 1; second call returns 0 changed', () => {
    const first = archiveChunks(db, ['c-live']);
    expect(first).toBe(1);
    const second = archiveChunks(db, ['c-live']);
    expect(second).toBe(0);
  });

  it('unarchiveChunk flips archived → 0 and bumps last_accessed_at', () => {
    const at = '2026-05-14T20:00:00.000Z';
    const restored = unarchiveChunk(db, 'c-archived', at);
    expect(restored).toBe(true);
    const chunk = getChunkById(db, 'c-archived');
    expect(chunk?.archived).toBe(false);
    expect(chunk?.lastAccessedAt).toBe(at);
  });

  it('unarchive of an already-live chunk is a no-op (returns false)', () => {
    const at = '2026-05-14T21:00:00.000Z';
    const restored = unarchiveChunk(db, 'c-live', at);
    expect(restored).toBe(false);
  });

  it('unarchive of unknown id returns false (404 hint for the API layer)', () => {
    expect(unarchiveChunk(db, 'ghost', '2026-05-14T22:00:00.000Z')).toBe(false);
  });
});
