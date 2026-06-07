/**
 * Unit tests for the new auxiliary repos introduced by migration v20:
 *
 *   - knowledge_point_alias  (knowledge-point-alias.ts)
 *   - knowledge_point_rel    (knowledge-point-rel.ts)
 *   - knowledge_point_roles  (knowledge-point-roles.ts)
 *   - retrieval_log + retrieval_log_points (retrieval-log.ts)
 *   - knowledge_chunks.updateChunkWithVersionCheck (G4 optimistic lock)
 *
 * Each repo is exercised in isolation; cross-repo integration goes
 * through the e2e migration suite.
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import {
  attachRoleToPoint,
  detachRoleFromPoint,
  getPointIdsForRole,
  getRolesForPoint,
  setRolesForPoint,
} from '../../../src/storage/repos/knowledge-point-roles.js';
import {
  deleteAlias,
  getAliasesForPoint,
  getPointIdsForAlias,
  insertAlias,
  setAliasesForPoint,
} from '../../../src/storage/repos/knowledge-point-alias.js';
import {
  addRel,
  getIncomingRels,
  getOutgoingRels,
  removeRel,
} from '../../../src/storage/repos/knowledge-point-rel.js';
import {
  getPointsForRetrieval,
  getRetrievalsCitingPoint,
  getRetrievalsForSession,
  recordRetrieval,
} from '../../../src/storage/repos/retrieval-log.js';
import { updateChunkWithVersionCheck } from '../../../src/storage/repos/roles.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

/** Seed a single role + N chunks so the auxiliary repos have FK targets. */
function seedRoleAndChunks(db: BetterSqlite3.Database, roleId: string, chunkIds: string[]): void {
  db.prepare(`
    INSERT INTO roles (id, name, system_prompt, is_builtin, created_at, version)
    VALUES (?, ?, 'sp', 0, '2026-06-06T00:00:00Z', 1)
  `).run(roleId, `Role-${roleId}`);
  for (const cid of chunkIds) {
    db.prepare(`
      INSERT INTO knowledge_chunks (id, role_id, chunk_text, kind, created_at)
      VALUES (?, ?, 'body', 'spec', '2026-06-06T00:00:00Z')
    `).run(cid, roleId);
  }
}

describe('knowledge-point-roles repo (N..N)', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => {
    db = openDb();
    seedRoleAndChunks(db, 'r-a', ['p-1']);
    seedRoleAndChunks(db, 'r-b', []);
    seedRoleAndChunks(db, 'r-c', []);
  });
  afterEach(() => { db.close(); });

  it('attaches a point to multiple roles independently', () => {
    attachRoleToPoint(db, 'p-1', 'r-a');
    attachRoleToPoint(db, 'p-1', 'r-b');
    expect(getRolesForPoint(db, 'p-1').sort()).toEqual(['r-a', 'r-b']);
  });

  it('attach is idempotent (same pair twice = single row)', () => {
    attachRoleToPoint(db, 'p-1', 'r-a');
    attachRoleToPoint(db, 'p-1', 'r-a');
    expect(getRolesForPoint(db, 'p-1')).toEqual(['r-a']);
  });

  it('detach removes only the targeted pairing', () => {
    attachRoleToPoint(db, 'p-1', 'r-a');
    attachRoleToPoint(db, 'p-1', 'r-b');
    detachRoleFromPoint(db, 'p-1', 'r-a');
    expect(getRolesForPoint(db, 'p-1')).toEqual(['r-b']);
  });

  it('setRolesForPoint replaces the entire set transactionally', () => {
    attachRoleToPoint(db, 'p-1', 'r-a');
    attachRoleToPoint(db, 'p-1', 'r-b');
    setRolesForPoint(db, 'p-1', ['r-c']);
    expect(getRolesForPoint(db, 'p-1')).toEqual(['r-c']);
  });

  it('reverse lookup: getPointIdsForRole', () => {
    seedRoleAndChunks(db, 'r-d', ['p-2', 'p-3']);
    attachRoleToPoint(db, 'p-2', 'r-d');
    attachRoleToPoint(db, 'p-3', 'r-d');
    expect(getPointIdsForRole(db, 'r-d').sort()).toEqual(['p-2', 'p-3']);
  });
});

