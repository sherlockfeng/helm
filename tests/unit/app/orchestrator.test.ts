import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { upsertHostSession } from '../../../src/storage/repos/host-sessions.js';
import { createCapturingLoggerFactory } from '../../../src/logger/index.js';
import { createHelmApp } from '../../../src/app/orchestrator.js';
import { sendBridgeMessage } from '../../../src/bridge/client.js';

let db: BetterSqlite3.Database;
let tmpDir: string;
let socketPath: string;

beforeEach(() => {
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  tmpDir = mkdtempSync(join(tmpdir(), 'helm-orch-'));
  socketPath = join(tmpDir, 'bridge.sock');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  db.close();
});

describe('createHelmApp — boot/shutdown', () => {
  it('start brings up bridge + http api + channel', async () => {
    const loggers = createCapturingLoggerFactory();
    const app = createHelmApp({ db, loggers, bridgeSocketPath: socketPath });
    await app.start();
    try {
      expect(app.httpPort()).toBeGreaterThan(0);
      expect(app.channel.isStarted()).toBe(true);
      // Round-trip bridge handler to confirm registration
      const res = await sendBridgeMessage(
        { type: 'host_session_start', host_session_id: 's1', cwd: '/proj' },
        { socketPath, timeoutMs: 5000 },
      );
      expect(res).toBeDefined();
    } finally {
      await app.stop();
    }
  });

  it('attack: starting twice throws', async () => {
    const loggers = createCapturingLoggerFactory();
    const app = createHelmApp({ db, loggers, bridgeSocketPath: socketPath });
    await app.start();
    try {
      await expect(app.start()).rejects.toThrow(/already started/);
    } finally {
      await app.stop();
    }
  });

  it('stop is idempotent', async () => {
    const loggers = createCapturingLoggerFactory();
    const app = createHelmApp({ db, loggers, bridgeSocketPath: socketPath });
    await app.start();
    await app.stop();
    await expect(app.stop()).resolves.toBeUndefined();
  });

  it('Phase 34: seeds built-in roles on createHelmApp so /api/roles is non-empty before MCP boots', async () => {
    const loggers = createCapturingLoggerFactory();
    // Empty DB pre-condition.
    expect((db.prepare('SELECT count(*) AS n FROM roles').get() as { n: number }).n).toBe(0);

    createHelmApp({ db, loggers, bridgeSocketPath: socketPath });

    // Built-in roles are seeded synchronously inside createHelmApp — no
    // start() needed. Without this, the Active Chats UI role picker is
    // disabled because the renderer fetches /api/roles before the MCP
    // stdio subprocess has any reason to be invoked.
    const count = (db.prepare('SELECT count(*) AS n FROM roles').get() as { n: number }).n;
    expect(count).toBeGreaterThan(0);
  });
});

