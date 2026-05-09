import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { upsertHostSession } from '../../../src/storage/repos/host-sessions.js';
import {
  getChannelBinding,
  getPendingBind,
  insertChannelBinding,
  pendingMessageCount,
} from '../../../src/storage/repos/channel-bindings.js';
import { getApprovalRequest } from '../../../src/storage/repos/approval.js';
import { ApprovalRegistry } from '../../../src/approval/registry.js';
import { ApprovalPolicyEngine } from '../../../src/approval/policy.js';
import { LarkChannel } from '../../../src/channel/lark/adapter.js';
import { createCapturingLoggerFactory } from '../../../src/logger/index.js';
import { createEventBus, type AppEvent } from '../../../src/events/bus.js';
import { attachLarkChannel, consumePendingBind } from '../../../src/app/lark-wiring.js';
import type {
  LarkCliRunner,
  LarkCliRunResult,
  LarkCliSpawnHandle,
} from '../../../src/channel/lark/cli-runner.js';
import type { LarkListener, LarkListenerEvent } from '../../../src/channel/lark/listener.js';

class FakeCli implements LarkCliRunner {
  readonly runs: Array<{ args: readonly string[] }> = [];
  async run(args: readonly string[]): Promise<LarkCliRunResult> {
    this.runs.push({ args });
    return { stdout: '', stderr: '', exitCode: 0 };
  }
  spawn(): LarkCliSpawnHandle { throw new Error('not used'); }
}

class FakeListener implements LarkListener {
  private handlers = new Set<(e: LarkListenerEvent) => void>();
  start(): void {}
  async stop(): Promise<void> { this.handlers.clear(); }
  onEvent(h: (e: LarkListenerEvent) => void): () => void {
    this.handlers.add(h);
    return () => { this.handlers.delete(h); };
  }
  isRunning(): boolean { return true; }
  spawnCount(): number { return 1; }
  emit(e: LarkListenerEvent): void { for (const h of [...this.handlers]) h(e); }
}

let db: BetterSqlite3.Database;
let registry: ApprovalRegistry;
let policy: ApprovalPolicyEngine;
let cli: FakeCli;
let listener: FakeListener;
let channel: LarkChannel;
let events: ReturnType<typeof createEventBus>;
let emitted: AppEvent[];

beforeEach(async () => {
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  registry = new ApprovalRegistry(db, { defaultTimeoutMs: 60_000 });
  policy = new ApprovalPolicyEngine(db);
  cli = new FakeCli();
  listener = new FakeListener();
  channel = new LarkChannel({ cli, listener });
  events = createEventBus();
  emitted = [];
  events.on((e) => { emitted.push(e); });
  await channel.start();

  // Seed a host_session + lark binding for most tests.
  const now = new Date().toISOString();
  upsertHostSession(db, { id: 's1', host: 'cursor', cwd: '/proj', status: 'active', firstSeenAt: now, lastSeenAt: now });
  insertChannelBinding(db, {
    id: 'bnd_lark', channel: 'lark', hostSessionId: 's1',
    externalChat: 'oc_chat', externalThread: 'om_thread',
    waitEnabled: true, createdAt: now,
  });
});

afterEach(async () => {
  await channel.stop();
  registry.shutdown();
  db.close();
});

const log = createCapturingLoggerFactory().module('test');

function attach() {
  return attachLarkChannel({ db, channel, registry, policy, events, log });
}

function inboundMessage(text: string, opts: { mentioned?: boolean } = {}): LarkListenerEvent {
  return {
    kind: 'message', messageId: 'om_msg', chatId: 'oc_chat', threadId: 'om_thread',
    text, mentioned: opts.mentioned ?? false, receivedAt: new Date().toISOString(), raw: {},
  };
}

