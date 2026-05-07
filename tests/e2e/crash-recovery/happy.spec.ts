/**
 * E2e — pending-approval crash recovery (Phase 31 / §25.4 D1).
 *
 * The orchestrator's `ApprovalRegistry.reloadFromDatabase()` re-arms the
 * timer + restores the in-memory mirror for any pending row that survived
 * a previous restart. The plumbing has been there since Phase 4, but until
 * now no e2e proved the round trip end-to-end:
 *
 *   1. Boot a Helm instance against a file-backed SQLite db.
 *   2. Drive a real beforeShellExecution hook so the registry creates a
 *      pending row + the LocalChannel pushes it.
 *   3. Stop the helm app *without* settling — the registry's shutdown
 *      transitions in-memory pending to 'timeout', but the on-disk row's
 *      `status` stays 'pending' (registry.shutdown does not flush state
 *      back to the DB).
 *   4. Re-open a fresh Helm instance against the same DB file.
 *   5. Assert the pending re-surfaces in `app.approval.listPending()` AND
 *      via `GET /api/approvals` so the renderer's Approvals page lights
 *      up after a restart.
 *   6. Decide via the second instance's HTTP API → registry.settle persists
 *      the new status to the DB.
 *
 * The "force kill" is approximated by closing the bridge / channel / HTTP
 * cleanly but skipping the registry's `shutdown('helm app shutdown')` call
 * that would normally settle pendings as 'timeout' — that's the realistic
 * crash signature where the process dies without a chance to drain.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { runMigrations } from '../../../src/storage/migrations.js';
import { createHelmApp, type HelmAppHandle } from '../../../src/app/orchestrator.js';
import { createCapturingLoggerFactory } from '../../../src/logger/index.js';
import { upsertHostSession } from '../../../src/storage/repos/host-sessions.js';
import { insertChannelBinding } from '../../../src/storage/repos/channel-bindings.js';
import { runHook } from '../../../src/host/cursor/hook-entry.js';
import { listPendingRequests } from '../../../src/storage/repos/approval.js';

/**
 * Phase 46a: bind the session to a fake Lark thread so the orchestrator's
 * requireApproval gate routes through the pending path. Without this the
 * gate auto-allows every request and no pending row is ever created.
 */
function seedLarkBinding(db: BetterSqlite3.Database, hostSessionId: string): void {
  insertChannelBinding(db, {
    id: `b_${hostSessionId}`,
    channel: 'lark',
    hostSessionId,
    externalChat: 'oc_e2e',
    externalThread: 'tr_e2e',
    externalRoot: 'om_e2e',
    waitEnabled: false,
    createdAt: new Date().toISOString(),
  });
}

let tmpDir: string;
let dbPath: string;
let socketPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'helm-crash-'));
  dbPath = join(tmpDir, 'data.db');
  socketPath = join(tmpDir, 'bridge.sock');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

async function bootApp(db: BetterSqlite3.Database): Promise<HelmAppHandle> {
  const app = createHelmApp({
    db,
    loggers: createCapturingLoggerFactory(),
    bridgeSocketPath: socketPath,
    httpPort: 0,
    waitPollMs: 500,
    approvalTimeoutMs: 60_000,
  });
  await app.start();
  return app;
}

class MemoryStdout extends Writable {
  chunks: Buffer[] = [];
  override _write(chunk: Buffer, _enc: string, cb: (err?: Error | null) => void): void {
    this.chunks.push(chunk);
    cb();
  }
  json(): unknown {
    const text = Buffer.concat(this.chunks).toString('utf8').trim();
    return text ? JSON.parse(text) : null;
  }
}

/**
 * Fire the hook in the background so it stays awaiting the bridge response.
 * Returns a controller the test can use to wait for the hook output once the
 * second instance settles the pending. We can't await it directly because
 * the first instance dies before responding.
 */
function spawnHookInBackground(payload: object): {
  outputP: Promise<unknown>;
  finished: () => boolean;
} {
  const stdin = Readable.from([Buffer.from(JSON.stringify(payload), 'utf8')]);
  const stdout = new MemoryStdout();
  let done = false;
  const outputP = runHook({
    argv: ['--event', 'beforeShellExecution'],
    stdin,
    stdout,
    socketPath,
    env: { ...process.env, HELM_BRIDGE_TIMEOUT_MS: '60000' },
  }).then(() => {
    done = true;
    return stdout.json();
  });
  return { outputP, finished: () => done };
}

