/**
 * Phase 7 MCP tool round-trips through real InMemoryTransport.
 *
 * One end-to-end test per workflow stage so the registration shape (input
 * schema, JSON-stringified payload, error path) is verified for the legacy
 * relay tool surface — not just the in-process engine logic.
 */

import BetterSqlite3 from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { createMcpServer } from '../../../src/mcp/server.js';
import type { LlmClient } from '../../../src/summarizer/campaign.js';

let db: BetterSqlite3.Database;
let server: McpServer;
let client: Client;
let docFirstBaseDir: string;

class FakeLlm implements LlmClient {
  async generate(): Promise<string> {
    return '## Why\nbecause\n\n## Key Decisions\n- decision A\n\n## Overall Path\narc';
  }
}

async function bootServer(): Promise<void> {
  server = createMcpServer({ db, llm: new FakeLlm(), docFirstBaseDir });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
}

beforeEach(async () => {
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  docFirstBaseDir = mkdtempSync(join(tmpdir(), 'helm-mcp-p7-'));
  await bootServer();
});

afterEach(async () => {
  await client?.close();
  await server?.close();
  db.close();
  rmSync(docFirstBaseDir, { recursive: true, force: true });
});

function parseJsonContent(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const block = result.content.find((b) => b.type === 'text');
  if (!block?.text) throw new Error('expected text content');
  try {
    return JSON.parse(block.text);
  } catch {
    return block.text;
  }
}

describe('Phase 7 MCP — workflow', () => {
  it('init_workflow → get_cycle_state → create_tasks → complete_cycle round trip', async () => {
    const init = await client.callTool({
      name: 'init_workflow',
      arguments: { projectPath: '/proj', title: 'C', brief: 'b' },
    });
    const initJson = parseJsonContent(init as never) as { campaignId: string };

    const state = await client.callTool({
      name: 'get_cycle_state',
      arguments: { campaignId: initJson.campaignId },
    });
    const stateJson = parseJsonContent(state as never) as { cycle: { id: string; status: string } };
    expect(stateJson.cycle.status).toBe('product');

    const created = await client.callTool({
      name: 'create_tasks',
      arguments: {
        cycleId: stateJson.cycle.id,
        tasks: [
          { role: 'dev', title: 'd' },
          { role: 'test', title: 't' },
        ],
      },
    });
    const createdJson = parseJsonContent(created as never) as { tasks: Array<{ id: string; role: string }> };
    expect(createdJson.tasks).toHaveLength(2);

    const devTaskId = createdJson.tasks.find((t) => t.role === 'dev')!.id;
    const testTaskId = createdJson.tasks.find((t) => t.role === 'test')!.id;

    // dev task without docAuditToken should error via the engine
    const failed = await client.callTool({
      name: 'complete_task',
      arguments: { taskId: devTaskId, result: 'r' },
    }) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(failed.isError).toBe(true);

    // Use update_doc_first to get a token, then complete the dev task
    const docResult = await client.callTool({
      name: 'update_doc_first',
      arguments: { filePath: 'docs/test.md', content: '# test', taskId: devTaskId },
    });
    const docJson = parseJsonContent(docResult as never) as { auditToken: string };

    await client.callTool({
      name: 'complete_task',
      arguments: { taskId: devTaskId, result: 'done', docAuditToken: docJson.auditToken },
    });
    await client.callTool({
      name: 'complete_task',
      arguments: { taskId: testTaskId, result: 'tested' },
    });

    const completed = await client.callTool({
      name: 'complete_cycle',
      arguments: { cycleId: stateJson.cycle.id },
    });
    const completedJson = parseJsonContent(completed as never) as { completedCycleId: string };
    expect(completedJson.completedCycleId).toBe(stateJson.cycle.id);
  });
});