describe('knowledge-point-alias repo', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => {
    db = openDb();
    seedRoleAndChunks(db, 'r-a', ['p-1', 'p-2']);
  });
  afterEach(() => { db.close(); });

  it('inserts and reads aliases with source provenance', () => {
    insertAlias(db, 'p-1', 'TCC', 'manual', 100);
    insertAlias(db, 'p-1', '灰度发布平台', 'llm-suggested', 200);
    const aliases = getAliasesForPoint(db, 'p-1');
    expect(aliases.map((a) => a.alias).sort()).toEqual(['TCC', '灰度发布平台']);
    expect(aliases.find((a) => a.alias === 'TCC')?.source).toBe('manual');
    expect(aliases.find((a) => a.alias === '灰度发布平台')?.source).toBe('llm-suggested');
  });

  it('insert is idempotent: first source wins, second insert is a no-op', () => {
    insertAlias(db, 'p-1', 'X', 'manual', 100);
    insertAlias(db, 'p-1', 'X', 'imported', 200);
    expect(getAliasesForPoint(db, 'p-1').find((a) => a.alias === 'X')?.source).toBe('manual');
  });

  it('deleteAlias removes only the targeted alias', () => {
    insertAlias(db, 'p-1', 'A');
    insertAlias(db, 'p-1', 'B');
    deleteAlias(db, 'p-1', 'A');
    expect(getAliasesForPoint(db, 'p-1').map((a) => a.alias)).toEqual(['B']);
  });

  it('setAliasesForPoint replaces the entire alias set', () => {
    insertAlias(db, 'p-1', 'old1');
    insertAlias(db, 'p-1', 'old2');
    setAliasesForPoint(db, 'p-1', [{ alias: 'new1' }, { alias: 'new2', source: 'imported' }]);
    const final = getAliasesForPoint(db, 'p-1');
    expect(final.map((a) => a.alias).sort()).toEqual(['new1', 'new2']);
    expect(final.find((a) => a.alias === 'new2')?.source).toBe('imported');
  });

  it('reverse alias lookup hits multiple points', () => {
    insertAlias(db, 'p-1', 'shared');
    insertAlias(db, 'p-2', 'shared');
    expect(getPointIdsForAlias(db, 'shared').sort()).toEqual(['p-1', 'p-2']);
  });
});

describe('knowledge-point-rel repo', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => {
    db = openDb();
    seedRoleAndChunks(db, 'r-a', ['p-1', 'p-2', 'p-3']);
  });
  afterEach(() => { db.close(); });

  it('adds and reads outgoing edges', () => {
    addRel(db, 'p-1', 'p-2', 'includes');
    addRel(db, 'p-1', 'p-3', 'correspondsTo');
    const out = getOutgoingRels(db, 'p-1');
    expect(out.map((r) => r.toPointId).sort()).toEqual(['p-2', 'p-3']);
  });

  it('outgoing query filters by relKind', () => {
    addRel(db, 'p-1', 'p-2', 'includes');
    addRel(db, 'p-1', 'p-3', 'correspondsTo');
    const includes = getOutgoingRels(db, 'p-1', 'includes');
    expect(includes.map((r) => r.toPointId)).toEqual(['p-2']);
  });

  it('incoming query is indexed in the reverse direction', () => {
    addRel(db, 'p-1', 'p-2', 'includes');
    addRel(db, 'p-3', 'p-2', 'includes');
    const incoming = getIncomingRels(db, 'p-2', 'includes');
    expect(incoming.map((r) => r.fromPointId).sort()).toEqual(['p-1', 'p-3']);
  });

  it('add is idempotent on (from, to, kind)', () => {
    addRel(db, 'p-1', 'p-2', 'includes');
    addRel(db, 'p-1', 'p-2', 'includes');
    expect(getOutgoingRels(db, 'p-1')).toHaveLength(1);
  });

  it('self-edges throw at the repo boundary', () => {
    expect(() => addRel(db, 'p-1', 'p-1', 'includes')).toThrow(/self-edges/);
  });

  it('removeRel deletes only the targeted edge', () => {
    addRel(db, 'p-1', 'p-2', 'includes');
    addRel(db, 'p-1', 'p-3', 'includes');
    removeRel(db, 'p-1', 'p-2', 'includes');
    expect(getOutgoingRels(db, 'p-1').map((r) => r.toPointId)).toEqual(['p-3']);
  });

  it('cascades when the from-point is deleted', () => {
    addRel(db, 'p-1', 'p-2', 'includes');
    db.prepare(`DELETE FROM knowledge_chunks WHERE id = 'p-1'`).run();
    expect(getOutgoingRels(db, 'p-1')).toEqual([]);
  });
});

