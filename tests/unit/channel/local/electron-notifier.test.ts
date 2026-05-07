import { describe, expect, it, vi } from 'vitest';
import {
  ElectronNotifier,
  type ElectronNotificationCtor,
  type ElectronNotificationInstance,
  type ElectronNotificationOptions,
} from '../../../../src/channel/local/electron-notifier.js';
import type { NotificationPayload } from '../../../../src/channel/local/notifier.js';

interface FakeState {
  ctorOpts: ElectronNotificationOptions[];
  shows: number;
  clickListeners: Array<() => void>;
  closes: number;
  isSupported: boolean;
}

function makeFakeCtor(
  state: FakeState,
  opts: { ctorThrows?: boolean; showThrows?: boolean; closeThrows?: boolean } = {},
): ElectronNotificationCtor {
  class FakeNotification implements ElectronNotificationInstance {
    constructor(o: ElectronNotificationOptions) {
      if (opts.ctorThrows) throw new Error('ctor boom');
      state.ctorOpts.push(o);
    }
    on(_event: 'click', listener: () => void): void {
      state.clickListeners.push(listener);
    }
    show(): void {
      if (opts.showThrows) throw new Error('show boom');
      state.shows += 1;
    }
    close(): void {
      if (opts.closeThrows) throw new Error('close boom');
      state.closes += 1;
    }
  }
  // Static method on the class
  (FakeNotification as unknown as { isSupported: () => boolean }).isSupported = () => state.isSupported;
  return FakeNotification as unknown as ElectronNotificationCtor;
}

const samplePayload: NotificationPayload = {
  title: 'Helm: approval needed',
  body: 'rm -rf /tmp',
  ref: { kind: 'approval', approvalId: 'apr_1' },
};

describe('ElectronNotifier — basics', () => {
  it('forwards title + body to the Notification ctor', () => {
    const state: FakeState = { ctorOpts: [], shows: 0, clickListeners: [], closes: 0, isSupported: true };
    const n = new ElectronNotifier({ Notification: makeFakeCtor(state) });
    n.notify(samplePayload);
    expect(state.ctorOpts).toHaveLength(1);
    expect(state.ctorOpts[0]).toMatchObject({
      title: 'Helm: approval needed',
      body: 'rm -rf /tmp',
      silent: false,
    });
    expect(state.shows).toBe(1);
  });

  it('isSupported reflects the underlying ctor', () => {
    const state: FakeState = { ctorOpts: [], shows: 0, clickListeners: [], closes: 0, isSupported: false };
    const n = new ElectronNotifier({ Notification: makeFakeCtor(state) });
    expect(n.isSupported()).toBe(false);
  });

  it('notify is a no-op when isSupported() returns false', () => {
    const state: FakeState = { ctorOpts: [], shows: 0, clickListeners: [], closes: 0, isSupported: false };
    const n = new ElectronNotifier({ Notification: makeFakeCtor(state) });
    n.notify(samplePayload);
    expect(state.shows).toBe(0);
    expect(state.ctorOpts).toHaveLength(0);
  });
});

describe('ElectronNotifier — click handler', () => {
  it('onClick fires with the original payload when notification is clicked', () => {
    const state: FakeState = { ctorOpts: [], shows: 0, clickListeners: [], closes: 0, isSupported: true };
    const onClick = vi.fn();
    const n = new ElectronNotifier({ Notification: makeFakeCtor(state), onClick });
    n.notify(samplePayload);
    expect(state.clickListeners).toHaveLength(1);
    state.clickListeners[0]!();
    expect(onClick).toHaveBeenCalledWith(samplePayload);
  });

  it('attack: throwing onClick is caught and routed to onError', () => {
    const state: FakeState = { ctorOpts: [], shows: 0, clickListeners: [], closes: 0, isSupported: true };
    const errors: Array<{ phase: string }> = [];
    const n = new ElectronNotifier({
      Notification: makeFakeCtor(state),
      onClick: () => { throw new Error('handler boom'); },
      onError: (_err, ctx) => errors.push(ctx),
    });
    n.notify(samplePayload);
    expect(() => state.clickListeners[0]!()).not.toThrow();
    expect(errors[0]?.phase).toBe('click');
  });

  it('multiple notifications keep their own click handlers separate', () => {
    const state: FakeState = { ctorOpts: [], shows: 0, clickListeners: [], closes: 0, isSupported: true };
    const calls: string[] = [];
    const n = new ElectronNotifier({
      Notification: makeFakeCtor(state),
      onClick: (p) => calls.push(p.title),
    });
    n.notify({ ...samplePayload, title: 'first' });
    n.notify({ ...samplePayload, title: 'second' });
    state.clickListeners[1]!();
    state.clickListeners[0]!();
    expect(calls).toEqual(['second', 'first']);
  });
});

