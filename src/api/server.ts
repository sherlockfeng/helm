/**
 * Helm HTTP API.
 *
 * Bound to 127.0.0.1 only (per §19 — never exposed). REST endpoints for the
 * renderer and any future PWA, plus a Server-Sent Events stream so the UI
 * gets push updates (new pending approvals, settle, sessions) without
 * polling.
 *
 * Endpoints:
 *
 *   GET  /api/health                       — { ok, version }
 *   GET  /api/active-chats                 — host_sessions where status=active
 *   GET  /api/approvals                    — pending approvals
 *   POST /api/approvals/:id/decide         — body { decision, reason? } → settle
 *   GET  /api/campaigns                    — listCampaigns
 *   GET  /api/campaigns/:id/cycles         — listCycles for a campaign
 *   GET  /api/events                       — SSE stream of AppEvent
 *
 * Plain node:http with a tiny router. No framework dep on purpose —
 * the surface is small and the renderer talks to it via fetch / EventSource.
 */

import http from 'node:http';
import type Database from 'better-sqlite3';
import {
  addHostSessionRole,
  deleteHostSession,
  getHostSession,
  listActiveSessions,
  removeHostSessionRole,
  setHostSessionDisplayName,
  setHostSessionRole,
  updateHostSession,
} from '../storage/repos/host-sessions.js';
import {
  getCampaign,
  getCycle,
  getTask,
  listCampaigns,
  listCycles,
  listTasks,
} from '../storage/repos/campaigns.js';
import { listDocAuditsByTask } from '../storage/repos/doc-audit.js';
import {
  deleteChannelBinding,
  deletePendingBind,
  getPendingBind,
  listAllChannelBindings,
  listPendingBinds,
} from '../storage/repos/channel-bindings.js';
import {
  getChunksForRole,
  getRole as getRoleRow,
  listRoles as listRolesRepo,
} from '../storage/repos/roles.js';
import { recallRequirements } from '../requirements/recall.js';
import { getRequirement } from '../storage/repos/requirements.js';
import type { ApprovalRegistry } from '../approval/registry.js';
import type { ApprovalPolicyEngine, AddPolicyInput } from '../approval/policy.js';
import { policyInputFromScope } from '../channel/lark/binding-resolver.js';
import type { Logger } from '../logger/index.js';
import type { EventBus } from '../events/bus.js';
import type { HelmConfig } from '../config/schema.js';
import {
  McpHttpSseHub,
  MCP_MESSAGES_PATH,
  MCP_SSE_PATH,
} from '../mcp/http-sse.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface HttpApiDeps {
  db: Database.Database;
  registry: ApprovalRegistry;
  /**
   * Phase 46: optional policy engine. When set, POST /api/approvals/:id/decide
   * accepts an optional `remember: true` field — the API derives a scope from
   * the pending approval (or honors an explicit `scope` string in the body)
   * and inserts an ApprovalPolicy rule before settling. When undefined, the
   * `remember` flag is rejected with 501 so the renderer can hide the checkbox.
   */
  policy?: ApprovalPolicyEngine;
  /** Optional event bus; when set, /api/events streams its emissions over SSE. */
  events?: EventBus;
  /** Optional logger; defaults to no-op. */
  logger?: Logger;
  /** Server name + version for /api/health. */
  appName?: string;
  appVersion?: string;
  /**
   * Optional diagnostics-bundle factory. When set, POST /api/diagnostics
   * invokes it and returns `{ bundleDir, manifest }`. Orchestrator wires
   * this to src/diagnostics/bundle.ts; tests inject fakes.
   */
  createDiagnosticsBundle?: () => { bundleDir: string; manifest: unknown };
  /**
   * GET /api/config returns whatever this getter produces. Orchestrator
   * passes the live HelmConfig; tests pass fakes. When undefined the
   * endpoint returns 501 so the renderer's Settings page knows config
   * editing isn't wired up here.
   */
  getConfig?: () => HelmConfig;
  /**
   * PUT /api/config invokes this with the validated body. Orchestrator
   * wires it to saveHelmConfig — UI changes are persisted to
   * `~/.helm/config.json`. Returning the saved value lets the renderer
   * show the post-save state.
   */
  saveConfig?: (input: unknown) => HelmConfig;
  /** Consume a pending_binds row and create a channel_bindings row. */
  consumePendingBind?: (code: string, hostSessionId: string) => { id: string } | null;
  /**
   * Workflow engine for cycle/task mutations. When undefined, the
   * /api/cycles/:id/complete + /api/cycles/:id/bug-tasks endpoints
   * return 501. The orchestrator wires this so a config docFirst.enforce
   * change takes effect on the next call without a server restart.
   */
  workflowEngine?: import('../workflow/engine.js').WorkflowEngine;
  /**
   * Summarize a campaign with the configured LLM (B2). When undefined
   * (no API key in config / env), POST /api/campaigns/:id/summarize
   * returns 501 so the UI can prompt the user to set the key in Settings.
   */
  summarizeCampaign?: (campaignId: string) => Promise<unknown>;
  /**
   * Train (or re-train) a role from documents (B3). When undefined, the
   * Roles page's POST /api/roles/:id/train endpoint returns 501. Tests
   * inject a stub; the orchestrator wires it via the same embedFn used
   * by LocalRolesProvider.
   */
  trainRole?: (input: {
    roleId: string;
    name: string;
    documents: Array<{ filename: string; content: string }>;
    baseSystemPrompt?: string;
  }) => Promise<unknown>;
  /**
   * Phase 45: factory for the MCP HTTP/SSE transport. When set, the server
   * exposes:
   *   GET  /mcp/sse                    — opens an SSE stream
   *   POST /mcp/messages?sessionId=X   — client→server JSON-RPC
   * Each new SSE connection invokes `mcpFactory()` once to build a fresh
   * McpServer. Cursor / Claude Desktop point their `mcp.json` at the URL
   * form and skip the stdio entry entirely. When undefined, both endpoints
   * return 501.
   */
  mcpFactory?: () => McpServer;
  /**
   * Phase 57: factory for the conversational role-trainer LLM client. Built
   * lazily so a Settings save updates the next call without restart. Returns
   * `null` when no provider is configured (no anthropic.apiKey AND no
   * Cursor); handlers surface a 501 with an actionable message.
   */
  llmChatFactory?: () => import('../llm/chat.js').LlmChatClient | null;
}

