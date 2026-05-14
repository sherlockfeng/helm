/**
 * FTS5 virtual table sync (Phase 76 — migration v13).
 *
 * Pins:
 *   - INSERT on knowledge_chunks → row visible in FTS5
 *   - UPDATE on knowledge_chunks → FTS5 row's text updates
 *   - DELETE on knowledge_chunks → FTS5 row disappears
 *   - Cascade DELETE (via knowledge_sources / roles) → FTS5 also cascades
 *
 * If any trigger gets dropped in a future migration these tests fail loudly
 * — the FTS5 index would otherwise silently desync from the main table.
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  insertChunk,
  insertSource,
  upsertRole,
} from '../../../src/storage/repos/roles.js';
import { runMigrations } from '../../../src/storage/migrations.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedRoleWithSource(db: BetterSqlite3.Database): { roleId: string; sourceId: string } {
  const roleId = 'r1';
  const sourceId = 'src1';
  const now = new Date().toISOString();
  upsertRole(db, { id: roleId, name: 'R1', systemPrompt: 'p', isBuiltin: false, createdAt: now });
  insertSource(db, {
    id: sourceId, roleId, kind: 'file', origin: 'spec.md', fingerprint: 'fp',
    createdAt: now,
  });
  return { roleId, sourceId };
}

function ftsRowCount(db: BetterSqlite3.Database, query?: string): number {
  if (query) {
    return (db.prepare(`SELECT COUNT(*) AS n FROM knowledge_chunks_fts WHERE chunk_text MATCH ?`).get(query) as { n: number }).n;
  }
  return (db.prepare(`SELECT COUNT(*) AS n FROM knowledge_chunks_fts`).get() as { n: number }).n;
}

describe('FTS5 trigger sync (migration v13)', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); });
  afterEach(() => { db.close(); });

  it('INSERT on knowledge_chunks adds a matching FTS5 row', () => {
    const { roleId, sourceId } = seedRoleWithSource(db);
    insertChunk(db, {
      id: 'c1', roleId, chunkText: 'TCE rollback runbook is here', kind: 'runbook',
      sourceId, createdAt: new Date().toISOString(),
    });
    expect(ftsRowCount(db)).toBe(1);
    expect(ftsRowCount(db, '"tce"*')).toBeGreaterThan(0);
    expect(ftsRowCount(db, '"rollback"*')).toBeGreaterThan(0);
  });

  it('UPDATE on knowledge_chunks updates the FTS5 row', () => {
    const { roleId, sourceId } = seedRoleWithSource(db);
    insertChunk(db, {
      id: 'c1', roleId, chunkText: 'original text', kind: 'other',
      sourceId, createdAt: new Date().toISOString(),
    });
    expect(ftsRowCount(db, '"original"*')).toBeGreaterThan(0);
    expect(ftsRowCount(db, '"updated"*')).toBe(0);

    db.prepare(`UPDATE knowledge_chunks SET chunk_text = ? WHERE id = ?`).run('updated text', 'c1');
    expect(ftsRowCount(db, '"original"*')).toBe(0);
    expect(ftsRowCount(db, '"updated"*')).toBeGreaterThan(0);
  });

  it('DELETE on knowledge_chunks removes the FTS5 row', () => {
    const { roleId, sourceId } = seedRoleWithSource(db);
    insertChunk(db, {
      id: 'c1', roleId, chunkText: 'rollback procedure step 1', kind: 'runbook',
      sourceId, createdAt: new Date().toISOString(),
    });
    expect(ftsRowCount(db)).toBe(1);
    db.prepare(`DELETE FROM knowledge_chunks WHERE id = ?`).run('c1');
    expect(ftsRowCount(db)).toBe(0);
  });

  it('cascading DELETE via knowledge_sources also wipes FTS5 rows', () => {
    const { roleId, sourceId } = seedRoleWithSource(db);
    insertChunk(db, {
      id: 'c1', roleId, chunkText: 'derived from spec.md', kind: 'spec',
      sourceId, createdAt: new Date().toISOString(),
    });
    insertChunk(db, {
      id: 'c2', roleId, chunkText: 'also from spec.md', kind: 'spec',
      sourceId, createdAt: new Date().toISOString(),
    });
    expect(ftsRowCount(db)).toBe(2);

    db.prepare(`DELETE FROM knowledge_sources WHERE id = ?`).run(sourceId);
    expect(ftsRowCount(db)).toBe(0);
  });

  it('cascading DELETE via roles also wipes FTS5 rows (and chunks, and sources)', () => {
    const { roleId, sourceId } = seedRoleWithSource(db);
    insertChunk(db, {
      id: 'c1', roleId, chunkText: 'whatever', kind: 'other',
      sourceId, createdAt: new Date().toISOString(),
    });
    db.prepare(`DELETE FROM roles WHERE id = ?`).run(roleId);
    expect(ftsRowCount(db)).toBe(0);
  });

  it('insert / delete cycle in the same DB connection keeps the index lean', () => {
    const { roleId, sourceId } = seedRoleWithSource(db);
    for (let i = 0; i < 5; i++) {
      insertChunk(db, {
        id: `c${i}`, roleId, chunkText: `chunk number ${i}`, kind: 'other',
        sourceId, createdAt: new Date().toISOString(),
      });
    }
    expect(ftsRowCount(db)).toBe(5);
    db.prepare(`DELETE FROM knowledge_chunks`).run();
    expect(ftsRowCount(db)).toBe(0);
  });
});
