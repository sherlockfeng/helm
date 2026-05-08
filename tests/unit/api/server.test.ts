import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { getHostSession, upsertHostSession } from '../../../src/storage/repos/host-sessions.js';
import { upsertRole } from '../../../src/storage/repos/roles.js';
import { ApprovalRegistry } from '../../../src/approval/registry.js';
import { ApprovalPolicyEngine } from '../../../src/approval/policy.js';
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

describe('PUT /api/active-chats/:id/role (Phase 25)', () => {
  function seedChat(id = 'sess-1'): void {
    const now = new Date().toISOString();
    upsertHostSession(db, { id, host: 'cursor', cwd: '/p', status: 'active', firstSeenAt: now, lastSeenAt: now });
  }
  function seedRole(id = 'role-pm'): void {
    upsertRole(db, {
      id, name: 'PM', systemPrompt: 'sp',
      isBuiltin: true, createdAt: new Date().toISOString(),
    });
  }

  it('binds a chat to a role and returns the refreshed chat', async () => {
    seedChat();
    seedRole();
    const r = await fetchJson('/api/active-chats/sess-1/role', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roleId: 'role-pm' }),
    });
    expect(r.status).toBe(200);
    expect((r.body as { chat: { roleId?: string } }).chat.roleId).toBe('role-pm');
    expect(getHostSession(db, 'sess-1')?.roleId).toBe('role-pm');
  });

  it('null roleId unbinds', async () => {
    seedChat();
    seedRole();
    // bind first
    await fetchJson('/api/active-chats/sess-1/role', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roleId: 'role-pm' }),
    });
    // then unbind
    const r = await fetchJson('/api/active-chats/sess-1/role', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roleId: null }),
    });
    expect(r.status).toBe(200);
    expect(getHostSession(db, 'sess-1')?.roleId).toBeUndefined();
  });

  it('returns 404 when host session is unknown', async () => {
    const r = await fetchJson('/api/active-chats/ghost/role', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roleId: null }),
    });
    expect(r.status).toBe(404);
  });

  it('returns 404 when the role does not exist', async () => {
    seedChat();
    const r = await fetchJson('/api/active-chats/sess-1/role', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roleId: 'ghost-role' }),
    });
    expect(r.status).toBe(404);
  });

  it('rejects bad body shape with 400', async () => {
    seedChat();
    const bad = await fetchJson('/api/active-chats/sess-1/role', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(bad.status).toBe(400);

    const wrongType = await fetchJson('/api/active-chats/sess-1/role', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roleId: 123 }),
    });
    expect(wrongType.status).toBe(400);
  });

  it('attack: GET on the role endpoint returns 405', async () => {
    seedChat();
    const r = await fetchJson('/api/active-chats/sess-1/role');
    expect(r.status).toBe(405);
  });
});

