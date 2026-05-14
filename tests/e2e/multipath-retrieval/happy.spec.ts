/**
 * E2e — multipath retrieval (Phase 76).
 *
 * Drives the MCP client end-to-end:
 *   - train_role with content covering every retrieval-leg sweet spot
 *     (camelCase identifier / acronym / URL / paraphrase-friendly long
 *     text)
 *   - search_knowledge with each strategy variant + the default fusion
 *   - assert that fusion's top-K covers each test query's "right answer"
 *     at least as well as the best single leg
 *
 * Uses the same marker-keyword embedder as the unit suite for predictable
 * cosine behavior. (The pseudo-embedder shipped with helm is char-bin
 * noise; a real benchmark would use a real embedder.)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../../src/mcp/server.js';
import { bootE2e, type E2eHarness } from '../_helpers/setup.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

let harness: E2eHarness;
let mcpServer: McpServer;
let mcpClient: Client;

const MARKERS = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO'] as const;
async function markerEmbed(text: string): Promise<Float32Array> {
  const v = new Float32Array(MARKERS.length);
  for (let i = 0; i < MARKERS.length; i++) {
    if (text.toUpperCase().includes(MARKERS[i]!)) v[i] = 1;
  }
  let n = 0; for (const x of v) n += x * x;
  const d = Math.sqrt(n);
  if (d > 0) for (let i = 0; i < v.length; i++) v[i] /= d;
  return v;
}

function parseJson(result: unknown): unknown {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  const block = r.content?.find((b) => b.type === 'text');
  if (!block?.text) throw new Error('expected text content');
  return JSON.parse(block.text);
}

beforeEach(async () => {
  harness = await bootE2e();
  mcpServer = createMcpServer({
    db: harness.db,
    knowledge: harness.app.knowledge,
    embedFn: markerEmbed,
  });
  const [s, c] = InMemoryTransport.createLinkedPair();
  mcpClient = new Client({ name: 'e2e-multipath', version: '0.0.0' });
  await Promise.all([mcpServer.connect(s), mcpClient.connect(c)]);
});

afterEach(async () => {
  await mcpClient.close();
  await harness.shutdown();
});

/** Train the canonical mini-corpus used by the multipath e2e suite. */
async function seedRole(): Promise<void> {
  await mcpClient.callTool({
    name: 'train_role',
    arguments: {
      roleId: 'role-multi',
      name: 'Multipath',
      documents: [
        // Chunk 1: cosine-friendly (ALPHA marker), no entity, no acronym
        { filename: 'overview.md', kind: 'spec',
          content: 'ALPHA system overview. The platform handles requests across the global mesh.' },
        // Chunk 2: BM25-friendly (literal "tce rollback"), entity (TCE), cosine BRAVO
        { filename: 'runbook.md', kind: 'runbook',
          content: 'BRAVO incident: tce rollback procedure. Run tce rollback <service> then verify health.' },
        // Chunk 3: entity-friendly (camelCase + URL), cosine CHARLIE
        { filename: 'apidoc.md', kind: 'spec',
          content: 'CHARLIE: see getCycleState() and ResponseHandler in https://bytedance.com/docs/cycle.' },
        // Chunk 4: filename entity + glossary kind
        { filename: 'csr-fallback-spec.md', kind: 'glossary',
          content: 'DELTA glossary: CSR fallback path activates when SSR fails.' },
      ],
    },
  });
}

