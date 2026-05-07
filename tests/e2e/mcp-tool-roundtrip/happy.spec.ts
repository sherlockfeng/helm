/**
 * E2e — MCP tool round trip (Phase 30 / C2).
 *
 * Boots the helm orchestrator AND a real MCP server (over an in-memory
 * transport) sharing the same DB. Drives an agent's perspective:
 *   1. list_knowledge_providers — verify the orchestrator-registered providers
 *      surface to the MCP client.
 *   2. get_active_chats — verify the same DB row the orchestrator's
 *      session_start hook persisted shows up.
 *   3. init_workflow → create_tasks → get_my_tasks → complete_task — drives
 *      the workflow engine through the MCP layer instead of HTTP.
 *
 * Proves the MCP server, orchestrator, and HTTP API all read consistent
 * state from the shared DB / KnowledgeProviderRegistry. Without this spec,
 * a contract drift between the two surfaces (e.g. a tool not seeing the
 * orchestrator's pre-registered providers) would only surface in production.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../../src/mcp/server.js';
import { HelmConfigSchema } from '../../../src/config/schema.js';
import { bootE2e, runHookViaBridge, type E2eHarness } from '../_helpers/setup.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

let harness: E2eHarness;
let mcpServer: McpServer;
let mcpClient: Client;

async function bootMcpClient(): Promise<void> {
  // The MCP server uses the same DB and knowledge registry the orchestrator
  // already populated, so list_knowledge_providers / get_active_chats see
  // the orchestrator's view. docFirstBaseDir points at the harness's tmp
  // dir so update_doc_first writes don't leak into the project.
  mcpServer = createMcpServer({
    db: harness.db,
    knowledge: harness.app.knowledge,
    docFirstBaseDir: harness.tmpDir,
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  mcpClient = new Client({ name: 'e2e-test-client', version: '0.0.0' });
  await Promise.all([
    mcpServer.connect(serverTransport),
    mcpClient.connect(clientTransport),
  ]);
}

function parseJsonContent(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const block = result.content.find((b) => b.type === 'text');
  if (!block?.text) throw new Error('expected text content');
  return JSON.parse(block.text);
}

beforeEach(async () => {
  // Disable docFirst.enforce so complete_task in the workflow round-trip
  // doesn't need a minted token (covered in unit tests).
  harness = await bootE2e({
    deps: { config: HelmConfigSchema.parse({ docFirst: { enforce: false } }) },
  });
  await bootMcpClient();
});

afterEach(async () => {
  await mcpClient?.close();
  await mcpServer?.close();
  await harness.shutdown();
});

describe('mcp-tool-roundtrip happy', () => {
  it('list_knowledge_providers reflects the orchestrator-registered set', async () => {
    const result = await mcpClient.callTool({
      name: 'list_knowledge_providers',
      arguments: {},
    }) as { content: Array<{ type: string; text: string }> };
    const body = parseJsonContent(result) as {
      providers: Array<{ id: string; healthy: boolean }>;
    };
    const ids = body.providers.map((p) => p.id);
    // Orchestrator registers these two as always-on; the MCP server sees them.
    expect(ids).toContain('local-roles');
    expect(ids).toContain('requirements-archive');
  });

  it('get_active_chats reflects sessions persisted by the orchestrator', async () => {
    // Drive the real session_start hook — same path Cursor uses on chat open.
    await runHookViaBridge(harness, {
      event: 'sessionStart',
      payload: { session_id: 'sess_mcp_e2e', cwd: '/proj', composer_mode: 'agent' },
    });

    const result = await mcpClient.callTool({
      name: 'get_active_chats',
      arguments: {},
    }) as { content: Array<{ type: string; text: string }> };
    const body = parseJsonContent(result) as {
      chats: Array<{ hostSessionId: string; cwd?: string; composerMode?: string }>;
    };
    const ours = body.chats.find((c) => c.hostSessionId === 'sess_mcp_e2e');
    expect(ours).toBeDefined();
    expect(ours!.cwd).toBe('/proj');
    expect(ours!.composerMode).toBe('agent');
  });

  it('init_workflow → create_tasks → get_my_tasks → complete_task', async () => {
    // Step 1: agent kicks off a campaign.
    const init = await mcpClient.callTool({
      name: 'init_workflow',
      arguments: { projectPath: '/proj', title: 'mcp-roundtrip' },
    }) as { content: Array<{ type: string; text: string }> };
    const initBody = parseJsonContent(init) as { campaignId: string };
    expect(initBody.campaignId).toBeTruthy();

    // get_cycle_state lets the agent discover the cycle id from the campaign.
    // Returns { cycle, tasks } — read cycle.id / cycle.status off the body.
    const cycleState = await mcpClient.callTool({
      name: 'get_cycle_state',
      arguments: { campaignId: initBody.campaignId },
    }) as { content: Array<{ type: string; text: string }> };
    const stateBody = parseJsonContent(cycleState) as {
      cycle: { id: string; status: string };
      tasks: unknown[];
    };
    expect(stateBody.cycle.status).toBe('product');
    const cycleId = stateBody.cycle.id;

    // Step 2: product splits into dev + test tasks.
    const createReply = await mcpClient.callTool({
      name: 'create_tasks',
      arguments: {
        cycleId,
        tasks: [
          { role: 'dev', title: 'wire endpoint' },
          { role: 'test', title: 'cover endpoint' },
        ],
      },
    }) as { content: Array<{ type: string; text: string }> };
    const created = parseJsonContent(createReply) as { tasks: Array<{ id: string; role: string }> };
    expect(created.tasks).toHaveLength(2);
    const devTaskId = created.tasks.find((t) => t.role === 'dev')!.id;

    // Step 3: dev queries its work queue.
    const myTasks = await mcpClient.callTool({
      name: 'get_my_tasks',
      arguments: { cycleId, role: 'dev' },
    }) as { content: Array<{ type: string; text: string }> };
    const myBody = parseJsonContent(myTasks) as Array<{ id: string }>;
    expect(myBody.map((t) => t.id)).toContain(devTaskId);

    // Step 4: dev runs update_doc_first to mint an audit token (the
    // prescribed agent flow per §12.3 — dev tasks require a fresh token to
    // complete unless docFirst.enforce is off). This also exercises the
    // doc-first plumbing end-to-end.
    const docFirstReply = await mcpClient.callTool({
      name: 'update_doc_first',
      arguments: {
        filePath: 'docs/endpoint.md',
        content: '# Endpoint\nWired this PR.',
        taskId: devTaskId,
      },
    }) as { content: Array<{ type: string; text: string }> };
    const auditToken = (parseJsonContent(docFirstReply) as { auditToken: string }).auditToken;
    expect(auditToken).toBeTruthy();

    // Step 5: dev completes with the audit token — engine flips cycle to
    // 'test' once the last dev task is done.
    const completeReply = await mcpClient.callTool({
      name: 'complete_task',
      arguments: { taskId: devTaskId, result: 'done', docAuditToken: auditToken },
    }) as { content: Array<{ type: string; text: string }> };
    const completeBody = parseJsonContent(completeReply) as { id: string; status: string };
    expect(completeBody.status).toBe('completed');

    // Cycle state advanced to 'test'.
    const finalState = await mcpClient.callTool({
      name: 'get_cycle_state',
      arguments: { cycleId },
    }) as { content: Array<{ type: string; text: string }> };
    const finalBody = parseJsonContent(finalState) as { cycle: { status: string } };
    expect(finalBody.cycle.status).toBe('test');
  });
});