export interface HttpApiOptions {
  /** 127.0.0.1 by default. */
  host?: string;
  /** Random ephemeral port when 0 (default for tests). */
  port?: number;
}

export interface HttpApiHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** The actual port the server bound to (resolved after start). */
  port(): number | null;
}

interface RouteContext {
  url: URL;
  request: http.IncomingMessage;
  response: http.ServerResponse;
  body: string;
}

async function readBody(req: http.IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function notFound(res: http.ServerResponse): void {
  send(res, 404, { error: 'not_found' });
}

function methodNotAllowed(res: http.ServerResponse): void {
  send(res, 405, { error: 'method_not_allowed' });
}

function badRequest(res: http.ServerResponse, message: string): void {
  send(res, 400, { error: 'bad_request', message });
}

function internalError(res: http.ServerResponse, err: unknown): void {
  send(res, 500, { error: 'internal', message: (err as Error).message });
}

export function createHttpApi(deps: HttpApiDeps, options: HttpApiOptions = {}): HttpApiHandle {
  const host = options.host ?? '127.0.0.1';
  const desiredPort = options.port ?? 0;
  const appName = deps.appName ?? 'helm';
  const appVersion = deps.appVersion ?? '0.1.0';

  // Track open SSE clients so we can close them gracefully on stop().
  const sseClients = new Set<http.ServerResponse>();
  let unsubscribeFromBus: (() => void) | undefined;

  // Phase 45: MCP HTTP/SSE transport. Hub is created up-front (cheap — just
  // an empty Map) so route handlers can dispatch even when no factory was
  // supplied; without one, the routes 501.
  const mcpHub = deps.mcpFactory
    ? new McpHttpSseHub({ factory: deps.mcpFactory, ...(deps.logger ? { logger: deps.logger } : {}) })
    : null;

  if (deps.events) {
    unsubscribeFromBus = deps.events.on((event) => {
      const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
      for (const client of sseClients) {
        try {
          if (!client.writableEnded) client.write(payload);
        } catch (err) {
          deps.logger?.warn('sse_write_failed', { data: { error: (err as Error).message } });
        }
      }
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      // SSE endpoint is special-cased before body read because it streams.
      if (url.pathname === '/api/events') {
        if (req.method !== 'GET') return methodNotAllowed(res);
        return handleEvents(req, res, sseClients);
      }

      // Phase 45: MCP HTTP/SSE — also pre-body because /mcp/sse streams and
      // /mcp/messages lets the SDK consume the request stream itself.
      if (url.pathname === MCP_SSE_PATH) {
        if (req.method !== 'GET') return methodNotAllowed(res);
        if (!mcpHub) return send(res, 501, { error: 'not_implemented', message: 'mcp factory not wired' });
        return mcpHub.handleSse(req, res);
      }
      if (url.pathname === MCP_MESSAGES_PATH) {
        if (req.method !== 'POST') return methodNotAllowed(res);
        if (!mcpHub) return send(res, 501, { error: 'not_implemented', message: 'mcp factory not wired' });
        return mcpHub.handleMessage(req, res, url.searchParams.get('sessionId'));
      }

      const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : '';
      const ctx: RouteContext = { url, request: req, response: res, body };

      if (url.pathname === '/api/health') {
        if (req.method !== 'GET') return methodNotAllowed(res);
        return send(res, 200, { ok: true, name: appName, version: appVersion });
      }

      if (url.pathname === '/api/active-chats') {
        if (req.method !== 'GET') return methodNotAllowed(res);
        const sessions = listActiveSessions(deps.db);
        return send(res, 200, { chats: sessions });
      }

      // Phase 25: bind / unbind a chat to a single role (legacy single-select
      // path). Phase 42 turned this into a "replace whole role list with one
      // role" semantic on top of host_session_roles.
      const chatRoleMatch = url.pathname.match(/^\/api\/active-chats\/([^/]+)\/role$/);
      if (chatRoleMatch) {
        if (req.method !== 'PUT') return methodNotAllowed(res);
        return handleSetChatRole(ctx, deps, chatRoleMatch[1]!);
      }

      // Phase 42: multi-role per chat. Add/remove individual roles to build a
      // stack (e.g. Goofy + 容灾大盘 on one chat).
      //
      //   POST   /api/active-chats/:id/roles         { roleId }   → idempotent add
      //   DELETE /api/active-chats/:id/roles/:roleId             → remove one
      const chatRolesAddMatch = url.pathname.match(/^\/api\/active-chats\/([^/]+)\/roles$/);
      if (chatRolesAddMatch) {
        if (req.method !== 'POST') return methodNotAllowed(res);
        return handleAddChatRole(ctx, deps, chatRolesAddMatch[1]!);
      }
      const chatRolesRemoveMatch = url.pathname.match(/^\/api\/active-chats\/([^/]+)\/roles\/([^/]+)$/);
      if (chatRolesRemoveMatch) {
        if (req.method !== 'DELETE') return methodNotAllowed(res);
        return handleRemoveChatRole(ctx, deps, chatRolesRemoveMatch[1]!, chatRolesRemoveMatch[2]!);
      }

      // Phase 55: rename the user-facing chat label.
      //   PUT /api/active-chats/:id/label   { label: string | null }
      // Empty / null clears back to the firstPrompt-based fallback.
      const chatLabelMatch = url.pathname.match(/^\/api\/active-chats\/([^/]+)\/label$/);
      if (chatLabelMatch) {
        if (req.method !== 'PUT') return methodNotAllowed(res);
        return handleSetChatLabel(ctx, deps, chatLabelMatch[1]!);
      }

      // Phase 36: chat lifecycle UX. Two flavors:
      //   ?cascade=false (default) → set status='closed'; row + bindings stay
      //                              for history. Disappears from Active Chats.
      //   ?cascade=true            → DELETE the row; FK ON DELETE CASCADE
      //                              drops channel_bindings + queued msgs.
      // Either way, emits session.closed SSE so the renderer refreshes.
      const chatDeleteMatch = url.pathname.match(/^\/api\/active-chats\/([^/]+)$/);
      if (chatDeleteMatch) {
        if (req.method !== 'DELETE') return methodNotAllowed(res);
        const cascade = url.searchParams.get('cascade') === 'true';
        return handleDeleteChat(ctx, deps, chatDeleteMatch[1]!, cascade);
      }

      if (url.pathname === '/api/approvals') {
        if (req.method !== 'GET') return methodNotAllowed(res);
        return send(res, 200, { approvals: deps.registry.listPending() });
      }

      const decideMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/decide$/);
      if (decideMatch) {
        if (req.method !== 'POST') return methodNotAllowed(res);
        return handleDecide(ctx, deps, decideMatch[1]!);
      }

      if (url.pathname === '/api/campaigns') {
        if (req.method !== 'GET') return methodNotAllowed(res);
        return send(res, 200, { campaigns: listCampaigns(deps.db) });
      }

      const cyclesMatch = url.pathname.match(/^\/api\/campaigns\/([^/]+)\/cycles$/);
      if (cyclesMatch) {
        if (req.method !== 'GET') return methodNotAllowed(res);
        return send(res, 200, { cycles: listCycles(deps.db, cyclesMatch[1]!) });
      }

      const summarizeMatch = url.pathname.match(/^\/api\/campaigns\/([^/]+)\/summarize$/);
      if (summarizeMatch) {
        if (req.method !== 'POST') return methodNotAllowed(res);
        if (!deps.summarizeCampaign) {
          return send(res, 501, {
            error: 'not_implemented',
            message: 'summarize factory not wired',
          });
        }
        try {
          const summary = await deps.summarizeCampaign(summarizeMatch[1]!);
          deps.logger?.info('campaign_summarized', { data: { campaignId: summarizeMatch[1] } });
          return send(res, 200, { summary });
        } catch (err) {
          const msg = (err as Error).message;
          // Phase 24: CursorLlmClient cloud mode throws "API key required"
          // when CURSOR_API_KEY is missing. Surface as 501 so the renderer's
          // Settings prompt is the right next step. Local mode never throws
          // this.
          if (msg.includes('API key') && (msg.includes('CURSOR_API_KEY') || msg.includes('cloud mode'))) {
            return send(res, 501, { error: 'not_implemented', message: msg });
          }
          if (msg.includes('not found')) return send(res, 404, { error: 'not_found', message: msg });
          deps.logger?.error('summarize_failed', { data: { campaignId: summarizeMatch[1], error: msg } });
          return internalError(res, err);
        }
      }

      const cycleCompleteMatch = url.pathname.match(/^\/api\/cycles\/([^/]+)\/complete$/);
      if (cycleCompleteMatch) {
        if (req.method !== 'POST') return methodNotAllowed(res);
        return handleCompleteCycle(ctx, deps, cycleCompleteMatch[1]!);
      }

      const cycleBugTasksMatch = url.pathname.match(/^\/api\/cycles\/([^/]+)\/bug-tasks$/);
      if (cycleBugTasksMatch) {
        if (req.method !== 'POST') return methodNotAllowed(res);
        return handleCreateBugTasks(ctx, deps, cycleBugTasksMatch[1]!);
      }

      const cycleMatch = url.pathname.match(/^\/api\/cycles\/([^/]+)$/);
      if (cycleMatch) {
        if (req.method !== 'GET') return methodNotAllowed(res);
        const cycle = getCycle(deps.db, cycleMatch[1]!);
        if (!cycle) return notFound(res);
        const campaign = getCampaign(deps.db, cycle.campaignId);
        const tasks = listTasks(deps.db, cycle.id);
        return send(res, 200, { cycle, campaign, tasks });
      }

      const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (taskMatch) {
        if (req.method !== 'GET') return methodNotAllowed(res);
        const task = getTask(deps.db, taskMatch[1]!);
        if (!task) return notFound(res);
        const auditLog = listDocAuditsByTask(deps.db, task.id);
        return send(res, 200, { task, auditLog });
      }

      // ── Roles (B3) ──────────────────────────────────────────────────
      if (url.pathname === '/api/roles') {
        if (req.method !== 'GET') return methodNotAllowed(res);
        const roles = listRolesRepo(deps.db).map((r) => ({
          ...r,
          chunkCount: getChunksForRole(deps.db, r.id).length,
        }));
        return send(res, 200, { roles });
      }
      const roleTrainMatch = url.pathname.match(/^\/api\/roles\/([^/]+)\/train$/);
      if (roleTrainMatch) {
        if (req.method !== 'POST') return methodNotAllowed(res);
        return handleTrainRole(ctx, deps, roleTrainMatch[1]!);
      }
      // Phase 57: conversational role-training endpoints. Multi-turn chat
      // first; commit distills the conversation into a role spec and saves.
      if (url.pathname === '/api/roles/train-chat') {
        if (req.method !== 'POST') return methodNotAllowed(res);
        return handleRoleTrainChat(ctx, deps);
      }
      if (url.pathname === '/api/roles/train-chat/commit') {
        if (req.method !== 'POST') return methodNotAllowed(res);
        return handleRoleTrainChatCommit(ctx, deps);
      }
      const roleMatch = url.pathname.match(/^\/api\/roles\/([^/]+)$/);
      if (roleMatch) {
        if (req.method !== 'GET') return methodNotAllowed(res);
        const role = getRoleRow(deps.db, roleMatch[1]!);
        if (!role) return notFound(res);
        const chunks = getChunksForRole(deps.db, role.id).map((c) => ({
          // Strip the embedding Float32Array — it's binary + huge + not
          // useful in the UI; the renderer just needs sourceFile + chunkText.
          id: c.id,
          sourceFile: c.sourceFile,
          chunkText: c.chunkText,
          createdAt: c.createdAt,
        }));
        return send(res, 200, { role, chunks });
      }

      // ── Requirements (B3) ───────────────────────────────────────────
      if (url.pathname === '/api/requirements') {
        if (req.method !== 'GET') return methodNotAllowed(res);
        const query = url.searchParams.get('q') ?? undefined;
        const requirements = recallRequirements(deps.db, query);
        return send(res, 200, { requirements });
      }
      const reqMatch = url.pathname.match(/^\/api\/requirements\/([^/]+)$/);
      if (reqMatch) {
        if (req.method !== 'GET') return methodNotAllowed(res);
        const requirement = getRequirement(deps.db, reqMatch[1]!);
        if (!requirement) return notFound(res);
        return send(res, 200, { requirement });
      }

      if (url.pathname === '/api/diagnostics') {
        if (req.method !== 'POST') return methodNotAllowed(res);
        if (!deps.createDiagnosticsBundle) {
          return send(res, 501, { error: 'not_implemented', message: 'diagnostics bundle disabled' });
        }
        try {
          const result = deps.createDiagnosticsBundle();
          deps.logger?.info('diagnostics_bundle_created', { data: { bundleDir: result.bundleDir } });
          return send(res, 200, result);
        } catch (err) {
          return internalError(res, err);
        }
      }

      if (url.pathname === '/api/config') {
        if (req.method === 'GET') {
          if (!deps.getConfig) {
            return send(res, 501, { error: 'not_implemented', message: 'config read disabled' });
          }
          return send(res, 200, deps.getConfig());
        }
        if (req.method === 'PUT') {
          if (!deps.saveConfig) {
            return send(res, 501, { error: 'not_implemented', message: 'config save disabled' });
          }
          let parsed: unknown;
          try { parsed = JSON.parse(ctx.body); }
          catch { return badRequest(res, 'invalid JSON'); }
          try {
            const saved = deps.saveConfig(parsed);
            deps.logger?.info('config_saved');
            return send(res, 200, saved);
          } catch (err) {
            // Zod validation errors → 400 (user fixable); other errors → 500.
            const msg = (err as Error).message;
            if (msg.includes('parse') || msg.includes('expected')) {
              return badRequest(res, msg);
            }
            return internalError(res, err);
          }
        }
        return methodNotAllowed(res);
      }

      if (url.pathname === '/api/bindings') {
        if (req.method !== 'GET') return methodNotAllowed(res);
        return send(res, 200, { bindings: listAllChannelBindings(deps.db) });
      }

      if (url.pathname === '/api/bindings/pending') {
        if (req.method !== 'GET') return methodNotAllowed(res);
        return send(res, 200, { pending: listPendingBinds(deps.db) });
      }

      // Phase 39: cancel a pending bind code without consuming it. Lets the
      // user dismiss accidental / stale codes from the UI instead of waiting
      // for the 10-minute TTL. Idempotent: 404 if the code never existed
      // (or was already consumed / expired-and-purged).
      const pendingDeleteMatch = url.pathname.match(/^\/api\/bindings\/pending\/([^/]+)$/);
      if (pendingDeleteMatch) {
        if (req.method !== 'DELETE') return methodNotAllowed(res);
        const code = pendingDeleteMatch[1]!;
        // We need to know whether the row existed before deleting so the API
        // can return 404 vs 200 distinctly. getPendingBind also filters out
        // expired rows; treat those as 404 to match the consume path's UX.
        const existed = Boolean(getPendingBind(deps.db, code));
        deletePendingBind(deps.db, code);
        if (!existed) return send(res, 404, { error: 'unknown_or_expired_code' });
        deps.logger?.info('pending_bind_cancelled', { data: { code } });
        return send(res, 200, { ok: true, code });
      }

      if (url.pathname === '/api/bindings/consume') {
        if (req.method !== 'POST') return methodNotAllowed(res);
        if (!deps.consumePendingBind) {
          return send(res, 501, { error: 'not_implemented', message: 'consume disabled' });
        }
        let parsed: unknown;
        try { parsed = JSON.parse(ctx.body); }
        catch { return badRequest(res, 'invalid JSON'); }
        if (!parsed || typeof parsed !== 'object') {
          return badRequest(res, 'body must be a JSON object');
        }
        const { code, hostSessionId } = parsed as { code?: unknown; hostSessionId?: unknown };
        if (typeof code !== 'string' || !code) return badRequest(res, 'code (string) required');
        if (typeof hostSessionId !== 'string' || !hostSessionId) {
          return badRequest(res, 'hostSessionId (string) required');
        }
        const created = deps.consumePendingBind(code, hostSessionId);
        if (!created) return send(res, 404, { error: 'unknown_or_expired_code' });
        return send(res, 200, { binding: created });
      }

      const bindingMatch = url.pathname.match(/^\/api\/bindings\/([^/]+)$/);
      if (bindingMatch && bindingMatch[1] !== 'pending' && bindingMatch[1] !== 'consume') {
        if (req.method !== 'DELETE') return methodNotAllowed(res);
        const removed = deleteChannelBinding(deps.db, bindingMatch[1]!);
        if (!removed) return send(res, 404, { error: 'unknown_binding' });
        deps.events?.emit({ type: 'binding.removed', bindingId: bindingMatch[1]! });
        return send(res, 200, { ok: true });
      }

      return notFound(res);
    } catch (err) {
      deps.logger?.error('http handler threw', { data: { url: req.url, error: (err as Error).message } });
      return internalError(res, err);
    }
  });

  let actualPort: number | null = null;
  let stopped = false;

  return {
    async start(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(desiredPort, host, () => {
          server.off('error', reject);
          const addr = server.address();
          if (addr && typeof addr === 'object') actualPort = addr.port;
          deps.logger?.info('http_api started', { data: { host, port: actualPort } });
          resolve();
        });
      });
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      // Detach from event bus first so no new SSE messages queue while we close.
      unsubscribeFromBus?.();
      unsubscribeFromBus = undefined;
      // End every open SSE stream so server.close() can resolve.
      for (const client of sseClients) {
        try { client.end(); } catch { /* socket already gone */ }
      }
      sseClients.clear();
      // Phase 45: close any live MCP SSE sessions too. The SDK transports own
      // their own ServerResponse refs (separate from sseClients) so this
      // matters for graceful shutdown of Cursor's connection.
      if (mcpHub) await mcpHub.closeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      deps.logger?.info('http_api stopped');
    },
    port: () => actualPort,
  };
}

