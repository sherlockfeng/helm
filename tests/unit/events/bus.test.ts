import { describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../../../src/events/bus.js';

describe('createEventBus', () => {
  it('emits to every subscriber', () => {
    const bus = createEventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.on(a);
    bus.on(b);
    bus.emit({ type: 'session.closed', hostSessionId: 's1' });
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it('listenerCount tracks active subscribers', () => {
    const bus = createEventBus();
    expect(bus.listenerCount()).toBe(0);
    const off = bus.on(() => {});
    expect(bus.listenerCount()).toBe(1);
    off();
    expect(bus.listenerCount()).toBe(0);
  });

  it('subscribers added during dispatch do not receive the in-flight event', () => {
    const bus = createEventBus();
    const late = vi.fn();
    bus.on(() => { bus.on(late); });
    bus.emit({ type: 'session.closed', hostSessionId: 's1' });
    expect(late).not.toHaveBeenCalled();
  });

  it('attack: throwing sync handler does not block other handlers', () => {
    const errors: Error[] = [];
    const bus = createEventBus({ onListenerError: (err) => errors.push(err) });
    const ok = vi.fn();
    bus.on(() => { throw new Error('boom'); });
    bus.on(ok);
    bus.emit({ type: 'session.closed', hostSessionId: 's1' });
    expect(ok).toHaveBeenCalledOnce();
    expect(errors[0]?.message).toBe('boom');
  });

  it('attack: rejecting async handler is caught', async () => {
    const errors: Error[] = [];
    const bus = createEventBus({ onListenerError: (err) => errors.push(err) });
    bus.on(async () => { throw new Error('async boom'); });
    bus.emit({ type: 'session.closed', hostSessionId: 's1' });
    // Wait a tick for the async catch to fire
    await new Promise((r) => setTimeout(r, 10));
    expect(errors[0]?.message).toBe('async boom');
  });

  it('clear() drops all subscribers', () => {
    const bus = createEventBus();
    const h = vi.fn();
    bus.on(h);
    bus.clear();
    bus.emit({ type: 'session.closed', hostSessionId: 's1' });
    expect(h).not.toHaveBeenCalled();
    expect(bus.listenerCount()).toBe(0);
  });
});
