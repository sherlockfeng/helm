/**
 * MCP HTTP/SSE transport mounted on the helm HTTP API (Phase 45).
 *
 * Replaces the stdio MCP entry point (`src/mcp/stdio.js`) for clients that
 * support URL-based MCP servers (Cursor 0.45+, Claude Desktop, etc.). Why:
 *
 *   - **One process owns the DB.** The Electron main process (NODE_MODULE_VERSION
 *     130) already has `better-sqlite3` open. Cursor spawning a Node child
 *     against the stdio entry hits the wrong ABI (Node 127) → silent crash.
 *   - **No subprocess lifecycle.** Cursor doesn't have to exec helm; it just
 *     opens an HTTP connection to the helm server already running on
 *     127.0.0.1:17317. Restart helm → Cursor reconnects.
 *
 * Wire format follows the MCP SSE spec:
 *
 *   GET  /mcp/sse                  — opens an SSE stream. Server emits an
 *                                    `endpoint` event carrying the relative
 *                                    URL the client should POST to (with the
 *                                    new sessionId).
 *   POST /mcp/messages?sessionId=X — client → server JSON-RPC. Server routes
 *                                    by sessionId to the right transport.
 *
 * One transport (and one McpServer instance built via the injected factory)
 * per SSE connection. Cursor opens exactly one SSE connection per IDE
 * instance, so the map is small and short-lived.
 */

import http from 'node:http';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from '../logger/index.js';

/** Path the helm HTTP server uses for the SSE stream. */
export const MCP_SSE_PATH = '/mcp/sse';
/** Path the helm HTTP server uses for client→server JSON-RPC POSTs. */
export const MCP_MESSAGES_PATH = '/mcp/messages';

export interface McpHttpSseDeps {
  /**
   * Build a fresh McpServer for each new SSE connection. The factory should
   * close over the orchestrator's shared deps (db, knowledge registry,
   * spawner, ...) and call `createMcpServer({...}, info)` internally.
   *
   * One server per session keeps things simple — the helm tools are stateless
   * (they read the live DB) but per-connection servers avoid concerns about
   * the SDK's transport multiplexing semantics.
   */
  factory: () => McpServer;
  /** Optional logger for connection lifecycle + errors. */
  logger?: Logger;
}

interface ActiveSession {
  transport: SSEServerTransport;
  server: McpServer;
}

/**
 * In-process registry of live SSE sessions. Exposed as a class so the HTTP
 * server can both route POSTs (by sessionId) and close everything cleanly on
 * shutdown.
 */
export class McpHttpSseHub {
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly deps: McpHttpSseDeps;
  private closed = false;

  constructor(deps: McpHttpSseDeps) {
    this.deps = deps;
  }

  /**
   * Handle a `GET /mcp/sse` request. Opens an SSE stream, attaches a fresh
   * McpServer to a new SSEServerTransport, and stores the pair keyed by the
   * generated sessionId. Returns synchronously after wiring; the SDK keeps
   * the response open for the lifetime of the connection.
   */
  async handleSse(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (this.closed) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'shutting_down' }));
      return;
    }

    // SSEServerTransport writes its own SSE headers + the `endpoint` event
    // pointing the client at MCP_MESSAGES_PATH (with sessionId). We pass the
    // path as a relative URL so it works for both http://127.0.0.1:17317 and
    // any future reverse proxy.
    const transport = new SSEServerTransport(MCP_MESSAGES_PATH, res);
    const server = this.deps.factory();

    // Guard against the close-cascade: McpServer.close() closes its
    // transport, transport.close() fires onclose, and our onclose used to
    // call server.close() again — infinite recursion. Latch this once so
    // either path (transport-first or server-first) cleans up at most once.
    let closing = false;
    transport.onclose = () => {
      if (closing) return;
      closing = true;
      const sid = transport.sessionId;
      const had = this.sessions.delete(sid);
      if (had) {
        this.deps.logger?.info('mcp_sse_session_closed', { data: { sessionId: sid } });
      }
      // Drop our reference to the server so its tool closures can be GC'd.
      void server.close().catch(() => {/* ignored — connection already gone */});
    };
    transport.onerror = (err) => {
      this.deps.logger?.warn('mcp_sse_transport_error', {
        data: { error: err.message, sessionId: transport.sessionId },
      });
    };

    try {
      // server.connect() awaits transport.start() which writes the initial
      // SSE headers + endpoint event. After this resolves, the client knows
      // where to POST.
      await server.connect(transport);
    } catch (err) {
      this.deps.logger?.warn('mcp_sse_connect_failed', {
        data: { error: (err as Error).message },
      });
      // transport.start() already wrote headers; tearing the response down
      // is the SDK's job here. We just bail out.
      return;
    }

    this.sessions.set(transport.sessionId, { transport, server });
    this.deps.logger?.info('mcp_sse_session_opened', { data: { sessionId: transport.sessionId } });

    // When the underlying socket dies (Cursor restart, network drop), the
    // SDK fires onclose via its own listeners — but belt-and-suspenders,
    // also clean up on req close in case the SDK ever changes.
    req.on('close', () => {
      if (this.sessions.has(transport.sessionId)) {
        void transport.close().catch(() => {/* ignored */});
      }
    });
  }

  /**
   * Handle a `POST /mcp/messages?sessionId=X` request. Looks up the
   * transport by sessionId and forwards the request to its handlePostMessage.
   * The SDK consumes the request stream itself, so the helm router must NOT
   * pre-read the body.
   */
  async handleMessage(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    sessionId: string | null,
  ): Promise<void> {
    if (!sessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing_session_id' }));
      return;
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown_session', sessionId }));
      return;
    }
    try {
      await session.transport.handlePostMessage(req, res);
    } catch (err) {
      this.deps.logger?.warn('mcp_sse_post_failed', {
        data: { error: (err as Error).message, sessionId },
      });
      // handlePostMessage normally writes the response itself. If it threw
      // before that, attempt a 500.
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal' }));
      }
    }
  }

  /** Close all open SSE sessions (called on httpApi.stop()). */
  async closeAll(): Promise<void> {
    this.closed = true;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((s) => s.transport.close()));
  }

  /** Test helper: live session count. */
  size(): number {
    return this.sessions.size;
  }
}