function handleEvents(req: http.IncomingMessage, res: http.ServerResponse, clients: Set<http.ServerResponse>): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Initial comment line establishes the stream and triggers EventSource onopen.
  res.write(': connected\n\n');
  clients.add(res);

  const cleanup = (): void => { clients.delete(res); };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('error', cleanup);
}

function handleDecide(ctx: RouteContext, deps: HttpApiDeps, approvalId: string): void {
  let parsed: unknown;
  try { parsed = JSON.parse(ctx.body); }
  catch { return badRequest(ctx.response, 'invalid JSON'); }

  if (!parsed || typeof parsed !== 'object') {
    return badRequest(ctx.response, 'body must be a JSON object');
  }
  const {
    decision, reason, remember, scope,
  } = parsed as {
    decision?: unknown; reason?: unknown; remember?: unknown; scope?: unknown;
  };
  if (decision !== 'allow' && decision !== 'deny') {
    return badRequest(ctx.response, 'decision must be "allow" or "deny"');
  }
  if (reason !== undefined && typeof reason !== 'string') {
    return badRequest(ctx.response, 'reason must be a string when provided');
  }
  if (remember !== undefined && typeof remember !== 'boolean') {
    return badRequest(ctx.response, 'remember must be a boolean when provided');
  }
  if (scope !== undefined && typeof scope !== 'string') {
    return badRequest(ctx.response, 'scope must be a string when provided');
  }

  // Phase 46d: when the renderer asks us to remember the decision, derive a
  // policy rule from the pending request (or the explicit `scope` when
  // provided) and insert it BEFORE settling so the rule is in place if a
  // duplicate request races behind. Mirrors Lark `/allow! <scope>` flow.
  let rememberedRule: { id: string; tool: string; decision: 'allow' | 'deny' } | undefined;
  if (remember) {
    if (!deps.policy) {
      return send(ctx.response, 501, {
        error: 'not_implemented',
        message: 'policy engine not wired',
      });
    }
    // We need the pending request to know the tool / command for inference.
    const pending = deps.registry.listPending().find((r) => r.id === approvalId)
      ?? deps.registry.get(approvalId);
    if (!pending) {
      return send(ctx.response, 404, { error: 'not_found', message: 'unknown approvalId' });
    }
    const policyInput = derivePolicyInput(pending, decision, scope);
    if (!policyInput) {
      return badRequest(ctx.response,
        'unable to derive policy scope from this approval — pass an explicit `scope` string');
    }
    try {
      const rule = deps.policy.add(policyInput);
      rememberedRule = { id: rule.id, tool: rule.tool, decision: rule.decision };
      deps.logger?.info('approval_policy_added', {
        data: { ruleId: rule.id, tool: rule.tool, decision: rule.decision, scope },
      });
    } catch (err) {
      deps.logger?.warn('approval_policy_add_failed', {
        data: { error: (err as Error).message, scope },
      });
      return send(ctx.response, 400, {
        error: 'policy_add_failed', message: (err as Error).message,
      });
    }
  }

  const settled = deps.registry.settle(approvalId, {
    permission: decision,
    reason,
    decidedBy: 'local-ui',
  });
  if (!settled) {
    deps.logger?.warn('approval_decide_unknown_or_settled', { data: { approvalId } });
    return send(ctx.response, 409, { error: 'already_settled_or_unknown' });
  }

  deps.logger?.info('approval_decide', {
    data: { approvalId, decision, remember: Boolean(remember) },
  });
  return send(ctx.response, 200, {
    ok: true,
    approvalId,
    ...(rememberedRule ? { rememberedRule } : {}),
  });
}

