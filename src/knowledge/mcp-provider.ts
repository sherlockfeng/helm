/**
 * McpStdioProvider — a fully config-driven KnowledgeProvider that
 * bridges to ANY MCP stdio server.
 *
 * The user pastes a launch command + env vars into Settings (e.g. an
 * internal knowledge platform's npm package) and helm queries it via
 * one MCP tool call per search. No vendor specifics live in this repo —
 * they're all data in `~/.helm/config.json`:
 *
 *   { id: 'my-kb', enabled: true, kind: 'mcp-stdio',
 *     config: { command: 'npx', args: ['-y', '@org/kb-mcp'],
 *               env: { KB_SPACE_ID: '…' } } }
 *
 * helm is normally an MCP *server* — this is the one place it acts as
 * an MCP *client*, so the subprocess lifecycle lives entirely here:
 *
 *   - lazy connect on first search/healthcheck (no child at boot)
 *   - one connection reused across queries; reconnect on next call after
 *     a transport error
 *   - dispose() tears the child down (orchestrator calls it when the
 *     provider set is hot-reloaded)
 *
 * Failure modes never throw at the provider boundary: search() returns []
 * and healthcheck() reports unhealthy with a reason. The aggregator
 * (query_knowledge) additionally isolates per-provider timeouts.
 */

import type {
  KnowledgeContext,
  KnowledgeProvider,
  KnowledgeProviderHealth,
  KnowledgeSnippet,
} from './types.js';

/** Minimal slice of the MCP client the provider needs — test seam. */
export interface McpBridgeConnection {
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  callTool(input: { name: string; arguments: Record<string, unknown> }): Promise<{
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  }>;
  close(): Promise<void>;
}

export interface McpStdioProviderOptions {
  /** Provider id shown in diagnostics + used in `providers` filters. */
  id: string;
  displayName?: string;
  /** Launcher, e.g. command='npx' args=['-y', '@org/kb-mcp']. */
  command: string;
  args?: readonly string[];
  /** Extra env merged over process.env when spawning the server. */
  env?: Record<string, string>;
  /**
   * Tool to invoke. When omitted, the provider prefers a listed tool
   * whose name equals the provider id, then one containing 'search',
   * else the server's first tool. Pin it here when the server exposes
   * several.
   */
  toolName?: string;
  /** Name of the tool's query argument. Default 'userQuery'. */
  queryParam?: string;
  /** Per-query timeout. Default 15 s — RAG backends are not instant. */
  requestTimeoutMs?: number;
  /** Optional logger sink. Defaults to no-op. */
  onWarning?: (msg: string, ctx: Record<string, unknown>) => void;
  /** Test seam: replaces the real stdio MCP client factory. */
  connectFactory?: () => Promise<McpBridgeConnection>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_QUERY_PARAM = 'userQuery';

export class McpStdioProvider implements KnowledgeProvider {
  readonly id: string;
  readonly displayName: string;

  private readonly opts: McpStdioProviderOptions;
  private readonly requestTimeoutMs: number;
  private readonly queryParam: string;
  private readonly onWarning: (msg: string, ctx: Record<string, unknown>) => void;

  private connection: McpBridgeConnection | null = null;
  private connecting: Promise<McpBridgeConnection> | null = null;
  private resolvedToolName: string | null = null;

  constructor(options: McpStdioProviderOptions) {
    if (!options.id || !options.command) {
      throw new Error('McpStdioProvider requires id + command');
    }
    this.opts = options;
    this.id = options.id;
    this.displayName = options.displayName ?? options.id;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.queryParam = options.queryParam ?? DEFAULT_QUERY_PARAM;
    this.onWarning = options.onWarning ?? (() => {});
  }

  /**
   * External knowledge bases are org-wide — not scoped to a cwd or
   * repo — so a configured bridge handles any session.
   */
  canHandle(_ctx: KnowledgeContext): boolean {
    return true;
  }