describe('crash-recovery happy', () => {
  it('pending created in instance A re-surfaces in instance B after restart', async () => {
    // Boot A.
    let db = openDb();
    const now = new Date().toISOString();
    upsertHostSession(db, {
      id: 'sess_recover', host: 'cursor', cwd: '/proj',
      status: 'active', firstSeenAt: now, lastSeenAt: now,
    });
    seedLarkBinding(db, 'sess_recover');
    let app = await bootApp(db);

    // Step 2: fire a hook that creates a pending. The hook's outputP will
    // hang until *something* settles (the original instance dies first, so
    // the original promise never resolves; we abandon it).
    const hookA = spawnHookInBackground({
      session_id: 'sess_recover',
      command: 'pnpm install',
    });
    void hookA;

    // Wait for the registry to actually have a pending.
    const deadline = Date.now() + 2000;
    while (app.approval.listPending().length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(app.approval.listPending()).toHaveLength(1);
    const pendingId = app.approval.listPending()[0]!.id;

    // Step 3: simulate crash. Stop the orchestrator *but skip* the registry
    // shutdown sweep — emulates the process being killed without a chance to
    // settle in-flight pendings as timeout. The on-disk row's status stays
    // 'pending'. We do this by closing the lower-level subsystems directly
    // and skipping app.stop() (which would invoke registry.shutdown and
    // mutate the row to 'timeout').
    await app.bridge.stop();
    await app.channel.stop();
    await app.httpApi.stop();
    db.close();

    // Confirm the row is still pending on disk.
    db = openDb();
    const surviving = listPendingRequests(db).find((p) => p.id === pendingId);
    expect(surviving).toBeDefined();
    expect(surviving!.status).toBe('pending');

    // Step 4: boot B against the same file.
    app = await bootApp(db);

    // Step 5: pending re-appears via the in-memory listing AND via HTTP.
    const pendingAfterRestart = app.approval.listPending();
    expect(pendingAfterRestart.map((p) => p.id)).toContain(pendingId);

    const r = await fetch(`http://127.0.0.1:${app.httpPort()}/api/approvals`);
    expect(r.status).toBe(200);
    const body = await r.json() as { approvals: Array<{ id: string; tool: string; command?: string }> };
    const restored = body.approvals.find((p) => p.id === pendingId);
    expect(restored).toBeDefined();
    expect(restored!.tool).toBe('Shell');
    expect(restored!.command).toContain('pnpm install');

    // Step 6: settle via the second instance's HTTP API.
    const decideR = await fetch(
      `http://127.0.0.1:${app.httpPort()}/api/approvals/${encodeURIComponent(pendingId)}/decide`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'allow', reason: 'recovered + approved' }),
      },
    );
    expect(decideR.status).toBe(200);

    // The DB row is no longer pending; the Approvals list is empty again.
    expect(app.approval.listPending()).toHaveLength(0);
    expect(listPendingRequests(db).find((p) => p.id === pendingId)).toBeUndefined();

    await app.stop();
    db.close();
  });

  it('expired pending still loads but its restored timer fires immediately, settling as timeout', async () => {
    let db = openDb();
    const now = new Date().toISOString();
    upsertHostSession(db, {
      id: 'sess_x', host: 'cursor', cwd: '/proj',
      status: 'active', firstSeenAt: now, lastSeenAt: now,
    });

    // Manually insert a pending whose expires_at is in the past — emulates a
    // crash followed by a long pause before the user got back.
    db.prepare(`
      INSERT INTO approval_requests
        (id, host_session_id, tool, command, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      'pa_stale', 'sess_x', 'Shell', 'rm -rf /tmp/old',
      new Date(Date.now() - 60_000).toISOString(),
      new Date(Date.now() - 1000).toISOString(),
    );
    db.close();

    db = openDb();
    const app = await bootApp(db);

    // The reloadFromDatabase path arms the timer with `expiresMs = max(0, …)`,
    // so an already-expired entry fires on the first event-loop turn. Wait
    // briefly for the timeout sweep to run, then assert it's gone.
    const deadline = Date.now() + 500;
    while (app.approval.listPending().length > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(app.approval.listPending()).toHaveLength(0);
    const dbRow = listPendingRequests(db).find((p) => p.id === 'pa_stale');
    expect(dbRow).toBeUndefined();

    await app.stop();
    db.close();
  });
});