/**
 * Phase 46d helper: build an AddPolicyInput from the live pending approval +
 * an optional user-typed scope. Mirrors `policyInputFromScope` for the
 * explicit-scope path; otherwise we infer a sensible default:
 *   - `mcp__server__tool` exact tool          → toolScope=true
 *   - Shell with absolute path command         → pathPrefix = dir(command)
 *   - any tool with first-token command        → commandPrefix = firstToken
 *   - any tool with empty command              → toolScope=true
 */
function derivePolicyInput(
  pending: { tool: string; command?: string },
  decision: 'allow' | 'deny',
  scope: string | undefined,
): AddPolicyInput | null {
  if (scope && scope.trim()) {
    return policyInputFromScope(scope, decision);
  }
  const tool = pending.tool;
  const command = (pending.command ?? '').trim();
  if (tool.startsWith('mcp__')) {
    return { tool, decision, toolScope: true };
  }
  if (!command) {
    return { tool, decision, toolScope: true };
  }
  // Use the first token (e.g. `pnpm`, `git`) as a sensible default prefix.
  // Users can broaden / narrow later from the policy list.
  const firstToken = command.split(/\s+/, 1)[0] ?? '';
  if (!firstToken) return { tool, decision, toolScope: true };
  return { tool, decision, commandPrefix: firstToken };
}