describe('DELETE /api/active-chats/:id (Phase 36)', () => {
  function seedChat(id = 'sess-1'): void {
    const now = new Date().toISOString();
    upsertHostSession(db, { id, host: 'cursor', cwd: '/p', status: 'active', firstSeenAt: now, lastSeenAt: now });
  }

  it('default (cascade=false) marks status=closed; row stays in DB', async () => {
    seedChat();
    const r = await fetchJson('/api/active-chats/sess-1', { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect((r.body as { ok: true; cascade: boolean }).cascade).toBe(false);
    // Row still present, but inactive — falls out of GET /api/active-chats.
    const row = db.prepare('SELECT status FROM host_sessions WHERE id = ?').get('sess-1') as { status: string };
    expect(row.status).toBe('closed');
    const list = await fetchJson('/api/active-chats');
    expect((list.body as { chats: unknown[] }).chats).toEqual([]);
  });

  it('cascade=true hard-deletes the row + cascades bindings (FK)', async () => {
    seedChat();
    // Stash a binding to confirm cascade.
    db.prepare(`
      INSERT INTO channel_bindings (id, channel, host_session_id, wait_enabled, created_at)
      VALUES ('b1', 'lark', 'sess-1', 1, ?)
    `).run(new Date().toISOString());

    const r = await fetchJson('/api/active-chats/sess-1?cascade=true', { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect((r.body as { cascade: boolean }).cascade).toBe(true);

    expect(db.prepare('SELECT count(*) AS n FROM host_sessions WHERE id = ?').get('sess-1')).toEqual({ n: 0 });
    // FK ON DELETE CASCADE took care of channel_bindings.
    expect(db.prepare('SELECT count(*) AS n FROM channel_bindings WHERE id = ?').get('b1')).toEqual({ n: 0 });
  });

  it('returns 404 when the host session is unknown', async () => {
    const r = await fetchJson('/api/active-chats/ghost', { method: 'DELETE' });
    expect(r.status).toBe(404);
  });

  it('attack: PATCH not allowed on the chat endpoint', async () => {
    seedChat();
    const r = await fetchJson('/api/active-chats/sess-1', { method: 'PATCH' });
    expect(r.status).toBe(405);
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

describe('POST /api/approvals/:id/decide — Phase 46d remember', () => {
  let policy: ApprovalPolicyEngine;

  beforeEach(async () => {
    const now = new Date().toISOString();
    upsertHostSession(db, { id: 's1', host: 'cursor', status: 'active', firstSeenAt: now, lastSeenAt: now });
    // Rebuild api with the policy engine wired so this branch is exercised.
    await api.stop();
    policy = new ApprovalPolicyEngine(db);
    api = createHttpApi({ db, registry, policy });
    await api.start();
    baseUrl = `http://127.0.0.1:${api.port()}`;
  });

  it('remember=true on Shell command inserts a commandPrefix rule (first token)', async () => {
    const a = registry.create({ hostSessionId: 's1', tool: 'Shell', command: 'pnpm install --frozen-lockfile' });
    const r = await fetchJson(`/api/approvals/${a.request.id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'allow', remember: true }),
    });
    expect(r.status).toBe(200);
    const body = r.body as { rememberedRule?: { tool: string; decision: string } };
    expect(body.rememberedRule).toMatchObject({ tool: 'Shell', decision: 'allow' });
    const rules = policy.list();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ tool: 'Shell', commandPrefix: 'pnpm', decision: 'allow' });
  });

  it('remember=true on mcp__ tool inserts a toolScope rule', async () => {
    const a = registry.create({ hostSessionId: 's1', tool: 'mcp__helm__ping', command: '' });
    const r = await fetchJson(`/api/approvals/${a.request.id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'allow', remember: true }),
    });
    expect(r.status).toBe(200);
    const rules = policy.list();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ tool: 'mcp__helm__ping', toolScope: true, decision: 'allow' });
  });

  it('explicit scope overrides the inferred default', async () => {
    const a = registry.create({ hostSessionId: 's1', tool: 'Shell', command: 'pnpm test' });
    const r = await fetchJson(`/api/approvals/${a.request.id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'allow', remember: true, scope: 'shell pnpm test' }),
    });
    expect(r.status).toBe(200);
    const rules = policy.list();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ tool: 'Shell', commandPrefix: 'pnpm test' });
  });

  it('remember=true without policy engine wired returns 501', async () => {
    // Rebuild api WITHOUT policy.
    await api.stop();
    api = createHttpApi({ db, registry });
    await api.start();
    baseUrl = `http://127.0.0.1:${api.port()}`;
    const a = registry.create({ hostSessionId: 's1', tool: 'Shell', command: 'rm' });
    const r = await fetchJson(`/api/approvals/${a.request.id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'allow', remember: true }),
    });
    expect(r.status).toBe(501);
  });

  it('attack: remember on unknown approvalId returns 404 BEFORE settling', async () => {
    const r = await fetchJson('/api/approvals/ghost/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'allow', remember: true }),
    });
    expect(r.status).toBe(404);
    expect(policy.list()).toHaveLength(0);
  });

  it('attack: remember=non-boolean returns 400 and inserts no rule', async () => {
    const a = registry.create({ hostSessionId: 's1', tool: 'Shell', command: 'ls' });
    const r = await fetchJson(`/api/approvals/${a.request.id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'allow', remember: 'yes' }),
    });
    expect(r.status).toBe(400);
    expect(policy.list()).toHaveLength(0);
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

  // ── Phase 62: POST /api/bindings/initiate ─────────────────────────────
  describe('POST /api/bindings/initiate (Phase 62)', () => {
    it('501 when initiateLarkBind is not wired (Lark not configured)', async () => {
      const r = await fetchJson('/api/bindings/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(r.status).toBe(501);
      expect((r.body as { message: string }).message).toMatch(/Lark not configured/i);
    });

    it('happy: returns code + instruction + expiresAt; forwards label', async () => {
      let receivedLabel: string | undefined;
      await api.stop();
      api = createHttpApi({
        db, registry,
        initiateLarkBind: (opts) => {
          receivedLabel = opts.label;
          return {
            code: 'XYZ987',
            expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
            instruction: 'Send "@bot bind XYZ987" in Lark…',
          };
        },
      });
      await api.start();
      baseUrl = `http://127.0.0.1:${api.port()}`;

      const r = await fetchJson('/api/bindings/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'tce-thread' }),
      });
      expect(r.status).toBe(200);
      const body = r.body as { code: string; expiresAt: string; instruction: string };
      expect(body.code).toBe('XYZ987');
      expect(body.instruction).toContain('XYZ987');
      expect(receivedLabel).toBe('tce-thread');
    });

    it('label is trimmed + capped at 60 chars; whitespace-only is dropped', async () => {
      let receivedLabel: string | undefined;
      await api.stop();
      api = createHttpApi({
        db, registry,
        initiateLarkBind: (opts) => {
          receivedLabel = opts.label;
          return {
            code: 'ABC', expiresAt: new Date().toISOString(),
            instruction: '',
          };
        },
      });
      await api.start();
      baseUrl = `http://127.0.0.1:${api.port()}`;

      // whitespace-only → undefined
      await fetchJson('/api/bindings/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: '   ' }),
      });
      expect(receivedLabel).toBeUndefined();

      // overlong → truncated at 60
      const longLabel = 'x'.repeat(120);
      await fetchJson('/api/bindings/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: longLabel }),
      });
      expect(receivedLabel?.length).toBe(60);
    });

    it('attack: GET → 405', async () => {
      const r = await fetchJson('/api/bindings/initiate');
      expect(r.status).toBe(405);
    });

    it('empty body is OK (label is optional)', async () => {
      await api.stop();
      api = createHttpApi({
        db, registry,
        initiateLarkBind: () => ({
          code: 'ABC', expiresAt: new Date().toISOString(), instruction: '',
        }),
      });
      await api.start();
      baseUrl = `http://127.0.0.1:${api.port()}`;

      // No body at all
      const r = await fetchJson('/api/bindings/initiate', { method: 'POST' });
      expect(r.status).toBe(200);
    });
  });

  // ── Phase 63: POST /api/setup-mcp ─────────────────────────────────────
  describe('POST /api/setup-mcp (Phase 63)', () => {
    it('happy: forwards target, returns the SetupMcpResult shape', async () => {
      let receivedTarget: 'claude' | 'cursor' | null = null;
      await api.stop();
      api = createHttpApi({
        db, registry,
        setupMcp: (target) => {
          receivedTarget = target;
          return {
            changed: true,
            message: `Registered helm with ${target}.`,
            location: target === 'claude' ? 'claude mcp (user)' : '~/.cursor/mcp.json',
          };
        },
      });
      await api.start();
      baseUrl = `http://127.0.0.1:${api.port()}`;

      const r = await fetchJson('/api/setup-mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'cursor' }),
      });
      expect(r.status).toBe(200);
      const body = r.body as { target: string; changed: boolean; message: string };
      expect(body.target).toBe('cursor');
      expect(body.changed).toBe(true);
      expect(body.message).toMatch(/cursor/);
      expect(receivedTarget).toBe('cursor');
    });

    it('attack: unknown target → 400', async () => {
      await api.stop();
      api = createHttpApi({ db, registry, setupMcp: () => ({ changed: false, message: '', location: '' }) });
      await api.start();
      baseUrl = `http://127.0.0.1:${api.port()}`;

      const r = await fetchJson('/api/setup-mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'helmless' }),
      });
      expect(r.status).toBe(400);
      expect((r.body as { message: string }).message).toMatch(/claude.*cursor/);
    });

    it('attack: setupMcp throwing → 500 with message (not a stack trace)', async () => {
      await api.stop();
      api = createHttpApi({
        db, registry,
        setupMcp: () => { throw new Error('refusing to overwrite corrupt JSON'); },
      });
      await api.start();
      baseUrl = `http://127.0.0.1:${api.port()}`;

      const r = await fetchJson('/api/setup-mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'claude' }),
      });
      expect(r.status).toBe(500);
      expect((r.body as { message: string }).message).toContain('refusing to overwrite');
    });

    it('501 when setupMcp dep is not wired (defensive — orchestrator always wires it)', async () => {
      const r = await fetchJson('/api/setup-mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'claude' }),
      });
      expect(r.status).toBe(501);
    });

    it('attack: GET → 405', async () => {
      const r = await fetchJson('/api/setup-mcp');
      expect(r.status).toBe(405);
    });

    it('attack: malformed JSON → 400', async () => {
      await api.stop();
      api = createHttpApi({ db, registry, setupMcp: () => ({ changed: false, message: '', location: '' }) });
      await api.start();
      baseUrl = `http://127.0.0.1:${api.port()}`;

      const r = await fetchJson('/api/setup-mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
      });
      expect(r.status).toBe(400);
    });
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

  // ── Phase 39: cancel pending bind ─────────────────────────────────────
  describe('DELETE /api/bindings/pending/:code (Phase 39)', () => {
    it('removes a live pending code, returns ok + code', async () => {
      const future = new Date(Date.now() + 60_000).toISOString();
      db.prepare(`INSERT INTO pending_binds (code, channel, expires_at) VALUES (?, ?, ?)`)
        .run('LIVE01', 'lark', future);

      const r = await fetchJson('/api/bindings/pending/LIVE01', { method: 'DELETE' });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, code: 'LIVE01' });
      expect(db.prepare(`SELECT 1 FROM pending_binds WHERE code = ?`).get('LIVE01'))
        .toBeUndefined();
    });

    it('returns 404 for an unknown code', async () => {
      const r = await fetchJson('/api/bindings/pending/NEVER', { method: 'DELETE' });
      expect(r.status).toBe(404);
    });

    it('attack: expired code returns 404 (matches consume\'s ux), still cleans the row', async () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      db.prepare(`INSERT INTO pending_binds (code, channel, expires_at) VALUES (?, ?, ?)`)
        .run('STALE', 'lark', past);
      const r = await fetchJson('/api/bindings/pending/STALE', { method: 'DELETE' });
      expect(r.status).toBe(404);
      // Even if the API returned 404, the row got purged so it doesn't linger.
      expect(db.prepare(`SELECT 1 FROM pending_binds WHERE code = ?`).get('STALE'))
        .toBeUndefined();
    });

    it('attack: GET on the cancel endpoint returns 405', async () => {
      const r = await fetchJson('/api/bindings/pending/anything');
      expect(r.status).toBe(405);
    });
  });
});

