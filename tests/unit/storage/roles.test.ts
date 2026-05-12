import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteChunksForRole, deleteRole, getAgentSession, getChunksForRole, getRole,
  insertChunk, listRoles, upsertAgentSession, upsertRole,
} from '../../../src/storage/repos/roles.js';
import { runMigrations } from '../../../src/storage/migrations.js';
import type { AgentSession, KnowledgeChunk, Role } from '../../../src/storage/types.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeRole(overrides: Partial<Role> = {}): Role {
  return { id: 'r1', name: 'Dev', systemPrompt: 'You are a dev', isBuiltin: false, createdAt: new Date().toISOString(), ...overrides };
}

describe('roles', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); });
  afterEach(() => { db.close(); });

  it('upserts and retrieves a role', () => {
    upsertRole(db, makeRole());
    expect(getRole(db, 'r1')?.name).toBe('Dev');
  });

  it('upsert updates name and systemPrompt on conflict', () => {
    upsertRole(db, makeRole());
    upsertRole(db, makeRole({ name: 'Updated Dev', systemPrompt: 'new prompt' }));
    const got = getRole(db, 'r1');
    expect(got?.name).toBe('Updated Dev');
    expect(got?.systemPrompt).toBe('new prompt');
  });

  it('lists roles: builtins first, then alphabetical', () => {
    upsertRole(db, makeRole({ id: 'r1', name: 'Zebra', isBuiltin: false }));
    upsertRole(db, makeRole({ id: 'r2', name: 'Alpha', isBuiltin: true }));
    upsertRole(db, makeRole({ id: 'r3', name: 'Middle', isBuiltin: false }));
    const list = listRoles(db);
    expect(list[0]?.id).toBe('r2');
  });

  it('deletes role and cascades to chunks', () => {
    upsertRole(db, makeRole());
    insertChunk(db, { id: 'ch1', roleId: 'r1', chunkText: 'x', kind: 'other', createdAt: new Date().toISOString() });
    deleteRole(db, 'r1');
    expect(getRole(db, 'r1')).toBeUndefined();
    expect(getChunksForRole(db, 'r1')).toHaveLength(0);
  });

  it('attack: getRole on missing id returns undefined', () => {
    expect(getRole(db, 'ghost')).toBeUndefined();
  });
});

describe('knowledge chunks', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); upsertRole(db, makeRole()); });
  afterEach(() => { db.close(); });

  it('inserts and retrieves chunks for a role', () => {
    const chunk: KnowledgeChunk = { id: 'ch1', roleId: 'r1', chunkText: 'hello world', kind: 'other', createdAt: new Date().toISOString() };
    insertChunk(db, chunk);
    const list = getChunksForRole(db, 'r1');
    expect(list).toHaveLength(1);
    expect(list[0]?.chunkText).toBe('hello world');
  });

  it('stores and retrieves embedding blob', () => {
    const embedding = new Float32Array([0.1, 0.2, 0.3]);
    insertChunk(db, { id: 'ch1', roleId: 'r1', chunkText: 'vec', embedding, kind: 'other', createdAt: new Date().toISOString() });
    const got = getChunksForRole(db, 'r1')[0];
    expect(got?.embedding).toBeInstanceOf(Float32Array);
    const values = Array.from(got!.embedding!);
    expect(values[0]).toBeCloseTo(0.1, 5);
    expect(values[1]).toBeCloseTo(0.2, 5);
    expect(values[2]).toBeCloseTo(0.3, 5);
  });

  it('deleteChunksForRole removes all chunks', () => {
    insertChunk(db, { id: 'ch1', roleId: 'r1', chunkText: 'a', kind: 'other', createdAt: new Date().toISOString() });
    insertChunk(db, { id: 'ch2', roleId: 'r1', chunkText: 'b', kind: 'other', createdAt: new Date().toISOString() });
    deleteChunksForRole(db, 'r1');
    expect(getChunksForRole(db, 'r1')).toHaveLength(0);
  });

  it('attack: chunk with non-existent roleId throws (FK)', () => {
    expect(() => insertChunk(db, { id: 'ch1', roleId: 'ghost', chunkText: 'x', kind: 'other', createdAt: new Date().toISOString() })).toThrow();
  });
});

describe('agent sessions', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); upsertRole(db, makeRole()); });
  afterEach(() => { db.close(); });

  it('upserts and retrieves an agent session', () => {
    const session: AgentSession = { provider: 'cursor', roleId: 'r1', sessionId: 's1', externalId: 'ext1', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    upsertAgentSession(db, session);
    const got = getAgentSession(db, 'cursor', 'r1', 's1');
    expect(got?.externalId).toBe('ext1');
  });

  it('upsert updates externalId on conflict', () => {
    const base: AgentSession = { provider: 'cursor', roleId: 'r1', sessionId: 's1', externalId: 'old', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    upsertAgentSession(db, base);
    upsertAgentSession(db, { ...base, externalId: 'new' });
    expect(getAgentSession(db, 'cursor', 'r1', 's1')?.externalId).toBe('new');
  });

  it('attack: session with non-existent roleId throws (FK)', () => {
    const session: AgentSession = { provider: 'cursor', roleId: 'ghost', sessionId: 's1', externalId: 'x', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    expect(() => upsertAgentSession(db, session)).toThrow();
  });
});