describe('attachLarkChannel — approval decisions', () => {
  it('/allow on the latest pending settles via registry', async () => {
    attach();
    const pending = registry.create({ hostSessionId: 's1', tool: 'Shell', command: 'rm' });
    listener.emit(inboundMessage('/allow'));
    const settled = await pending.settled;
    expect(settled.permission).toBe('allow');
    expect(settled.decidedBy).toBe('lark');
    // The bot replied with a confirmation message
    expect(cli.runs.length).toBeGreaterThanOrEqual(1);
    expect(emitted.some((e) => e.type === 'approval.settled')).toBe(true);
  });

  it('/allow! shell adds a Policy rule and settles', async () => {
    attach();
    const pending = registry.create({ hostSessionId: 's1', tool: 'Shell', command: 'pnpm install' });
    listener.emit(inboundMessage('/allow! shell'));
    const settled = await pending.settled;
    expect(settled.permission).toBe('allow');
    const rules = policy.list();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ tool: 'Shell', toolScope: true, decision: 'allow' });
  });

  it('/deny apr_xyz with explicit id targets that approval', async () => {
    attach();
    const a = registry.create({ hostSessionId: 's1', tool: 'Shell', command: 'a' });
    const b = registry.create({ hostSessionId: 's1', tool: 'Shell', command: 'b' });
    listener.emit(inboundMessage(`/deny ${a.request.id}`));
    expect((await a.settled).permission).toBe('deny');
    // b should still be pending → not settled
    expect(getApprovalRequest(db, b.request.id)?.status).toBe('pending');
    // Cleanup b for the registry
    registry.settle(b.request.id, { permission: 'allow', decidedBy: 'local-ui' });
    await b.settled;
  });

  it('attack: /allow when no pending exists replies "no pending" and does NOT throw', async () => {
    attach();
    listener.emit(inboundMessage('/allow'));
    // Wait a tick for handler chain to run
    await new Promise((r) => setTimeout(r, 5));
    const reply = cli.runs.find((r) => r.args.includes('--markdown'));
    const idx = reply?.args.indexOf('--markdown');
    expect(reply?.args[(idx ?? -1) + 1]).toContain('No pending approval');
  });

  it('attack: /allow with id that does not exist replies with the missing-id message', async () => {
    attach();
    registry.create({ hostSessionId: 's1', tool: 'Shell', command: 'a' });
    listener.emit(inboundMessage('/allow apr_ghost'));
    await new Promise((r) => setTimeout(r, 5));
    const replies = cli.runs.map((r) => r.args[r.args.indexOf('--markdown') + 1]);
    expect(replies.some((t) => typeof t === 'string' && t.includes('apr_ghost'))).toBe(true);
  });
});

describe('attachLarkChannel — bind handshake', () => {
  it('creates a pending_bind row and replies with the code', async () => {
    attach();
    listener.emit(inboundMessage('@bot bind chat', { mentioned: true }));
    await new Promise((r) => setTimeout(r, 5));

    const reply = cli.runs.find((r) => {
      const md = r.args[r.args.indexOf('--markdown') + 1];
      return typeof md === 'string' && md.includes('Binding code');
    });
    expect(reply).toBeDefined();
    const text = reply!.args[reply!.args.indexOf('--markdown') + 1] ?? '';
    const codeMatch = /`([0-9A-F]{6})`/.exec(text);
    expect(codeMatch).not.toBeNull();
    const code = codeMatch![1]!;
    expect(getPendingBind(db, code)?.channel).toBe('lark');
  });

  it('Phase 36: "@bot dr bind chat" persists label="dr" in pending_binds and reply mentions it', async () => {
    attach();
    listener.emit(inboundMessage('@bot dr bind chat', { mentioned: true }));
    await new Promise((r) => setTimeout(r, 5));

    const reply = cli.runs.find((r) => {
      const md = r.args[r.args.indexOf('--markdown') + 1];
      return typeof md === 'string' && md.includes('Binding code');
    });
    const text = reply!.args[reply!.args.indexOf('--markdown') + 1] ?? '';
    const code = /`([0-9A-F]{6})`/.exec(text)![1]!;
    // Reply confirms the label so the user can see it stuck.
    expect(text).toContain('label: "dr"');
    // pending_binds row carries it for the consume step.
    expect(getPendingBind(db, code)?.label).toBe('dr');
  });
});

