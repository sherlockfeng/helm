import { describe, expect, it } from 'vitest';
import { KnowledgeProviderRegistry, type KnowledgeProvider } from '../../../../src/knowledge/types.js';
import { listKnowledgeProviders } from '../../../../src/mcp/tools/list-knowledge-providers.js';

function makeProvider(overrides: Partial<KnowledgeProvider> & { id: string }): KnowledgeProvider {
  return {
    displayName: overrides.id,
    canHandle: () => true,
    getSessionContext: async () => null,
    search: async () => [],
    healthcheck: async () => ({ ok: true }),
    ...overrides,
  } as KnowledgeProvider;
}

describe('listKnowledgeProviders', () => {
  it('returns empty array when no providers registered', async () => {
    const registry = new KnowledgeProviderRegistry();
    expect(await listKnowledgeProviders(registry)).toEqual({ providers: [] });
  });

  it('returns id, displayName, healthy=true for healthy providers', async () => {
    const registry = new KnowledgeProviderRegistry();
    registry.register(makeProvider({ id: 'p1', displayName: 'Provider One' }));
    const r = await listKnowledgeProviders(registry);
    expect(r.providers).toEqual([
      { id: 'p1', displayName: 'Provider One', healthy: true, reason: undefined },
    ]);
  });

  it('reports healthy=false with reason for unhealthy provider', async () => {
    const registry = new KnowledgeProviderRegistry();
    registry.register(makeProvider({ id: 'p1', healthcheck: async () => ({ ok: false, reason: 'auth expired' }) }));
    const r = await listKnowledgeProviders(registry);
    expect(r.providers[0]).toMatchObject({ healthy: false, reason: 'auth expired' });
  });

  it('attack: provider whose healthcheck throws is reported unhealthy with the error', async () => {
    const registry = new KnowledgeProviderRegistry();
    registry.register(makeProvider({ id: 'p1', healthcheck: async () => { throw new Error('connection refused'); } }));
    const r = await listKnowledgeProviders(registry);
    expect(r.providers[0]).toMatchObject({ healthy: false, reason: 'connection refused' });
  });

  it('attack: slow provider is timed out, others still report', async () => {
    const registry = new KnowledgeProviderRegistry();
    registry.register(makeProvider({
      id: 'slow',
      healthcheck: () => new Promise((_resolve) => { /* never resolves */ }),
    }));
    registry.register(makeProvider({ id: 'fast' }));
    const r = await listKnowledgeProviders(registry, { healthcheckTimeoutMs: 30 });
    const slow = r.providers.find((p) => p.id === 'slow')!;
    const fast = r.providers.find((p) => p.id === 'fast')!;
    expect(slow.healthy).toBe(false);
    expect(slow.reason).toContain('timed out');
    expect(fast.healthy).toBe(true);
  });
});