describe('Phase 7 MCP — roles', () => {
  it('list_roles returns the seeded built-ins', async () => {
    const r = await client.callTool({ name: 'list_roles', arguments: {} });
    const json = parseJsonContent(r as never) as Array<{ id: string }>;
    const ids = json.map((x) => x.id).sort();
    expect(ids).toEqual(['developer', 'product', 'tester']);
  });

  it('get_role returns full systemPrompt', async () => {
    const r = await client.callTool({ name: 'get_role', arguments: { roleId: 'developer' } });
    const json = parseJsonContent(r as never) as { systemPrompt: string };
    expect(json.systemPrompt.length).toBeGreaterThan(0);
  });

  it('train_role + search_knowledge round-trip', async () => {
    await client.callTool({
      name: 'train_role',
      arguments: {
        roleId: 'expert', name: 'Expert',
        documents: [{ filename: 'a.md', content: 'foo bar baz' }],
      },
    });
    const search = await client.callTool({
      name: 'search_knowledge',
      arguments: { roleId: 'expert', query: 'foo', topK: 3 },
    });
    const json = parseJsonContent(search as never) as Array<{ chunkText: string }>;
    expect(json.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Phase 7 MCP — requirements', () => {
  it('start → answer → confirm flow', async () => {
    const start = await client.callTool({
      name: 'capture_requirement',
      arguments: { action: 'start', name: 'feat', chatContext: 'we discussed X' },
    });
    const startJson = parseJsonContent(start as never) as { sessionId: string };

    const answered = await client.callTool({
      name: 'capture_requirement',
      arguments: {
        action: 'answer',
        sessionId: startJson.sessionId,
        answers: { purpose: 'p', changes: 'c1' },
      },
    });
    expect((parseJsonContent(answered as never) as { phase: string }).phase).toBe('confirming');

    const confirmed = await client.callTool({
      name: 'capture_requirement',
      arguments: { action: 'confirm', sessionId: startJson.sessionId },
    });
    const reqJson = parseJsonContent(confirmed as never) as { requirementId: string; status: string };
    expect(reqJson.status).toBe('confirmed');

    const recall = await client.callTool({
      name: 'recall_requirement',
      arguments: { id: reqJson.requirementId },
    });
    expect(parseJsonContent(recall as never)).toContain('# 需求：feat');
  });

  it('attack: capture_requirement start without chatContext returns isError', async () => {
    const r = await client.callTool({
      name: 'capture_requirement',
      arguments: { action: 'start', name: 'x' },
    }) as { isError?: boolean };
    expect(r.isError).toBe(true);
  });
});

describe('Phase 7 MCP — summarizer', () => {
  it('list_campaigns + summarize_campaign round trip', async () => {
    const init = await client.callTool({
      name: 'init_workflow',
      arguments: { projectPath: '/p', title: 'sum-test', brief: 'b' },
    });
    const initJson = parseJsonContent(init as never) as { campaignId: string };

    const list = await client.callTool({ name: 'list_campaigns', arguments: {} });
    const listJson = parseJsonContent(list as never) as Array<{ id: string }>;
    expect(listJson.some((c) => c.id === initJson.campaignId)).toBe(true);

    const summary = await client.callTool({
      name: 'summarize_campaign',
      arguments: { campaignId: initJson.campaignId },
    });
    const sumJson = parseJsonContent(summary as never) as { why: string; keyDecisions: string[] };
    expect(sumJson.why).toBe('because');
    expect(sumJson.keyDecisions).toEqual(['decision A']);
  });

  it('attack: summarize_campaign without LLM dep returns isError', async () => {
    // Boot a server with no llm dep
    const noLlmServer = createMcpServer({ db });
    const [s, c] = InMemoryTransport.createLinkedPair();
    const newClient = new Client({ name: 't', version: '0.0.0' });
    await Promise.all([noLlmServer.connect(s), newClient.connect(c)]);
    try {
      const r = await newClient.callTool({
        name: 'summarize_campaign',
        arguments: { campaignId: 'whatever' },
      }) as { isError?: boolean };
      expect(r.isError).toBe(true);
    } finally {
      await newClient.close();
      await noLlmServer.close();
    }
  });
});