  /** No per-session ambient context; the bridge is query-driven only. */
  async getSessionContext(_ctx: KnowledgeContext): Promise<string | null> {
    return null;
  }

  async search(query: string, _ctx?: KnowledgeContext): Promise<KnowledgeSnippet[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    try {
      const result = await this.withTimeout((async () => {
        const conn = await this.ensureConnected();
        const toolName = await this.resolveToolName(conn);
        return conn.callTool({ name: toolName, arguments: { [this.queryParam]: trimmed } });
      })(), this.requestTimeoutMs);
      if (result.isError) {
        this.onWarning('mcp_provider_tool_error', { id: this.id, query: trimmed });
        return [];
      }
      const text = (result.content ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('\n')
        .trim();
      if (!text) return [];
      return [{
        source: this.id,
        title: `${this.displayName} 检索结果`,
        body: text,
      }];
    } catch (err) {
      this.onWarning('mcp_provider_search_failed', { id: this.id, message: (err as Error).message });
      // Drop the connection so the next call reconnects — transport
      // errors (dead child, broken pipe) are not self-healing.
      await this.dispose().catch(() => {});
      return [];
    }
  }

  async healthcheck(): Promise<KnowledgeProviderHealth> {
    try {
      const conn = await this.withTimeout(this.ensureConnected(), this.requestTimeoutMs);
      const toolName = await this.resolveToolName(conn);
      return { ok: true, reason: `connected; tool=${toolName}` };
    } catch (err) {
      await this.dispose().catch(() => {});
      return { ok: false, reason: (err as Error).message };
    }
  }

  /** Tear down the child process / transport. Safe to call repeatedly. */
  async dispose(): Promise<void> {
    const conn = this.connection;
    this.connection = null;
    this.connecting = null;
    this.resolvedToolName = null;
    if (conn) await conn.close().catch(() => {});
  }

  private ensureConnected(): Promise<McpBridgeConnection> {
    if (this.connection) return Promise.resolve(this.connection);
    if (this.connecting) return this.connecting;
    const factory = this.opts.connectFactory ?? (() => this.connectStdio());
    this.connecting = factory()
      .then((conn) => {
        this.connection = conn;
        this.connecting = null;
        return conn;
      })
      .catch((err) => {
        this.connecting = null;
        throw err;
      });
    return this.connecting;
  }

  private async resolveToolName(conn: McpBridgeConnection): Promise<string> {
    if (this.opts.toolName) return this.opts.toolName;
    if (this.resolvedToolName) return this.resolvedToolName;
    const { tools } = await conn.listTools();
    if (tools.length === 0) throw new Error(`MCP server for '${this.id}' exposes no tools`);
    const pick = tools.find((t) => t.name === this.id)
      ?? tools.find((t) => /search/i.test(t.name))
      ?? tools[0]!;
    this.resolvedToolName = pick.name;
    return pick.name;
  }

  /** Real path: spawn the MCP server over stdio via the SDK client. */
  private async connectStdio(): Promise<McpBridgeConnection> {
    // Dynamic imports keep the SDK's client half out of the boot path —
    // it's only loaded when an mcp-stdio provider is actually configured.
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({
      command: this.opts.command,
      args: [...(this.opts.args ?? [])],
      env: {
        ...process.env as Record<string, string>,
        ...(this.opts.env ?? {}),
      },
      stderr: 'ignore',
    });
    const client = new Client({ name: 'helm-mcp-bridge', version: '0.1.0' });
    await client.connect(transport);
    return {
      listTools: () => client.listTools() as Promise<{ tools: Array<{ name: string }> }>,
      callTool: (input) => client.callTool(input) as Promise<{
        content?: Array<{ type: string; text?: string }>; isError?: boolean;
      }>,
      close: () => client.close(),
    };
  }

  private async withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`mcp request timed out after ${ms}ms`)), ms);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