function handleCompleteCycle(ctx: RouteContext, deps: HttpApiDeps, cycleId: string): void {
  if (!deps.workflowEngine) {
    return send(ctx.response, 501, { error: 'not_implemented', message: 'workflow engine not wired' });
  }
  let parsed: unknown = {};
  if (ctx.body) {
    try { parsed = JSON.parse(ctx.body); }
    catch { return badRequest(ctx.response, 'invalid JSON'); }
  }
  const input = (parsed && typeof parsed === 'object') ? parsed as {
    passRate?: unknown; failedTests?: unknown; screenshots?: unknown;
  } : {};
  const passRate = typeof input.passRate === 'number' ? input.passRate : undefined;
  const failedTests = Array.isArray(input.failedTests)
    ? input.failedTests.filter((s): s is string => typeof s === 'string')
    : undefined;
  const screenshots = Array.isArray(input.screenshots)
    ? input.screenshots
        .filter((s): s is { filePath: string; description: string; capturedAt?: string } =>
          Boolean(s) && typeof s === 'object'
          && typeof (s as { filePath?: unknown }).filePath === 'string'
          && typeof (s as { description?: unknown }).description === 'string')
        .map((s) => ({
          filePath: s.filePath,
          description: s.description,
          // engine.completeCycle requires a fully-typed Screenshot; stamp now
          // when the client didn't pass one.
          capturedAt: s.capturedAt ?? new Date().toISOString(),
        }))
    : undefined;

  try {
    const cycle = deps.workflowEngine.completeCycle(cycleId, { passRate, failedTests, screenshots });
    deps.logger?.info('cycle_complete', { data: { cycleId, passRate } });
    return send(ctx.response, 200, { cycle });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('not found')) return send(ctx.response, 404, { error: 'not_found', message: msg });
    return badRequest(ctx.response, msg);
  }
}

