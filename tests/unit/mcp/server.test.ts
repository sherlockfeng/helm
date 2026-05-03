import BetterSqlite3 from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { upsertHostSession } from '../../../src/storage/repos/host-sessions.js';
import { KnowledgeProviderRegistry } from '../../../src/knowledge/types.js';
import { createMcpServer } from '../../../src/mcp/server.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

let db: BetterSqlite3.Database;
let server: McpServer;
let client: Client;

async function bootServer(knowledge?: KnowledgeProviderRegistry): Promise<void> {
  server = createMcpServer({ db, knowledge });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
}

beforeEach(() => {
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(async () => {
  await client?.close();
  await server?.close();
  db.close();
});

function parseJsonContent(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const block = result.content.find((b) => b.type === 'text');
  if (!block?.text) throw new Error('expected text content');
  return JSON.parse(block.text);
}

describe('MCP server — tool registration', () => {
  it('lists every helm + phase-7 tool', async () => {
    await bootServer();
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    // Phase 6: helm-specific (4)
    expect(names).toContain('bind_to_remote_channel');
    expect(names).toContain('get_active_chats');
    expect(names).toContain('list_knowledge_providers');
    expect(names).toContain('query_knowledge');
    // Phase 7: workflow (8)
    expect(names).toContain('init_workflow');
    expect(names).toContain('get_cycle_state');
    expect(names).toContain('create_tasks');
    expect(names).toContain('get_my_tasks');
    expect(names).toContain('complete_task');
    expect(names).toContain('add_task_comment');
    expect(names).toContain('create_bug_tasks');
    expect(names).toContain('add_product_feedback');
    expect(names).toContain('complete_cycle');
    // Phase 7: doc-first
    expect(names).toContain('update_doc_first');
    // Phase 7: roles (4)
    expect(names).toContain('list_roles');
    expect(names).toContain('get_role');
    expect(names).toContain('train_role');
    expect(names).toContain('search_knowledge');
    // Phase 7: requirements (2)
    expect(names).toContain('capture_requirement');
    expect(names).toContain('recall_requirement');
    // Phase 7: summarizer (2)
    expect(names).toContain('list_campaigns');
    expect(names).toContain('summarize_campaign');
  });
});

describe('MCP server — get_active_chats round trip', () => {
  it('returns the registered active sessions', async () => {
    const now = new Date().toISOString();
    upsertHostSession(db, { id: 's1', host: 'cursor', cwd: '/proj', status: 'active', firstSeenAt: now, lastSeenAt: now });
    await bootServer();

    const result = await client.callTool({ name: 'get_active_chats', arguments: {} });
    const json = parseJsonContent(result as { content: Array<{ type: string; text?: string }> }) as { chats: Array<{ hostSessionId: string }> };
    expect(json.chats).toHaveLength(1);
    expect(json.chats[0]?.hostSessionId).toBe('s1');
  });
});

describe('MCP server — bind_to_remote_channel round trip', () => {
  it('immediate bind when externalChat + externalThread are provided', async () => {
    const now = new Date().toISOString();
    upsertHostSession(db, { id: 's1', host: 'cursor', status: 'active', firstSeenAt: now, lastSeenAt: now });
    await bootServer();

    const result = await client.callTool({
      name: 'bind_to_remote_channel',
      arguments: { hostSessionId: 's1', channel: 'lark', externalChat: 'c1', externalThread: 't1' },
    });
    const json = parseJsonContent(result as { content: Array<{ type: string; text?: string }> }) as { kind: string; bindingId?: string };
    expect(json.kind).toBe('bound');
    expect(json.bindingId).toMatch(/^bnd_/);
  });

  it('pending mode when no thread provided', async () => {
    const now = new Date().toISOString();
    upsertHostSession(db, { id: 's1', host: 'cursor', status: 'active', firstSeenAt: now, lastSeenAt: now });
    await bootServer();

    const result = await client.callTool({
      name: 'bind_to_remote_channel',
      arguments: { hostSessionId: 's1', channel: 'lark' },
    });
    const json = parseJsonContent(result as { content: Array<{ type: string; text?: string }> }) as { kind: string; pendingCode?: string };
    expect(json.kind).toBe('pending');
    expect(json.pendingCode).toMatch(/^[0-9A-F]{6}$/);
  });

  it('attack: unknown hostSessionId surfaces as a tool error', async () => {
    await bootServer();
    const result = await client.callTool({
      name: 'bind_to_remote_channel',
      arguments: { hostSessionId: 'ghost', channel: 'lark' },
    }) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain('unknown host_session_id');
  });
});

describe('MCP server — knowledge tools round trip', () => {
  it('list_knowledge_providers returns empty when registry is empty', async () => {
    await bootServer();
    const result = await client.callTool({ name: 'list_knowledge_providers', arguments: {} });
    const json = parseJsonContent(result as { content: Array<{ type: string; text?: string }> }) as { providers: unknown[] };
    expect(json.providers).toEqual([]);
  });

  it('query_knowledge returns empty snippets when registry is empty', async () => {
    await bootServer();
    const result = await client.callTool({ name: 'query_knowledge', arguments: { query: 'hello' } });
    const json = parseJsonContent(result as { content: Array<{ type: string; text?: string }> }) as { snippets: unknown[]; diagnostics: unknown[] };
    expect(json.snippets).toEqual([]);
    expect(json.diagnostics).toEqual([]);
  });

  it('query_knowledge surfaces snippets from a registered provider', async () => {
    const reg = new KnowledgeProviderRegistry();
    reg.register({
      id: 'fake',
      displayName: 'Fake',
      canHandle: () => true,
      getSessionContext: async () => null,
      search: async () => [{ source: 'fake', title: 't', body: 'b', score: 0.9 }],
      healthcheck: async () => ({ ok: true }),
    });
    await bootServer(reg);

    const result = await client.callTool({ name: 'query_knowledge', arguments: { query: 'hi' } });
    const json = parseJsonContent(result as { content: Array<{ type: string; text?: string }> }) as { snippets: Array<{ source: string }> };
    expect(json.snippets[0]?.source).toBe('fake');
  });
});
