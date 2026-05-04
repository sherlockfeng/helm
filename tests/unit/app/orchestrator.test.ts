import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
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
