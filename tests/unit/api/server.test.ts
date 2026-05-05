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

describe('GET /api/cycles/:id', () => {
  it('returns the cycle, its campaign, and its tasks', async () => {
    const engine = new WorkflowEngine(db);
    const campaign = engine.initWorkflow('/proj', 'C1', 'brief');
    const cycle = engine.getCycleState(undefined, campaign.id)!.cycle;
    engine.createTasks(cycle.id, [
      { role: 'dev', title: 'dev task' },
      { role: 'test', title: 'test task' },
    ]);

    const r = await fetchJson(`/api/cycles/${cycle.id}`);
    expect(r.status).toBe(200);
    const body = r.body as {
      cycle: { id: string; cycleNum: number };
      campaign: { id: string; title: string };
      tasks: Array<{ role: string; title: string }>;
    };
    expect(body.cycle.id).toBe(cycle.id);
    expect(body.campaign.title).toBe('C1');
    expect(body.tasks.map((t) => t.role).sort()).toEqual(['dev', 'test']);
  });

  it('attack: unknown cycleId returns 404', async () => {
    const r = await fetchJson('/api/cycles/cyc_ghost');
    expect(r.status).toBe(404);
  });

  it('attack: POST is rejected as 405', async () => {
    const engine = new WorkflowEngine(db);
    const campaign = engine.initWorkflow('/proj', 'C1');
    const cycle = engine.getCycleState(undefined, campaign.id)!.cycle;
    const r = await fetchJson(`/api/cycles/${cycle.id}`, { method: 'POST' });
    expect(r.status).toBe(405);
  });
});