describe('createHelmApp — bridge handlers', () => {
  it('host_session_start persists host_session row', async () => {
    const loggers = createCapturingLoggerFactory();
    const app = createHelmApp({ db, loggers, bridgeSocketPath: socketPath });
    await app.start();
    try {
      await sendBridgeMessage(
        { type: 'host_session_start', host_session_id: 'sess-1', cwd: '/proj', composer_mode: 'agent' },
        { socketPath, timeoutMs: 5000 },
      );
      const row = db.prepare(`SELECT * FROM host_sessions WHERE id = ?`).get('sess-1') as Record<string, unknown> | undefined;
      expect(row?.['cwd']).toBe('/proj');
      expect(row?.['status']).toBe('active');
    } finally {
      await app.stop();
    }
  });

  it('Phase 43: host_prompt_submit auto-registers a session that pre-existed before helm started', async () => {
    const loggers = createCapturingLoggerFactory();
    const app = createHelmApp({ db, loggers, bridgeSocketPath: socketPath });
    await app.start();
    try {
      // Pre-condition: helm has never seen this session id (chat opened before
      // helm booted). The host_prompt_submit handler should still create the row.
      expect(db.prepare(`SELECT 1 FROM host_sessions WHERE id = ?`).get('sess-old')).toBeUndefined();

      const sessionStarted: Array<{ id: string }> = [];
      app.events.on((e) => {
        if (e.type === 'session.started') sessionStarted.push({ id: e.session.id });
      });

      await sendBridgeMessage(
        { type: 'host_prompt_submit', host_session_id: 'sess-old', prompt: 'hi from old chat', cwd: '/proj-old' },
        { socketPath, timeoutMs: 5000 },
      );

      const row = db.prepare(`SELECT cwd, status, first_prompt FROM host_sessions WHERE id = ?`).get('sess-old') as { cwd: string; status: string; first_prompt: string };
      expect(row.cwd).toBe('/proj-old');
      expect(row.status).toBe('active');
      expect(row.first_prompt).toBe('hi from old chat');
      expect(sessionStarted.map((e) => e.id)).toContain('sess-old');
    } finally {
      await app.stop();
    }
  });

  it('Phase 43: host_stop on an unknown session also auto-registers (covers idle chats receiving Lark followups)', async () => {
    const loggers = createCapturingLoggerFactory();
    const app = createHelmApp({ db, loggers, bridgeSocketPath: socketPath, waitPollMs: 50 });
    await app.start();
    try {
      await sendBridgeMessage(
        { type: 'host_stop', host_session_id: 'sess-stop' },
        { socketPath, timeoutMs: 5000 },
      );
      const row = db.prepare(`SELECT status FROM host_sessions WHERE id = ?`).get('sess-stop') as { status: string } | undefined;
      expect(row?.status).toBe('active');
    } finally {
      await app.stop();
    }
  });

  it('Phase 43: existing row is updated, not re-created — session.started fires only first time', async () => {
    const loggers = createCapturingLoggerFactory();
    upsertHostSession(db, {
      id: 'sess-known', host: 'cursor', cwd: '/proj', status: 'active',
      firstSeenAt: '2024-01-01T00:00:00.000Z', lastSeenAt: '2024-01-01T00:00:00.000Z',
    });
    const app = createHelmApp({ db, loggers, bridgeSocketPath: socketPath });
    await app.start();
    try {
      const sessionStarted: string[] = [];
      app.events.on((e) => {
        if (e.type === 'session.started') sessionStarted.push(e.session.id);
      });

      await sendBridgeMessage(
        { type: 'host_prompt_submit', host_session_id: 'sess-known', prompt: 'next msg' },
        { socketPath, timeoutMs: 5000 },
      );
      // last_seen_at bumped, but no session.started fired (already known)
      const row = db.prepare(`SELECT first_seen_at, last_seen_at FROM host_sessions WHERE id = ?`).get('sess-known') as { first_seen_at: string; last_seen_at: string };
      expect(row.first_seen_at).toBe('2024-01-01T00:00:00.000Z');
      expect(row.last_seen_at).not.toBe('2024-01-01T00:00:00.000Z');
      expect(sessionStarted).not.toContain('sess-known');
    } finally {
      await app.stop();
    }
  });

  it('host_approval_request returns "ask" via fallback when no policy + no UI decision', async () => {
    const loggers = createCapturingLoggerFactory();
    const app = createHelmApp({
      db, loggers, bridgeSocketPath: socketPath,
      approvalTimeoutMs: 50, // settle as timeout fast
    });
    await app.start();
    try {
      // Seed a host_session so resolveCwd works
      upsertHostSession(db, {
        id: 'sess-1', host: 'cursor', cwd: '/proj', status: 'active',
        firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
      });
      const res = await sendBridgeMessage(
        { type: 'host_approval_request', host_session_id: 'sess-1', tool: 'Shell', command: 'rm -rf' },
        { socketPath, timeoutMs: 5000 },
      ) as { decision?: string };
      // Default timeout (50ms) elapses → registry maps to 'ask'
      expect(res.decision).toBe('ask');
    } finally {
      await app.stop();
    }
  });

  it('host_approval_request settled by HTTP /decide round-trips back to bridge caller', async () => {
    const loggers = createCapturingLoggerFactory();
    const app = createHelmApp({ db, loggers, bridgeSocketPath: socketPath });
    await app.start();
    try {
      const now = new Date().toISOString();
      upsertHostSession(db, { id: 'sess-1', host: 'cursor', cwd: '/proj', status: 'active', firstSeenAt: now, lastSeenAt: now });

      const bridgeP = sendBridgeMessage(
        { type: 'host_approval_request', host_session_id: 'sess-1', tool: 'Shell', command: 'rm' },
        { socketPath, timeoutMs: 5000 },
      ) as Promise<{ decision: string }>;

      // Wait for the registry to hold a pending entry
      await waitFor(() => app.approval.listPending().length === 1);
      const pending = app.approval.listPending()[0]!;

      const decideRes = await fetch(`http://127.0.0.1:${app.httpPort()}/api/approvals/${pending.id}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'allow' }),
      });
      expect(decideRes.status).toBe(200);

      const bridgeRes = await bridgeP;
      expect(bridgeRes.decision).toBe('allow');
    } finally {
      await app.stop();
    }
  });
});

describe('createHelmApp — provider hot-reload (Phase 27 / D4)', () => {
  it('PUT /api/config swaps configured KnowledgeProviders without a restart', async () => {
    const loggers = createCapturingLoggerFactory();
    const configPath = join(tmpDir, 'config.json');
    const initialConfig = {
      knowledge: {
        providers: [{
          id: 'depscope',
          enabled: true,
          config: {
            endpoint: 'http://depscope.test',
            mappings: [{ cwdPrefix: '/old', scmName: 'org/old' }],
          },
        }],
      },
    };
    const app = createHelmApp({
      db, loggers,
      bridgeSocketPath: socketPath,
      configPath,
      // Cast through unknown — intentionally partial to exercise the schema's
      // defaults-fill behavior; the orchestrator parses this via HelmConfigSchema.
      config: initialConfig as unknown as Parameters<typeof createHelmApp>[0]['config'],
    });
    await app.start();
    try {
      // Boot lands depscope alongside the always-on LocalRoles + RequirementsArchive.
      const initialIds = app.knowledge.list().map((p) => p.id).sort();
      expect(initialIds).toContain('depscope');
      expect(initialIds).toContain('local-roles');
      expect(initialIds).toContain('requirements-archive');

      // Disable depscope via /api/config — should drop it on the spot.
      const port = app.httpPort();
      let res = await fetch(`http://127.0.0.1:${port}/api/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          knowledge: { providers: [{ id: 'depscope', enabled: false, config: {} }] },
        }),
      });
      expect(res.status).toBe(200);
      const afterDisable = app.knowledge.list().map((p) => p.id).sort();
      expect(afterDisable).not.toContain('depscope');
      expect(afterDisable).toContain('local-roles');
      expect(afterDisable).toContain('requirements-archive');

      // Re-enable with new mappings — should re-register a fresh DepscopeProvider.
      res = await fetch(`http://127.0.0.1:${port}/api/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          knowledge: {
            providers: [{
              id: 'depscope',
              enabled: true,
              config: {
                endpoint: 'http://depscope.test',
                mappings: [{ cwdPrefix: '/new', scmName: 'org/new' }],
              },
            }],
          },
        }),
      });
      expect(res.status).toBe(200);
      const afterReEnable = app.knowledge.list().map((p) => p.id).sort();
      expect(afterReEnable).toContain('depscope');

      // The persisted file matches what we just sent (atomic-write target).
      const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as {
        knowledge: { providers: Array<{ id: string; enabled: boolean }> };
      };
      const dep = onDisk.knowledge.providers.find((p) => p.id === 'depscope')!;
      expect(dep.enabled).toBe(true);
    } finally {
      await app.stop();
    }
  });

  it('attack: invalid provider config skips the offender — registry survives', async () => {
    const loggers = createCapturingLoggerFactory();
    const configPath = join(tmpDir, 'config.json');
    const app = createHelmApp({
      db, loggers,
      bridgeSocketPath: socketPath,
      configPath,
    });
    await app.start();
    try {
      const port = app.httpPort();
      // depscope with a bogus endpoint (not a URL) — schema rejects per-provider,
      // orchestrator logs a warning and skips. Always-on providers stay alive.
      const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          knowledge: {
            providers: [{ id: 'depscope', enabled: true, config: { endpoint: 'not-a-url' } }],
          },
        }),
      });
      // Top-level config still parses (per-provider config blob is loose);
      // the per-provider DepscopeProviderConfigSchema is what rejects the URL.
      expect(res.status).toBe(200);
      const ids = app.knowledge.list().map((p) => p.id);
      expect(ids).not.toContain('depscope');
      expect(ids).toContain('local-roles');
    } finally {
      await app.stop();
    }
  });
});

describe('createHelmApp — host_agent_response → Lark mirror (Phase 38)', () => {
  it('mirrors response_text to every Lark binding for the session', async () => {
    const loggers = createCapturingLoggerFactory();

    // Minimal LarkChannel stub. We cast through unknown so we don't need to
    // implement every method — only sendMessage is exercised here.
    const sentMessages: Array<{ bindingId: string; text: string }> = [];
    const fakeLark = {
      id: 'lark',
      isStarted: () => true,
      start: async () => undefined,
      stop: async () => undefined,
      sendMessage: async (binding: { id: string }, text: string) => {
        sentMessages.push({ bindingId: binding.id, text });
      },
      sendApprovalRequest: async () => undefined,
      onInboundMessage: () => () => undefined,
      onApprovalDecision: () => () => undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const app = createHelmApp({
      db, loggers, bridgeSocketPath: socketPath,
      lark: { channel: fakeLark },
    });
    await app.start();
    try {
      // Seed a host_session + 2 lark bindings (multi-fanout) + 1 unrelated channel.
      const now = new Date().toISOString();
      upsertHostSession(db, {
        id: 'sess-mirror', host: 'cursor', cwd: '/p',
        status: 'active', firstSeenAt: now, lastSeenAt: now,
      });
      db.prepare(`
        INSERT INTO channel_bindings (id, channel, host_session_id, external_chat, external_thread, wait_enabled, created_at)
        VALUES ('bnd-l1', 'lark', 'sess-mirror', 'oc_a', 'om_t', 1, ?),
               ('bnd-l2', 'lark', 'sess-mirror', 'oc_b', 'om_t', 1, ?),
               ('bnd-x',  'other', 'sess-mirror', 'x', 'y', 1, ?)
      `).run(now, now, now);

      const r = await sendBridgeMessage(
        { type: 'host_agent_response', host_session_id: 'sess-mirror', response_text: 'agent says hi' },
        { socketPath, timeoutMs: 5000 },
      ) as { ok: boolean; suppressed?: boolean };

      expect(r.ok).toBe(true);
      expect(r.suppressed).toBeUndefined();

      // Allow the fire-and-forget sends to complete.
      await waitFor(() => sentMessages.length === 2);
      const ids = sentMessages.map((m) => m.bindingId).sort();
      expect(ids).toEqual(['bnd-l1', 'bnd-l2']);
      expect(sentMessages.every((m) => m.text === 'agent says hi')).toBe(true);
    } finally {
      await app.stop();
    }
  });

  it('returns suppressed=true when the session has no Lark bindings', async () => {
    const loggers = createCapturingLoggerFactory();
    const app = createHelmApp({ db, loggers, bridgeSocketPath: socketPath });
    await app.start();
    try {
      const now = new Date().toISOString();
      upsertHostSession(db, {
        id: 'sess-quiet', host: 'cursor', status: 'active',
        firstSeenAt: now, lastSeenAt: now,
      });
      const r = await sendBridgeMessage(
        { type: 'host_agent_response', host_session_id: 'sess-quiet', response_text: 'tree falls' },
        { socketPath, timeoutMs: 5000 },
      ) as { ok: boolean; suppressed?: boolean };
      expect(r).toEqual({ ok: true, suppressed: true });
    } finally {
      await app.stop();
    }
  });

  it('attack: empty / whitespace response_text suppresses the mirror', async () => {
    const loggers = createCapturingLoggerFactory();
    const app = createHelmApp({ db, loggers, bridgeSocketPath: socketPath });
    await app.start();
    try {
      const r = await sendBridgeMessage(
        { type: 'host_agent_response', host_session_id: 's', response_text: '   ' },
        { socketPath, timeoutMs: 5000 },
      ) as { suppressed?: boolean };
      expect(r.suppressed).toBe(true);
    } finally {
      await app.stop();
    }
  });
});

describe('createHelmApp — shutdown wakes pendings', () => {
  it('in-flight host_approval_request resolves with ask after stop()', async () => {
    const loggers = createCapturingLoggerFactory();
    const app = createHelmApp({ db, loggers, bridgeSocketPath: socketPath });
    await app.start();
    upsertHostSession(db, {
      id: 'sess-1', host: 'cursor', cwd: '/proj', status: 'active',
      firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
    });

    const bridgeP = sendBridgeMessage(
      { type: 'host_approval_request', host_session_id: 'sess-1', tool: 'Shell', command: 'rm' },
      { socketPath, timeoutMs: 5000 },
    ) as Promise<{ decision: string }>;

    await waitFor(() => app.approval.listPending().length === 1);
    await app.stop();

    const res = await bridgeP;
    expect(res.decision).toBe('ask');
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: predicate did not become true in time');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