function handleCreateBugTasks(ctx: RouteContext, deps: HttpApiDeps, cycleId: string): void {
  if (!deps.workflowEngine) {
    return send(ctx.response, 501, { error: 'not_implemented', message: 'workflow engine not wired' });
  }
  let parsed: unknown;
  try { parsed = JSON.parse(ctx.body); }
  catch { return badRequest(ctx.response, 'invalid JSON'); }
  if (!parsed || typeof parsed !== 'object') {
    return badRequest(ctx.response, 'body must be a JSON object');
  }
  const { bugs } = parsed as { bugs?: unknown };
  if (!Array.isArray(bugs) || bugs.length === 0) {
    return badRequest(ctx.response, 'bugs must be a non-empty array');
  }
  const validated: Array<{
    title: string; description?: string; expected?: string;
    actual?: string; screenshotDescription?: string;
  }> = [];
  for (const raw of bugs) {
    if (!raw || typeof raw !== 'object') {
      return badRequest(ctx.response, 'each bug must be an object with at least a title');
    }
    const b = raw as Record<string, unknown>;
    if (typeof b['title'] !== 'string' || !b['title']) {
      return badRequest(ctx.response, 'each bug requires a non-empty title');
    }
    validated.push({
      title: b['title'],
      description: typeof b['description'] === 'string' ? b['description'] : undefined,
      expected: typeof b['expected'] === 'string' ? b['expected'] : undefined,
      actual: typeof b['actual'] === 'string' ? b['actual'] : undefined,
      screenshotDescription: typeof b['screenshotDescription'] === 'string'
        ? b['screenshotDescription'] : undefined,
    });
  }

  try {
    const tasks = deps.workflowEngine.createBugTasks(cycleId, validated);
    deps.logger?.info('bug_tasks_created', { data: { cycleId, count: tasks.length } });
    return send(ctx.response, 200, { tasks });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('not found')) return send(ctx.response, 404, { error: 'not_found', message: msg });
    return badRequest(ctx.response, msg);
  }
}

/**
 * Phase 55: PUT /api/active-chats/:id/label — rename a chat's user-facing
 * label. Empty / null clears the override and falls back to firstPrompt.
 *
 * Body: `{ label: string | null }`. The setter trims and caps at 120 chars
 * so paste-from-anywhere doesn't break the sidebar layout. Emits
 * `session.started` (re-using the existing event for "this row changed,
 * renderer please re-fetch") so SSE consumers refresh without polling.
 */
function handleSetChatLabel(ctx: RouteContext, deps: HttpApiDeps, hostSessionId: string): void {
  const session = getHostSession(deps.db, hostSessionId);
  if (!session) {
    return send(ctx.response, 404, { error: 'not_found', message: 'unknown host session' });
  }
  let parsed: unknown;
  try { parsed = JSON.parse(ctx.body); }
  catch { return badRequest(ctx.response, 'invalid JSON'); }
  if (!parsed || typeof parsed !== 'object') {
    return badRequest(ctx.response, 'body must be a JSON object');
  }
  const { label } = parsed as { label?: unknown };
  if (label !== null && label !== undefined && typeof label !== 'string') {
    return badRequest(ctx.response, 'label must be a string, null, or omitted');
  }
  const persisted = setHostSessionDisplayName(deps.db, hostSessionId, label ?? null);
  deps.logger?.info('chat_label_set', {
    data: { hostSessionId, displayName: persisted ?? null },
  });
  const refreshed = getHostSession(deps.db, hostSessionId);
  if (refreshed) {
    deps.events?.emit({ type: 'session.started', session: refreshed });
  }
  return send(ctx.response, 200, { chat: refreshed });
}

function handleSetChatRole(ctx: RouteContext, deps: HttpApiDeps, hostSessionId: string): void {
  const session = getHostSession(deps.db, hostSessionId);
  if (!session) {
    return send(ctx.response, 404, { error: 'not_found', message: 'unknown host session' });
  }
  let parsed: unknown;
  try { parsed = JSON.parse(ctx.body); }
  catch { return badRequest(ctx.response, 'invalid JSON'); }
  if (!parsed || typeof parsed !== 'object') {
    return badRequest(ctx.response, 'body must be a JSON object');
  }
  const { roleId } = parsed as { roleId?: unknown };
  if (roleId !== null && typeof roleId !== 'string') {
    return badRequest(ctx.response, 'roleId must be a string or null');
  }
  if (typeof roleId === 'string' && roleId.length > 0) {
    const role = getRoleRow(deps.db, roleId);
    if (!role) {
      return send(ctx.response, 404, { error: 'not_found', message: `unknown role ${roleId}` });
    }
  }
  const next = (typeof roleId === 'string' && roleId.length > 0) ? roleId : null;
  setHostSessionRole(deps.db, hostSessionId, next);
  deps.logger?.info('chat_role_set', { data: { hostSessionId, roleId: next } });
  const refreshed = getHostSession(deps.db, hostSessionId);
  return send(ctx.response, 200, { chat: refreshed });
}

function handleAddChatRole(ctx: RouteContext, deps: HttpApiDeps, hostSessionId: string): void {
  const session = getHostSession(deps.db, hostSessionId);
  if (!session) {
    return send(ctx.response, 404, { error: 'not_found', message: 'unknown host session' });
  }
  let parsed: unknown;
  try { parsed = JSON.parse(ctx.body); }
  catch { return badRequest(ctx.response, 'invalid JSON'); }
  if (!parsed || typeof parsed !== 'object') {
    return badRequest(ctx.response, 'body must be a JSON object');
  }
  const { roleId } = parsed as { roleId?: unknown };
  if (typeof roleId !== 'string' || !roleId) {
    return badRequest(ctx.response, 'roleId (non-empty string) required');
  }
  const role = getRoleRow(deps.db, roleId);
  if (!role) {
    return send(ctx.response, 404, { error: 'not_found', message: `unknown role ${roleId}` });
  }
  const added = addHostSessionRole(deps.db, hostSessionId, roleId);
  deps.logger?.info('chat_role_added', { data: { hostSessionId, roleId, alreadyPresent: !added } });
  const refreshed = getHostSession(deps.db, hostSessionId);
  return send(ctx.response, 200, { chat: refreshed });
}

function handleRemoveChatRole(
  ctx: RouteContext,
  deps: HttpApiDeps,
  hostSessionId: string,
  roleId: string,
): void {
  const session = getHostSession(deps.db, hostSessionId);
  if (!session) {
    return send(ctx.response, 404, { error: 'not_found', message: 'unknown host session' });
  }
  const removed = removeHostSessionRole(deps.db, hostSessionId, roleId);
  if (!removed) {
    return send(ctx.response, 404, {
      error: 'not_found', message: `role ${roleId} not bound to chat ${hostSessionId}`,
    });
  }
  deps.logger?.info('chat_role_removed', { data: { hostSessionId, roleId } });
  const refreshed = getHostSession(deps.db, hostSessionId);
  return send(ctx.response, 200, { chat: refreshed });
}

