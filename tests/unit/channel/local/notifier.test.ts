import { describe, expect, it } from 'vitest';
import {
  approvalToNotification,
  CallbackNotifier,
  NoopNotifier,
} from '../../../../src/channel/local/notifier.js';
import type { ApprovalRequest } from '../../../../src/storage/types.js';

function makeApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'apr_1', tool: 'Shell', command: 'rm -rf /tmp',
    status: 'pending', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

describe('NoopNotifier', () => {
  it('notify is a no-op (no throw)', () => {
    expect(() => new NoopNotifier().notify({ title: 't', body: 'b' })).not.toThrow();
  });
});

describe('CallbackNotifier', () => {
  it('records every notify and forwards to callback', () => {
    const events: string[] = [];
    const n = new CallbackNotifier((p) => events.push(p.title));
    n.notify({ title: 'a', body: 'A' });
    n.notify({ title: 'b', body: 'B' });
    expect(n.received.map((p) => p.title)).toEqual(['a', 'b']);
    expect(events).toEqual(['a', 'b']);
  });

  it('callback is optional', () => {
    const n = new CallbackNotifier();
    n.notify({ title: 'x', body: 'X' });
    expect(n.received).toHaveLength(1);
  });
});

describe('approvalToNotification', () => {
  it('uses the tool name in the title', () => {
    const p = approvalToNotification(makeApproval({ tool: 'Write' }));
    expect(p.title).toContain('Write');
  });

  it('uses the command (truncated) as body', () => {
    const longCmd = 'rm -rf ' + 'x'.repeat(200);
    const p = approvalToNotification(makeApproval({ command: longCmd }));
    expect(p.body.length).toBeLessThanOrEqual(140);
    expect(p.body.endsWith('…')).toBe(true);
  });

  it('falls back to a generic body when command is missing', () => {
    const p = approvalToNotification(makeApproval({ command: undefined }));
    expect(p.body).toContain('Cursor wants');
  });

  it('attack: empty/whitespace command falls back to generic body', () => {
    expect(approvalToNotification(makeApproval({ command: '' })).body).toContain('Cursor wants');
    expect(approvalToNotification(makeApproval({ command: '   ' })).body).toContain('Cursor wants');
  });

  it('payload ref carries the approval id for click correlation', () => {
    const p = approvalToNotification(makeApproval({ id: 'apr_xyz' }));
    expect(p.ref).toEqual({ kind: 'approval', approvalId: 'apr_xyz' });
  });
});
