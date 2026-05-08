import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LarkChannel, type LarkInboundMetadata } from '../../../../src/channel/lark/adapter.js';
import type {
  LarkCliRunner,
  LarkCliRunResult,
  LarkCliSpawnHandle,
} from '../../../../src/channel/lark/cli-runner.js';
import type { LarkListener, LarkListenerEvent } from '../../../../src/channel/lark/listener.js';
import type { ApprovalRequest, ChannelBinding } from '../../../../src/storage/types.js';
import type { ApprovalDecision, InboundMessage } from '../../../../src/channel/types.js';

class FakeCli implements LarkCliRunner {
  readonly runs: Array<{ args: readonly string[] }> = [];
  nextResult: LarkCliRunResult = { stdout: '', stderr: '', exitCode: 0 };

  async run(args: readonly string[]): Promise<LarkCliRunResult> {
    this.runs.push({ args });
    return this.nextResult;
  }
  spawn(): LarkCliSpawnHandle {
    throw new Error('FakeCli.spawn should not be called when listener is injected');
  }
}

/** Minimal LarkListener stub the adapter can drive event emission through. */
class FakeListener implements LarkListener {
  private handlers = new Set<(e: LarkListenerEvent) => void>();
  started = false;
  stopped = false;

  start(): void { this.started = true; }
  async stop(): Promise<void> { this.stopped = true; this.handlers.clear(); }
  onEvent(h: (e: LarkListenerEvent) => void): () => void {
    this.handlers.add(h);
    return () => { this.handlers.delete(h); };
  }
  isRunning(): boolean { return this.started && !this.stopped; }
  spawnCount(): number { return this.started ? 1 : 0; }

  // Test-only:
  emit(event: LarkListenerEvent): void {
    for (const h of [...this.handlers]) h(event);
  }
}

function makeApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'apr_1', tool: 'Shell', command: 'rm -rf /tmp',
    status: 'pending', createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function makeBinding(overrides: Partial<ChannelBinding> = {}): ChannelBinding {
  return {
    id: 'bnd_1', channel: 'lark', hostSessionId: 's1',
    externalChat: 'oc_chat', externalThread: 'om_thread',
    waitEnabled: true, createdAt: new Date().toISOString(),
    ...overrides,
  };
}

let cli: FakeCli;
let listener: FakeListener;
let channel: LarkChannel;

beforeEach(() => {
  cli = new FakeCli();
  listener = new FakeListener();
  channel = new LarkChannel({ cli, listener });
});

afterEach(async () => { await channel.stop(); });

describe('LarkChannel — lifecycle', () => {
  it('id is "lark"', () => {
    expect(channel.id).toBe('lark');
  });

  it('start spins up the listener; stop tears it down', async () => {
    await channel.start();
    expect(listener.started).toBe(true);
    expect(channel.isStarted()).toBe(true);
    await channel.stop();
    expect(listener.stopped).toBe(true);
    expect(channel.isStarted()).toBe(false);
  });

  it('start is idempotent', async () => {
    await channel.start();
    await channel.start();
    // listener.start() is itself idempotent, so we just verify no extra
    // unsubscribers leaked. Emit one message and confirm it's only seen once.
    const seen: string[] = [];
    channel.onInboundMessage((m) => { seen.push(m.text); });
    listener.emit({
      kind: 'message', messageId: 'om_x', chatId: 'oc_a', text: 'hi', mentioned: false,
      receivedAt: new Date().toISOString(), raw: {},
    });
    expect(seen).toEqual(['hi']);
  });

  it('stop() before start() is a no-op', async () => {
    await expect(channel.stop()).resolves.toBeUndefined();
  });
});

describe('LarkChannel — sendMessage / sendApprovalRequest', () => {
  beforeEach(async () => { await channel.start(); });

  it('sendMessage shells out to lark-cli with correct args', async () => {
    await channel.sendMessage(makeBinding(), 'hello world');
    expect(cli.runs).toHaveLength(1);
    const args = cli.runs[0]!.args;
    expect(args).toContain('+messages-reply');
    expect(args).toContain('--message-id');
    expect(args).toContain('om_thread');
    expect(args).toContain('--markdown');
    expect(args).toContain('hello world');
    expect(args).toContain('--reply-in-thread');
  });

  it('sendMessage uses opts.inReplyTo when provided', async () => {
    await channel.sendMessage(makeBinding(), 'reply', { inReplyTo: 'om_specific' });
    const args = cli.runs[0]!.args;
    const idx = args.indexOf('--message-id');
    expect(args[idx + 1]).toBe('om_specific');
  });

  it('sendMessage uses externalRoot fallback when externalThread missing', async () => {
    const binding = makeBinding({ externalThread: undefined, externalRoot: 'om_root' });
    await channel.sendMessage(binding, 'hi');
    const args = cli.runs[0]!.args;
    const idx = args.indexOf('--message-id');
    expect(args[idx + 1]).toBe('om_root');
  });

  it('attack: sendMessage rejects a binding for a different channel', async () => {
    const binding = makeBinding({ channel: 'local' });
    await expect(channel.sendMessage(binding, 'hi')).rejects.toThrow(/channel "local"/);
  });

  it('attack: sendMessage rejects when no thread / inReplyTo / root is available', async () => {
    const binding = makeBinding({ externalThread: undefined, externalRoot: undefined });
    await expect(channel.sendMessage(binding, 'hi')).rejects.toThrow(/inReplyTo/);
  });

  it('attack: lark-cli non-zero exit surfaces as error with stderr detail', async () => {
    cli.nextResult = { stdout: '', stderr: 'auth expired', exitCode: 1 };
    await expect(channel.sendMessage(makeBinding(), 'hi')).rejects.toThrow(/auth expired/);
  });

  it('sendApprovalRequest formats approval markdown then sends', async () => {
    await channel.sendApprovalRequest(makeApproval(), makeBinding());
    expect(cli.runs).toHaveLength(1);
    const idx = cli.runs[0]!.args.indexOf('--markdown');
    const md = cli.runs[0]!.args[idx + 1] ?? '';
    expect(md).toContain('Helm — approval requested');
    expect(md).toContain('Shell');
    expect(md).toContain('rm -rf /tmp');
    expect(md).toContain('apr_1');
    expect(md).toContain('/allow');
  });

  it('attack: sendApprovalRequest without binding throws', async () => {
    await expect(channel.sendApprovalRequest(makeApproval())).rejects.toThrow(/requires a binding/);
  });
});

