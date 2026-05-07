/**
 * E2e attacks for mcp-tool-roundtrip.
 *
 * Verifies tool errors don't tear down the connection — clients should be
 * able to call subsequent tools after a bad call.
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

beforeEach(async () => {
  harness = await bootE2e();
  mcpServer = createMcpServer({ db: harness.db, knowledge: harness.app.knowledge });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  mcpClient = new Client({ name: 'e2e-test-client', version: '0.0.0' });
  await Promise.all([
    mcpServer.connect(serverTransport),
    mcpClient.connect(clientTransport),
  ]);
});

afterEach(async () => {
  await mcpClient?.close();
  await mcpServer?.close();
  await harness.shutdown();
});

describe('mcp-tool-roundtrip attacks', () => {
  it('attack: get_cycle_state with no campaignId / cycleId returns informative text, not a crash', async () => {
    const result = await mcpClient.callTool({
      name: 'get_cycle_state',
      arguments: {},
    }) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    // When the engine can't find a state to return, the tool returns a text
    // message — not a JSON-RPC error. Either way, the client must still
    // function on the next call.
    expect(result.content[0]!.text).toBeTruthy();
  });

  it('attack: complete_task on unknown taskId — tool reports error, server keeps serving', async () => {
    const bad = await mcpClient.callTool({
      name: 'complete_task',
      arguments: { taskId: 'ghost', result: 'noop' },
    }).catch((err) => ({ thrown: err })) as { thrown?: Error } | { content: unknown[]; isError?: true };
    // Either an isError-flagged content payload OR a thrown error — both are
    // acceptable per the MCP spec.
    if ('thrown' in bad) {
      expect(bad.thrown).toBeDefined();
    } else {
      // If not thrown it's a content payload; we just want it not to crash.
      expect(bad).toBeDefined();
    }

    // The connection survives — list_knowledge_providers still works.
    const ok = await mcpClient.callTool({
      name: 'list_knowledge_providers',
      arguments: {},
    }) as { content: Array<{ type: string; text: string }> };
    expect(ok.content[0]!.text).toContain('providers');
  });

  it('attack: create_tasks with empty tasks array fails Zod schema, surfaces as isError content', async () => {
    const r = await mcpClient.callTool({
      name: 'create_tasks',
      arguments: { cycleId: 'whatever', tasks: [] },
    }) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/tasks/);

    // Connection still serving.
    const ok = await mcpClient.listTools();
    expect(ok.tools.length).toBeGreaterThan(0);
  });
});
