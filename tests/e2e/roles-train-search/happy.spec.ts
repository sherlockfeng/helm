/**
 * E2e — train a custom role + search its knowledge base via MCP.
 *
 * The /roles renderer page lets the user point helm at a folder of docs and
 * mint a custom role. Under the hood:
 *
 *   POST /api/roles/:id/train          ← renderer
 *   train_role MCP tool                ← agent
 *
 * Both call into `roles/library.ts → trainRole()`. Once the role exists,
 * agents recall its knowledge via `search_knowledge` (RAG over the chunk
 * embeddings). This spec drives the MCP path because that's the one that
 * has fewest seams (the HTTP path is just a thin wrapper) and doubles as
 * regression coverage for the embed function the orchestrator wires.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../../src/mcp/server.js';
import { bootE2e, type E2eHarness } from '../_helpers/setup.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listRoles } from '../../../src/roles/library.js';
import { getChunksForRole } from '../../../src/storage/repos/roles.js';

let harness: E2eHarness;
let mcpServer: McpServer;
let mcpClient: Client;

function parseJsonContent(result: unknown): unknown {
  // The SDK types callTool's return as a union (legacy `toolResult` shape OR
  // the modern `content` shape); we only ever exercise the modern path.
  const r = result as { content?: Array<{ type: string; text?: string }> };
  const block = r.content?.find((b) => b.type === 'text');
  if (!block?.text) throw new Error('expected text content');
  return JSON.parse(block.text);
}

beforeEach(async () => {
  harness = await bootE2e();
  // Reuse the orchestrator's DB + knowledge registry so list_roles / role
  // chunks see the trained role end-to-end.
  mcpServer = createMcpServer({
    db: harness.db,
    knowledge: harness.app.knowledge,
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  mcpClient = new Client({ name: 'e2e-roles', version: '0.0.0' });
  await Promise.all([
    mcpServer.connect(serverTransport),
    mcpClient.connect(clientTransport),
  ]);
});

afterEach(async () => {
  await mcpClient.close();
  await harness.shutdown();
});

describe('roles-train-search happy', () => {
  it('train_role indexes documents → list_roles surfaces it → search_knowledge returns matching chunk', async () => {
    // Step 1: train. Two docs so the chunker splits across multiple chunks
    // and the recall test has something interesting to pick from.
    const trainResult = await mcpClient.callTool({
      name: 'train_role',
      arguments: {
        roleId: 'role-disaster-dashboard',
        name: 'Disaster Dashboard Expert',
        documents: [
          {
            filename: 'overview.md',
            content: 'The disaster dashboard surfaces critical alerts during incidents. '
              + 'It aggregates metrics from prometheus, ELB, and the on-call rotation.',
          },
          {
            filename: 'runbook.md',
            content: 'When a P0 alert fires: page the on-call, open the dashboard at /disaster, '
              + 'and start the incident bridge in Lark. Escalate after 15 minutes.',
          },
        ],
      },
    });
    expect(trainResult.isError).not.toBe(true);
    const trained = parseJsonContent(trainResult) as { roleId: string; name: string; chunksIndexed: number };
    expect(trained.roleId).toBe('role-disaster-dashboard');
    expect(trained.chunksIndexed).toBeGreaterThan(0);

    // Step 2: list_roles surfaces it (built-ins + the new one).
    const listResult = await mcpClient.callTool({ name: 'list_roles', arguments: {} });
    const roles = parseJsonContent(listResult) as Array<{ id: string }>;
    expect(roles.map((r) => r.id)).toContain('role-disaster-dashboard');

    // Storage matches: chunks are in the role-specific table, queryable
    // independently for any external tooling.
    const chunks = getChunksForRole(harness.db, 'role-disaster-dashboard');
    expect(chunks.length).toBeGreaterThan(0);

    // Step 3: search returns the indexed chunks. The pseudo-embedder shipped
    // for tests is deterministic but token-bag (not semantic), so we don't
    // assert which chunk ranks first — just that the search round-trip
    // surfaces non-empty hits whose text was actually drawn from the
    // documents we trained on.
    const searchResult = await mcpClient.callTool({
      name: 'search_knowledge',
      arguments: {
        roleId: 'role-disaster-dashboard',
        query: 'P0 alert escalation runbook',
        topK: 5,
      },
    });
    expect(searchResult.isError).not.toBe(true);
    const hits = parseJsonContent(searchResult) as Array<{ chunkText: string; score: number }>;
    expect(hits.length).toBeGreaterThan(0);
    // Every hit's chunkText should pull a recognizable token from the trained
    // docs — proves the embeddings + storage round-trip is wired, without
    // baking in pseudo-embedder ranking specifics that might drift.
    for (const hit of hits) {
      expect(/disaster|dashboard|alert|on-call|prometheus|ELB|escalate|P0|runbook|incident|page|bridge|Lark/i.test(hit.chunkText)).toBe(true);
    }
  });

  it('retrain replaces the chunk set — old content drops out, new content takes over', async () => {
    await mcpClient.callTool({
      name: 'train_role',
      arguments: {
        roleId: 'role-tmp',
        name: 'Tmp',
        documents: [{ filename: 'a.md', content: 'apricot apple avocado' }],
      },
    });
    const before = getChunksForRole(harness.db, 'role-tmp');
    expect(before.length).toBeGreaterThan(0);

    await mcpClient.callTool({
      name: 'train_role',
      arguments: {
        roleId: 'role-tmp',
        name: 'Tmp',
        documents: [{ filename: 'b.md', content: 'banana blueberry blackberry' }],
      },
    });
    const after = getChunksForRole(harness.db, 'role-tmp');
    expect(after.length).toBeGreaterThan(0);
    // No surviving chunk should reference apricot — retrain wipes prior content.
    const apricotSurvived = after.some((c) => /apricot/i.test(c.chunkText));
    expect(apricotSurvived).toBe(false);
  });

  it('get_role returns the trained role\'s system prompt + metadata', async () => {
    await mcpClient.callTool({
      name: 'train_role',
      arguments: {
        roleId: 'role-meta',
        name: 'Meta Role',
        baseSystemPrompt: 'You are a meta agent. Cite sources.',
        documents: [{ filename: 'doc.md', content: 'cite your sources' }],
      },
    });

    const result = await mcpClient.callTool({
      name: 'get_role', arguments: { roleId: 'role-meta' },
    });
    expect(result.isError).not.toBe(true);
    const role = parseJsonContent(result) as { id: string; name: string; systemPrompt?: string };
    expect(role.id).toBe('role-meta');
    expect(role.systemPrompt ?? '').toContain('meta agent');
  });

  it('attack: search_knowledge against an unknown roleId returns empty list, not an error', async () => {
    const result = await mcpClient.callTool({
      name: 'search_knowledge',
      arguments: { roleId: 'role-no-exist', query: 'anything', topK: 3 },
    });
    expect(result.isError).not.toBe(true);
    const hits = parseJsonContent(result) as unknown[];
    expect(Array.isArray(hits)).toBe(true);
    expect(hits).toHaveLength(0);
  });

  it('attack: train_role with empty documents array fails the schema (zero-doc training is meaningless)', async () => {
    // Zod schema enforces `.min(1)` on documents. SDK reports the validation
    // failure as `{ isError: true }` — the "did this surface as an error AND
    // not silently land a role row?" contract is what we care about.
    const result = await mcpClient.callTool({
      name: 'train_role',
      arguments: {
        roleId: 'role-empty', name: 'Empty', documents: [],
      },
    });
    expect(result.isError).toBe(true);

    // No role row should have been inserted.
    const rolesNow = listRoles(harness.db).map((r) => r.id);
    expect(rolesNow).not.toContain('role-empty');
  });
});
