/**
 * Unit tests for the retrieval_log writer wired into LocalRolesProvider
 * (PR 3.1). Validates:
 *
 *   1. With a hostSessionId, every search() writes one retrieval_log row
 *      + one retrieval_log_points row per fused hit.
 *   2. Without a hostSessionId (e.g. bare MCP `search_knowledge` from a
 *      detached agent), search() still returns hits but writes nothing.
 *   3. A writer failure does NOT throw out of search() — the audit row
 *      is best-effort.
 *   4. The recorded `pointId` matches the canonical knowledge_chunks.id
 *      (and not, say, sourceFile or some other identifier) so
 *      KnowledgePoint Detail reverse-lookups land on the right row.
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { LocalRolesProvider } from '../../../src/knowledge/local-roles-provider.js';
import { trainRole } from '../../../src/roles/library.js';
import { getRetrievalsForSession, getPointsForRetrieval } from '../../../src/storage/repos/retrieval-log.js';

function fakeEmbedder(): (text: string) => Promise<Float32Array> {
  // Cheap deterministic embedder so the writer wires up without a model:
  // a fixed 4-dim vector that varies only by string length. Two distinct
  // queries cosine-collapse, but that's fine — we're not testing recall.
  return async (text: string) => {
    const v = new Float32Array(4);
    v[0] = (text.length % 7) / 7;
    v[1] = (text.length % 5) / 5;
    v[2] = (text.length % 3) / 3;
    v[3] = 1;
    return v;
  };
}

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

async function seedRoleWithChunks(
  db: BetterSqlite3.Database,
  embedFn: (text: string) => Promise<Float32Array>,
): Promise<string> {
  const roleId = 'r-pr3';
  await trainRole(db, {
    roleId, name: 'PR3 Role',
    documents: [{
      filename: 'doc.md',
      content: [
        '# rollback runbook',
        '',
        'rollback step one: pause the gate.',
        '',
        'rollback step two: wait sixty seconds before resuming.',
      ].join('\n'),
    }],
    embedFn,
  });
  return roleId;
}

describe('LocalRolesProvider.search → retrieval_log writer (PR 3.1)', () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => { db = openDb(); });
  afterEach(() => { db.close(); });

  it('writes a retrieval_log row + per-point rows when ctx.hostSessionId is set', async () => {
    const embedFn = fakeEmbedder();
    await seedRoleWithChunks(db, embedFn);
    db.prepare(`
      INSERT INTO host_sessions (id, host, agent_kind, status, first_seen_at, last_seen_at)
      VALUES ('s-1', 'cursor', 'cursor', 'active', ?, ?)
    `).run(new Date().toISOString(), new Date().toISOString());

    const provider = new LocalRolesProvider({ db, embedFn });
    const hits = await provider.search('rollback', {
      hostSessionId: 's-1', cwd: '/tmp', turn: 3,
    });
    expect(hits.length).toBeGreaterThan(0);

    const logs = getRetrievalsForSession(db, 's-1');
    expect(logs).toHaveLength(1);
    expect(logs[0]!.turn).toBe(3);
    expect(logs[0]!.queryText).toBe('rollback');

    const points = getPointsForRetrieval(db, logs[0]!.id);
    expect(points.length).toBe(hits.length);
    expect(points.every((p) => p.injected)).toBe(true);
    // Ranks are 0..N-1 in fused order.
    expect(points.map((p) => p.rank)).toEqual(points.map((_, i) => i));
  });

  it('persists pointId as the canonical knowledge_chunks.id', async () => {
    const embedFn = fakeEmbedder();
    const roleId = await seedRoleWithChunks(db, embedFn);
    db.prepare(`
      INSERT INTO host_sessions (id, host, agent_kind, status, first_seen_at, last_seen_at)
      VALUES ('s-1', 'cursor', 'cursor', 'active', ?, ?)
    `).run(new Date().toISOString(), new Date().toISOString());

    const provider = new LocalRolesProvider({ db, embedFn });
    await provider.search('rollback', { hostSessionId: 's-1', cwd: '/tmp' });

    const chunkIds = (db.prepare(
      `SELECT id FROM knowledge_chunks WHERE role_id = ?`,
    ).all(roleId) as { id: string }[]).map((r) => r.id);
    const logs = getRetrievalsForSession(db, 's-1');
    const recordedIds = getPointsForRetrieval(db, logs[0]!.id).map((p) => p.pointId);
    expect(recordedIds.every((id) => chunkIds.includes(id))).toBe(true);
  });

  it('omits the writer when ctx.hostSessionId is missing', async () => {
    const embedFn = fakeEmbedder();
    await seedRoleWithChunks(db, embedFn);
    const provider = new LocalRolesProvider({ db, embedFn });
    const hits = await provider.search('rollback');
    expect(hits.length).toBeGreaterThan(0);
    // No session row, no log row.
    const count = db.prepare(`SELECT COUNT(*) AS n FROM retrieval_log`).get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('does not throw out of search() when the writer fails', async () => {
    const embedFn = fakeEmbedder();
    await seedRoleWithChunks(db, embedFn);
    db.prepare(`
      INSERT INTO host_sessions (id, host, agent_kind, status, first_seen_at, last_seen_at)
      VALUES ('s-1', 'cursor', 'cursor', 'active', ?, ?)
    `).run(new Date().toISOString(), new Date().toISOString());

    // Force a writer failure: drop the retrieval_log table mid-test.
    db.prepare(`DROP TABLE retrieval_log_points`).run();
    db.prepare(`DROP TABLE retrieval_log`).run();

    const provider = new LocalRolesProvider({ db, embedFn });
    // Should NOT throw — audit failure must not break the chat surface.
    await expect(provider.search('rollback', {
      hostSessionId: 's-1', cwd: '/tmp',
    })).resolves.toBeInstanceOf(Array);
  });

  it('defaults turn to 0 when caller omits it', async () => {
    const embedFn = fakeEmbedder();
    await seedRoleWithChunks(db, embedFn);
    db.prepare(`
      INSERT INTO host_sessions (id, host, agent_kind, status, first_seen_at, last_seen_at)
      VALUES ('s-no-turn', 'cursor', 'cursor', 'active', ?, ?)
    `).run(new Date().toISOString(), new Date().toISOString());
    const provider = new LocalRolesProvider({ db, embedFn });
    await provider.search('rollback', { hostSessionId: 's-no-turn', cwd: '/tmp' });
    const logs = getRetrievalsForSession(db, 's-no-turn');
    expect(logs[0]!.turn).toBe(0);
  });
});
