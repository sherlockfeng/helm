/**
 * Shared boot harness for e2e tests.
 *
 * Each spec gets its own HelmApp instance with:
 *   - in-memory SQLite (no `~/.helm` side-effects)
 *   - capturing logger (no file IO, accessible for assertions)
 *   - tmp UDS socket path so parallel specs (if ever enabled) don't collide
 *   - ephemeral HTTP port
 *
 * Helper functions for the most common e2e moves:
 *   - runHookViaBridge() — drives the real Cursor hook entry against the
 *     real bridge over a real socket, end-to-end.
 *   - waitFor() — polling assertion helper for "eventually X" properties.
 */

import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { runMigrations } from '../../../src/storage/migrations.js';
import { createHelmApp, type HelmAppDeps, type HelmAppHandle } from '../../../src/app/orchestrator.js';
import { createCapturingLoggerFactory, type LoggerFactory } from '../../../src/logger/index.js';
import { runHook } from '../../../src/host/cursor/hook-entry.js';
import { insertChannelBinding } from '../../../src/storage/repos/channel-bindings.js';

/**
 * Phase 46a: the orchestrator's requireApproval gate auto-allows requests
 * from chats that aren't bound to any remote channel. E2e tests that
 * exercise the full approval round-trip (pending row → user click → settle)
 * must seed a Lark binding so the gate routes through the pending path.
 *
 * Lower-cost than threading a `requireApproval` test override — this
 * matches production wiring (only Lark-bound chats need approvals) and
 * keeps the e2e surface honest.
 */
export function seedLarkBinding(db: BetterSqlite3.Database, hostSessionId: string): void {
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

export interface E2eHarness {
  app: HelmAppHandle;
  db: BetterSqlite3.Database;
  loggers: LoggerFactory;
  socketPath: string;
  tmpDir: string;
  shutdown: () => Promise<void>;
}

export interface BootE2eOptions {
  /** Override fields on HelmAppDeps. Test gets full control. */
  deps?: Partial<HelmAppDeps>;
  /** Pre-seed the DB before HelmApp.start(). */
  seed?: (db: BetterSqlite3.Database) => void;
}

export async function bootE2e(options: BootE2eOptions = {}): Promise<E2eHarness> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'helm-e2e-'));
  const socketPath = join(tmpDir, 'bridge.sock');
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  if (options.seed) options.seed(db);

  const loggers = createCapturingLoggerFactory();
  const app = createHelmApp({
    db,
    loggers,
    bridgeSocketPath: socketPath,
    httpPort: 0,
    waitPollMs: 500,
    approvalTimeoutMs: 2000,
    ...options.deps,
  });
  await app.start();

  return {
    app, db, loggers, socketPath, tmpDir,
    async shutdown() {
      await app.stop();
      rmSync(tmpDir, { recursive: true, force: true });
      db.close();
    },
  };
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
 * End-to-end Cursor hook → bridge → orchestrator → response. Drives the real
 * runHook() from src/host/cursor/hook-entry.ts using injected stdin/stdout
 * streams against the test app's socket.
 */
export async function runHookViaBridge(
  harness: E2eHarness,
  args: { event: string; payload: object; envOverrides?: NodeJS.ProcessEnv },
): Promise<unknown> {
  const stdin = Readable.from([Buffer.from(JSON.stringify(args.payload), 'utf8')]);
  const stdout = new MemoryStdout();
  await runHook({
    argv: ['--event', args.event],
    stdin,
    stdout,
    socketPath: harness.socketPath,
    env: { ...process.env, ...args.envOverrides },
  });
  return stdout.json();
}

/**
 * Poll `predicate()` until it returns truthy or `timeoutMs` elapses.
 * Throws with the last evaluated value when the deadline passes.
 */
export async function waitFor<T>(
  predicate: () => T | undefined | null | false,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 2000);
  const interval = options.intervalMs ?? 10;
  let last: T | undefined | null | false = undefined;
  while (Date.now() < deadline) {
    last = predicate();
    if (last) return last as T;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitFor(${options.label ?? 'predicate'}) timed out; last=${JSON.stringify(last)}`);
}