function handleDeleteChat(
  ctx: RouteContext,
  deps: HttpApiDeps,
  hostSessionId: string,
  cascade: boolean,
): void {
  const session = getHostSession(deps.db, hostSessionId);
  if (!session) {
    return send(ctx.response, 404, { error: 'not_found', message: 'unknown host session' });
  }
  if (cascade) {
    deleteHostSession(deps.db, hostSessionId);
    deps.logger?.info('chat_deleted', { data: { hostSessionId, cascade: true } });
  } else {
    // Soft-close: row + bindings stay for history; the chat just falls out
    // of `listActiveSessions`. Lets the user re-open the same Cursor chat
    // later and have helm re-attach instead of treating it as brand-new.
    updateHostSession(deps.db, hostSessionId, { status: 'closed' });
    deps.logger?.info('chat_closed', { data: { hostSessionId } });
  }
  deps.events?.emit({ type: 'session.closed', hostSessionId });
  return send(ctx.response, 200, { ok: true, hostSessionId, cascade });
}

function handleTrainRole(ctx: RouteContext, deps: HttpApiDeps, roleId: string): void {
  if (!deps.trainRole) {
    return send(ctx.response, 501, { error: 'not_implemented', message: 'role training not wired' });
  }
  let parsed: unknown;
  try { parsed = JSON.parse(ctx.body); }
  catch { return badRequest(ctx.response, 'invalid JSON'); }
  if (!parsed || typeof parsed !== 'object') {
    return badRequest(ctx.response, 'body must be a JSON object');
  }
  const { name, documents, baseSystemPrompt } = parsed as {
    name?: unknown; documents?: unknown; baseSystemPrompt?: unknown;
  };
  if (typeof name !== 'string' || !name.trim()) {
    return badRequest(ctx.response, 'name (non-empty string) required');
  }
  if (!Array.isArray(documents) || documents.length === 0) {
    return badRequest(ctx.response, 'documents must be a non-empty array');
  }
  const docs: Array<{ filename: string; content: string }> = [];
  for (const raw of documents) {
    if (!raw || typeof raw !== 'object') {
      return badRequest(ctx.response, 'each document must be an object with filename + content');
    }
    const d = raw as Record<string, unknown>;
    if (typeof d['filename'] !== 'string' || !d['filename']) {
      return badRequest(ctx.response, 'each document requires a non-empty filename');
    }
    if (typeof d['content'] !== 'string') {
      return badRequest(ctx.response, 'each document requires a string content');
    }
    docs.push({ filename: d['filename'], content: d['content'] });
  }
  if (baseSystemPrompt !== undefined && typeof baseSystemPrompt !== 'string') {
    return badRequest(ctx.response, 'baseSystemPrompt must be a string when provided');
  }

  // Async-execute; need to wrap because `handleX` functions are sync.
  void (async () => {
    try {
      const role = await deps.trainRole!({
        roleId,
        name,
        documents: docs,
        baseSystemPrompt: baseSystemPrompt as string | undefined,
      });
      deps.logger?.info('role_trained', { data: { roleId, docCount: docs.length } });
      send(ctx.response, 200, { role });
    } catch (err) {
      deps.logger?.error('role_train_failed', { data: { roleId, error: (err as Error).message } });
      internalError(ctx.response, err);
    }
  })();
}

/**
 * Phase 57: instructions the LLM follows when role-coaching the user. Kept
 * inline so the user can read it in the source rather than guessing what
 * the LLM is up to. The coach asks clarifying questions, summarizes when
 * confident, and refuses to invent — it only distills what the user has
 * actually told it.
 */
const ROLE_TRAIN_SYSTEM_PROMPT = [
  'You are a role-coach helping the user define a new AI agent role for the helm system.',
  '',
  'Your job, in order:',
  '  1. Ask clarifying questions, ONE OR TWO AT A TIME, to figure out:',
  '     - The role\'s name (e.g. "Goofy 专家", "容灾大盘 reviewer")',
  '     - Domain expertise (what topics, products, codebases)',
  '     - Voice / style (terse code-reviewer, patient teacher, ...)',
  '     - Concrete tasks the role should handle well',
  '     - Edge cases / failure modes the role should NOT do',
  '  2. When you have enough to draft a useful system prompt, summarize what',
  '     you understand about the role and ask the user to confirm or correct.',
  '  3. Once the user confirms, briefly say "Ready to save — click Save in the UI"',
  '     and stop.',
  '',
  'Hard rules:',
  '  - Never invent expertise the user did not describe.',
  '  - Stay in English unless the user writes in Chinese; mirror their language.',
  '  - Keep each turn short (under 200 words). The user is in a chat box, not reading docs.',
].join('\n');

/**
 * Phase 57 commit: distills the chat history into a structured role spec.
 * Uses a strict JSON-only system prompt so we can parse the response without
 * regex hacks. The LLM emits exactly:
 *   { "name": string, "systemPrompt": string }
 */
const ROLE_TRAIN_COMMIT_PROMPT = [
  'You are converting a coaching conversation into a finalized role spec.',
  'Read the entire conversation above and emit ONLY a JSON object with two fields:',
  '  - "name": the role\'s human-readable name (the value the user agreed on).',
  '  - "systemPrompt": a self-contained system prompt that captures the role\'s',
  '    expertise, style, and task focus. Written in second person ("You are ...").',
  '    300-700 characters is plenty.',
  '',
  'Output ONLY the JSON object — no markdown, no commentary, no fences.',
  'If the conversation is too thin to produce a coherent role, emit:',
  '  {"error": "<short reason>"}',
].join('\n');

