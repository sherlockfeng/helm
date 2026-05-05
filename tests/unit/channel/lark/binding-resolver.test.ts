import { describe, expect, it } from 'vitest';
import {
  findBindingForLarkThread,
  pickTargetApprovalId,
  policyInputFromScope,
} from '../../../../src/channel/lark/binding-resolver.js';
import type { ApprovalRequest, ChannelBinding } from '../../../../src/storage/types.js';

function makeApproval(id: string, createdAt: string): ApprovalRequest {
  return {
    id, tool: 'Shell', status: 'pending',
    createdAt, expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function makeBinding(overrides: Partial<ChannelBinding> = {}): ChannelBinding {
  return {
    id: 'b1', channel: 'lark', hostSessionId: 's1',
    externalChat: 'oc_chat', externalThread: 'om_thread',
    waitEnabled: true, createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('pickTargetApprovalId', () => {
  it('returns null for an empty pending list', () => {
    expect(pickTargetApprovalId([], undefined)).toBeNull();
    expect(pickTargetApprovalId([], 'apr_x')).toBeNull();
  });

  it('returns the matched id when explicitId is provided', () => {
    const pending = [makeApproval('apr_a', '2026-05-01T00:00:00Z'), makeApproval('apr_b', '2026-05-02T00:00:00Z')];
    expect(pickTargetApprovalId(pending, 'apr_a')).toBe('apr_a');
  });

  it('returns null when explicitId does not match', () => {
    const pending = [makeApproval('apr_a', '2026-05-01T00:00:00Z')];
    expect(pickTargetApprovalId(pending, 'apr_ghost')).toBeNull();
  });

  it('picks the newest pending when explicitId is undefined or empty', () => {
    const pending = [
      makeApproval('apr_a', '2026-05-01T00:00:00Z'),
      makeApproval('apr_b', '2026-05-03T00:00:00Z'),
      makeApproval('apr_c', '2026-05-02T00:00:00Z'),
    ];
    expect(pickTargetApprovalId(pending, undefined)).toBe('apr_b');
    expect(pickTargetApprovalId(pending, '')).toBe('apr_b');
  });

  it('attack: whitespace explicitId falls back to "latest"', () => {
    const pending = [makeApproval('apr_a', '2026-05-03T00:00:00Z')];
    expect(pickTargetApprovalId(pending, '   ')).toBe('apr_a');
  });
});

describe('policyInputFromScope', () => {
  it('returns null for empty / undefined scope', () => {
    expect(policyInputFromScope(undefined, 'allow')).toBeNull();
    expect(policyInputFromScope('', 'allow')).toBeNull();
    expect(policyInputFromScope('   ', 'allow')).toBeNull();
  });

  it('mcp__* → toolScope rule', () => {
    expect(policyInputFromScope('mcp__svc__do', 'allow')).toEqual({
      tool: 'mcp__svc__do', decision: 'allow', toolScope: true,
    });
  });

  it('bare tool keyword → toolScope rule', () => {
    expect(policyInputFromScope('shell', 'allow')).toEqual({
      tool: 'Shell', decision: 'allow', toolScope: true,
    });
    expect(policyInputFromScope('Write', 'deny')).toEqual({
      tool: 'Write', decision: 'deny', toolScope: true,
    });
    expect(policyInputFromScope('multiedit', 'allow')).toEqual({
      tool: 'MultiEdit', decision: 'allow', toolScope: true,
    });
  });

  it('"<tool> <prefix>" → tool + commandPrefix', () => {
    expect(policyInputFromScope('shell node', 'allow')).toEqual({
      tool: 'Shell', decision: 'allow', commandPrefix: 'node',
    });
    expect(policyInputFromScope('shell git push', 'allow')).toEqual({
      tool: 'Shell', decision: 'allow', commandPrefix: 'git push',
    });
  });

  it('bare unknown word → Shell + commandPrefix', () => {
    expect(policyInputFromScope('pnpm', 'allow')).toEqual({
      tool: 'Shell', decision: 'allow', commandPrefix: 'pnpm',
    });
  });

  it('multi-word unknown → Shell + commandPrefix (full string preserved)', () => {
    expect(policyInputFromScope('git status', 'allow')).toEqual({
      tool: 'Shell', decision: 'allow', commandPrefix: 'git status',
    });
  });

  it('attack: case-insensitive tool keyword', () => {
    expect(policyInputFromScope('SHELL', 'allow')).toEqual({
      tool: 'Shell', decision: 'allow', toolScope: true,
    });
  });
});

describe('findBindingForLarkThread', () => {
  const bindings: ChannelBinding[] = [
    makeBinding({ id: 'b1', externalChat: 'chatA', externalThread: 'thread1' }),
    makeBinding({ id: 'b2', externalChat: 'chatA', externalThread: 'thread2' }),
    makeBinding({ id: 'b3', externalChat: 'chatB', externalThread: undefined }),
    makeBinding({ id: 'b4', channel: 'local', externalChat: 'chatA', externalThread: 'thread1' }),
  ];

  it('returns the exact (chat, thread) match', () => {
    expect(findBindingForLarkThread(bindings, 'chatA', 'thread2')?.id).toBe('b2');
  });

  it('falls back to a thread-less binding when the requested thread is missing', () => {
    expect(findBindingForLarkThread(bindings, 'chatB', 'unknown_thread')?.id).toBe('b3');
  });

  it('returns null when no binding matches', () => {
    expect(findBindingForLarkThread(bindings, 'chatZ', 'tx')).toBeNull();
  });

  it('attack: ignores non-lark bindings even with same external_chat', () => {
    const onlyLocal = bindings.filter((b) => b.id === 'b4');
    expect(findBindingForLarkThread(onlyLocal, 'chatA', 'thread1')).toBeNull();
  });

  it('attack: undefined threadId still matches a thread-less binding', () => {
    expect(findBindingForLarkThread(bindings, 'chatB', undefined)?.id).toBe('b3');
  });
});
