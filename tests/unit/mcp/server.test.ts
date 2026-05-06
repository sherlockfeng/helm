import BetterSqlite3 from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { upsertHostSession } from '../../../src/storage/repos/host-sessions.js';
import { KnowledgeProviderRegistry } from '../../../src/knowledge/types.js';
import { createMcpServer } from '../../../src/mcp/server.js';
import { CursorAgentSpawner } from '../../../src/spawner/cursor-spawner.js';
import type { Run, SDKAgent } from '@cursor/sdk';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

let db: BetterSqlite3.Database;
let server: McpServer;
let client: Client;

async function bootServer(
  knowledge?: KnowledgeProviderRegistry,
  extra?: { spawner?: CursorAgentSpawner },
): Promise<void> {
  server = createMcpServer({ db, knowledge, spawner: extra?.spawner });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
}

function makeFakeAgent(opts: { agentId?: string; send?: SDKAgent['send'] } = {}): SDKAgent {
  const agentId = opts.agentId ?? 'agent_test';
  return {
    agentId,
    model: { id: 'auto' },
    send: opts.send ?? (async (): Promise<Run> => ({ id: 'run_test' } as unknown as Run)),
    close: () => undefined,
    reload: async () => undefined,
    [Symbol.asyncDispose]: async () => undefined,
    listArtifacts: async () => [],
    downloadArtifact: async () => Buffer.from(''),
  } as SDKAgent;
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
    // Phase 26: spawner
    expect(names).toContain('start_relay_chat_session');
  });
});

describe('MCP server — start_relay_chat_session (Phase 26)', () => {
  it('errors out actionably when no spawner is wired', async () => {
    await bootServer();
    const result = await client.callTool({
      name: 'start_relay_chat_session',
      arguments: { projectPath: '/proj' },
    }) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    const text = result.content[0]!.text;
    expect(text).toMatch(/CURSOR_API_KEY|Cursor app/);
  });

  it('returns the agentId when a spawner is wired', async () => {
    const seenOptions: Record<string, unknown>[] = [];
    const spawner = new CursorAgentSpawner({
      agentFactory: async (opts) => {
        seenOptions.push(opts as Record<string, unknown>);
        return makeFakeAgent({ agentId: 'agent_spawned_1' });
      },
    });
    await bootServer(undefined, { spawner });

    const result = await client.callTool({
      name: 'start_relay_chat_session',
      arguments: { projectPath: '/proj', name: 'dev-runner' },
    }) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    const body = parseJsonContent(result) as { agentId: string; modelId: string; projectPath: string };
    expect(body.agentId).toBe('agent_spawned_1');
    expect(body.projectPath).toBe('/proj');
    const opts = seenOptions[0] as { local?: { cwd?: string }; name?: string };
    expect(opts.local?.cwd).toBe('/proj');
    expect(opts.name).toBe('dev-runner');
  });

  it('passes prompt through to agent.send and surfaces the run id', async () => {
    const sentMessages: string[] = [];
    const spawner = new CursorAgentSpawner({
      agentFactory: async () => makeFakeAgent({
        send: async (msg) => {
          sentMessages.push(typeof msg === 'string' ? msg : msg.text);
          return { id: 'run_initial_99' } as unknown as Run;
        },
      }),
    });
    await bootServer(undefined, { spawner });

    const result = await client.callTool({
      name: 'start_relay_chat_session',
      arguments: { projectPath: '/proj', prompt: 'kick off cycle 3' },
    }) as { content: Array<{ type: string; text: string }> };
    const body = parseJsonContent(result) as { initialRunId?: string };
    expect(body.initialRunId).toBe('run_initial_99');
    expect(sentMessages).toEqual(['kick off cycle 3']);
  });

  it('attack: surfaces the spawn error as an actionable tool error, not a crash', async () => {
    const spawner = new CursorAgentSpawner({
      agentFactory: async () => { throw new Error('cursor not signed in'); },
    });
    await bootServer(undefined, { spawner });

    const result = await client.callTool({
      name: 'start_relay_chat_session',
      arguments: { projectPath: '/proj' },
    }) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/cursor not signed in/);
  });

  it('attack: empty projectPath bubbles up as tool error', async () => {
    const spawner = new CursorAgentSpawner({
      agentFactory: async () => makeFakeAgent(),
    });
    await bootServer(undefined, { spawner });
    const result = await client.callTool({
      name: 'start_relay_chat_session',
      arguments: { projectPath: '' },
    }) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/projectPath/);
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
