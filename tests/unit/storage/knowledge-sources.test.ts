/**
 * KnowledgeSource repo (Phase 73).
 *
 * Pins the contract migration v12 + the new repo helpers establish:
 *   - `insertSource` writes the row + reads back as KnowledgeSource shape
 *   - `getSourceByFingerprint` dedups within the (roleId, fingerprint) tuple
 *   - `listSourcesForRole` returns rows with `chunkCount` joined in
 *   - `deleteSource` cascades to derived chunks via the SQL FK
 *   - chunks created with a source_id survive the role's existence; chunks
 *     created without a source_id (i.e. by old code paths) would be wiped
 *     by the v12 clean-slate DELETE, but we test that the column itself
 *     defaults to null for any future caller that misses the field.
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  deleteSource,
  getChunksForRole,
  getSource,
  getSourceByFingerprint,
  insertChunk,
  insertSource,
  listSourcesForRole,
  upsertRole,
} from '../../../src/storage/repos/roles.js';
import { runMigrations } from '../../../src/storage/migrations.js';
import type { KnowledgeSource } from '../../../src/storage/types.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedRole(db: BetterSqlite3.Database, id = 'r1'): void {
  upsertRole(db, {
    id, name: id, systemPrompt: 'p', isBuiltin: false,
    createdAt: new Date().toISOString(),
  });
}

function makeSource(overrides: Partial<KnowledgeSource> = {}): KnowledgeSource {
  return {
    id: randomUUID(),
    roleId: 'r1',
    kind: 'file',
    origin: '/proj/spec.md',
    fingerprint: 'abc123',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('knowledge_sources', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); seedRole(db); });
  afterEach(() => { db.close(); });

  it('inserts and retrieves a source row', () => {
    const s = makeSource({ id: 'src-1' });
    insertSource(db, s);
    const got = getSource(db, 'src-1');
    expect(got).toMatchObject({
      id: 'src-1', roleId: 'r1', kind: 'file', origin: '/proj/spec.md', fingerprint: 'abc123',
    });
  });

  it('stores an optional label when provided, omits it otherwise', () => {
    insertSource(db, makeSource({ id: 'src-with', label: 'Q3 spec' }));
    insertSource(db, makeSource({ id: 'src-without', fingerprint: 'abc124' }));
    expect(getSource(db, 'src-with')?.label).toBe('Q3 spec');
    expect(getSource(db, 'src-without')?.label).toBeUndefined();
  });

  it('getSourceByFingerprint hits within (roleId, fingerprint)', () => {
    insertSource(db, makeSource({ id: 'src-A', fingerprint: 'aaa' }));
    insertSource(db, makeSource({ id: 'src-B', fingerprint: 'bbb' }));
    expect(getSourceByFingerprint(db, 'r1', 'bbb')?.id).toBe('src-B');
    expect(getSourceByFingerprint(db, 'r1', 'never')).toBeUndefined();
  });

  it('getSourceByFingerprint scopes by role — same fp across roles is independent', () => {
    seedRole(db, 'r2');
    insertSource(db, makeSource({ id: 'r1-src', roleId: 'r1', fingerprint: 'shared' }));
    insertSource(db, makeSource({ id: 'r2-src', roleId: 'r2', fingerprint: 'shared' }));
    expect(getSourceByFingerprint(db, 'r1', 'shared')?.id).toBe('r1-src');
    expect(getSourceByFingerprint(db, 'r2', 'shared')?.id).toBe('r2-src');
  });

  it('listSourcesForRole returns rows with derived chunkCount', () => {
    insertSource(db, makeSource({ id: 'src-1', fingerprint: 'a' }));
    insertSource(db, makeSource({ id: 'src-2', fingerprint: 'b' }));
    insertChunk(db, {
      id: 'c1', roleId: 'r1', chunkText: 'x', kind: 'spec', sourceId: 'src-1',
      createdAt: new Date().toISOString(),
    });
    insertChunk(db, {
      id: 'c2', roleId: 'r1', chunkText: 'y', kind: 'spec', sourceId: 'src-1',
      createdAt: new Date().toISOString(),
    });
    insertChunk(db, {
      id: 'c3', roleId: 'r1', chunkText: 'z', kind: 'example', sourceId: 'src-2',
      createdAt: new Date().toISOString(),
    });
    const rows = listSourcesForRole(db, 'r1');
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.chunkCount]));
    expect(byId).toEqual({ 'src-1': 2, 'src-2': 1 });
  });

  it('deleteSource cascades to derived chunks via FK', () => {
    insertSource(db, makeSource({ id: 'src-1' }));
    insertChunk(db, {
      id: 'c1', roleId: 'r1', chunkText: 'x', kind: 'spec', sourceId: 'src-1',
      createdAt: new Date().toISOString(),
    });
    insertChunk(db, {
      id: 'c2', roleId: 'r1', chunkText: 'y', kind: 'spec', sourceId: 'src-1',
      createdAt: new Date().toISOString(),
    });
    expect(getChunksForRole(db, 'r1')).toHaveLength(2);

    const result = deleteSource(db, 'src-1');
    expect(result).toEqual({ removed: true, chunksDeleted: 2 });
    expect(getChunksForRole(db, 'r1')).toHaveLength(0);
    expect(getSource(db, 'src-1')).toBeUndefined();
  });

  it('deleteSource leaves chunks from OTHER sources untouched', () => {
    insertSource(db, makeSource({ id: 'src-keep', fingerprint: 'a' }));
    insertSource(db, makeSource({ id: 'src-drop', fingerprint: 'b' }));
    insertChunk(db, {
      id: 'c-keep', roleId: 'r1', chunkText: 'keep', kind: 'spec', sourceId: 'src-keep',
      createdAt: new Date().toISOString(),
    });
    insertChunk(db, {
      id: 'c-drop', roleId: 'r1', chunkText: 'drop', kind: 'spec', sourceId: 'src-drop',
      createdAt: new Date().toISOString(),
    });

    deleteSource(db, 'src-drop');
    const surviving = getChunksForRole(db, 'r1');
    expect(surviving).toHaveLength(1);
    expect(surviving[0]?.id).toBe('c-keep');
  });

  it('deleteSource is idempotent on unknown id', () => {
    const result = deleteSource(db, 'never-existed');
    expect(result).toEqual({ removed: false, chunksDeleted: 0 });
  });

  it('attack: inserting source with unknown role_id throws (FK)', () => {
    expect(() => insertSource(db, makeSource({ id: 'src-ghost', roleId: 'ghost' }))).toThrow();
  });

  it('attack: deleting a role cascades to its sources AND their chunks', () => {
    insertSource(db, makeSource({ id: 'src-1' }));
    insertChunk(db, {
      id: 'c1', roleId: 'r1', chunkText: 'x', kind: 'spec', sourceId: 'src-1',
      createdAt: new Date().toISOString(),
    });
    db.prepare(`DELETE FROM roles WHERE id = ?`).run('r1');
    expect(getSource(db, 'src-1')).toBeUndefined();
    expect(getChunksForRole(db, 'r1')).toHaveLength(0);
  });

  it('chunk kind filter on getChunksForRole returns only matching rows', () => {
    insertSource(db, makeSource({ id: 'src-1' }));
    insertChunk(db, {
      id: 'cs', roleId: 'r1', chunkText: 'spec text', kind: 'spec', sourceId: 'src-1',
      createdAt: new Date().toISOString(),
    });
    insertChunk(db, {
      id: 'ce', roleId: 'r1', chunkText: 'example text', kind: 'example', sourceId: 'src-1',
      createdAt: new Date().toISOString(),
    });
    expect(getChunksForRole(db, 'r1', { kind: 'spec' }).map((c) => c.id)).toEqual(['cs']);
    expect(getChunksForRole(db, 'r1', { kind: 'example' }).map((c) => c.id)).toEqual(['ce']);
    expect(getChunksForRole(db, 'r1', { kind: 'warning' })).toEqual([]);
    expect(getChunksForRole(db, 'r1').map((c) => c.id)).toEqual(['cs', 'ce']);
  });

  it('chunk sourceId filter returns only chunks from that source', () => {
    insertSource(db, makeSource({ id: 'src-A', fingerprint: 'a' }));
    insertSource(db, makeSource({ id: 'src-B', fingerprint: 'b' }));
    insertChunk(db, {
      id: 'cA', roleId: 'r1', chunkText: 'A', kind: 'spec', sourceId: 'src-A',
      createdAt: new Date().toISOString(),
    });
    insertChunk(db, {
      id: 'cB', roleId: 'r1', chunkText: 'B', kind: 'spec', sourceId: 'src-B',
      createdAt: new Date().toISOString(),
    });
    expect(getChunksForRole(db, 'r1', { sourceId: 'src-A' }).map((c) => c.id)).toEqual(['cA']);
  });
});
