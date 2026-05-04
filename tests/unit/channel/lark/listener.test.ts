import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLarkListener,
  type LarkInboundMessage,
  type LarkListenerEvent,
} from '../../../../src/channel/lark/listener.js';
import type {
  LarkCliRunner,
  LarkCliRunResult,
  LarkCliSpawnHandle,
} from '../../../../src/channel/lark/cli-runner.js';

/**
 * Test double for LarkCliRunner.spawn — exposes hooks for the test to feed
 * stdout lines and trigger exits, simulating a real lark-cli subprocess
 * without spawning anything.
 */
class FakeSpawnHandle implements LarkCliSpawnHandle {
  private readonly stdoutHandlers = new Set<(line: string) => void>();
  private readonly stderrHandlers = new Set<(line: string) => void>();
  private readonly errorHandlers = new Set<(err: Error) => void>();
  private exitResolve!: (res: { exitCode: number | null; signal: NodeJS.Signals | null }) => void;

  readonly exited: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  killed = false;

  constructor() {
    this.exited = new Promise((r) => { this.exitResolve = r; });
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.exitResolve({ exitCode: 143, signal: 'SIGTERM' });
  }

  // Test-only helpers ------
  emitStdout(line: string): void {
    for (const h of [...this.stdoutHandlers]) h(line);
  }
  emitStderr(line: string): void {
    for (const h of [...this.stderrHandlers]) h(line);
  }
  emitError(err: Error): void {
    for (const h of [...this.errorHandlers]) h(err);
  }
  exit(code: number | null = 0): void {
    if (this.killed) return;
    this.killed = true;
    this.exitResolve({ exitCode: code, signal: null });
  }

  onStdoutLine(h: (line: string) => void): () => void {
    this.stdoutHandlers.add(h);
    return () => { this.stdoutHandlers.delete(h); };
  }
  onStderrLine(h: (line: string) => void): () => void {
    this.stderrHandlers.add(h);
    return () => { this.stderrHandlers.delete(h); };
  }
  onError(h: (err: Error) => void): () => void {
    this.errorHandlers.add(h);
    return () => { this.errorHandlers.delete(h); };
  }
}

class FakeCli implements LarkCliRunner {
  readonly spawns: FakeSpawnHandle[] = [];
  readonly runs: Array<{ args: readonly string[] }> = [];

  spawn(_args: readonly string[]): LarkCliSpawnHandle {
    const handle = new FakeSpawnHandle();
    this.spawns.push(handle);
    return handle;
  }

  async run(args: readonly string[]): Promise<LarkCliRunResult> {
    this.runs.push({ args });
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  /** Most-recently-spawned handle for convenience. */
  current(): FakeSpawnHandle {
    const last = this.spawns[this.spawns.length - 1];
    if (!last) throw new Error('FakeCli: no spawns yet');
    return last;
  }
}

let cli: FakeCli;
let events: LarkListenerEvent[];
let errors: Array<{ where: string; msg: string }>;

beforeEach(() => {
  cli = new FakeCli();
  events = [];
  errors = [];
});

afterEach(() => { /* nothing — listener.stop awaits in tests */ });

function makeListener(opts: Partial<Parameters<typeof createLarkListener>[0]> = {}) {
  return createLarkListener({
    cli,
    initialBackoffMs: 5,
    maxBackoffMs: 20,
    onError: (err, where) => errors.push({ where, msg: err.message }),
    ...opts,
  });
}

describe('listener — startup + event parsing', () => {
  it('start() spawns once and parses an im.message.receive_v1 line', () => {
    const listener = makeListener();
    listener.onEvent((e) => events.push(e));
    listener.start();
    expect(cli.spawns).toHaveLength(1);

    cli.current().emitStdout(JSON.stringify({
      event_type: 'im.message.receive_v1',
      message: { message_id: 'om_1', chat_id: 'oc_a', text: 'hello @bot', mentions: [{ name: 'bot' }] },
    }));

    expect(events).toHaveLength(1);
    const msg = events[0] as LarkInboundMessage;
    expect(msg.kind).toBe('message');
    expect(msg.messageId).toBe('om_1');
    expect(msg.text).toBe('hello @bot');
    expect(msg.mentioned).toBe(true);
  });

  it('parses card.action.trigger', () => {
    const listener = makeListener();
    listener.onEvent((e) => events.push(e));
    listener.start();

    cli.current().emitStdout(JSON.stringify({
      event_type: 'card.action.trigger',
      action: { token: 'tok-1', value: '{"id":"apr_1"}', chat_id: 'oc_a' },
    }));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'card_action', token: 'tok-1', chatId: 'oc_a', value: { id: 'apr_1' } });
  });