describe('LarkChannel — sendAttachment (Phase 54)', () => {
  let tmpFile: string;

  beforeEach(async () => {
    await channel.start();
    // A real on-disk file so the existence check + lark-cli dry path both pass.
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'helm-attach-'));
    tmpFile = join(dir, 'screenshot.png');
    // 1-byte placeholder — we never actually shell out, the FakeCli swallows args.
    writeFileSync(tmpFile, 'x');
  });

  it('image attachment shells out with --image <absPath>', async () => {
    await channel.sendAttachment(makeBinding(), { filePath: tmpFile, kind: 'image' });
    expect(cli.runs).toHaveLength(1);
    const args = cli.runs[0]!.args;
    expect(args).toContain('+messages-reply');
    expect(args).toContain('--image');
    const idx = args.indexOf('--image');
    expect(args[idx + 1]).toBe(tmpFile);
    expect(args).toContain('--reply-in-thread');
  });

  it('file attachment maps kind=file → --file flag', async () => {
    await channel.sendAttachment(makeBinding(), { filePath: tmpFile, kind: 'file' });
    expect(cli.runs).toHaveLength(1);
    expect(cli.runs[0]!.args).toContain('--file');
    expect(cli.runs[0]!.args).not.toContain('--image');
  });

  it('caption posts a leading text reply BEFORE the asset', async () => {
    await channel.sendAttachment(
      makeBinding(),
      { filePath: tmpFile, kind: 'image', caption: 'Cycle 3 final UI' },
    );
    expect(cli.runs).toHaveLength(2);
    // First call: text reply with caption.
    const first = cli.runs[0]!.args;
    expect(first).toContain('--markdown');
    expect(first).toContain('Cycle 3 final UI');
    // Second call: the actual image upload.
    const second = cli.runs[1]!.args;
    expect(second).toContain('--image');
  });

  it('attack: missing file throws before lark-cli is invoked', async () => {
    await expect(channel.sendAttachment(
      makeBinding(),
      { filePath: '/nonexistent/missing.png', kind: 'image' },
    )).rejects.toThrow(/cannot read/);
    expect(cli.runs).toHaveLength(0);
  });

  it('attack: lark-cli failure surfaces with detail; falls into the kind-aware error', async () => {
    cli.nextResult = { stdout: '', stderr: 'upload size exceeded', exitCode: 1 };
    await expect(channel.sendAttachment(
      makeBinding(),
      { filePath: tmpFile, kind: 'image' },
    )).rejects.toThrow(/--image.*upload size exceeded/);
  });

  it('attack: caption failure does NOT block the asset upload (caption is best-effort)', async () => {
    // Make ONLY the first call (the caption text) fail; image succeeds on
    // the second call. Easier than juggling FakeCli — observe that the
    // image still got through.
    let calls = 0;
    cli.run = async (args) => {
      cli.runs.push({ args });
      calls += 1;
      if (calls === 1) return { stdout: '', stderr: 'rate limited', exitCode: 1 };
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    await channel.sendAttachment(
      makeBinding(),
      { filePath: tmpFile, kind: 'image', caption: 'hi' },
    );
    expect(cli.runs).toHaveLength(2);
    expect(cli.runs[1]!.args).toContain('--image');
  });

  it('attack: binding for a different channel throws', async () => {
    const binding = makeBinding({ channel: 'local' });
    await expect(channel.sendAttachment(
      binding, { filePath: tmpFile, kind: 'image' },
    )).rejects.toThrow(/channel "local"/);
  });

  it('attack: no thread / inReplyTo / root → throws', async () => {
    const binding = makeBinding({ externalThread: undefined, externalRoot: undefined });
    await expect(channel.sendAttachment(
      binding, { filePath: tmpFile, kind: 'image' },
    )).rejects.toThrow(/inReplyTo/);
  });
});