describe('multipath retrieval — strategy router', () => {
  it('default fusion returns hits enriched with per-leg scores when multiple legs match', async () => {
    await seedRole();
    const out = parseJson(await mcpClient.callTool({
      name: 'search_knowledge',
      arguments: { roleId: 'role-multi', query: 'BRAVO tce rollback', topK: 4 },
    })) as Array<{ chunkText: string; score: number; bm25Score?: number; cosineScore?: number; entityScore?: number }>;
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]!.chunkText).toContain('tce rollback procedure');
    // At least one leg contributed a raw score to the top hit.
    const top = out[0]!;
    const someLeg = (top.bm25Score ?? 0) + (top.cosineScore ?? 0) + (top.entityScore ?? 0);
    expect(someLeg).toBeGreaterThan(0);
  });

  it('strategy=bm25 surfaces literal token matches even when cosine has stronger signal elsewhere', async () => {
    await seedRole();
    const out = parseJson(await mcpClient.callTool({
      name: 'search_knowledge',
      arguments: { roleId: 'role-multi', query: 'tce rollback', topK: 3, strategy: 'bm25' },
    })) as Array<{ chunkText: string }>;
    expect(out[0]?.chunkText).toContain('tce rollback');
  });

  it('strategy=cosine ignores literal tokens; works on marker-embedded semantic signal', async () => {
    await seedRole();
    const out = parseJson(await mcpClient.callTool({
      name: 'search_knowledge',
      arguments: { roleId: 'role-multi', query: 'BRAVO incident', topK: 3, strategy: 'cosine' },
    })) as Array<{ chunkText: string }>;
    expect(out[0]?.chunkText).toContain('BRAVO incident');
  });

  it('strategy=entity matches camelCase / URL / acronym entities', async () => {
    await seedRole();
    const out = parseJson(await mcpClient.callTool({
      name: 'search_knowledge',
      arguments: { roleId: 'role-multi', query: 'getCycleState helper', topK: 3, strategy: 'entity' },
    })) as Array<{ chunkText: string }>;
    expect(out[0]?.chunkText).toContain('getCycleState');
  });

  it('fusion at least matches the best single-leg for each query category', async () => {
    await seedRole();
    // Queries crafted so each one has a clearly correct chunk (by inspection):
    const queries = [
      { q: 'tce rollback', expectFragment: 'tce rollback' }, // BM25 sweet spot
      { q: 'BRAVO incident', expectFragment: 'BRAVO incident' }, // cosine sweet spot
      { q: 'getCycleState helper', expectFragment: 'getCycleState' }, // entity sweet spot
      { q: 'CSR fallback path', expectFragment: 'CSR fallback' }, // BM25 + entity
    ];
    for (const { q, expectFragment } of queries) {
      const out = parseJson(await mcpClient.callTool({
        name: 'search_knowledge',
        arguments: { roleId: 'role-multi', query: q, topK: 4 },
      })) as Array<{ chunkText: string }>;
      const topThreeText = out.slice(0, 3).map((h) => h.chunkText).join(' ');
      expect(topThreeText, `fusion missed "${expectFragment}" for query "${q}"`).toContain(expectFragment);
    }
  });

  it('kind filter applies across every leg of fusion', async () => {
    await seedRole();
    const out = parseJson(await mcpClient.callTool({
      name: 'search_knowledge',
      arguments: { roleId: 'role-multi', query: 'fallback', topK: 5, kind: 'glossary' },
    })) as Array<{ chunkText: string; kind: string }>;
    // Only the glossary chunk should surface, even though "fallback" is
    // also a BM25 / entity hit on other kinds.
    for (const h of out) expect(h.kind).toBe('glossary');
  });

  it('search on unknown role returns empty list, not error', async () => {
    const out = parseJson(await mcpClient.callTool({
      name: 'search_knowledge',
      arguments: { roleId: 'role-never-trained', query: 'anything', topK: 3 },
    }));
    expect(out).toEqual([]);
  });

  it('legacy single-arg topK still works via positional path (back-compat with Phase 73 callers)', async () => {
    // The MCP schema requires named topK now; this test exercises the
    // LIBRARY path directly to assert searchKnowledge(db, role, q, fn, 3)
    // (number 5th arg) still resolves.
    const { searchKnowledge } = await import('../../../src/roles/library.js');
    await seedRole();
    const r = await searchKnowledge(harness.db, 'role-multi', 'BRAVO', markerEmbed, 2);
    expect(r.length).toBeLessThanOrEqual(2);
  });
});