describe('retrieval-log repo', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => {
    db = openDb();
    seedRoleAndChunks(db, 'r-a', ['p-1', 'p-2', 'p-3']);
    db.prepare(`
      INSERT INTO host_sessions (id, host, agent_kind, status, first_seen_at, last_seen_at)
      VALUES ('s-1', 'cursor', 'cursor', 'active', '2026-06-06T00:00:00Z', '2026-06-06T00:00:00Z')
    `).run();
  });
  afterEach(() => { db.close(); });

  it('records header + point rows transactionally', () => {
    recordRetrieval(db, {
      id: 'log-1', hostSessionId: 's-1', turn: 1, queryText: 'how to roll back?', ts: 1000,
    }, [
      { pointId: 'p-1', rank: 0, fusionScore: 0.91, injected: true,
        legContrib: { bm25Rank: 0, cosineRank: 1 } },
      { pointId: 'p-2', rank: 1, fusionScore: 0.74, injected: true },
      { pointId: 'p-3', rank: 2, fusionScore: 0.50, injected: false },
    ]);
    expect(getRetrievalsForSession(db, 's-1')).toHaveLength(1);
    const points = getPointsForRetrieval(db, 'log-1');
    expect(points).toHaveLength(3);
    expect(points.map((p) => p.pointId)).toEqual(['p-1', 'p-2', 'p-3']);
    expect(points[0]!.injected).toBe(true);
    expect(points[2]!.injected).toBe(false);
    expect(points[0]!.legContrib).toEqual({ bm25Rank: 0, cosineRank: 1 });
  });

  it('reverse lookup: getRetrievalsCitingPoint', () => {
    recordRetrieval(db, { id: 'log-A', hostSessionId: 's-1', turn: 1, ts: 100 },
      [{ pointId: 'p-1', rank: 0, fusionScore: 1, injected: true }]);
    recordRetrieval(db, { id: 'log-B', hostSessionId: 's-1', turn: 2, ts: 200 },
      [{ pointId: 'p-1', rank: 0, fusionScore: 1, injected: true }]);
    recordRetrieval(db, { id: 'log-C', hostSessionId: 's-1', turn: 3, ts: 300 },
      [{ pointId: 'p-2', rank: 0, fusionScore: 1, injected: true }]);
    const cited = getRetrievalsCitingPoint(db, 'p-1');
    expect(cited.map((l) => l.id).sort()).toEqual(['log-A', 'log-B']);
  });

  it('newest-first ordering for session retrievals', () => {
    recordRetrieval(db, { id: 'log-old', hostSessionId: 's-1', turn: 1, ts: 100 }, []);
    recordRetrieval(db, { id: 'log-mid', hostSessionId: 's-1', turn: 2, ts: 200 }, []);
    recordRetrieval(db, { id: 'log-new', hostSessionId: 's-1', turn: 3, ts: 300 }, []);
    const logs = getRetrievalsForSession(db, 's-1');
    expect(logs.map((l) => l.id)).toEqual(['log-new', 'log-mid', 'log-old']);
  });

  it('cascades retrieval_log_points when the parent log is deleted', () => {
    recordRetrieval(db, { id: 'log-cas', hostSessionId: 's-1', turn: 1, ts: 100 },
      [{ pointId: 'p-1', rank: 0, fusionScore: 1, injected: true }]);
    db.prepare(`DELETE FROM retrieval_log WHERE id = 'log-cas'`).run();
    expect(getPointsForRetrieval(db, 'log-cas')).toEqual([]);
  });

  it('survives corrupt JSON in leg_contrib (returns undefined, does not crash)', () => {
    db.prepare(`
      INSERT INTO retrieval_log (id, host_session_id, turn, query_text, ts)
      VALUES ('log-bad', 's-1', 1, NULL, 1000)
    `).run();
    db.prepare(`
      INSERT INTO retrieval_log_points
        (log_id, point_id, rank, fusion_score, leg_contrib, injected)
      VALUES ('log-bad', 'p-1', 0, 0.5, 'not-json{{{', 1)
    `).run();
    const points = getPointsForRetrieval(db, 'log-bad');
    expect(points).toHaveLength(1);
    expect(points[0]!.legContrib).toBeUndefined();
  });
});