describe('/api/cycles/:id/complete (B1)', () => {
  it('returns 200 + cycle when engine wired and cycle in test phase', async () => {
    const engine = new WorkflowEngine(db);
    const campaign = engine.initWorkflow('/proj', 'C', 'b');
    const cycle = engine.getCycleState(undefined, campaign.id)!.cycle;
    // Walk it through to test phase: create + complete one dev task (no docFirst).
    const e2 = new WorkflowEngine(db, { isDocFirstEnforced: () => false });
    const [t] = e2.createTasks(cycle.id, [{ role: 'dev', title: 'd' }]);
    e2.completeTask(t!.id, { result: 'done' });

    await api.stop();
    api = createHttpApi({ db, registry, workflowEngine: e2 });
    await api.start();
    baseUrl = `http://127.0.0.1:${api.port()}`;

    const r = await fetchJson(`/api/cycles/${cycle.id}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passRate: 95 }),
    });
    expect(r.status).toBe(200);
    expect((r.body as { cycle: { status: string } }).cycle.status).toBe('completed');
  });

  it('returns 501 when engine not wired', async () => {
    const r = await fetchJson('/api/cycles/c1/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(501);
  });

  it('attack: GET is 405', async () => {
    const r = await fetchJson('/api/cycles/c1/complete');
    expect(r.status).toBe(405);
  });

  it('attack: malformed JSON → 400', async () => {
    await api.stop();
    api = createHttpApi({ db, registry, workflowEngine: new WorkflowEngine(db) });
    await api.start();
    baseUrl = `http://127.0.0.1:${api.port()}`;

    const r = await fetchJson('/api/cycles/c1/complete', {
      method: 'POST',
      body: '{not json',
    });
    expect(r.status).toBe(400);
  });

  it('attack: unknown cycle → 404', async () => {
    await api.stop();
    api = createHttpApi({ db, registry, workflowEngine: new WorkflowEngine(db) });
    await api.start();
    baseUrl = `http://127.0.0.1:${api.port()}`;

    const r = await fetchJson('/api/cycles/ghost/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(404);
  });
});

describe('/api/cycles/:id/bug-tasks (B1)', () => {
  it('creates bug tasks + sends cycle back to dev', async () => {
    const engine = new WorkflowEngine(db);
    const campaign = engine.initWorkflow('/proj', 'C');
    const cycle = engine.getCycleState(undefined, campaign.id)!.cycle;

    await api.stop();
    api = createHttpApi({ db, registry, workflowEngine: engine });
    await api.start();
    baseUrl = `http://127.0.0.1:${api.port()}`;

    const r = await fetchJson(`/api/cycles/${cycle.id}/bug-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bugs: [
          { title: 'login button broken', description: 'click does nothing' },
          { title: 'dark mode contrast' },
        ],
      }),
    });
    expect(r.status).toBe(200);
    expect((r.body as { tasks: unknown[] }).tasks).toHaveLength(2);
  });

  it('attack: empty bugs array → 400', async () => {
    await api.stop();
    api = createHttpApi({ db, registry, workflowEngine: new WorkflowEngine(db) });
    await api.start();
    baseUrl = `http://127.0.0.1:${api.port()}`;

    const r = await fetchJson('/api/cycles/c1/bug-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bugs: [] }),
    });
    expect(r.status).toBe(400);
  });

  it('attack: bug missing title → 400', async () => {
    await api.stop();
    api = createHttpApi({ db, registry, workflowEngine: new WorkflowEngine(db) });
    await api.start();
    baseUrl = `http://127.0.0.1:${api.port()}`;

    const r = await fetchJson('/api/cycles/c1/bug-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bugs: [{ description: 'no title' }] }),
    });
    expect(r.status).toBe(400);
  });

  it('attack: 501 when engine absent', async () => {
    const r = await fetchJson('/api/cycles/c1/bug-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bugs: [{ title: 'x' }] }),
    });
    expect(r.status).toBe(501);
  });
});