function handleRoleTrainChat(ctx: RouteContext, deps: HttpApiDeps): void {
  const factory = deps.llmChatFactory;
  if (!factory) {
    return send(ctx.response, 501, {
      error: 'not_implemented',
      message: 'role-train chat factory not wired',
    });
  }
  let parsed: unknown;
  try { parsed = JSON.parse(ctx.body); }
  catch { return badRequest(ctx.response, 'invalid JSON'); }
  if (!parsed || typeof parsed !== 'object') {
    return badRequest(ctx.response, 'body must be a JSON object');
  }
  const { messages } = parsed as { messages?: unknown };
  if (!Array.isArray(messages) || messages.length === 0) {
    return badRequest(ctx.response, 'messages must be a non-empty array of {role,content}');
  }
  const validated: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') {
      return badRequest(ctx.response, 'each message must be an object');
    }
    const m = raw as Record<string, unknown>;
    if (m['role'] !== 'user' && m['role'] !== 'assistant') {
      return badRequest(ctx.response, 'message.role must be "user" or "assistant"');
    }
    if (typeof m['content'] !== 'string' || !m['content']) {
      return badRequest(ctx.response, 'message.content must be a non-empty string');
    }
    validated.push({ role: m['role'], content: m['content'] });
  }

  let client;
  try { client = factory(); }
  catch (err) {
    return send(ctx.response, 501, {
      error: 'no_provider',
      message: (err as Error).message,
    });
  }
  if (!client) {
    return send(ctx.response, 501, {
      error: 'no_provider',
      message: 'No LLM provider configured. Set anthropic.apiKey in Settings or sign into Cursor.',
    });
  }

  void (async () => {
    try {
      const result = await client.chat(validated, {
        system: ROLE_TRAIN_SYSTEM_PROMPT,
        maxTokens: 1024,
      });
      deps.logger?.info('role_train_chat_turn', {
        data: { provider: result.provider, model: result.model, msgs: validated.length },
      });
      send(ctx.response, 200, {
        message: { role: 'assistant', content: result.content },
        provider: result.provider,
        model: result.model,
      });
    } catch (err) {
      deps.logger?.warn('role_train_chat_failed', { data: { error: (err as Error).message } });
      send(ctx.response, 502, { error: 'llm_failed', message: (err as Error).message });
    }
  })();
}

function handleRoleTrainChatCommit(ctx: RouteContext, deps: HttpApiDeps): void {
  const factory = deps.llmChatFactory;
  if (!factory || !deps.trainRole) {
    return send(ctx.response, 501, {
      error: 'not_implemented',
      message: 'role-train factory + trainRole must both be wired to commit',
    });
  }
  let parsed: unknown;
  try { parsed = JSON.parse(ctx.body); }
  catch { return badRequest(ctx.response, 'invalid JSON'); }
  if (!parsed || typeof parsed !== 'object') {
    return badRequest(ctx.response, 'body must be a JSON object');
  }
  const { messages, roleId } = parsed as { messages?: unknown; roleId?: unknown };
  if (!Array.isArray(messages) || messages.length === 0) {
    return badRequest(ctx.response, 'messages must be a non-empty array');
  }
  if (roleId !== undefined && typeof roleId !== 'string') {
    return badRequest(ctx.response, 'roleId must be a string when provided');
  }
  // Re-validate message shape (mirrors handleRoleTrainChat).
  const validated: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') return badRequest(ctx.response, 'each message must be an object');
    const m = raw as Record<string, unknown>;
    if (m['role'] !== 'user' && m['role'] !== 'assistant') {
      return badRequest(ctx.response, 'message.role must be "user" or "assistant"');
    }
    if (typeof m['content'] !== 'string') {
      return badRequest(ctx.response, 'message.content must be a string');
    }
    validated.push({ role: m['role'], content: m['content'] });
  }

  let client;
  try { client = factory(); }
  catch (err) {
    return send(ctx.response, 501, { error: 'no_provider', message: (err as Error).message });
  }
  if (!client) return send(ctx.response, 501, { error: 'no_provider' });

  void (async () => {
    try {
      // Step 1: ask the LLM to distill into a {name, systemPrompt} JSON.
      const distill = await client.chat(validated, {
        system: ROLE_TRAIN_COMMIT_PROMPT,
        maxTokens: 1500,
      });
      const spec = parseRoleSpec(distill.content);
      if ('error' in spec) {
        return send(ctx.response, 422, {
          error: 'distill_failed', message: spec.error,
        });
      }

      // Step 2: feed the distilled spec into the existing trainRole pipeline.
      // The conversation transcript becomes a single document so search-time
      // RAG can recall the source dialogue.
      const transcript = validated
        .map((m) => `**${m.role === 'user' ? 'User' : 'Coach'}**: ${m.content}`)
        .join('\n\n');
      const finalRoleId = (roleId && roleId.trim()) || `role-${slugify(spec.name)}-${Date.now().toString(36)}`;
      const role = await deps.trainRole!({
        roleId: finalRoleId,
        name: spec.name,
        documents: [
          { filename: 'training-conversation.md', content: transcript },
        ],
        baseSystemPrompt: spec.systemPrompt,
      });

      deps.logger?.info('role_trained_via_chat', {
        data: { roleId: finalRoleId, name: spec.name, msgs: validated.length, provider: distill.provider },
      });
      return send(ctx.response, 200, {
        role,
        spec: { name: spec.name, systemPrompt: spec.systemPrompt },
        provider: distill.provider,
        model: distill.model,
      });
    } catch (err) {
      deps.logger?.warn('role_train_chat_commit_failed', { data: { error: (err as Error).message } });
      return send(ctx.response, 500, { error: 'commit_failed', message: (err as Error).message });
    }
  })();
}

function parseRoleSpec(text: string): { name: string; systemPrompt: string } | { error: string } {
  // The commit-prompt asks for raw JSON, but defensive — strip code fences if
  // the model wraps the output anyway.
  const trimmed = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  let obj: unknown;
  try { obj = JSON.parse(trimmed); }
  catch { return { error: `LLM did not return valid JSON: ${trimmed.slice(0, 120)}…` }; }
  if (!obj || typeof obj !== 'object') return { error: 'LLM JSON was not an object' };
  const o = obj as Record<string, unknown>;
  if (typeof o['error'] === 'string') return { error: o['error'] };
  if (typeof o['name'] !== 'string' || !o['name'].trim()) {
    return { error: 'LLM JSON missing name' };
  }
  if (typeof o['systemPrompt'] !== 'string' || !o['systemPrompt'].trim()) {
    return { error: 'LLM JSON missing systemPrompt' };
  }
  return { name: o['name'].trim(), systemPrompt: o['systemPrompt'].trim() };
}

function slugify(text: string): string {
  return text.toLowerCase()
    .replace(/[^\w\s-]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    || 'role';
}