describe('attachLarkChannel — Phase 64 consume (`@bot bind <CODE>`)', () => {
  it('happy: consumes a helm-minted code → channel_bindings row + binding.created event', async () => {
    attach();

    // Seed a pending row pre-bound to a chat (this is what
    // createPendingLarkBind would have written when the user clicked
    // "Mirror to Lark" in helm UI).
    db.prepare(`
      INSERT INTO pending_binds (code, channel, host_session_id, label, expires_at)
      VALUES ('ABC123', 'lark', 's1', 'tce-thread', ?)
    `).run(new Date(Date.now() + 60_000).toISOString());

    // The user pastes the snippet in a fresh Lark thread (om_target_thread).
    listener.emit({
      kind: 'message',
      messageId: 'om_consume_msg',
      chatId: 'oc_target_chat',
      threadId: 'om_target_thread',
      text: '@bot bind ABC123',
      mentioned: true,
      receivedAt: new Date().toISOString(),
      raw: {},
    });
    await new Promise((r) => setTimeout(r, 5));

    // pending_binds row gone (consumed).
    expect(getPendingBind(db, 'ABC123')).toBeUndefined();

    // channel_bindings row exists with the thread coordinates from the
    // inbound message + the hostSessionId from the pending row + label.
    const created = emitted.find((e) => e.type === 'binding.created');
    expect(created).toBeDefined();
    const bindingId = (created as Extract<AppEvent, { type: 'binding.created' }>).binding.id;
    const binding = getChannelBinding(db, bindingId);
    expect(binding).toMatchObject({
      channel: 'lark',
      hostSessionId: 's1',
      externalChat: 'oc_target_chat',
      externalThread: 'om_target_thread',
      label: 'tce-thread',
    });
  });

  it('attack: unknown code (valid hex but not in DB) → friendly reply, no binding created', async () => {
    attach();
    listener.emit({
      kind: 'message',
      messageId: 'om_consume_msg',
      chatId: 'oc_x', threadId: 'om_x',
      // Valid 6-hex shape but no row in pending_binds → "unknown or expired"
      text: '@bot bind DEADBE',
      mentioned: true,
      receivedAt: new Date().toISOString(), raw: {},
    });
    await new Promise((r) => setTimeout(r, 5));

    const created = emitted.filter((e) => e.type === 'binding.created');
    expect(created).toHaveLength(0);

    const reply = cli.runs.find((r) => {
      const md = r.args[r.args.indexOf('--markdown') + 1];
      return typeof md === 'string' && md.includes('DEADBE');
    });
    expect(reply).toBeDefined();
    const md = reply!.args[reply!.args.indexOf('--markdown') + 1] ?? '';
    expect(md).toMatch(/unknown or expired/i);
  });

  it('attack: invalid-shape code (non-hex chars) → parser drops it; no reply, no binding', async () => {
    attach();
    listener.emit({
      kind: 'message',
      messageId: 'om_consume_msg',
      chatId: 'oc_x', threadId: 'om_x',
      text: '@bot bind ZZZZZZ',  // Z is not [0-9A-F] → parser returns unknown
      mentioned: true,
      receivedAt: new Date().toISOString(), raw: {},
    });
    await new Promise((r) => setTimeout(r, 5));

    // No reply at all — parser short-circuited before handleInbound saw a
    // consume intent. Documenting the actual behavior: arbitrary chatter
    // with the word "bind" doesn't trigger ANY response.
    expect(cli.runs).toHaveLength(0);
    expect(emitted.filter((e) => e.type === 'binding.created')).toHaveLength(0);
  });

  it('legacy: code without hostSessionId (Lark-first flow) → instructive reply, no auto-consume', async () => {
    attach();

    // Seed a pending without hostSessionId — mirrors the `@bot bind chat`
    // path where the user is supposed to consume via the renderer.
    db.prepare(`
      INSERT INTO pending_binds (code, channel, expires_at)
      VALUES ('FACE01', 'lark', ?)
    `).run(new Date(Date.now() + 60_000).toISOString());

    listener.emit({
      kind: 'message',
      messageId: 'om_legacy', chatId: 'oc_x', threadId: 'om_x',
      text: '@bot bind FACE01', mentioned: true,
      receivedAt: new Date().toISOString(), raw: {},
    });
    await new Promise((r) => setTimeout(r, 5));

    // Pending row stays — it's still consumable via the renderer flow.
    expect(getPendingBind(db, 'FACE01')).toBeDefined();

    const reply = cli.runs.find((r) => {
      const md = r.args[r.args.indexOf('--markdown') + 1];
      return typeof md === 'string' && md.includes('FACE01');
    });
    expect(reply).toBeDefined();
    const md = reply!.args[reply!.args.indexOf('--markdown') + 1] ?? '';
    expect(md).toMatch(/needs to be consumed in the Helm desktop app/i);
  });
});

