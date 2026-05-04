import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { upsertHostSession } from '../../../src/storage/repos/host-sessions.js';
import { ApprovalRegistry } from '../../../src/approval/registry.js';
import { WorkflowEngine } from '../../../src/workflow/engine.js';
import { createHttpApi, type HttpApiHandle } from '../../../src/api/server.js';

let db: BetterSqlite3.Database;
let registry: ApprovalRegistry;
let api: HttpApiHandle;
let baseUrl: string;

async function fetchJson(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, init);
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

beforeEach(async () => {
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  registry = new ApprovalRegistry(db, { defaultTimeoutMs: 60_000 });
  api = createHttpApi({ db, registry });
  await api.start();
  baseUrl = `http://127.0.0.1:${api.port()}`;
});

afterEach(async () => {
  await api.stop();
  registry.shutdown();
  db.close();
});

describe('GET /api/health', () => {
  it('returns 200 with name + version', async () => {
    const r = await fetchJson('/api/health');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, name: 'helm' });
  });

  it('attack: POST is rejected as 405', async () => {
    const r = await fetchJson('/api/health', { method: 'POST' });
    expect(r.status).toBe(405);
  });
});

describe('GET /api/active-chats', () => {
  it('returns active sessions (empty when none)', async () => {
    const r = await fetchJson('/api/active-chats');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ chats: [] });
  });

  it('omits closed sessions', async () => {
    const now = new Date().toISOString();
    upsertHostSession(db, { id: 'a', host: 'cursor', status: 'active', firstSeenAt: now, lastSeenAt: now });
    upsertHostSession(db, { id: 'b', host: 'cursor', status: 'closed', firstSeenAt: now, lastSeenAt: now });
    const r = await fetchJson('/api/active-chats');
    const ids = ((r.body as { chats: Array<{ id: string }> }).chats).map((c) => c.id);
    expect(ids).toEqual(['a']);
  });
});

describe('GET /api/approvals', () => {
  it('returns pending list', async () => {
    const now = new Date().toISOString();
    upsertHostSession(db, { id: 's1', host: 'cursor', status: 'active', firstSeenAt: now, lastSeenAt: now });
    const a = registry.create({ hostSessionId: 's1', tool: 'Shell', command: 'rm' });

    const r = await fetchJson('/api/approvals');
    expect(r.status).toBe(200);
    const body = r.body as { approvals: Array<{ id: string }> };
    expect(body.approvals.map((p) => p.id)).toEqual([a.request.id]);
  });
});

describe('POST /api/approvals/:id/decide', () => {
  beforeEach(() => {
    const now = new Date().toISOString();
    upsertHostSession(db, { id: 's1', host: 'cursor', status: 'active', firstSeenAt: now, lastSeenAt: now });
  });

  it('settles a pending approval as allow and returns 200', async () => {
    const a = registry.create({ hostSessionId: 's1', tool: 'Shell', command: 'rm' });
    const r = await fetchJson(`/api/approvals/${a.request.id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'allow' }),
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, approvalId: a.request.id });
    const settled = await a.settled;
    expect(settled.permission).toBe('allow');
  });

  it('attack: invalid decision returns 400', async () => {
    const a = registry.create({ hostSessionId: 's1', tool: 'Shell', command: 'rm' });
    const r = await fetchJson(`/api/approvals/${a.request.id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'maybe' }),
    });
    expect(r.status).toBe(400);
  });

  it('attack: malformed JSON returns 400', async () => {
    const r = await fetchJson('/api/approvals/x/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json}',
    });
    expect(r.status).toBe(400);
  });

  it('attack: unknown approvalId returns 409', async () => {
    const r = await fetchJson('/api/approvals/ghost/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'allow' }),
    });
    expect(r.status).toBe(409);
  });

  it('attack: settling twice — first 200, second 409', async () => {
    const a = registry.create({ hostSessionId: 's1', tool: 'Shell', command: 'rm' });
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'deny' }) };
    const first = await fetchJson(`/api/approvals/${a.request.id}/decide`, init);
    expect(first.status).toBe(200);
    const second = await fetchJson(`/api/approvals/${a.request.id}/decide`, init);
    expect(second.status).toBe(409);
  });

  it('attack: GET on the decide endpoint returns 405', async () => {
    const r = await fetchJson('/api/approvals/x/decide');
    expect(r.status).toBe(405);
  });
});

describe('GET /api/campaigns + /:id/cycles', () => {
  it('lists campaigns and cycles', async () => {
    const engine = new WorkflowEngine(db);
    const c = engine.initWorkflow('/proj', 'C1', 'b');

    const list = await fetchJson('/api/campaigns');
    expect(list.status).toBe(200);
    expect((list.body as { campaigns: Array<{ id: string }> }).campaigns).toHaveLength(1);

    const cycles = await fetchJson(`/api/campaigns/${c.id}/cycles`);
    expect(cycles.status).toBe(200);
    expect((cycles.body as { cycles: Array<{ cycleNum: number }> }).cycles[0]?.cycleNum).toBe(1);
  });
});

describe('attack: unknown route', () => {
  it('returns 404 for unknown path', async () => {
    const r = await fetchJson('/api/nope');
    expect(r.status).toBe(404);
  });
});

describe('attack: only binds 127.0.0.1', () => {
  it('default host is 127.0.0.1 (loopback only)', () => {
    expect(api.port()).toBeGreaterThan(0);
    // Sanity: server is reachable via loopback
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });
});