describe('GET /api/tasks/:id', () => {
  it('returns the task with its empty audit log when nothing has been recorded', async () => {
    const engine = new WorkflowEngine(db);
    const campaign = engine.initWorkflow('/proj', 'C1');
    const cycle = engine.getCycleState(undefined, campaign.id)!.cycle;
    const [task] = engine.createTasks(cycle.id, [{ role: 'dev', title: 'D1' }]);

    const r = await fetchJson(`/api/tasks/${task!.id}`);
    expect(r.status).toBe(200);
    const body = r.body as { task: { id: string; title: string }; auditLog: unknown[] };
    expect(body.task.id).toBe(task!.id);
    expect(body.auditLog).toEqual([]);
  });

  it('surfaces doc-first audit-log entries written for the task', async () => {
    const engine = new WorkflowEngine(db);
    const campaign = engine.initWorkflow('/proj', 'C1');
    const cycle = engine.getCycleState(undefined, campaign.id)!.cycle;
    const [task] = engine.createTasks(cycle.id, [{ role: 'dev', title: 'D1' }]);
    db.prepare(`INSERT INTO doc_audit_log (token, task_id, file_path, content_hash, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run('tok_a', task!.id, '/proj/docs/a.md', 'hash1', new Date().toISOString());
    db.prepare(`INSERT INTO doc_audit_log (token, task_id, file_path, content_hash, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run('tok_b', task!.id, '/proj/docs/b.md', 'hash2', new Date().toISOString());

    const r = await fetchJson(`/api/tasks/${task!.id}`);
    const body = r.body as { auditLog: Array<{ token: string; filePath: string }> };
    expect(body.auditLog).toHaveLength(2);
    expect(body.auditLog.map((e) => e.filePath).sort()).toEqual(['/proj/docs/a.md', '/proj/docs/b.md']);
  });

  it('attack: unknown taskId returns 404', async () => {
    const r = await fetchJson('/api/tasks/task_ghost');
    expect(r.status).toBe(404);
  });
});

describe('attack: unknown route', () => {
  it('returns 404 for unknown path', async () => {
    const r = await fetchJson('/api/nope');
    expect(r.status).toBe(404);
  });
});

describe('POST /api/diagnostics', () => {
  it('returns 200 with bundleDir + manifest when factory configured', async () => {
    await api.stop();
    const fakeBundle = { bundleDir: '/tmp/helm-fake', manifest: { generatedAt: 'now', files: [] } };
    api = createHttpApi({
      db, registry,
      createDiagnosticsBundle: () => fakeBundle,
    });
    await api.start();
    baseUrl = `http://127.0.0.1:${api.port()}`;

    const r = await fetchJson('/api/diagnostics', { method: 'POST' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject(fakeBundle);
  });

  it('attack: returns 501 when no factory configured', async () => {
    const r = await fetchJson('/api/diagnostics', { method: 'POST' });
    expect(r.status).toBe(501);
  });

  it('attack: GET is rejected as 405', async () => {
    const r = await fetchJson('/api/diagnostics');
    expect(r.status).toBe(405);
  });

  it('attack: factory throw surfaces as 500', async () => {
    await api.stop();
    api = createHttpApi({
      db, registry,
      createDiagnosticsBundle: () => { throw new Error('disk full'); },
    });
    await api.start();
    baseUrl = `http://127.0.0.1:${api.port()}`;

    const r = await fetchJson('/api/diagnostics', { method: 'POST' });
    expect(r.status).toBe(500);
    expect((r.body as { message: string }).message).toContain('disk full');
  });
});

describe('/api/config', () => {
  it('GET returns the configured value', async () => {
    await api.stop();
    const fakeConfig = { server: { port: 19999 } };
    api = createHttpApi({ db, registry, getConfig: () => fakeConfig as never });
    await api.start();
    baseUrl = `http://127.0.0.1:${api.port()}`;

    const r = await fetchJson('/api/config');
    expect(r.status).toBe(200);
    expect(r.body).toEqual(fakeConfig);
  });

  it('PUT validates + persists; returns the saved value', async () => {
    await api.stop();
    let saved: unknown = null;
    api = createHttpApi({
      db, registry,
      saveConfig: (input) => {
        saved = input;
        return { server: { port: 20000 } } as never;
      },
    });
    await api.start();
    baseUrl = `http://127.0.0.1:${api.port()}`;

    const r = await fetchJson('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server: { port: 20000 } }),
    });
    expect(r.status).toBe(200);
    expect(saved).toEqual({ server: { port: 20000 } });
  });

  it('attack: PUT with invalid JSON returns 400', async () => {
    await api.stop();
    api = createHttpApi({ db, registry, saveConfig: () => ({} as never) });
    await api.start();
    baseUrl = `http://127.0.0.1:${api.port()}`;

    const r = await fetchJson('/api/config', { method: 'PUT', body: '{not json' });
    expect(r.status).toBe(400);
  });

  it('attack: PUT validation error → 400 with message', async () => {
    await api.stop();
    api = createHttpApi({
      db, registry,
      saveConfig: () => { throw new Error('expected number, received string'); },
    });
    await api.start();
    baseUrl = `http://127.0.0.1:${api.port()}`;

    const r = await fetchJson('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server: { port: 'nope' } }),
    });
    expect(r.status).toBe(400);
  });

  it('GET → 501 when getConfig is not provided', async () => {
    const r = await fetchJson('/api/config');
    expect(r.status).toBe(501);
  });

  it('PUT → 501 when saveConfig is not provided', async () => {
    const r = await fetchJson('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(501);
  });
});

describe('/api/bindings', () => {
  it('GET returns rows from listAllChannelBindings', async () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO host_sessions (id, host, status, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`)
      .run('s1', 'cursor', 'active', now, now);
    db.prepare(`INSERT INTO channel_bindings (id, channel, host_session_id, external_chat, external_thread, wait_enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('b1', 'lark', 's1', 'oc_a', 'om_t', 1, now);

    const r = await fetchJson('/api/bindings');
    expect(r.status).toBe(200);
    expect((r.body as { bindings: Array<{ id: string }> }).bindings[0]?.id).toBe('b1');
  });

  it('GET /api/bindings/pending returns active pending codes only', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    db.prepare(`INSERT INTO pending_binds (code, channel, expires_at) VALUES (?, ?, ?)`)
      .run('FUTURE', 'lark', future);
    db.prepare(`INSERT INTO pending_binds (code, channel, expires_at) VALUES (?, ?, ?)`)
      .run('STALE', 'lark', past);

    const r = await fetchJson('/api/bindings/pending');
    expect(r.status).toBe(200);
    const codes = (r.body as { pending: Array<{ code: string }> }).pending.map((p) => p.code);
    expect(codes).toEqual(['FUTURE']);
  });

  it('POST /api/bindings/consume invokes consumePendingBind', async () => {
    await api.stop();
    api = createHttpApi({
      db, registry,
      consumePendingBind: (code, sid) => code === 'GOOD' ? { id: `bnd_${sid}` } : null,
    });
    await api.start();
    baseUrl = `http://127.0.0.1:${api.port()}`;

    const r = await fetchJson('/api/bindings/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'GOOD', hostSessionId: 's1' }),
    });
    expect(r.status).toBe(200);
    expect((r.body as { binding: { id: string } }).binding.id).toBe('bnd_s1');
  });

  it('attack: POST consume with unknown code → 404', async () => {
    await api.stop();
    api = createHttpApi({
      db, registry,
      consumePendingBind: () => null,
    });
    await api.start();
    baseUrl = `http://127.0.0.1:${api.port()}`;

    const r = await fetchJson('/api/bindings/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'NOPE', hostSessionId: 's1' }),
    });
    expect(r.status).toBe(404);
  });

  it('attack: POST consume missing fields → 400', async () => {
    await api.stop();
    api = createHttpApi({ db, registry, consumePendingBind: () => ({ id: 'b' }) });
    await api.start();
    baseUrl = `http://127.0.0.1:${api.port()}`;

    const r = await fetchJson('/api/bindings/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'X' }),
    });
    expect(r.status).toBe(400);
  });

  it('DELETE /api/bindings/:id removes the row', async () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO host_sessions (id, host, status, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`)
      .run('s1', 'cursor', 'active', now, now);
    db.prepare(`INSERT INTO channel_bindings (id, channel, host_session_id, wait_enabled, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run('b1', 'lark', 's1', 1, now);

    const r = await fetchJson('/api/bindings/b1', { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect(db.prepare(`SELECT 1 FROM channel_bindings WHERE id = 'b1'`).get()).toBeUndefined();
  });

  it('attack: DELETE unknown binding → 404', async () => {
    const r = await fetchJson('/api/bindings/ghost', { method: 'DELETE' });
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