describe('attachLarkChannel — unbind / disable_wait', () => {
  it('@bot unbind drops bindings for this thread + emits binding.removed', async () => {
    attach();
    listener.emit(inboundMessage('@bot unbind', { mentioned: true }));
    await new Promise((r) => setTimeout(r, 5));
    expect(getChannelBinding(db, 'bnd_lark')).toBeUndefined();
    expect(emitted.find((e) => e.type === 'binding.removed')).toMatchObject({ bindingId: 'bnd_lark' });
  });

  it('@bot disable wait sets waitEnabled = false', async () => {
    attach();
    listener.emit(inboundMessage('@bot disable wait', { mentioned: true }));
    await new Promise((r) => setTimeout(r, 5));
    expect(getChannelBinding(db, 'bnd_lark')?.waitEnabled).toBe(false);
  });
});

describe('attachLarkChannel — inbound message queue', () => {
  it('non-command message enqueues into channel_message_queue + emits enqueued', async () => {
    attach();
    listener.emit(inboundMessage('hello there'));
    await new Promise((r) => setTimeout(r, 5));

    expect(pendingMessageCount(db, 'bnd_lark')).toBe(1);
    expect(emitted.find((e) => e.type === 'channel.message_enqueued')).toMatchObject({
      bindingId: 'bnd_lark',
    });
  });

  it('attack: message in a chat with no binding is silently dropped (no enqueue, no throw)', async () => {
    attach();
    const ev = {
      kind: 'message' as const,
      messageId: 'om_x', chatId: 'oc_unknown', threadId: 'om_thread',
      text: 'random', mentioned: false, receivedAt: new Date().toISOString(), raw: {},
    };
    listener.emit(ev);
    await new Promise((r) => setTimeout(r, 5));
    expect(pendingMessageCount(db, 'bnd_lark')).toBe(0);
  });
});

describe('attachLarkChannel — pending push to Lark', () => {
  it('a new ApprovalRequest with a Lark binding is pushed via lark-cli', async () => {
    attach();
    registry.create({ hostSessionId: 's1', tool: 'Shell', command: 'rm -rf /tmp' });
    // Wait a tick for the listener chain
    await new Promise((r) => setTimeout(r, 5));
    const replies = cli.runs.map((r) => r.args[r.args.indexOf('--markdown') + 1]);
    expect(replies.some((t) => typeof t === 'string' && t.includes('approval requested'))).toBe(true);
  });

  it('detach() stops further pushes', async () => {
    const handle = attach();
    handle.detach();
    registry.create({ hostSessionId: 's1', tool: 'Shell', command: 'a' });
    await new Promise((r) => setTimeout(r, 5));
    expect(cli.runs).toHaveLength(0);
  });
});

describe('consumePendingBind', () => {
  it('inserts a channel_binding from a valid code + deletes the pending row', () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    db.prepare(`INSERT INTO pending_binds (code, channel, external_chat, external_thread, external_root, expires_at) VALUES ('CODE01','lark','oc_a','om_t','om_root',?)`).run(expiresAt);

    const created = consumePendingBind(db, events, 'CODE01', 's1');
    expect(created?.externalChat).toBe('oc_a');
    expect(created?.hostSessionId).toBe('s1');
    expect(getPendingBind(db, 'CODE01')).toBeUndefined();
    expect(emitted.find((e) => e.type === 'binding.created')).toBeTruthy();
  });

  it('attack: expired code returns null and does not create a binding', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    db.prepare(`INSERT INTO pending_binds (code, channel, expires_at) VALUES ('STALE','lark',?)`).run(past);
    expect(consumePendingBind(db, events, 'STALE', 's1')).toBeNull();
  });

  it('Phase 36: forwards pending_binds.label to channel_bindings.label on consume', () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    db.prepare(`
      INSERT INTO pending_binds (code, channel, external_chat, external_thread, external_root, label, expires_at)
      VALUES ('CODE_DR', 'lark', 'oc_a', 'om_t', 'om_root', 'dr', ?)
    `).run(expiresAt);

    const created = consumePendingBind(db, events, 'CODE_DR', 's1');
    expect(created?.label).toBe('dr');
  });

  it('attack: unknown code returns null', () => {
    expect(consumePendingBind(db, events, 'NOPE', 's1')).toBeNull();
  });
});