describe('/api/campaigns/:id/summarize (B2)', () => {
  it('returns 200 + summary when factory wired', async () => {
    await api.stop();
    api = createHttpApi({
      db, registry,
      summarizeCampaign: async (id) => ({ id, why: 'because', cycles: [], keyDecisions: [], overallPath: 'X→Y' }),
    });
    await api.start();
    baseUrl = `http://127.0.0.1:${api.port()}`;

    const r = await fetchJson('/api/campaigns/c1/summarize', { method: 'POST' });
    expect(r.status).toBe(200);
    const body = r.body as { summary: { why: string } };
    expect(body.summary.why).toBe('because');
  });

  it('returns 501 when factory absent', async () => {
    const r = await fetchJson('/api/campaigns/c1/summarize', { method: 'POST' });
    expect(r.status).toBe(501);
  });

  it('Phase 24: cloud-mode missing key throws → 501 (live-config check)', async () => {
    await api.stop();
    api = createHttpApi({
      db, registry,
      summarizeCampaign: async () => {
        throw new Error('CursorLlmClient cloud mode requires an API key — pass options.apiKey or set CURSOR_API_KEY in env.');
      },
    });
    await api.start();
    baseUrl = `http://127.0.0.1:${api.port()}`;

    const r = await fetchJson('/api/campaigns/c1/summarize', { method: 'POST' });
    expect(r.status).toBe(501);
    expect((r.body as { message: string }).message).toMatch(/CURSOR_API_KEY/);
  });

  it('attack: GET → 405', async () => {
    const r = await fetchJson('/api/campaigns/c1/summarize');
    expect(r.status).toBe(405);
  });

  it('attack: factory throws "Campaign not found" → 404', async () => {
    await api.stop();
    api = createHttpApi({
      db, registry,
      summarizeCampaign: async () => { throw new Error('Campaign not found: c1'); },
    });
    await api.start();
    baseUrl = `http://127.0.0.1:${api.port()}`;

    const r = await fetchJson('/api/campaigns/c1/summarize', { method: 'POST' });
    expect(r.status).toBe(404);
  });

  it('attack: factory throws unknown error → 500', async () => {
    await api.stop();
    api = createHttpApi({
      db, registry,
      summarizeCampaign: async () => { throw new Error('rate limit exceeded'); },
    });
    await api.start();
    baseUrl = `http://127.0.0.1:${api.port()}`;

    const r = await fetchJson('/api/campaigns/c1/summarize', { method: 'POST' });
    expect(r.status).toBe(500);
  });
});

