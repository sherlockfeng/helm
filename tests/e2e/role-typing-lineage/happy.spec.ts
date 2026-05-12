/**
 * E2e — role knowledge typing + source lineage (Phase 73).
 *
 * End-to-end through the MCP client so we exercise the same surface a
 * Cursor / Claude agent uses:
 *   1. `train_role` with per-doc `kind` → typed chunks land in DB
 *   2. `search_knowledge` with `kind` filter → only that kind comes back
 *   3. `list_knowledge_sources` → reports each source row + chunkCount
 *   4. `drop_knowledge_source` → cascades to derived chunks, leaves others alone
 *   5. `update_role` with a re-ingested identical doc → fingerprint reuses
 *      the same source row (one entry, not two) but adds new chunks
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

function parseJsonContent(result: unknown): unknown {
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
  });
  const [s, c] = InMemoryTransport.createLinkedPair();
  mcpClient = new Client({ name: 'e2e-typing', version: '0.0.0' });
  await Promise.all([mcpServer.connect(s), mcpClient.connect(c)]);
});

afterEach(async () => {
  await mcpClient.close();
  await harness.shutdown();
});

describe('role typing + lineage (Phase 73)', () => {
  it('train_role propagates per-doc kind to chunks; search_knowledge filters by kind', async () => {
    await mcpClient.callTool({
      name: 'train_role',
      arguments: {
        roleId: 'role-tce',
        name: 'TCE expert',
        documents: [
          { filename: 'tce-spec.md', content: 'TCE deploy semantics: replicas, rolling, health…', kind: 'spec' },
          { filename: 'tce-runbook.md', content: 'Incident playbook: 1) tce status. 2) tce rollback…', kind: 'runbook' },
          { filename: 'tce-example.md', content: 'Example: tce apply --service auth --replicas 3', kind: 'example' },
        ],
      },
    });

    // No kind filter → all 3 kinds present.
    const all = parseJsonContent(await mcpClient.callTool({
      name: 'search_knowledge',
      arguments: { roleId: 'role-tce', query: 'tce', topK: 10 },
    })) as Array<{ kind: string; chunkText: string; sourceId?: string }>;
    expect(new Set(all.map((h) => h.kind))).toEqual(new Set(['spec', 'runbook', 'example']));
    // Every hit carries a non-empty sourceId — provenance round-trip.
    expect(all.every((h) => typeof h.sourceId === 'string' && h.sourceId.length > 0)).toBe(true);

    // kind=runbook → only the runbook chunk comes back.
    const onlyRunbook = parseJsonContent(await mcpClient.callTool({
      name: 'search_knowledge',
      arguments: { roleId: 'role-tce', query: 'tce', topK: 10, kind: 'runbook' },
    })) as Array<{ kind: string; chunkText: string }>;
    expect(onlyRunbook.length).toBeGreaterThan(0);
    expect(onlyRunbook.every((h) => h.kind === 'runbook')).toBe(true);
    expect(onlyRunbook[0]!.chunkText).toMatch(/Incident playbook/);
  });

  it('list_knowledge_sources reports each source with derived chunk count', async () => {
    await mcpClient.callTool({
      name: 'train_role',
      arguments: {
        roleId: 'role-x', name: 'x',
        documents: [
          { filename: 'a.md', content: 'a1\na2\na3', kind: 'spec' },
          { filename: 'b.md', content: 'b1', kind: 'example' },
        ],
      },
    });
    const sources = parseJsonContent(await mcpClient.callTool({
      name: 'list_knowledge_sources',
      arguments: { roleId: 'role-x' },
    })) as Array<{ origin: string; chunkCount: number; kind: string }>;
    expect(sources).toHaveLength(2);
    const byOrigin = Object.fromEntries(sources.map((s) => [s.origin, s.chunkCount]));
    expect(byOrigin['a.md']).toBeGreaterThan(0);
    expect(byOrigin['b.md']).toBeGreaterThan(0);
  });

  it('drop_knowledge_source cascade-removes derived chunks, other sources untouched', async () => {
    await mcpClient.callTool({
      name: 'train_role',
      arguments: {
        roleId: 'role-c', name: 'c',
        documents: [
          { filename: 'keep.md', content: 'keep content', kind: 'spec' },
          { filename: 'drop.md', content: 'drop content', kind: 'spec' },
        ],
      },
    });
    const sources = parseJsonContent(await mcpClient.callTool({
      name: 'list_knowledge_sources',
      arguments: { roleId: 'role-c' },
    })) as Array<{ id: string; origin: string }>;
    const dropTarget = sources.find((s) => s.origin === 'drop.md')!;

    const result = parseJsonContent(await mcpClient.callTool({
      name: 'drop_knowledge_source',
      arguments: { sourceId: dropTarget.id },
    })) as { removed: boolean; chunksDeleted: number };
    expect(result.removed).toBe(true);
    expect(result.chunksDeleted).toBeGreaterThan(0);

    // Surviving search must not include any chunk from drop.md.
    const after = parseJsonContent(await mcpClient.callTool({
      name: 'search_knowledge',
      arguments: { roleId: 'role-c', query: 'content', topK: 10 },
    })) as Array<{ chunkText: string; sourceId?: string }>;
    expect(after.every((h) => !/drop content/.test(h.chunkText))).toBe(true);
    expect(after.some((h) => /keep content/.test(h.chunkText))).toBe(true);
  });

  it('drop_knowledge_source on unknown id reports removed=false', async () => {
    const r = parseJsonContent(await mcpClient.callTool({
      name: 'drop_knowledge_source',
      arguments: { sourceId: 'never-existed' },
    })) as { removed: boolean; chunksDeleted: number; sourceId: string };
    expect(r).toMatchObject({ removed: false, chunksDeleted: 0, sourceId: 'never-existed' });
  });

  it('update_role re-ingesting identical doc reuses the same source row', async () => {
    await mcpClient.callTool({
      name: 'train_role',
      arguments: {
        roleId: 'role-fp', name: 'fp',
        documents: [{ filename: 'same.md', content: 'unchanged', kind: 'spec' }],
      },
    });
    const before = parseJsonContent(await mcpClient.callTool({
      name: 'list_knowledge_sources',
      arguments: { roleId: 'role-fp' },
    })) as Array<{ id: string; chunkCount: number }>;
    expect(before).toHaveLength(1);

    await mcpClient.callTool({
      name: 'update_role',
      arguments: {
        roleId: 'role-fp',
        appendDocuments: [{ filename: 'same.md', content: 'unchanged', kind: 'spec' }],
        force: true, // same content would otherwise self-conflict
      },
    });
    const after = parseJsonContent(await mcpClient.callTool({
      name: 'list_knowledge_sources',
      arguments: { roleId: 'role-fp' },
    })) as Array<{ id: string; chunkCount: number }>;
    // Decision §6: source is reused (only 1 row), but chunks DOUBLED (decision §C).
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before[0]?.id);
    expect(after[0]?.chunkCount).toBeGreaterThan(before[0]!.chunkCount);
  });

  it('train_role inputs without `kind` get the `other` default', async () => {
    await mcpClient.callTool({
      name: 'train_role',
      arguments: {
        roleId: 'role-default', name: 'd',
        documents: [{ filename: 'a.md', content: 'no kind specified' }],
      },
    });
    const hits = parseJsonContent(await mcpClient.callTool({
      name: 'search_knowledge',
      arguments: { roleId: 'role-default', query: 'kind', topK: 5 },
    })) as Array<{ kind: string }>;
    expect(hits[0]?.kind).toBe('other');
  });
});
