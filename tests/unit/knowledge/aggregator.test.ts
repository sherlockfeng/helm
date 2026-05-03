import { describe, expect, it } from 'vitest';
import { aggregateSessionContext } from '../../../src/knowledge/aggregator.js';
import { KnowledgeProviderRegistry, type KnowledgeProvider } from '../../../src/knowledge/types.js';

const ctx = { hostSessionId: 's1', cwd: '/proj' };

function provider(id: string, overrides: Partial<KnowledgeProvider> = {}): KnowledgeProvider {
  return {
    id,
    displayName: id,
    canHandle: () => true,
    getSessionContext: async () => `body of ${id}`,
    search: async () => [],
    healthcheck: async () => ({ ok: true }),
    ...overrides,
  } as KnowledgeProvider;
}

describe('aggregateSessionContext — basic', () => {
  it('returns empty when registry is empty', async () => {
    const r = await aggregateSessionContext(new KnowledgeProviderRegistry(), ctx);
    expect(r.context).toBe('');
    expect(r.diagnostics).toEqual([]);
  });

  it('concatenates handlers in registry order with displayName headers', async () => {
    const reg = new KnowledgeProviderRegistry();
    reg.register(provider('a', { displayName: 'Alpha', getSessionContext: async () => 'A body' }));
    reg.register(provider('b', { displayName: 'Beta', getSessionContext: async () => 'B body' }));
    const r = await aggregateSessionContext(reg, ctx);
    expect(r.context).toContain('## Alpha\nA body');
    expect(r.context).toContain('## Beta\nB body');
    // Order: Alpha precedes Beta
    expect(r.context.indexOf('Alpha')).toBeLessThan(r.context.indexOf('Beta'));
  });

  it('skips providers whose canHandle returns false', async () => {
    const reg = new KnowledgeProviderRegistry();
    reg.register(provider('a', { canHandle: () => false, getSessionContext: async () => 'A' }));
    reg.register(provider('b', { getSessionContext: async () => 'B' }));
    const r = await aggregateSessionContext(reg, ctx);
    expect(r.context).not.toContain('## a\nA');
    expect(r.context).toContain('B');
    expect(r.diagnostics.find((d) => d.provider === 'a')?.status).toBe('skipped');
  });

  it('skips providers whose getSessionContext returns null', async () => {
    const reg = new KnowledgeProviderRegistry();
    reg.register(provider('a', { getSessionContext: async () => null }));
    reg.register(provider('b'));
    const r = await aggregateSessionContext(reg, ctx);
    expect(r.context).toContain('## b\nbody of b');
    expect(r.context).not.toContain('## a');
  });
});

describe('aggregateSessionContext — failure modes', () => {
  it('attack: canHandle that throws → diagnostics error, others continue', async () => {
    const reg = new KnowledgeProviderRegistry();
    reg.register(provider('boom', { canHandle: () => { throw new Error('canHandle boom'); } }));
    reg.register(provider('ok'));
    const r = await aggregateSessionContext(reg, ctx);
    expect(r.context).toContain('## ok');
    const boomDiag = r.diagnostics.find((d) => d.provider === 'boom');
    expect(boomDiag?.status).toBe('error');
    expect(boomDiag?.reason).toContain('canHandle boom');
  });

  it('attack: canHandle that hangs → timeout, others continue', async () => {
    const reg = new KnowledgeProviderRegistry();
    reg.register(provider('slow', { canHandle: () => new Promise(() => { /* never */ }) }));
    reg.register(provider('fast'));
    const r = await aggregateSessionContext(reg, ctx, { canHandleTotalMs: 30 });
    expect(r.context).toContain('## fast');
    const slowDiag = r.diagnostics.find((d) => d.provider === 'slow');
    expect(slowDiag?.status).toBe('timeout');
  });

  it('attack: getSessionContext that throws → error in diagnostics, others continue', async () => {
    const reg = new KnowledgeProviderRegistry();
    reg.register(provider('boom', { getSessionContext: async () => { throw new Error('ctx boom'); } }));
    reg.register(provider('ok'));
    const r = await aggregateSessionContext(reg, ctx);
    expect(r.context).toContain('## ok');
    const boomDiag = r.diagnostics.find((d) => d.provider === 'boom' && d.phase === 'getSessionContext');
    expect(boomDiag?.status).toBe('error');
  });

  it('attack: getSessionContext that hangs → timeout, others continue', async () => {
    const reg = new KnowledgeProviderRegistry();
    reg.register(provider('slow', { getSessionContext: () => new Promise(() => { /* never */ }) }));
    reg.register(provider('fast'));
    const r = await aggregateSessionContext(reg, ctx, { getContextTimeoutMs: 30 });
    expect(r.context).toContain('## fast');
    const slowDiag = r.diagnostics.find((d) => d.provider === 'slow' && d.phase === 'getSessionContext');
    expect(slowDiag?.status).toBe('timeout');
  });

  it('warnings sink receives slow / failing entries', async () => {
    const reg = new KnowledgeProviderRegistry();
    reg.register(provider('boom', { getSessionContext: async () => { throw new Error('x'); } }));
    const warnings: Array<{ provider: string; phase: string }> = [];
    await aggregateSessionContext(reg, ctx, { onWarning: (_msg, c) => warnings.push(c) });
    expect(warnings.some((w) => w.provider === 'boom')).toBe(true);
  });
});

describe('aggregateSessionContext — byte cap', () => {
  it('truncates trailing providers when total exceeds maxBytes', async () => {
    const reg = new KnowledgeProviderRegistry();
    reg.register(provider('a', { getSessionContext: async () => 'x'.repeat(60) }));
    reg.register(provider('b', { getSessionContext: async () => 'y'.repeat(60) }));
    reg.register(provider('c', { getSessionContext: async () => 'z'.repeat(60) }));
    const r = await aggregateSessionContext(reg, ctx, { maxBytes: 75 });
    expect(r.context).toContain('## a');
    // First block fits (~65 bytes for "## a\n" + 60 x), second one would push us over.
    expect(r.context).not.toContain('## b');
    const bDiag = r.diagnostics.find((d) => d.provider === 'b');
    expect(bDiag?.status).toBe('truncated');
  });

  it('does not truncate when everything fits', async () => {
    const reg = new KnowledgeProviderRegistry();
    reg.register(provider('a', { getSessionContext: async () => 'tiny' }));
    reg.register(provider('b', { getSessionContext: async () => 'small' }));
    const r = await aggregateSessionContext(reg, ctx, { maxBytes: 10_000 });
    expect(r.context).toContain('## a\ntiny');
    expect(r.context).toContain('## b\nsmall');
    expect(r.diagnostics.every((d) => d.status !== 'truncated')).toBe(true);
  });
});

describe('aggregateSessionContext — header format', () => {
  it('separator between blocks is a blank line', async () => {
    const reg = new KnowledgeProviderRegistry();
    reg.register(provider('a', { displayName: 'A', getSessionContext: async () => 'aaa' }));
    reg.register(provider('b', { displayName: 'B', getSessionContext: async () => 'bbb' }));
    const r = await aggregateSessionContext(reg, ctx);
    expect(r.context).toBe('## A\naaa\n\n## B\nbbb');
  });
});