describe('/api/roles (B3)', () => {
  it('GET returns roles with chunkCount', async () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO roles (id, name, system_prompt, is_builtin, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run('product', 'Product Agent', 'be a PM', 1, now);
    db.prepare(`INSERT INTO knowledge_chunks (id, role_id, source_file, chunk_text, embedding, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('c1', 'product', 'a.md', 'foo', new Uint8Array(0), now);

    const r = await fetchJson('/api/roles');
    expect(r.status).toBe(200);
    const body = r.body as { roles: Array<{ id: string; chunkCount: number }> };
    expect(body.roles).toHaveLength(1);
    expect(body.roles[0]?.chunkCount).toBe(1);
  });

  it('GET /api/roles/:id returns role + chunks (no embedding)', async () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO roles (id, name, system_prompt, is_builtin, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run('dev', 'Dev', 'p', 0, now);
    db.prepare(`INSERT INTO knowledge_chunks (id, role_id, source_file, chunk_text, embedding, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('c1', 'dev', 'a.md', 'hello', new Uint8Array(0), now);

    const r = await fetchJson('/api/roles/dev');
    expect(r.status).toBe(200);
    const body = r.body as { role: { id: string }; chunks: Array<{ chunkText: string; embedding?: unknown }> };
    expect(body.role.id).toBe('dev');
    expect(body.chunks).toHaveLength(1);
    expect(body.chunks[0]?.chunkText).toBe('hello');
    // embedding intentionally stripped from API response
    expect(body.chunks[0]).not.toHaveProperty('embedding');
  });

  it('attack: GET unknown role → 404', async () => {
    const r = await fetchJson('/api/roles/ghost');
    expect(r.status).toBe(404);
  });

  it('POST /api/roles/:id/train invokes the factory', async () => {
    await api.stop();
    let received: unknown = null;
    api = createHttpApi({
      db, registry,
      trainRole: async (input) => {
        received = input;
        return { id: input.roleId, name: input.name, systemPrompt: 'x', isBuiltin: false, createdAt: new Date().toISOString() };
      },
    });
    await api.start();
    baseUrl = `http://127.0.0.1:${api.port()}`;

    const r = await fetchJson('/api/roles/expert/train', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Expert',
        documents: [{ filename: 'a.md', content: 'hello world' }],
      }),
    });
    expect(r.status).toBe(200);
    expect((received as { roleId: string }).roleId).toBe('expert');
    expect((received as { documents: unknown[] }).documents).toHaveLength(1);
  });

  it('attack: POST train without factory → 501', async () => {
    const r = await fetchJson('/api/roles/x/train', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', documents: [{ filename: 'a.md', content: '...' }] }),
    });
    expect(r.status).toBe(501);
  });

  it('attack: POST train missing name → 400', async () => {
    await api.stop();
    api = createHttpApi({
      db, registry,
      trainRole: async () => ({}),
    });
    await api.start();
    baseUrl = `http://127.0.0.1:${api.port()}`;

    const r = await fetchJson('/api/roles/x/train', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documents: [{ filename: 'a.md', content: '...' }] }),
    });
    expect(r.status).toBe(400);
  });

  it('attack: POST train empty documents → 400', async () => {
    await api.stop();
    api = createHttpApi({
      db, registry,
      trainRole: async () => ({}),
    });
    await api.start();
    baseUrl = `http://127.0.0.1:${api.port()}`;

    const r = await fetchJson('/api/roles/x/train', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X', documents: [] }),
    });
    expect(r.status).toBe(400);
  });

  it('attack: POST train doc missing filename → 400', async () => {
    await api.stop();
    api = createHttpApi({
      db, registry,
      trainRole: async () => ({}),
    });
    await api.start();
    baseUrl = `http://127.0.0.1:${api.port()}`;

    const r = await fetchJson('/api/roles/x/train', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X', documents: [{ content: 'no filename' }] }),
    });
    expect(r.status).toBe(400);
  });

  it('attack: trainRole factory throws → 500', async () => {
    await api.stop();
    api = createHttpApi({
      db, registry,
      trainRole: async () => { throw new Error('embed crashed'); },
    });
    await api.start();
    baseUrl = `http://127.0.0.1:${api.port()}`;

    const r = await fetchJson('/api/roles/x/train', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X', documents: [{ filename: 'a.md', content: '...' }] }),
    });
    // Wait for the async-execute path to complete
    await new Promise((r) => setTimeout(r, 30));
    expect(r.status).toBe(500);
  });
});

