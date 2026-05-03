/**
 * Helm MCP server.
 *
 * Builds an `McpServer` registered with the helm-specific tools. Phase 6 ships
 * the four new tools (PROJECT_BLUEPRINT.md §13.2):
 *   - get_active_chats
 *   - bind_to_remote_channel
 *   - query_knowledge
 *   - list_knowledge_providers
 *
 * The legacy relay tools (init_workflow, create_tasks, ...) land in Phase 7
 * once the workflow / roles / requirements engines have been ported. The
 * registration pattern stays the same so that addition is a drop-in.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import * as z from 'zod';
import type Database from 'better-sqlite3';
import { getActiveChats } from './tools/get-active-chats.js';
import { bindToRemoteChannel } from './tools/bind-to-remote-channel.js';
import { listKnowledgeProviders } from './tools/list-knowledge-providers.js';
import { queryKnowledge } from './tools/query-knowledge.js';
import { KnowledgeProviderRegistry } from '../knowledge/types.js';

export interface McpServerDeps {
  db: Database.Database;
  knowledge?: KnowledgeProviderRegistry;
}

export interface McpServerInfo {
  name: string;
  version: string;
}

const DEFAULT_SERVER_INFO: McpServerInfo = { name: 'helm', version: '0.1.0' };

/** JSON helper — every tool handler returns CallToolResult-compatible content. */
function jsonResult(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

export function createMcpServer(
  deps: McpServerDeps,
  info: McpServerInfo = DEFAULT_SERVER_INFO,
): McpServer {
  const server = new McpServer(info);
  const knowledge = deps.knowledge ?? new KnowledgeProviderRegistry();

  // ── get_active_chats ────────────────────────────────────────────────────

  server.registerTool('get_active_chats', {
    description: 'List all currently-active Cursor chats so the agent can discover sibling sessions.',
    inputSchema: {},
  }, async () => jsonResult(getActiveChats(deps.db)));

  // ── bind_to_remote_channel ──────────────────────────────────────────────

  server.registerTool('bind_to_remote_channel', {
    description:
      'Bind a host session to a remote channel thread. Provide externalThread+externalChat to bind immediately, '
      + 'or omit them to receive a pendingCode the user types into the channel.',
    inputSchema: {
      hostSessionId: z.string().describe('Host session id to bind (e.g. Cursor chat session id).'),
      channel: z.string().describe('Channel id, e.g. "lark" or "local".'),
      externalChat: z.string().optional().describe('Channel-side chat / room id.'),
      externalThread: z.string().optional().describe('Channel-side thread id (Lark message id om_*/omt_*).'),
      externalRoot: z.string().optional().describe('Optional root message id for threading.'),
    },
  }, async (input) => jsonResult(bindToRemoteChannel(deps.db, input)));

  // ── list_knowledge_providers ────────────────────────────────────────────

  server.registerTool('list_knowledge_providers', {
    description: 'List all KnowledgeProviders the agent can query, with their current healthcheck status.',
    inputSchema: {},
  }, async () => jsonResult(await listKnowledgeProviders(knowledge)));

  // ── query_knowledge ─────────────────────────────────────────────────────

  server.registerTool('query_knowledge', {
    description:
      'Search registered KnowledgeProviders. Aggregates and ranks snippets by score. '
      + 'When hostSessionId+cwd are provided, providers can use canHandle to scope themselves.',
    inputSchema: {
      query: z.string().describe('Free-text query.'),
      hostSessionId: z.string().optional(),
      cwd: z.string().optional(),
      filePath: z.string().optional(),
      providers: z.array(z.string()).optional().describe('Limit to a subset of provider ids.'),
    },
  }, async (input) => jsonResult(await queryKnowledge(knowledge, input)));

  return server;
}

/**
 * Connect the MCP server over stdio. Used by `bin/helm-mcp` (Phase 8) when
 * Cursor spawns the MCP subprocess. Tests use InMemoryTransport instead.
 */
export async function startMcpServer(
  deps: McpServerDeps,
  transport: Transport = new StdioServerTransport(),
  info: McpServerInfo = DEFAULT_SERVER_INFO,
): Promise<{ server: McpServer; transport: Transport }> {
  const server = createMcpServer(deps, info);
  await server.connect(transport);
  return { server, transport };
}
