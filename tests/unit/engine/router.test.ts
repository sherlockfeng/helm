/**
 * EngineRouter unit tests (Phase 68).
 *
 * Contracts we pin here:
 *   - `current()` resolves via `defaultGetter` on every call (no caching).
 *   - Missing adapter for the configured default → EngineNotAvailableError.
 *   - `byId(id)` lets callers force a specific engine even if it's not default.
 *   - `available()` reflects the adapter map.
 */

import { describe, expect, it } from 'vitest';
import { EngineRouter, EngineNotAvailableError } from '../../../src/engine/router.js';
import type { EngineAdapter, EngineId } from '../../../src/engine/types.js';

function makeFakeAdapter(id: EngineId): EngineAdapter {
  return {
    id,
    summarize: { generate: async () => `${id}-summary` },
    review: async () => `${id}-review`,
    runConversation: async () => ({ text: `${id}-conv`, stderr: '', sessionId: `${id}-sid` }),
  };
}

describe('EngineRouter', () => {
  it('current() resolves the adapter for the configured default', () => {
    const router = new EngineRouter({
      adapters: { claude: makeFakeAdapter('claude'), cursor: makeFakeAdapter('cursor') },
      defaultGetter: () => 'cursor',
    });
    expect(router.current().id).toBe('cursor');
  });

  it('current() re-reads defaultGetter every call (no caching)', () => {
    let active: EngineId = 'cursor';
    const router = new EngineRouter({
      adapters: { claude: makeFakeAdapter('claude'), cursor: makeFakeAdapter('cursor') },
      defaultGetter: () => active,
    });
    expect(router.current().id).toBe('cursor');
    active = 'claude';
    expect(router.current().id).toBe('claude');
    active = 'cursor';
    expect(router.current().id).toBe('cursor');
  });

  it('current() throws EngineNotAvailableError when the configured default is absent', () => {
    const router = new EngineRouter({
      adapters: { claude: makeFakeAdapter('claude') },
      defaultGetter: () => 'cursor',
    });
    expect(() => router.current()).toThrow(EngineNotAvailableError);
  });

  it('error message points the user at Settings + install path', () => {
    const router = new EngineRouter({
      adapters: {},
      defaultGetter: () => 'cursor',
    });
    try {
      router.current();
      throw new Error('expected throw');
    } catch (err) {
      const e = err as EngineNotAvailableError;
      expect(e).toBeInstanceOf(EngineNotAvailableError);
      expect(e.engineId).toBe('cursor');
      expect(e.message).toMatch(/Settings/);
      expect(e.message).toMatch(/cursor-agent CLI/);
    }
  });

  it('byId(id) returns that exact engine regardless of default', () => {
    const router = new EngineRouter({
      adapters: { claude: makeFakeAdapter('claude'), cursor: makeFakeAdapter('cursor') },
      defaultGetter: () => 'claude',
    });
    expect(router.byId('cursor').id).toBe('cursor');
  });

  it('byId throws if the requested engine is not registered', () => {
    const router = new EngineRouter({
      adapters: { claude: makeFakeAdapter('claude') },
      defaultGetter: () => 'claude',
    });
    expect(() => router.byId('cursor')).toThrow(EngineNotAvailableError);
  });

  it('available() lists keys with a defined adapter', () => {
    const router = new EngineRouter({
      adapters: { claude: makeFakeAdapter('claude') },
      defaultGetter: () => 'claude',
    });
    expect(router.available()).toEqual(['claude']);
  });
});
