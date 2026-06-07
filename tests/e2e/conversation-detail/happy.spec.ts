/**
 * E2e — Conversation Detail happy path (PR 3).
 *
 * Boots a real HelmApp through the HTTP server and proves the new
 * `/api/conversations/:id/detail` endpoint returns the merged shape
 * after we feed it data through the standard repos.
 *
 * Goal: catch wiring breakage at the API + storage boundary, including
 * the back-compat alias `/api/active-chats/:id/detail`.
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootE2e, type E2eHarness } from '../_helpers/setup.js';
import { recordRetrieval } from '../../../src/storage/repos/retrieval-log.js';
import { appendHostEvent } from '../../../src/storage/repos/host-event-log.js';

function seedSession(db: BetterSqlite3.Database, id: string, agentKind = 'cursor'): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO host_sessions (id, host, agent_kind, cwd, status, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, '/tmp', 'active', ?, ?)
  `).run(id, agentKind, agentKind, now, now);
}

function seedRoleAndChunk(db: BetterSqlite3.Database, roleId: string, chunkId: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO roles (id, name, system_prompt, is_builtin, created_at, version)
    VALUES (?, ?, 'sp', 0, ?, 1)
  `).run(roleId, `Role-${roleId}`, now);
  db.prepare(`
    INSERT INTO knowledge_chunks (id, role_id, chunk_text, kind, created_at)
    VALUES (?, ?, 'body', 'spec', ?)
  `).run(chunkId, roleId, now);
}

interface DetailShape {
  session: { id: string; agentKind?: string };
  timeline: ReadonlyArray<{ kind: string }>;
  knowledgeInPlay: ReadonlyArray<{ log: { id: string }; points: ReadonlyArray<{ pointId: string }> }>;
  candidates: ReadonlyArray<{ id: string }>;
}

async function fetchDetail(port: number, path: string): Promise<{ status: number; body?: DetailShape }> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  if (r.status !== 200) return { status: r.status };
  return { status: r.status, body: await r.json() as DetailShape };
}

describe('e2e Conversation Detail — happy', () => {
  let h: E2eHarness;
  beforeEach(async () => { h = await bootE2e(); });
  afterEach(async () => { await h.shutdown(); });

  it('GET /api/conversations/:id/detail returns the joined shape', async () => {
    seedSession(h.db, 's-1', 'cursor');
    seedRoleAndChunk(h.db, 'r-1', 'p-1');

    appendHostEvent(h.db, {
      hostSessionId: 's-1', kind: 'prompt', payload: { text: 'how to roll back?' },
      createdAt: new Date().toISOString(),
    });
    appendHostEvent(h.db, {
      hostSessionId: 's-1', kind: 'response', payload: { text: 'pause + wait 60s' },
      createdAt: new Date().toISOString(),
    });
    recordRetrieval(h.db, {
      id: 'log-1', hostSessionId: 's-1', turn: 1,
      queryText: 'rollback', ts: Date.now(),
    }, [{ pointId: 'p-1', rank: 0, fusionScore: 0.9, injected: true }]);

    const port = h.app.httpPort();
    if (port == null) throw new Error('httpPort not bound — orchestrator boot failed?');
    const r = await fetchDetail(port, '/api/conversations/s-1/detail');
    expect(r.status).toBe(200);
    expect(r.body!.session.id).toBe('s-1');
    expect(r.body!.session.agentKind).toBe('cursor');
    expect(r.body!.timeline.map((e) => e.kind)).toEqual(['prompt', 'response']);
    expect(r.body!.knowledgeInPlay).toHaveLength(1);
    expect(r.body!.knowledgeInPlay[0]!.log.id).toBe('log-1');
    expect(r.body!.knowledgeInPlay[0]!.points[0]!.pointId).toBe('p-1');
    expect(r.body!.candidates).toEqual([]);
  });

  it('back-compat: the legacy /api/active-chats/:id/detail alias returns the same shape', async () => {
    seedSession(h.db, 's-bc', 'cursor');
    const port = h.app.httpPort();
    if (port == null) throw new Error('httpPort not bound — orchestrator boot failed?');
    const r = await fetchDetail(port, '/api/active-chats/s-bc/detail');
    expect(r.status).toBe(200);
    expect(r.body!.session.id).toBe('s-bc');
  });

  it('returns 404 for an unknown session id', async () => {
    const port = h.app.httpPort();
    if (port == null) throw new Error('httpPort not bound — orchestrator boot failed?');
    const r = await fetchDetail(port, '/api/conversations/no-such-session/detail');
    expect(r.status).toBe(404);
  });

  it('discriminates sessions by agent_kind so the Conversations facet tabs have data', async () => {
    for (const kind of ['cursor', 'claude_code', 'codex'] as const) {
      seedSession(h.db, `s-${kind}`, kind);
    }
    const port = h.app.httpPort();
    if (port == null) throw new Error('httpPort not bound — orchestrator boot failed?');
    for (const kind of ['cursor', 'claude_code', 'codex'] as const) {
      const r = await fetchDetail(port, `/api/conversations/s-${kind}/detail`);
      expect(r.status).toBe(200);
      expect(r.body!.session.agentKind).toBe(kind);
    }
  });
});