  it('skips lines with unknown event_type silently', () => {
    const listener = makeListener();
    listener.onEvent((e) => events.push(e));
    listener.start();
    cli.current().emitStdout(JSON.stringify({ event_type: 'something.new', payload: {} }));
    expect(events).toHaveLength(0);
  });

  it('attack: malformed JSON line surfaces a parse error and does not crash', () => {
    const listener = makeListener();
    listener.start();
    cli.current().emitStdout('{not json}');
    expect(errors.some((e) => e.where === 'parse')).toBe(true);
  });

  it('attack: incomplete inbound (no message_id) is dropped', () => {
    const listener = makeListener();
    listener.onEvent((e) => events.push(e));
    listener.start();
    cli.current().emitStdout(JSON.stringify({ event_type: 'im.message.receive_v1', message: { text: 'hi' } }));
    expect(events).toHaveLength(0);
  });

  it('listener handler throws → other handlers still fire', () => {
    const listener = makeListener();
    listener.onEvent(() => { throw new Error('listener boom'); });
    const ok = vi.fn();
    listener.onEvent(ok);
    listener.start();
    cli.current().emitStdout(JSON.stringify({
      event_type: 'im.message.receive_v1',
      message: { message_id: 'om_x', chat_id: 'oc_a', text: 'hi' },
    }));
    expect(ok).toHaveBeenCalledOnce();
  });
});

describe('listener — reconnect', () => {
  it('respawns after process exit with backoff', async () => {
    const listener = makeListener();
    listener.start();
    expect(cli.spawns).toHaveLength(1);

    cli.current().exit(1);
    // Wait long enough for the timer to fire (initialBackoff=5ms)
    await new Promise((r) => setTimeout(r, 30));
    expect(cli.spawns).toHaveLength(2);
    expect(listener.spawnCount()).toBe(2);
  });

  it('stop() prevents reconnect', async () => {
    const listener = makeListener();
    listener.start();
    cli.current().exit(0);
    await listener.stop();
    await new Promise((r) => setTimeout(r, 40));
    expect(cli.spawns.length).toBeLessThanOrEqual(1);
  });

  it('attack: stderr lines surface as errors but do NOT trigger reconnect', async () => {
    const listener = makeListener();
    listener.start();
    cli.current().emitStderr('warning: rate limited');
    await new Promise((r) => setTimeout(r, 30));
    expect(errors.some((e) => e.msg.includes('warning'))).toBe(true);
    // Process is still alive, no respawn
    expect(cli.spawns).toHaveLength(1);
  });

  it('onConnected fires every (re)spawn', async () => {
    const seen: string[] = [];
    const listener = makeListener({ onConnected: () => seen.push('connect') });
    listener.start();
    expect(seen).toHaveLength(1);
    cli.current().exit(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(seen.length).toBeGreaterThanOrEqual(2);
    await listener.stop();
  });
});

describe('listener — lifecycle', () => {
  it('start() is idempotent', () => {
    const listener = makeListener();
    listener.start();
    listener.start();
    expect(cli.spawns).toHaveLength(1);
  });

  it('isRunning reflects start/stop', async () => {
    const listener = makeListener();
    expect(listener.isRunning()).toBe(false);
    listener.start();
    expect(listener.isRunning()).toBe(true);
    await listener.stop();
    expect(listener.isRunning()).toBe(false);
  });
});
