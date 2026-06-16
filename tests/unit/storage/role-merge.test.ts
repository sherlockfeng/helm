import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getRole, insertChunk, insertChunkEntity, listChunkEntities, mergeRole, upsertRole,
} from '../../../src/storage/repos/roles.js';
import { runMigrations } from '../../../src/storage/migrations.js';
import type { KnowledgeChunk, Role } from '../../../src/storage/types.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeRole(overrides: Partial<Role> = {}): Role {
  return {
    id: 'r1', name: 'Topic', systemPrompt: 'prompt',
    isBuiltin: false, createdAt: new Date().toISOString(),
    version: 1, bindable: true,
    ...overrides,
  };
}

function makeChunk(overrides: Partial<KnowledgeChunk> = {}): KnowledgeChunk {
  return {
    id: 'c1', roleId: 'A', chunkText: 'hello',
    kind: 'other', createdAt: new Date().toISOString(),
    accessCount: 0, archived: false, editVersion: 1,
    visibility: 'internal', versionExt: 1,
    ...overrides,
  };
}

describe('mergeRole', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); });
  afterEach(() => { db.close(); });

  it('moves all of A into B and deletes A', () => {
    upsertRole(db, makeRole({ id: 'A', name: 'A' }));
    upsertRole(db, makeRole({ id: 'B', name: 'B' }));

    // chunk under A with a chat-captured source_file pointing at A's segment.
    insertChunk(db, makeChunk({
      id: 'c1', roleId: 'A', sourceFile: 'chat-captured/u/A/x.md',
    }));
    insertChunkEntity(db, {
      chunkId: 'c1', roleId: 'A', entity: 'gateway',
      createdAt: new Date().toISOString(),
    });

    // chat_knowledge_point suggesting A.
    db.prepare(`
      INSERT INTO host_sessions (id, host, first_seen_at, last_seen_at)
      VALUES ('s1', 'h', 'now', 'now')
    `).run();
    db.prepare(`
      INSERT INTO chat_knowledge_points
        (id, host_session_id, title, body, kind, suggested_role_id, text_hash, status, created_at)
      VALUES ('p1', 's1', 't', 'b', 'other', 'A', 'hash1', 'pending', 'now')
    `).run();

    // benchmark case targeting A.
    db.prepare(`
      INSERT INTO benchmark_case (id, name, question, expected_truth, proposed_at, created_at, updated_at)
      VALUES ('case1', 'c', 'q', 'truth', 0, 0, 0)
    `).run();
    db.prepare(`
      INSERT INTO benchmark_case_target_role (case_id, role_id) VALUES ('case1', 'A')
    `).run();

    const res = mergeRole(db, 'A', 'B');
    expect(res.ok).toBe(true);
    expect(res.chunksMoved).toBe(1);

    // A is gone.
    expect(getRole(db, 'A')).toBeUndefined();

    // chunk moved to B + source_file rewritten.
    const chunk = db.prepare(
      `SELECT role_id, source_file FROM knowledge_chunks WHERE id = 'c1'`,
    ).get() as { role_id: string; source_file: string };
    expect(chunk.role_id).toBe('B');
    expect(chunk.source_file).toBe('chat-captured/u/B/x.md');

    // entity moved.
    const entRole = db.prepare(
      `SELECT role_id FROM knowledge_chunk_entities WHERE chunk_id = 'c1' AND entity = 'gateway'`,
    ).get() as { role_id: string };
    expect(entRole.role_id).toBe('B');
    expect(listChunkEntities(db, 'c1')).toHaveLength(1);

    // chat point suggestion moved.
    const point = db.prepare(
      `SELECT suggested_role_id FROM chat_knowledge_points WHERE id = 'p1'`,
    ).get() as { suggested_role_id: string };
    expect(point.suggested_role_id).toBe('B');

    // case target moved.
    const target = db.prepare(
      `SELECT role_id FROM benchmark_case_target_role WHERE case_id = 'case1'`,
    ).get() as { role_id: string };
    expect(target.role_id).toBe('B');
  });

  it('rejects merging a role into itself', () => {
    upsertRole(db, makeRole({ id: 'A', name: 'A' }));
    expect(mergeRole(db, 'A', 'A')).toEqual({ ok: false, reason: 'same' });
  });

  it('rejects merging a builtin source', () => {
    upsertRole(db, makeRole({ id: 'A', name: 'A', isBuiltin: true }));
    upsertRole(db, makeRole({ id: 'B', name: 'B' }));
    expect(mergeRole(db, 'A', 'B')).toEqual({ ok: false, reason: 'from_builtin' });
  });

  it('returns from_missing / to_missing for unknown roles', () => {
    upsertRole(db, makeRole({ id: 'B', name: 'B' }));
    expect(mergeRole(db, 'A', 'B')).toEqual({ ok: false, reason: 'from_missing' });
    expect(mergeRole(db, 'B', 'Z')).toEqual({ ok: false, reason: 'to_missing' });
  });
});
