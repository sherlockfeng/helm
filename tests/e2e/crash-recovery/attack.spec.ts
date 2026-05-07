/**
 * E2e attacks for crash-recovery (Phase 31 / D1).
 *
 * Verify the recovery path doesn't silently mishandle malformed / weird DB
 * state left behind by a previous boot.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../../../src/storage/migrations.js';
import { createHelmApp, type HelmAppHandle } from '../../../src/app/orchestrator.js';
import { createCapturingLoggerFactory } from '../../../src/logger/index.js';
import { upsertHostSession } from '../../../src/storage/repos/host-sessions.js';
import { listPendingRequests } from '../../../src/storage/repos/approval.js';

let tmpDir: string;
let dbPath: string;
let socketPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'helm-crash-atk-'));
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

describe('crash-recovery attacks', () => {
  it('attack: rows with already-final statuses (allowed/denied/timeout) are NOT re-restored', async () => {
    const db = openDb();
    const now = new Date().toISOString();
    upsertHostSession(db, {
      id: 'sess_a', host: 'cursor', cwd: '/proj',
      status: 'active', firstSeenAt: now, lastSeenAt: now,
    });

    const expires = new Date(Date.now() + 30_000).toISOString();
    // Three rows that pre-existed in the DB — only 'pending' should restore.
    const insert = db.prepare(`
      INSERT INTO approval_requests
        (id, host_session_id, tool, command, status, created_at, expires_at)
      VALUES (?, ?, 'Shell', ?, ?, ?, ?)
    `);
    insert.run('pa_alive', 'sess_a', 'rm a', 'pending', now, expires);
    insert.run('pa_done_allow', 'sess_a', 'rm b', 'allowed', now, expires);
    insert.run('pa_done_deny', 'sess_a', 'rm c', 'denied', now, expires);
    insert.run('pa_done_timeout', 'sess_a', 'rm d', 'timeout', now, expires);

    const app = await bootApp(db);

    const restoredIds = app.approval.listPending().map((p) => p.id);
    expect(restoredIds).toContain('pa_alive');
    expect(restoredIds).not.toContain('pa_done_allow');
    expect(restoredIds).not.toContain('pa_done_deny');
    expect(restoredIds).not.toContain('pa_done_timeout');

    // listPendingRequests filters by status='pending' — confirms our DB
    // ground truth matches the registry's view.
    const dbPending = listPendingRequests(db).map((p) => p.id);
    expect(dbPending).toEqual(['pa_alive']);

    await app.stop();
    db.close();
  });

  it('attack: empty DB (no surviving pendings) → registry boots cleanly with zero restored', async () => {
    const db = openDb();
    const app = await bootApp(db);
    expect(app.approval.listPending()).toHaveLength(0);
    await app.stop();
    db.close();
  });

  it('attack: deciding a restored pending via HTTP returns 409 if the row was already settled out-of-band', async () => {
    let db = openDb();
    const now = new Date().toISOString();
    upsertHostSession(db, {
      id: 'sess_x', host: 'cursor', cwd: '/proj',
      status: 'active', firstSeenAt: now, lastSeenAt: now,
    });

    db.prepare(`
      INSERT INTO approval_requests
        (id, host_session_id, tool, command, status, created_at, expires_at)
      VALUES (?, 'sess_x', 'Shell', 'rm', 'pending', ?, ?)
    `).run('pa_race', now, new Date(Date.now() + 30_000).toISOString());

    const app = await bootApp(db);
    expect(app.approval.listPending().map((p) => p.id)).toContain('pa_race');

    // Settle once via HTTP — succeeds.
    const r1 = await fetch(
      `http://127.0.0.1:${app.httpPort()}/api/approvals/pa_race/decide`,
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'allow' }),
      },
    );
    expect(r1.status).toBe(200);

    // A repeat decide on the same id (e.g. user double-clicked Approve) → 409.
    const r2 = await fetch(
      `http://127.0.0.1:${app.httpPort()}/api/approvals/pa_race/decide`,
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'deny' }),
      },
    );
    expect(r2.status).toBe(409);

    await app.stop();
    db.close();
  });
});