describe('/api/requirements (B3)', () => {
  it('GET returns the recalled requirements', async () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO requirements (id, name, context, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('r1', 'Login redesign', 'users want sso', 'confirmed', now, now);

    const r = await fetchJson('/api/requirements');
    expect(r.status).toBe(200);
    const body = r.body as { requirements: Array<{ id: string }> };
    expect(body.requirements).toHaveLength(1);
    expect(body.requirements[0]?.id).toBe('r1');
  });

  it('GET ?q= filters', async () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO requirements (id, name, context, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('r1', 'Login redesign', 'users want sso', 'confirmed', now, now);
    db.prepare(`INSERT INTO requirements (id, name, context, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('r2', 'Approvals UX', 'allow/deny buttons', 'confirmed', now, now);

    const r = await fetchJson('/api/requirements?q=login');
    expect(r.status).toBe(200);
    const body = r.body as { requirements: Array<{ id: string }> };
    expect(body.requirements).toHaveLength(1);
    expect(body.requirements[0]?.id).toBe('r1');
  });

  it('GET /api/requirements/:id returns the row', async () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO requirements (id, name, context, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('r1', 'Login', 'ctx', 'draft', now, now);

    const r = await fetchJson('/api/requirements/r1');
    expect(r.status).toBe(200);
    expect((r.body as { requirement: { id: string } }).requirement.id).toBe('r1');
  });

  it('attack: unknown id → 404', async () => {
    const r = await fetchJson('/api/requirements/ghost');
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

describe('POST /api/roles/train-chat (Phase 60b)', () => {

  // Build a fake ClaudeCodeAgent factory we can drive without spawning
  // a real `claude` subprocess. The agent under test only uses
  // `sendConversation` + `dispose` from the public surface.
  function makeFakeAgentFactory(behavior: {
    text?: string;
    stderr?: string;
    throws?: Error;
    onCall?: (
      messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
      opts?: { systemPrompt?: string },
    ) => void;
  } = {}) {
    const disposed: number[] = [];
    let agentCount = 0;
    const factory = (opts?: { cwd?: string }) => {
      const id = ++agentCount;
      void opts;
      return {
        sessionId: `fake-${id}`,
        async sendConversation(
          messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
          options: { systemPrompt?: string } = {},
        ) {
          behavior.onCall?.(messages, options);
          if (behavior.throws) throw behavior.throws;
          return {
            text: behavior.text ?? `you said ${messages.length} thing(s)`,
            stderr: behavior.stderr ?? '',
            sessionId: `fake-${id}`,
          };
        },
        dispose() { disposed.push(id); },
      } as unknown as import('../../../src/cli-agent/claude.js').ClaudeCodeAgent;
    };
    return { factory, getDisposed: () => disposed };
  }

  it('501 when cliAgentFactory is not wired', async () => {
    const r = await fetchJson('/api/roles/train-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(r.status).toBe(501);
  });

  it('501 when factory returns null (claude CLI not on PATH)', async () => {
    await api.stop();
    api = createHttpApi({ db, registry, cliAgentFactory: () => null });
    await api.start();
    baseUrl = `http://127.0.0.1:${api.port()}`;
    const r = await fetchJson('/api/roles/train-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(r.status).toBe(501);
    expect((r.body as { message: string }).message).toMatch(/Claude Code CLI not detected/i);
  });

  it('happy: forwards messages → cli agent; returns assistant turn + sessionId', async () => {
    const fake = makeFakeAgentFactory();
    await api.stop();
    api = createHttpApi({ db, registry, cliAgentFactory: fake.factory });
    await api.start();
    baseUrl = `http://127.0.0.1:${api.port()}`;

    const r = await fetchJson('/api/roles/train-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'tell me about Goofy' },
      ] }),
    });
    expect(r.status).toBe(200);
    const body = r.body as {
      message: { role: string; content: string };
      sessionId: string;
    };
    expect(body.message).toEqual({ role: 'assistant', content: 'you said 3 thing(s)' });
    expect(body.sessionId).toMatch(/^fake-/);
  });

  it('passes projectPath through to the factory as cwd', async () => {
    let receivedCwd: string | undefined;
    await api.stop();
    api = createHttpApi({
      db, registry,
      cliAgentFactory: (opts) => {
        receivedCwd = opts?.cwd;
        return makeFakeAgentFactory().factory(opts);
      },
    });
    await api.start();
    baseUrl = `http://127.0.0.1:${api.port()}`;

    await fetchJson('/api/roles/train-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        projectPath: '/Users/me/work/foo',
      }),
    });
    expect(receivedCwd).toBe('/Users/me/work/foo');
  });

  it('attack: missing messages array → 400 (no factory call wasted)', async () => {
    let calls = 0;
    await api.stop();
    api = createHttpApi({
      db, registry,
      cliAgentFactory: () => { calls += 1; return makeFakeAgentFactory().factory(); },
    });
    await api.start();
    baseUrl = `http://127.0.0.1:${api.port()}`;

    const r = await fetchJson('/api/roles/train-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
    expect(calls).toBe(0);
  });

  it('attack: bad message role → 400', async () => {
    const fake = makeFakeAgentFactory();
    await api.stop();
    api = createHttpApi({ db, registry, cliAgentFactory: fake.factory });
    await api.start();
    baseUrl = `http://127.0.0.1:${api.port()}`;

    const r = await fetchJson('/api/roles/train-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'system', content: 'oops' }] }),
    });
    expect(r.status).toBe(400);
  });

  it('attack: agent throws → 502 (cli failure)', async () => {
    const fake = makeFakeAgentFactory({ throws: new Error('claude crashed') });
    await api.stop();
    api = createHttpApi({ db, registry, cliAgentFactory: fake.factory });
    await api.start();
    baseUrl = `http://127.0.0.1:${api.port()}`;

    const r = await fetchJson('/api/roles/train-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(r.status).toBe(502);
    expect((r.body as { error: string }).error).toBe('cli_failed');
  });

  it('non-empty stderr surfaces in the response (debug aid)', async () => {
    const fake = makeFakeAgentFactory({ stderr: 'mcp: helm connected\n' });
    await api.stop();
    api = createHttpApi({ db, registry, cliAgentFactory: fake.factory });
    await api.start();
    baseUrl = `http://127.0.0.1:${api.port()}`;

    const r = await fetchJson('/api/roles/train-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(r.status).toBe(200);
    expect((r.body as { stderr?: string }).stderr).toContain('mcp: helm connected');
  });

  it('disposes the agent after each turn (no tmpdir leak)', async () => {
    const fake = makeFakeAgentFactory();
    await api.stop();
    api = createHttpApi({ db, registry, cliAgentFactory: fake.factory });
    await api.start();
    baseUrl = `http://127.0.0.1:${api.port()}`;

    await fetchJson('/api/roles/train-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'one' }] }),
    });
    await fetchJson('/api/roles/train-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'two' }] }),
    });
    expect(fake.getDisposed()).toEqual([1, 2]);
  });
});

