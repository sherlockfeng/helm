/**
 * TikaProvider — KnowledgeProvider over TikTok's internal Tika knowledge
 * platform, reached through its official MCP stdio server
 * (`npx @tiktok-mcp/tika`).
 *
 * Why MCP-local instead of Tika's OpenAPI: the OpenAPI route needs a
 * ByteCloud JWT + a create-conversation handshake per query; the npm
 * package only needs the space credentials as env vars and speaks a
 * single tool call per query. helm is normally an MCP *server* — this is
 * the first place it acts as an MCP *client*, so the subprocess lifecycle
 * lives entirely inside this module:
 *
 *   - lazy connect on first search/healthcheck (no Tika process at boot)
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
export interface TikaMcpConnection {
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  callTool(input: { name: string; arguments: Record<string, unknown> }): Promise<{
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  }>;
  close(): Promise<void>;
}

export interface TikaProviderOptions {
  /** Tika environment, e.g. 'office'. Becomes TIKA_ENV. */
  tikaEnv: string;
  /** Tenant/space id. Becomes TIKA_SPACE_ID; omitted = Tika public space. */
  spaceId?: string;
  /**
   * Service-account key. Becomes TIKA_SERVICE_KEY. Omitted = personal
   * SSO mode: the Tika MCP server pops a ByteCloud SSO browser
   * authorization on the first tool call.
   */
  serviceKey?: string;
  /** Launcher command. Default `npx @tiktok-mcp/tika`. */
  command?: string;
  args?: readonly string[];
  /**
   * Tool to invoke on the Tika server. When omitted, the provider picks
   * the first listed tool whose name contains 'tika' or 'search',
   * falling back to the first tool. Pin it here if the package renames.
   */
  toolName?: string;
  /** Per-query timeout. Default 15 s — Tika RAG answers are not instant. */
  requestTimeoutMs?: number;
  /** Optional logger sink. Defaults to no-op. */
  onWarning?: (msg: string, ctx: Record<string, unknown>) => void;
  /** Test seam: replaces the real stdio MCP client factory. */
  connectFactory?: () => Promise<TikaMcpConnection>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_COMMAND = 'npx';
const DEFAULT_ARGS = ['-y', '@tiktok-mcp/tika'] as const;

export class TikaProvider implements KnowledgeProvider {
  readonly id = 'tika';
  readonly displayName = 'Tika 知识库';

  private readonly opts: TikaProviderOptions;
  private readonly requestTimeoutMs: number;
  private readonly onWarning: (msg: string, ctx: Record<string, unknown>) => void;

  private connection: TikaMcpConnection | null = null;
  private connecting: Promise<TikaMcpConnection> | null = null;
  private resolvedToolName: string | null = null;

  constructor(options: TikaProviderOptions) {
    this.opts = options;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.onWarning = options.onWarning ?? (() => {});
  }

  /**
   * Tika is org-wide knowledge — not scoped to a cwd or repo — so any
   * configured instance can handle any session.
   */
  canHandle(_ctx: KnowledgeContext): boolean {
    return true;
  }

  /** No per-session ambient context; Tika is query-driven only. */
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
        return conn.callTool({ name: toolName, arguments: { userQuery: trimmed } });
      })(), this.requestTimeoutMs);
      if (result.isError) {
        this.onWarning('tika_tool_error', { query: trimmed });
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
        title: 'Tika 知识库检索结果',
        body: text,
      }];
    } catch (err) {
      this.onWarning('tika_search_failed', { message: (err as Error).message });
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

  private ensureConnected(): Promise<TikaMcpConnection> {
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

  private async resolveToolName(conn: TikaMcpConnection): Promise<string> {
    if (this.opts.toolName) return this.opts.toolName;
    if (this.resolvedToolName) return this.resolvedToolName;
    const { tools } = await conn.listTools();
    if (tools.length === 0) throw new Error('Tika MCP server exposes no tools');
    const pick = tools.find((t) => /tika/i.test(t.name))
      ?? tools.find((t) => /search/i.test(t.name))
      ?? tools[0]!;
    this.resolvedToolName = pick.name;
    return pick.name;
  }

  /** Real path: spawn the Tika MCP server over stdio via the SDK client. */
  private async connectStdio(): Promise<TikaMcpConnection> {
    // Dynamic imports keep the SDK's client half out of the boot path —
    // it's only loaded when a Tika provider is actually configured.
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({
      command: this.opts.command ?? DEFAULT_COMMAND,
      args: [...(this.opts.args ?? DEFAULT_ARGS)],
      env: {
        ...process.env as Record<string, string>,
        TIKA_ENV: this.opts.tikaEnv,
        ...(this.opts.spaceId ? { TIKA_SPACE_ID: this.opts.spaceId } : {}),
        ...(this.opts.serviceKey ? { TIKA_SERVICE_KEY: this.opts.serviceKey } : {}),
      },
      stderr: 'ignore',
    });
    const client = new Client({ name: 'helm-tika-bridge', version: '0.1.0' });
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
          timer = setTimeout(() => reject(new Error(`tika request timed out after ${ms}ms`)), ms);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