describe('LarkChannel — createThread (Phase 10 minimal)', () => {
  beforeEach(async () => { await channel.start(); });

  it('returns ExternalThread when externalChat is supplied', async () => {
    const t = await channel.createThread({ hostSessionId: 'sess_42', externalChat: 'oc_chat' });
    expect(t).toEqual({ channel: 'lark', externalChat: 'oc_chat', externalThread: 'sess_42' });
  });

  it('attack: createThread without externalChat throws (Phase 11 territory)', async () => {
    await expect(channel.createThread({ hostSessionId: 'sess_42' })).rejects.toThrow(/Phase 11/);
  });
});

describe('LarkChannel — inbound message dispatch', () => {
  beforeEach(async () => { await channel.start(); });

  function makeIncoming(text: string, opts: { mentioned?: boolean; threadId?: string } = {}): LarkListenerEvent {
    return {
      kind: 'message',
      messageId: 'om_msg',
      chatId: 'oc_chat',
      threadId: opts.threadId,
      text,
      mentioned: opts.mentioned ?? false,
      receivedAt: new Date().toISOString(),
      raw: {},
    };
  }

  it('approval /allow → onApprovalDecision (no targetId = "latest")', () => {
    const decisions: ApprovalDecision[] = [];
    channel.onApprovalDecision((d) => { decisions.push(d); });
    listener.emit(makeIncoming('/allow'));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      channel: 'lark',
      approvalId: '',
      decision: 'allow',
    });
    expect(decisions[0]?.source).toMatchObject({ remember: false });
  });

  it('approval /deny <id> → onApprovalDecision with targetId', () => {
    const decisions: ApprovalDecision[] = [];
    channel.onApprovalDecision((d) => { decisions.push(d); });
    listener.emit(makeIncoming('/deny apr_xyz'));
    expect(decisions[0]).toMatchObject({ approvalId: 'apr_xyz', decision: 'deny' });
  });

  it('approval /allow! shell → reason notes the scope', () => {
    const decisions: ApprovalDecision[] = [];
    channel.onApprovalDecision((d) => { decisions.push(d); });
    listener.emit(makeIncoming('/allow! shell'));
    expect(decisions[0]?.reason).toContain('shell');
    expect(decisions[0]?.source?.['scope']).toBe('shell');
    expect(decisions[0]?.source?.['remember']).toBe(true);
  });

  it('inbound non-approval message → onInboundMessage with intent metadata', () => {
    const inbound: Array<InboundMessage & { metadata?: LarkInboundMetadata }> = [];
    channel.onInboundMessage((m) => { inbound.push(m as never); });
    listener.emit(makeIncoming('hey team', { mentioned: false }));
    expect(inbound).toHaveLength(1);
    expect(inbound[0]?.text).toBe('hey team');
    expect(inbound[0]?.metadata?.intent.kind).toBe('unknown');
  });

  it('lifecycle command (mentioned bind chat) goes to onInboundMessage with intent=bind', () => {
    const inbound: Array<InboundMessage & { metadata?: LarkInboundMetadata }> = [];
    channel.onInboundMessage((m) => { inbound.push(m as never); });
    listener.emit(makeIncoming('@bot bind chat', { mentioned: true }));
    expect(inbound[0]?.metadata?.intent.kind).toBe('bind');
  });

  it('attack: throwing approval listener does not block other listeners', () => {
    const ok = vi.fn();
    channel.onApprovalDecision(() => { throw new Error('boom'); });
    channel.onApprovalDecision(ok);
    listener.emit(makeIncoming('/allow'));
    expect(ok).toHaveBeenCalledOnce();
  });

  it('attack: rejecting async inbound listener does not block others', async () => {
    const ok = vi.fn();
    channel.onInboundMessage(async () => { throw new Error('async boom'); });
    channel.onInboundMessage(ok);
    listener.emit(makeIncoming('hi'));
    // Allow microtasks
    await new Promise((r) => setTimeout(r, 5));
    expect(ok).toHaveBeenCalledOnce();
  });

  it('subscribers added during dispatch do not see the in-flight event', () => {
    const late = vi.fn();
    channel.onInboundMessage(() => { channel.onInboundMessage(late); });
    listener.emit(makeIncoming('hi'));
    expect(late).not.toHaveBeenCalled();
  });
});

describe('LarkChannel — unsubscribe', () => {
  beforeEach(async () => { await channel.start(); });

  it('unsubscribe stops further callbacks', () => {
    const seen: string[] = [];
    const off = channel.onInboundMessage((m) => { seen.push(m.text); });
    listener.emit({
      kind: 'message', messageId: 'om_a', chatId: 'oc', text: 'one',
      mentioned: false, receivedAt: new Date().toISOString(), raw: {},
    });
    off();
    listener.emit({
      kind: 'message', messageId: 'om_b', chatId: 'oc', text: 'two',
      mentioned: false, receivedAt: new Date().toISOString(), raw: {},
    });
    expect(seen).toEqual(['one']);
  });
});
