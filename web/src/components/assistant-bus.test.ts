import { describe, it, expect, vi } from 'vitest';
import { openAssistant, onOpenAssistant } from './assistant-bus.js';

describe('assistant-bus', () => {
  it('delivers openAssistant(seed) to the registered listener; unsubscribe stops it', () => {
    const fn = vi.fn();
    const off = onOpenAssistant(fn);
    openAssistant('帮我整理 X');
    expect(fn).toHaveBeenCalledWith('帮我整理 X');
    off();
    openAssistant('again');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when nothing is listening', () => {
    expect(() => openAssistant('x')).not.toThrow();
  });
});