describe('ElectronNotifier — error paths', () => {
  it('attack: ctor that throws routes to onError, never crashes notify()', () => {
    const state: FakeState = { ctorOpts: [], shows: 0, clickListeners: [], closes: 0, isSupported: true };
    const errors: Array<{ phase: string }> = [];
    const n = new ElectronNotifier({
      Notification: makeFakeCtor(state, { ctorThrows: true }),
      onError: (_err, ctx) => errors.push(ctx),
    });
    expect(() => n.notify(samplePayload)).not.toThrow();
    expect(errors[0]?.phase).toBe('show');
  });

  it('attack: show() that throws routes to onError', () => {
    const state: FakeState = { ctorOpts: [], shows: 0, clickListeners: [], closes: 0, isSupported: true };
    const errors: Array<{ phase: string }> = [];
    const n = new ElectronNotifier({
      Notification: makeFakeCtor(state, { showThrows: true }),
      onError: (_err, ctx) => errors.push(ctx),
    });
    n.notify(samplePayload);
    expect(errors[0]?.phase).toBe('show');
  });

  it('attack: isSupported() that throws is treated as unsupported', () => {
    const ctor = (() => {
      const fake = (() => {/* noop */}) as unknown as ElectronNotificationCtor;
      (fake as unknown as { isSupported: () => boolean }).isSupported = () => {
        throw new Error('platform check failed');
      };
      return fake;
    })();
    const errors: Array<{ phase: string }> = [];
    const n = new ElectronNotifier({
      Notification: ctor,
      onError: (_err, ctx) => errors.push(ctx),
    });
    expect(n.isSupported()).toBe(false);
    expect(errors[0]?.phase).toBe('isSupported');
  });
});

describe('ElectronNotifier — closeForApproval (Phase 46c)', () => {
  it('closeForApproval(id) calls Notification.close() and forgets the id', () => {
    const state: FakeState = { ctorOpts: [], shows: 0, clickListeners: [], closes: 0, isSupported: true };
    const n = new ElectronNotifier({ Notification: makeFakeCtor(state) });
    n.notify({ ...samplePayload, ref: { kind: 'approval', approvalId: 'apr_42' } });
    n.closeForApproval('apr_42');
    expect(state.closes).toBe(1);
    // Second close on the same id is a no-op (already removed).
    n.closeForApproval('apr_42');
    expect(state.closes).toBe(1);
  });

  it('closeForApproval is a no-op for unknown id', () => {
    const state: FakeState = { ctorOpts: [], shows: 0, clickListeners: [], closes: 0, isSupported: true };
    const n = new ElectronNotifier({ Notification: makeFakeCtor(state) });
    n.closeForApproval('nope');
    expect(state.closes).toBe(0);
  });

  it('clicking the toast removes it from the active map (close becomes no-op)', () => {
    const state: FakeState = { ctorOpts: [], shows: 0, clickListeners: [], closes: 0, isSupported: true };
    const n = new ElectronNotifier({ Notification: makeFakeCtor(state) });
    n.notify({ ...samplePayload, ref: { kind: 'approval', approvalId: 'apr_clk' } });
    state.clickListeners[0]!();
    n.closeForApproval('apr_clk');
    expect(state.closes).toBe(0);
  });

  it('attack: close() that throws is caught and routed to onError', () => {
    const state: FakeState = { ctorOpts: [], shows: 0, clickListeners: [], closes: 0, isSupported: true };
    const errors: Array<{ phase: string }> = [];
    const n = new ElectronNotifier({
      Notification: makeFakeCtor(state, { closeThrows: true }),
      onError: (_err, ctx) => errors.push(ctx),
    });
    n.notify({ ...samplePayload, ref: { kind: 'approval', approvalId: 'apr_x' } });
    expect(() => n.closeForApproval('apr_x')).not.toThrow();
    expect(errors[0]?.phase).toBe('close');
  });

  it('non-approval payloads are not tracked (no leak)', () => {
    const state: FakeState = { ctorOpts: [], shows: 0, clickListeners: [], closes: 0, isSupported: true };
    const n = new ElectronNotifier({ Notification: makeFakeCtor(state) });
    n.notify({ title: 't', body: 'b', ref: { kind: 'message', messageId: 'm1' } });
    n.closeForApproval('m1');
    expect(state.closes).toBe(0);
  });
});