describe('updateChunkWithVersionCheck (G4 optimistic lock)', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => {
    db = openDb();
    seedRoleAndChunks(db, 'r-a', ['p-1']);
  });
  afterEach(() => { db.close(); });

  it('updates and bumps edit_version + version_ext on a matching version', () => {
    const r = updateChunkWithVersionCheck(db, 'p-1', 1, { title: 'New title', body: 'New body' });
    expect(r.applied).toBe(true);
    expect(r.newEditVersion).toBe(2);
    const row = db.prepare(`
      SELECT title, chunk_text, edit_version, version_ext
        FROM knowledge_chunks WHERE id = 'p-1'
    `).get() as { title: string; chunk_text: string; edit_version: number; version_ext: number };
    expect(row.title).toBe('New title');
    expect(row.chunk_text).toBe('New body');
    expect(row.edit_version).toBe(2);
    expect(row.version_ext).toBe(2);
  });

  it('returns applied=false on stale version (no clobber, no bump)', () => {
    updateChunkWithVersionCheck(db, 'p-1', 1, { title: 'first writer' });
    const r = updateChunkWithVersionCheck(db, 'p-1', 1, { title: 'second writer' });
    expect(r.applied).toBe(false);
    const row = db.prepare(`SELECT title, edit_version FROM knowledge_chunks WHERE id = 'p-1'`)
      .get() as { title: string; edit_version: number };
    expect(row.title).toBe('first writer');
    expect(row.edit_version).toBe(2);
  });

  it('preserves columns where input is undefined (COALESCE semantics)', () => {
    updateChunkWithVersionCheck(db, 'p-1', 1, { title: 'set' });
    // Read what we just wrote; pass only chunk_text the next time.
    const r = updateChunkWithVersionCheck(db, 'p-1', 2, { body: 'changed body' });
    expect(r.applied).toBe(true);
    const row = db.prepare(`SELECT title, chunk_text FROM knowledge_chunks WHERE id = 'p-1'`)
      .get() as { title: string; chunk_text: string };
    expect(row.title).toBe('set');
    expect(row.chunk_text).toBe('changed body');
  });

  it('serializes source as JSON when provided', () => {
    updateChunkWithVersionCheck(db, 'p-1', 1, {
      source: { kind: 'conversation', ref: 'chat-42' },
    });
    const row = db.prepare(`SELECT source FROM knowledge_chunks WHERE id = 'p-1'`)
      .get() as { source: string };
    expect(JSON.parse(row.source)).toEqual({ kind: 'conversation', ref: 'chat-42' });
  });
});
