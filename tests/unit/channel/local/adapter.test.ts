import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalChannel } from '../../../../src/channel/local/adapter.js';
import { CallbackNotifier } from '../../../../src/channel/local/notifier.js';
import type { ApprovalRequest, ChannelBinding } from '../../../../src/storage/types.js';

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
    id: 'b1', channel: 'local', hostSessionId: 's1',
    waitEnabled: true, createdAt: new Date().toISOString(),
    ...overrides,
  };
}

let channel: LocalChannel;
let notifier: CallbackNotifier;

beforeEach(() => {
  notifier = new CallbackNotifier();
  channel = new LocalChannel({ notifier });
});

afterEach(async () => {
  await channel.stop();
});

describe('LocalChannel — lifecycle', () => {
  it('id is "local"', () => {
    expect(channel.id).toBe('local');
  });

  it('isStarted reflects start/stop', async () => {
    expect(channel.isStarted()).toBe(false);
    await channel.start();
    expect(channel.isStarted()).toBe(true);
    await channel.stop();
    expect(channel.isStarted()).toBe(false);
  });

  it('attack: send before start throws', async () => {
    await expect(channel.sendApprovalRequest(makeApproval())).rejects.toThrow(/start/);
    await expect(channel.sendMessage(makeBinding(), 'hi')).rejects.toThrow(/start/);
  });

  it('stop clears all listeners', async () => {
    await channel.start();
    const inbound = vi.fn();
    const decision = vi.fn();
    channel.onInboundMessage(inbound);
    channel.onApprovalDecision(decision);
    await channel.stop();
    await channel.start();
    await channel.pushInboundMessage({ channel: 'local', text: 'x', receivedAt: new Date().toISOString() });
    await channel.pushApprovalDecision({ approvalId: 'apr_1', decision: 'allow' });
    expect(inbound).not.toHaveBeenCalled();
    expect(decision).not.toHaveBeenCalled();
  });
});

describe('LocalChannel — sendApprovalRequest', () => {
  beforeEach(async () => { await channel.start(); });

  it('triggers a notification for the approval', async () => {
    await channel.sendApprovalRequest(makeApproval({ tool: 'Write', command: '/proj/foo.ts' }));
    expect(notifier.received).toHaveLength(1);
    expect(notifier.received[0]?.title).toContain('Write');
    expect(notifier.received[0]?.ref).toEqual({ kind: 'approval', approvalId: 'apr_1' });
  });

  it('calls onApprovalPushed if provided', async () => {
    const seen: string[] = [];
    channel = new LocalChannel({ notifier, onApprovalPushed: (req) => seen.push(req.id) });
    await channel.start();
    await channel.sendApprovalRequest(makeApproval({ id: 'apr_xyz' }));
    expect(seen).toEqual(['apr_xyz']);
  });
});

describe('LocalChannel — sendMessage', () => {
  beforeEach(async () => { await channel.start(); });

  it('forwards to onOutboundMessage callback when provided', async () => {
    const seen: Array<{ text: string }> = [];
    channel = new LocalChannel({
      notifier,
      onOutboundMessage: ({ text }) => seen.push({ text }),
    });
    await channel.start();
    await channel.sendMessage(makeBinding(), 'streamed reply');
    expect(seen).toEqual([{ text: 'streamed reply' }]);
  });

  it('no-op when no callback registered (does not throw)', async () => {
    await expect(channel.sendMessage(makeBinding(), 'hi')).resolves.toBeUndefined();
  });
});

describe('LocalChannel — createThread', () => {
  it('returns a deterministic ExternalThread keyed by hostSessionId', async () => {
    const thread = await channel.createThread({ hostSessionId: 'sess_42' });
    expect(thread).toEqual({
      channel: 'local',
      externalChat: 'local:sess_42',
      externalThread: 'sess_42',
    });
  });

  it('respects explicit externalChat override', async () => {
    const thread = await channel.createThread({ hostSessionId: 'sess_42', externalChat: 'custom-chat' });
    expect(thread.externalChat).toBe('custom-chat');
  });
});

describe('LocalChannel — inbound + decision pipelines', () => {
  beforeEach(async () => { await channel.start(); });

  it('pushInboundMessage fans out to all subscribers', async () => {
    const a = vi.fn();
    const b = vi.fn();
    channel.onInboundMessage(a);
    channel.onInboundMessage(b);
    await channel.pushInboundMessage({
      channel: 'local', text: 'hi', receivedAt: new Date().toISOString(),
    });
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it('unsubscribe removes a listener', async () => {
    const a = vi.fn();
    const unsub = channel.onInboundMessage(a);
    unsub();
    await channel.pushInboundMessage({ channel: 'local', text: 'hi', receivedAt: new Date().toISOString() });
    expect(a).not.toHaveBeenCalled();
  });

  it('pushApprovalDecision fills in channel id', async () => {
    const seen: Array<{ channel: string }> = [];
    channel.onApprovalDecision((d) => { seen.push({ channel: d.channel }); });
    await channel.pushApprovalDecision({ approvalId: 'apr_1', decision: 'allow' });
    expect(seen).toEqual([{ channel: 'local' }]);
  });

  it('attack: throwing inbound listener does not block other listeners', async () => {
    const ok = vi.fn();
    channel.onInboundMessage(() => { throw new Error('boom'); });
    channel.onInboundMessage(ok);
    await channel.pushInboundMessage({ channel: 'local', text: 'x', receivedAt: new Date().toISOString() });
    expect(ok).toHaveBeenCalledOnce();
  });

  it('attack: throwing approval listener does not block others', async () => {
    const ok = vi.fn();
    channel.onApprovalDecision(() => { throw new Error('boom'); });
    channel.onApprovalDecision(ok);
    await channel.pushApprovalDecision({ approvalId: 'apr_1', decision: 'deny' });
    expect(ok).toHaveBeenCalledOnce();
  });

  it('attack: async listener that rejects does not block others', async () => {
    const ok = vi.fn();
    channel.onApprovalDecision(async () => {
      await new Promise((r) => setTimeout(r, 5));
      throw new Error('async boom');
    });
    channel.onApprovalDecision(ok);
    await channel.pushApprovalDecision({ approvalId: 'apr_1', decision: 'allow' });
    expect(ok).toHaveBeenCalledOnce();
  });

  it('subscribers added during dispatch are not invoked for the same event', async () => {
    const late = vi.fn();
    channel.onApprovalDecision(() => {
      // Subscribe inside a dispatching callback — should NOT receive this event.
      channel.onApprovalDecision(late);
    });
    await channel.pushApprovalDecision({ approvalId: 'apr_1', decision: 'allow' });
    expect(late).not.toHaveBeenCalled();
  });
});

describe('LocalChannel — integration with ApprovalRegistry settle pattern', () => {
  it('decision listener can call into a settle adapter (idempotency-safe)', async () => {
    await channel.start();
    const settleCalls: string[] = [];
    channel.onApprovalDecision((d) => { settleCalls.push(`${d.approvalId}:${d.decision}`); });
    await channel.pushApprovalDecision({ approvalId: 'apr_1', decision: 'allow' });
    await channel.pushApprovalDecision({ approvalId: 'apr_1', decision: 'allow' });
    // Channel itself does NOT dedupe — the registry's idempotent settle does.
    // We just verify the channel forwards both decisions truthfully.
    expect(settleCalls).toEqual(['apr_1:allow', 'apr_1:allow']);
  });
});
