/**
 * host_stop long-poll behavior. Tests against the real orchestrator + bridge
 * loopback so the e2e wiring (bridge handler → channel_message_queue drain →
 * EventBus subscription) is exercised end-to-end.
 */

import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { upsertHostSession } from '../../../src/storage/repos/host-sessions.js';
import {
  enqueueMessage,
  insertChannelBinding,
} from '../../../src/storage/repos/channel-bindings.js';
import { createCapturingLoggerFactory } from '../../../src/logger/index.js';
import { createHelmApp, type HelmAppHandle } from '../../../src/app/orchestrator.js';
import { sendBridgeMessage } from '../../../src/bridge/client.js';

let db: BetterSqlite3.Database;
let tmpDir: string;
let socketPath: string;
let app: HelmAppHandle;

beforeEach(() => {
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  tmpDir = mkdtempSync(join(tmpdir(), 'helm-host-stop-'));
  socketPath = join(tmpDir, 'bridge.sock');

  const now = new Date().toISOString();
  upsertHostSession(db, { id: 's1', host: 'cursor', cwd: '/proj', status: 'active', firstSeenAt: now, lastSeenAt: now });
  insertChannelBinding(db, {
    id: 'bnd_lark', channel: 'lark', hostSessionId: 's1',
    externalChat: 'oc_chat', externalThread: 'om_thread',
    waitEnabled: true, createdAt: now,
  });
});

afterEach(async () => {
  if (app) await app.stop();
  rmSync(tmpDir, { recursive: true, force: true });
  db.close();
});

async function bootApp(waitPollMs = 50): Promise<void> {
  app = createHelmApp({
    db,
    loggers: createCapturingLoggerFactory(),
    bridgeSocketPath: socketPath,
    waitPollMs,
  });
  await app.start();
}

describe('host_stop — drain', () => {
  it('returns followup_message immediately when a message is already queued', async () => {
    enqueueMessage(db, { bindingId: 'bnd_lark', text: 'pre-queued', createdAt: new Date().toISOString() });
    await bootApp(10_000);

    const res = await sendBridgeMessage(
      { type: 'host_stop', host_session_id: 's1' },
      { socketPath, timeoutMs: 5_000 },
    ) as { followup_message?: string };
    expect(res.followup_message).toBe('pre-queued');
  });

  it('joins multiple queued messages with blank-line separator', async () => {
    enqueueMessage(db, { bindingId: 'bnd_lark', text: 'one', createdAt: new Date().toISOString() });
    enqueueMessage(db, { bindingId: 'bnd_lark', text: 'two', createdAt: new Date().toISOString() });
    await bootApp(10_000);

    const res = await sendBridgeMessage(
      { type: 'host_stop', host_session_id: 's1' },
      { socketPath, timeoutMs: 5_000 },
    ) as { followup_message?: string };
    expect(res.followup_message).toBe('one\n\ntwo');
  });
});

describe('host_stop — long-poll wakeup', () => {
  it('resolves promptly when a message arrives mid-poll', async () => {
    await bootApp(2_000);

    const stopP = sendBridgeMessage(
      { type: 'host_stop', host_session_id: 's1' },
      { socketPath, timeoutMs: 5_000 },
    ) as Promise<{ followup_message?: string }>;

    // Simulate Lark message arriving 30ms in
    setTimeout(() => {
      const id = enqueueMessage(db, { bindingId: 'bnd_lark', text: 'arrived', createdAt: new Date().toISOString() });
      app.events.emit({ type: 'channel.message_enqueued', bindingId: 'bnd_lark', messageId: id });
    }, 30);

    const res = await stopP;
    expect(res.followup_message).toBe('arrived');
  });
});

describe('host_stop — empty + no bindings', () => {
  it('returns {} after waitPollMs when no messages arrive', async () => {
    await bootApp(40);
    const res = await sendBridgeMessage(
      { type: 'host_stop', host_session_id: 's1' },
      { socketPath, timeoutMs: 5_000 },
    );
    expect(res).toEqual({});
  });

  it('attack: session with no bindings → fast empty response', async () => {
    db.prepare(`DELETE FROM channel_bindings WHERE id = 'bnd_lark'`).run();
    await bootApp(10_000);

    const start = Date.now();
    const res = await sendBridgeMessage(
      { type: 'host_stop', host_session_id: 's1' },
      { socketPath, timeoutMs: 5_000 },
    );
    expect(res).toEqual({});
    // Should be fast (no waitPoll wait) — not held for the long-poll budget
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('attack: messages enqueued for a different binding do not wake this poll', async () => {
    const now = new Date().toISOString();
    upsertHostSession(db, { id: 's2', host: 'cursor', status: 'active', firstSeenAt: now, lastSeenAt: now });
    insertChannelBinding(db, {
      id: 'bnd_other', channel: 'lark', hostSessionId: 's2',
      externalChat: 'oc_other', externalThread: 'om_other',
      waitEnabled: true, createdAt: now,
    });
    await bootApp(40);

    setTimeout(() => {
      const id = enqueueMessage(db, { bindingId: 'bnd_other', text: 'noise', createdAt: new Date().toISOString() });
      app.events.emit({ type: 'channel.message_enqueued', bindingId: 'bnd_other', messageId: id });
    }, 5);

    const res = await sendBridgeMessage(
      { type: 'host_stop', host_session_id: 's1' },
      { socketPath, timeoutMs: 5_000 },
    );
    expect(res).toEqual({});
  });
});
