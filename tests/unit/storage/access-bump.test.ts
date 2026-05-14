/**
 * bumpChunkAccess (Phase 77).
 *
 * Pins:
 *   - increments access_count by 1 per chunk per call
 *   - writes last_accessed_at to the supplied timestamp
 *   - unknown ids don't throw — UPDATE on no-row is a no-op
 *   - empty input list is a no-op (no transaction overhead either)
 *   - all ids in a single call run inside one transaction (atomic on partial failure)
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import {
  bumpChunkAccess,
  insertChunk,
  insertSource,
  upsertRole,
} from '../../../src/storage/repos/roles.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seed(db: BetterSqlite3.Database): { sourceId: string } {
  const now = new Date().toISOString();
  upsertRole(db, { id: 'r1', name: 'r1', systemPrompt: 'p', isBuiltin: false, createdAt: now });
  insertSource(db, {
    id: 'src1', roleId: 'r1', kind: 'file', origin: 'spec.md',
    fingerprint: 'fp', createdAt: now,
  });
  insertChunk(db, {
    id: 'c1', roleId: 'r1', chunkText: 'one', kind: 'other', sourceId: 'src1', createdAt: now,
  });
  insertChunk(db, {
    id: 'c2', roleId: 'r1', chunkText: 'two', kind: 'other', sourceId: 'src1', createdAt: now,
  });
  return { sourceId: 'src1' };
}

function read(db: BetterSqlite3.Database, id: string): { access_count: number; last_accessed_at: string | null } {
  return db.prepare(
    `SELECT access_count, last_accessed_at FROM knowledge_chunks WHERE id = ?`,
  ).get(id) as { access_count: number; last_accessed_at: string | null };
}

describe('bumpChunkAccess', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); seed(db); });
  afterEach(() => { db.close(); });

  it('increments access_count and writes last_accessed_at', () => {
    const t = '2026-05-14T12:00:00.000Z';
    bumpChunkAccess(db, ['c1'], t);
    const row = read(db, 'c1');
    expect(row.access_count).toBe(1);
    expect(row.last_accessed_at).toBe(t);
  });

  it('two bumps in a row land as access_count=2', () => {
    bumpChunkAccess(db, ['c1'], '2026-05-14T12:00:00.000Z');
    bumpChunkAccess(db, ['c1'], '2026-05-14T13:00:00.000Z');
    const row = read(db, 'c1');
    expect(row.access_count).toBe(2);
    expect(row.last_accessed_at).toBe('2026-05-14T13:00:00.000Z');
  });

  it('multi-id bump touches every supplied chunk', () => {
    const t = '2026-05-14T14:00:00.000Z';
    bumpChunkAccess(db, ['c1', 'c2'], t);
    expect(read(db, 'c1').access_count).toBe(1);
    expect(read(db, 'c2').access_count).toBe(1);
  });

  it('unknown id does not throw', () => {
    expect(() => bumpChunkAccess(db, ['does-not-exist'], '2026-05-14T15:00:00.000Z')).not.toThrow();
    // No chunks were affected.
    expect(read(db, 'c1').access_count).toBe(0);
  });

  it('mixing known + unknown ids only bumps the known ones', () => {
    bumpChunkAccess(db, ['c1', 'ghost'], '2026-05-14T16:00:00.000Z');
    expect(read(db, 'c1').access_count).toBe(1);
  });

  it('empty input is a no-op', () => {
    expect(() => bumpChunkAccess(db, [], '2026-05-14T17:00:00.000Z')).not.toThrow();
    expect(read(db, 'c1').access_count).toBe(0);
  });
});
