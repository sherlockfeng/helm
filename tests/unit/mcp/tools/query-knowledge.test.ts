import { describe, expect, it } from 'vitest';
import { KnowledgeProviderRegistry, type KnowledgeProvider, type KnowledgeSnippet } from '../../../../src/knowledge/types.js';
import { queryKnowledge } from '../../../../src/mcp/tools/query-knowledge.js';

function provider(id: string, overrides: Partial<KnowledgeProvider> = {}): KnowledgeProvider {
  return {
    id,
    displayName: id,
    canHandle: () => true,
    getSessionContext: async () => null,
    search: async () => [],
    healthcheck: async () => ({ ok: true }),
    ...overrides,
  } as KnowledgeProvider;
}

function snippet(source: string, score: number, body = 'body'): KnowledgeSnippet {
  return { source, title: `${source}-${score}`, body, score };
}

describe('queryKnowledge', () => {
  it('returns empty when no providers registered', async () => {
    const r = await queryKnowledge(new KnowledgeProviderRegistry(), { query: 'hello' });
    expect(r.snippets).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  });

  it('aggregates snippets from multiple providers, sorted by score desc', async () => {
    const reg = new KnowledgeProviderRegistry();
    reg.register(provider('a', { search: async () => [snippet('a', 0.5), snippet('a', 0.9)] }));
    reg.register(provider('b', { search: async () => [snippet('b', 0.7)] }));

    const r = await queryKnowledge(reg, { query: 'q' });
    expect(r.snippets.map((s) => s.score)).toEqual([0.9, 0.7, 0.5]);
    expect(r.diagnostics.find((d) => d.provider === 'a')).toMatchObject({ status: 'ok', snippetCount: 2 });
    expect(r.diagnostics.find((d) => d.provider === 'b')).toMatchObject({ status: 'ok', snippetCount: 1 });
  });

  it('respects providers filter', async () => {
    const reg = new KnowledgeProviderRegistry();
    reg.register(provider('a', { search: async () => [snippet('a', 0.5)] }));
    reg.register(provider('b', { search: async () => [snippet('b', 0.5)] }));

    const r = await queryKnowledge(reg, { query: 'q', providers: ['a'] });
    expect(r.snippets).toHaveLength(1);
    expect(r.snippets[0]?.source).toBe('a');
    expect(r.diagnostics.map((d) => d.provider)).toEqual(['a']);
  });

  it('skips providers whose canHandle returns false (when context provided)', async () => {
    const reg = new KnowledgeProviderRegistry();
    reg.register(provider('a', {
      canHandle: () => false,
      search: async () => [snippet('a', 1)],
    }));
    reg.register(provider('b', { search: async () => [snippet('b', 0.5)] }));

    const r = await queryKnowledge(reg, { query: 'q', hostSessionId: 's1', cwd: '/proj' });
    expect(r.snippets.map((s) => s.source)).toEqual(['b']);
    const diagA = r.diagnostics.find((d) => d.provider === 'a');
    expect(diagA?.status).toBe('skipped');
  });

  it('canHandle is bypassed when no context provided (matches §11.5 v1 semantics)', async () => {
    const reg = new KnowledgeProviderRegistry();
    reg.register(provider('a', {
      canHandle: () => false,
      search: async () => [snippet('a', 1)],
    }));
    const r = await queryKnowledge(reg, { query: 'q' });
    expect(r.snippets).toHaveLength(1);
  });

  it('attack: provider that throws in search is recorded as error, others continue', async () => {
    const reg = new KnowledgeProviderRegistry();
    reg.register(provider('boom', { search: async () => { throw new Error('endpoint down'); } }));
    reg.register(provider('ok', { search: async () => [snippet('ok', 0.5)] }));

    const r = await queryKnowledge(reg, { query: 'q' });
    expect(r.snippets).toHaveLength(1);
    const diagBoom = r.diagnostics.find((d) => d.provider === 'boom');
    expect(diagBoom?.status).toBe('error');
    expect(diagBoom?.reason).toContain('endpoint down');
  });

  it('attack: slow provider is timed out, others still return', async () => {
    const reg = new KnowledgeProviderRegistry();
    reg.register(provider('slow', { search: () => new Promise(() => { /* never */ }) }));
    reg.register(provider('fast', { search: async () => [snippet('fast', 0.5)] }));

    const r = await queryKnowledge(reg, { query: 'q' }, { searchTimeoutMs: 30 });
    expect(r.snippets.map((s) => s.source)).toEqual(['fast']);
    const diagSlow = r.diagnostics.find((d) => d.provider === 'slow');
    expect(diagSlow?.status).toBe('timeout');
  });

  it('attack: provider with no score is treated as 0 and sorts last', async () => {
    const reg = new KnowledgeProviderRegistry();
    reg.register(provider('a', {
      search: async () => [{ source: 'a', title: 'no-score', body: '' }],
    }));
    reg.register(provider('b', { search: async () => [snippet('b', 0.1)] }));
    const r = await queryKnowledge(reg, { query: 'q' });
    expect(r.snippets[0]?.source).toBe('b');
  });

  it('attack: canHandle that throws is treated as error (provider skipped)', async () => {
    const reg = new KnowledgeProviderRegistry();
    reg.register(provider('a', {
      canHandle: () => { throw new Error('check failed'); },
      search: async () => [snippet('a', 1)],
    }));
    const r = await queryKnowledge(reg, { query: 'q', hostSessionId: 's1', cwd: '/proj' });
    expect(r.snippets).toHaveLength(0);
    expect(r.diagnostics[0]?.status).toBe('error');
    expect(r.diagnostics[0]?.reason).toContain('check failed');
  });
});
