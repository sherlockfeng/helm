import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { upsertHostSession, listHostSessionRoles } from '../../../src/storage/repos/host-sessions.js';
import { appendHostEvent } from '../../../src/storage/repos/host-event-log.js';
import { upsertRole } from '../../../src/storage/repos/roles.js';
import { suggestRolesForChat } from '../../../src/knowledge/chat-role-suggester.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedSession(db: BetterSqlite3.Database, id = 's1'): void {
  const now = new Date().toISOString();
  upsertHostSession(db, { id, host: 'claude-code', status: 'active', firstSeenAt: now, lastSeenAt: now });
}

function seedRoleWithEntities(
  db: BetterSqlite3.Database,
  roleId: string,
  roleName: string,
  entities: readonly string[],
): void {
  upsertRole(db, { id: roleId, name: roleName, systemPrompt: 'p', isBuiltin: false, createdAt: 't' });
  // Insert one synthetic chunk per role so the entities can hang off it
  const chunkId = `chunk-${roleId}`;
  db.prepare(`
    INSERT INTO knowledge_chunks (id, role_id, chunk_text, kind, created_at)
    VALUES (?, ?, 'body', 'spec', datetime('now'))
  `).run(chunkId, roleId);
  const stmt = db.prepare(`
    INSERT INTO knowledge_chunk_entities (chunk_id, role_id, entity, weight, created_at)
    VALUES (?, ?, ?, 1.0, datetime('now'))
  `);
  for (const e of entities) stmt.run(chunkId, roleId, e);
}

function appendPrompt(db: BetterSqlite3.Database, sid: string, text: string): void {
  appendHostEvent(db, {
    hostSessionId: sid, kind: 'prompt', payload: { text }, createdAt: new Date().toISOString(),
  });
}
function appendResponse(db: BetterSqlite3.Database, sid: string, text: string): void {
  appendHostEvent(db, {
    hostSessionId: sid, kind: 'response', payload: { text }, createdAt: new Date().toISOString(),
  });
}

describe('suggestRolesForChat', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); });
  afterEach(() => { db.close(); });

  it('returns [] for a chat with no events', () => {
    seedSession(db);
    expect(suggestRolesForChat(db, 's1')).toEqual([]);
  });

  it('returns [] when no role\'s entities show up in the chat', () => {
    seedSession(db);
    seedRoleWithEntities(db, 'tce', 'TCE 专家', ['TCE', 'TCE-CSR', 'TCE-fallback']);
    appendPrompt(db, 's1', '我想讨论 React hooks 的最佳实践');
    appendResponse(db, 's1', 'useState / useEffect / useMemo');
    expect(suggestRolesForChat(db, 's1')).toEqual([]);
  });

  it('returns the role when ≥2 distinct entities mentioned ≥3 times total', () => {
    seedSession(db);
    seedRoleWithEntities(db, 'tce', 'TCE 专家', ['TCE', 'TCE-CSR', 'TCE-fallback']);
    appendPrompt(db, 's1', '我想看 TCE 怎么走 TCE-CSR 的');
    appendResponse(db, 's1', 'TCE 通过 TCE-fallback 路由, TCE-CSR 是子模块');
    const out = suggestRolesForChat(db, 's1');
    expect(out).toHaveLength(1);
    expect(out[0]!.roleId).toBe('tce');
    expect(out[0]!.roleName).toBe('TCE 专家');
    expect(out[0]!.hitEntities.sort()).toEqual(['TCE', 'TCE-CSR', 'TCE-fallback']);
    expect(out[0]!.totalHits).toBeGreaterThanOrEqual(4); // TCE×3 + TCE-CSR×2 + TCE-fallback×1
    expect(out[0]!.isBound).toBe(false);
  });

  it('suppresses suggestions below the distinct-entity threshold', () => {
    seedSession(db);
    seedRoleWithEntities(db, 'tce', 'TCE 专家', ['TCE', 'TCE-CSR', 'TCE-fallback']);
    // Only ONE distinct entity mentioned, even if mentioned many times.
    appendPrompt(db, 's1', 'TCE TCE TCE TCE TCE');
    expect(suggestRolesForChat(db, 's1')).toEqual([]);
  });

  it('sorts multiple matched roles by distinct-entity count, then total hits', () => {
    seedSession(db);
    seedRoleWithEntities(db, 'tce', 'TCE 专家', ['TCE', 'TCE-CSR', 'TCE-fallback']);
    seedRoleWithEntities(db, 'og', 'OG 专家', ['OG', 'OG-BD', 'v5 schema', 'BAM']);
    // OG hit harder
    appendPrompt(db, 's1', 'OG 和 OG-BD 在 v5 schema 下用 BAM IDL Load');
    appendResponse(db, 's1', 'OG 走 OG-BD; TCE 跑 TCE-CSR');
    const out = suggestRolesForChat(db, 's1');
    expect(out.map((s) => s.roleId)).toEqual(['og', 'tce']);
  });

  it('marks isBound=true for roles already on the chat', () => {
    seedSession(db);
    seedRoleWithEntities(db, 'tce', 'TCE 专家', ['TCE', 'TCE-CSR', 'TCE-fallback']);
    // Bind the role to the session.
    db.prepare(`
      INSERT INTO host_session_roles (host_session_id, role_id, created_at)
      VALUES (?, ?, datetime('now'))
    `).run('s1', 'tce');
    appendPrompt(db, 's1', 'TCE 通过 TCE-CSR 在 TCE-fallback 模式下');
    const out = suggestRolesForChat(db, 's1');
    expect(out[0]!.isBound).toBe(true);
    // Sanity — confirm the binding actually landed.
    expect(listHostSessionRoles(db, 's1')).toEqual(['tce']);
  });

  it('respects custom thresholds via options', () => {
    seedSession(db);
    seedRoleWithEntities(db, 'tce', 'TCE 专家', ['TCE', 'TCE-CSR']);
    appendPrompt(db, 's1', 'TCE TCE-CSR'); // 2 distinct, 2 total
    expect(suggestRolesForChat(db, 's1')).toEqual([]); // default minTotal=3
    const relaxed = suggestRolesForChat(db, 's1', { minTotalHits: 2 });
    expect(relaxed).toHaveLength(1);
  });
});
