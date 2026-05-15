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
  getChannelBinding,
  getPendingBind,
  listAllChannelBindings,
  listPendingBinds,
  pendingMessageCountsByHostSession,
} from '../storage/repos/channel-bindings.js';
import {
  deleteSource,
  getChunkById as getChunkByIdRepo,
  getChunksForRole,
  getRole as getRoleRow,
  getSource,
  listRoles as listRolesRepo,
  listSourcesForRole,
  unarchiveChunk as unarchiveChunkRepo,
} from '../storage/repos/roles.js';
import {
  getCandidateById,
  listCandidatesForRole,
  pendingCountsByRole,
  setCandidateStatus,
  updateCandidateText,
} from '../storage/repos/knowledge-candidates.js';
import { updateRole as updateRoleLibrary } from '../roles/library.js';
import { makePseudoEmbedFn } from '../mcp/embed.js';
import { createHash } from 'node:crypto';
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
import * as harnessLib from '../harness/library.js';
import {
  getReview as harnessGetReview,
  listReviewsForTask as harnessListReviews,
} from '../storage/repos/harness.js';
import type { HarnessReview } from '../storage/types.js';

const harnessReviewRepos = {
  getReview: harnessGetReview,
  listReviewsForTask: harnessListReviews,
};

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
   * Phase 62: create a fresh pending_binds row from the renderer's
   * "Mirror to Lark" button. The caller (orchestrator) wires this to
   * `createPendingLarkBind`. Returns the same shape the user-facing
   * modal needs: a copyable code + instruction string.
   */
  initiateLarkBind?: (opts: { label?: string; hostSessionId?: string }) => {
    code: string;
    expiresAt: string;
    instruction: string;
  };
  /**
   * Phase 63: register helm's MCP server with the user's CLI / IDE
   * directly from the renderer (no `helm` binary on PATH required).
   * Wraps `setupMcp()` from `src/cli/setup-mcp.ts`. Always wired —
   * tests stub it.
   */
  setupMcp?: (target: 'claude' | 'cursor') => {
    changed: boolean;
    message: string;
    location: string;
  };
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
    // Phase 73: per-doc kind + provenance. Optional so older callers still work.
    documents: Array<{
      filename: string;
      content: string;
      kind?: 'spec' | 'example' | 'warning' | 'runbook' | 'glossary' | 'other';
      sourceKind?: 'lark-doc' | 'file' | 'inline';
      origin?: string;
      sourceLabel?: string;
    }>;
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
   * Phase 77: override the SSE keepalive interval in ms. Tests use this
   * to verify the keepalive frame in deterministic time. Production
   * leaves it undefined → the McpHttpSseHub defaults to 25s.
   */
  mcpKeepaliveIntervalMs?: number;
  /**
   * Phase 57: factory for the conversational role-trainer LLM client. Built
   * lazily so a Settings save updates the next call without restart. Returns
   * `null` when no provider is configured (no anthropic.apiKey AND no
   * Cursor); handlers surface a 501 with an actionable message.
   *
   * Phase 59: takes optional per-call options. `cwd` lets the caller pin
   * the Cursor agent's file-access root to a user-supplied project path
   * (so the agent's built-in `read`/`grep` tools see the right code).
   */
  /**
   * Phase 60b: factory for a per-modal Claude Code subprocess agent. The
   * role-trainer chat now spawns `claude -p` for each turn so the agent
   * uses Claude Code's full native capabilities (reading code, web fetch,
   * shell) plus helm's MCP tools (`train_role`, `read_lark_doc`, ...). Helm
   * holds zero API keys for this path — claude's own auth runs the model.
   *
   * Returns null when the `claude` binary isn't on PATH; the
   * `/api/roles/train-chat` endpoint then 501s with an actionable message
   * pointing the user at `helm setup-mcp claude` (or to install Claude
   * Code).
   */
  cliAgentFactory?: (
    opts?: { cwd?: string },
  ) => import('../cli-agent/claude.js').ClaudeCodeAgent | null;
  /**
   * Phase 68: pluggable conversational runner used by handleRoleTrainChat.
   * Goes through EngineRouter so the user's default engine drives the
   * chat. Returns null when no engine is currently available
   * (`EngineRouter.current()` throws); the endpoint then 501s with an
   * actionable message.
   */
  runConversation?: (
    input: import('../engine/types.js').RunConversationInput,
  ) => Promise<import('../engine/types.js').RunConversationResult | null>;
  /**
   * Phase 68: GET /api/engine/health returns whatever this resolves to.
   * Orchestrator wires `detectEngines()`. Tests substitute fakes. When
   * absent, the endpoint returns 501 so the Settings UI can fall back
   * to showing "health unknown".
   */
  getEngineHealth?: () => Promise<import('../engine/types.js').EngineHealth[]>;
  /**
   * Phase 67: spawn the Harness review subprocess for a given task. Wraps
   * `runReview()` from `src/harness/review-runner.ts` with the orchestrator's
   * pre-bound conventions getter + DB. Returns the completed review row.
   * When undefined (e.g. tests that don't want to shell out), POST to
   * `/api/harness/tasks/:id/review` returns 501.
   */
  runHarnessReview?: (taskId: string) => Promise<HarnessReview>;
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
    ? new McpHttpSseHub({
        factory: deps.mcpFactory,
        ...(deps.logger ? { logger: deps.logger } : {}),
        ...(deps.mcpKeepaliveIntervalMs !== undefined
          ? { keepaliveIntervalMs: deps.mcpKeepaliveIntervalMs }
          : {}),
      })
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
        // Phase 70: hydrate each chat with its current pending-message
        // depth so the UI can show a "queued" badge. One aggregate query
        // covers all rows; chats with no queue get omitted from the map
        // and fall back to undefined (the renderer treats undefined as 0).
        const queueDepth = pendingMessageCountsByHostSession(deps.db);
        const enriched = sessions.map((s) => ({
          ...s,
          ...(queueDepth[s.id] ? { queuedMessageCount: queueDepth[s.id] } : {}),
        }));
        return send(res, 200, { chats: enriched });
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
        // Phase 78: include pending candidate counts so the Roles list
        // can render a `(N)` badge without N+1 round-trips. One COUNT GROUP
        // BY across the whole table; the per-role lookup is O(1).
        const pendingByRole = pendingCountsByRole(deps.db);
        const roles = listRolesRepo(deps.db).map((r) => ({
          ...r,
          chunkCount: getChunksForRole(deps.db, r.id).length,
          pendingCandidateCount: pendingByRole.get(r.id) ?? 0,
        }));
        return send(res, 200, { roles });
      }
      const roleTrainMatch = url.pathname.match(/^\/api\/roles\/([^/]+)\/train$/);
      if (roleTrainMatch) {
        if (req.method !== 'POST') return methodNotAllowed(res);
        return handleTrainRole(ctx, deps, roleTrainMatch[1]!);
      }
      // Phase 60b: conversational role-training endpoint. Per-turn POST;
      // the agent calls helm's `train_role` MCP tool itself when the user
      // confirms — no separate /commit step.
      if (url.pathname === '/api/roles/train-chat') {
        if (req.method !== 'POST') return methodNotAllowed(res);
        return handleRoleTrainChat(ctx, deps);
      }
      const roleMatch = url.pathname.match(/^\/api\/roles\/([^/]+)$/);
      if (roleMatch) {
        if (req.method !== 'GET') return methodNotAllowed(res);
        const role = getRoleRow(deps.db, roleMatch[1]!);
        if (!role) return notFound(res);
        // Phase 77: also load archived chunks so the Roles page can render
        // them in a folded "Archived (N)" section. The repo's
        // includeArchived flag is what the search path uses too, so both
        // surfaces stay aligned on what counts as archived.
        const chunks = getChunksForRole(deps.db, role.id, { includeArchived: true }).map((c) => ({
          // Strip the embedding Float32Array — it's binary + huge + not
          // useful in the UI; the renderer just needs sourceFile + chunkText.
          id: c.id,
          sourceFile: c.sourceFile,
          chunkText: c.chunkText,
          // Phase 73: kind + sourceId surface in the UI as badges / links.
          kind: c.kind,
          sourceId: c.sourceId,
          createdAt: c.createdAt,
          // Phase 77: lifecycle fields. accessCount / lastAccessedAt drive
          // the "accessed N times · last <reltime>" stat strip; archived
          // bucket determines which section the card lands in.
          accessCount: c.accessCount,
          lastAccessedAt: c.lastAccessedAt,
          archived: c.archived,
        }));
        // Phase 73: include every knowledge_source row for this role with
        // chunk counts. The Roles page renders a "Sources" block driven by
        // this list — each entry has a "Drop" button hitting DELETE below.
        const sources = listSourcesForRole(deps.db, role.id);
        return send(res, 200, { role, chunks, sources });
      }

      // Phase 77: POST /api/knowledge-chunks/:id/unarchive — restore a
      // single archived chunk. Driven by the Roles UI's "unarchive" button
      // inside the Archived (N) folded section. We do NOT expose an
      // archive endpoint — archive happens via the background sweep only
      // (Decision §4).
      const unarchiveMatch = url.pathname.match(/^\/api\/knowledge-chunks\/([^/]+)\/unarchive$/);
      if (unarchiveMatch) {
        if (req.method !== 'POST') return methodNotAllowed(res);
        const chunkId = unarchiveMatch[1]!;
        const before = getChunkByIdRepo(deps.db, chunkId);
        if (!before) return notFound(res);
        const restored = unarchiveChunkRepo(deps.db, chunkId, new Date().toISOString());
        deps.logger?.info('knowledge_chunk_unarchived', {
          data: { chunkId, roleId: before.roleId, wasArchived: before.archived, restored },
        });
        return send(res, 200, { chunkId, restored });
      }

      // Phase 78: list candidates for a role.
      //   GET /api/roles/:id/candidates?status=pending     (default pending)
      //   GET /api/roles/:id/candidates?status=all         (accepted + rejected + pending)
      // Drives the Roles UI's Candidates tab. status filter mirrors the
      // repo's ListCandidatesOptions.
      const candidatesListMatch = url.pathname.match(/^\/api\/roles\/([^/]+)\/candidates$/);
      if (candidatesListMatch) {
        if (req.method !== 'GET') return methodNotAllowed(res);
        const roleId = candidatesListMatch[1]!;
        const role = getRoleRow(deps.db, roleId);
        if (!role) return notFound(res);
        // Reviewer #4: validate status against the documented set —
        // unknown values (typo / curl misuse) used to silently fall
        // through to the SQL filter and return [], which the UI would
        // render as "no candidates" indistinguishable from the real
        // empty case. 400 forces the caller to fix the param.
        const VALID_STATUSES = ['pending', 'accepted', 'rejected', 'expired', 'all'] as const;
        type ValidStatus = typeof VALID_STATUSES[number];
        const statusParam = url.searchParams.get('status') ?? 'pending';
        if (!(VALID_STATUSES as readonly string[]).includes(statusParam)) {
          return badRequest(res, `invalid status: '${statusParam}'. Expected one of ${VALID_STATUSES.join(', ')}.`);
        }
        const candidates = listCandidatesForRole(deps.db, roleId, { status: statusParam as ValidStatus });
        return send(res, 200, { candidates });
      }

      // Phase 78: candidate lifecycle endpoints. All three POST verbs work
      // on a single candidate id.
      //   POST /api/knowledge-candidates/:id/accept
      //     — flips status to accepted + invokes updateRole.appendDocuments
      //       (Phase 66 conflict-detection runs unchanged; if it returns
      //       'conflicts', we leave the candidate as 'pending' and surface
      //       the conflict payload to the renderer for confirmation).
      //   POST /api/knowledge-candidates/:id/reject
      //     — flips status to rejected (terminal; the dedup index will
      //       then prevent the same text from being re-suggested).
      //   POST /api/knowledge-candidates/:id/edit-and-accept
      //     — body { chunkText: string } updates the candidate text (+
      //       recomputes hash) THEN runs accept.
      const candidateActionMatch = url.pathname.match(
        /^\/api\/knowledge-candidates\/([^/]+)\/(accept|reject|edit-and-accept)$/,
      );
      if (candidateActionMatch) {
        if (req.method !== 'POST') return methodNotAllowed(res);
        const candidateId = candidateActionMatch[1]!;
        const action = candidateActionMatch[2] as 'accept' | 'reject' | 'edit-and-accept';
        const before = getCandidateById(deps.db, candidateId);
        if (!before) return notFound(res);
        if (before.status !== 'pending') {
          return send(res, 409, {
            error: 'not_pending',
            message: `Candidate is already ${before.status}; only pending candidates can transition.`,
            currentStatus: before.status,
          });
        }

        const now = new Date().toISOString();

        if (action === 'reject') {
          const flipped = setCandidateStatus(deps.db, candidateId, 'rejected', now);
          deps.logger?.info('knowledge_candidate_rejected', {
            data: { candidateId, roleId: before.roleId, flipped },
          });
          return send(res, 200, { candidateId, status: 'rejected', flipped });
        }

        // For edit-and-accept, parse + apply the edit BEFORE the accept
        // flow runs. We require chunkText in the body and re-validate via
        // updateCandidateText so the partial-unique-index catches dupes.
        let finalText = before.chunkText;
        if (action === 'edit-and-accept') {
          let body: { chunkText?: unknown };
          try { body = JSON.parse(ctx.body); }
          catch { return badRequest(res, 'invalid JSON body'); }
          if (typeof body.chunkText !== 'string' || body.chunkText.trim().length === 0) {
            return badRequest(res, 'chunkText must be a non-empty string');
          }
          finalText = body.chunkText;
          const newHash = createHash('sha256').update(finalText).digest('hex');
          try {
            const ok = updateCandidateText(deps.db, candidateId, finalText, newHash);
            if (!ok) return notFound(res);
          } catch (err) {
            const code = (err as { code?: string }).code;
            if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT') {
              return send(res, 409, {
                error: 'edit_collides',
                message: 'Edited text collides with another pending or rejected candidate for this role.',
              });
            }
            throw err;
          }
        }

        // Accept path: run updateRole with the candidate text as a single
        // appended document. Phase 66's conflict detection still applies —
        // if it returns 'conflicts', we leave the candidate pending and
        // surface the conflicts so the user resolves before retrying.
        try {
          const result = await updateRoleLibrary(deps.db, {
            roleId: before.roleId,
            appendDocuments: [{
              filename: `capture-${candidateId}`,
              content: finalText,
              kind: before.kind,
              sourceKind: 'inline',
              origin: `capture-${candidateId}`,
              sourceLabel: `Captured from chat ${before.hostSessionId?.slice(0, 8) ?? 'unknown'}`,
            }],
            embedFn: makePseudoEmbedFn(),
          });
          if (result.status === 'conflicts') {
            // Phase 66: report conflicts to the caller; candidate stays
            // pending so the user can either Edit-and-Accept with a
            // different phrasing, or call accept again with `force=true`
            // (not yet exposed here — TODO if the user hits this often).
            return send(res, 409, {
              error: 'conflicts',
              message: 'Accepting this candidate would create near-duplicate chunks. Resolve via the existing chunks UI then retry.',
              conflicts: result.conflicts,
            });
          }
          const flipped = setCandidateStatus(deps.db, candidateId, 'accepted', now);
          deps.logger?.info('knowledge_candidate_accepted', {
            data: {
              candidateId, roleId: before.roleId,
              edited: action === 'edit-and-accept',
              chunksAdded: result.chunksAdded, flipped,
            },
          });
          return send(res, 200, {
            candidateId, status: 'accepted', flipped,
            chunksAdded: result.chunksAdded,
          });
        } catch (err) {
          return internalError(res, err);
        }
      }

      // Phase 73: explicit drop endpoint. DELETE /api/knowledge-sources/:id
      // → cascade-removes the source row + every derived chunk via the SQL
      // FK. Renderer calls this from the Sources list's "Drop" button. The
      // MCP tool path (`drop_knowledge_source`) calls the same library
      // helper, so the two routes can't diverge in semantics.
      const sourceMatch = url.pathname.match(/^\/api\/knowledge-sources\/([^/]+)$/);
      if (sourceMatch) {
        if (req.method !== 'DELETE') return methodNotAllowed(res);
        const before = getSource(deps.db, sourceMatch[1]!);
        if (!before) return notFound(res);
        const result = deleteSource(deps.db, sourceMatch[1]!);
        deps.logger?.info('knowledge_source_dropped', {
          data: { sourceId: sourceMatch[1]!, roleId: before.roleId, chunksDeleted: result.chunksDeleted },
        });
        return send(res, 200, { ...result, source: before });
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

      // Phase 63: register helm's MCP server with the user's CLI/IDE from
      // the renderer's "Set up Claude Code / Cursor" buttons. Replaces the
      // PATH-dependent `helm setup-mcp <target>` shell command — same
      // underlying `setupMcp()` logic, just exposed as HTTP.
      if (url.pathname === '/api/setup-mcp') {
        if (req.method !== 'POST') return methodNotAllowed(res);
        if (!deps.setupMcp) {
          return send(res, 501, { error: 'not_implemented' });
        }
        let parsed: unknown;
        try { parsed = JSON.parse(ctx.body); }
        catch { return badRequest(res, 'invalid JSON'); }
        if (!parsed || typeof parsed !== 'object') {
          return badRequest(res, 'body must be a JSON object');
        }
        const target = (parsed as Record<string, unknown>)['target'];
        if (target !== 'claude' && target !== 'cursor') {
          return badRequest(res, 'target must be "claude" or "cursor"');
        }
        try {
          const result = deps.setupMcp(target);
          deps.logger?.info('setup_mcp', { data: { target, ...result } });
          return send(res, 200, { target, ...result });
        } catch (err) {
          return send(res, 500, { error: 'setup_failed', message: (err as Error).message });
        }
      }

      // Phase 62: from the renderer's "Mirror to Lark" button, mint a
      // pending_binds code without waiting for an `@bot bind chat` message
      // in Lark. The user copies the code into a Lark thread (`@bot bind X`)
      // → the listener consumes it → Phase 61 ack fires.
      if (url.pathname === '/api/bindings/initiate') {
        if (req.method !== 'POST') return methodNotAllowed(res);
        if (!deps.initiateLarkBind) {
          return send(res, 501, { error: 'not_implemented', message: 'Lark not configured' });
        }
        let parsed: unknown = {};
        if (ctx.body) {
          try { parsed = JSON.parse(ctx.body); }
          catch { return badRequest(res, 'invalid JSON'); }
        }
        const obj = (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {};
        const label = typeof obj['label'] === 'string' && obj['label'].trim()
          ? obj['label'].trim().slice(0, 60)
          : undefined;
        const hostSessionId = typeof obj['hostSessionId'] === 'string' && obj['hostSessionId'].trim()
          ? obj['hostSessionId'].trim()
          : undefined;
        const result = deps.initiateLarkBind({
          ...(label ? { label } : {}),
          ...(hostSessionId ? { hostSessionId } : {}),
        });
        deps.logger?.info('lark_bind_initiated', {
          data: { code: result.code, label, hostSessionId, expiresAt: result.expiresAt },
        });
        return send(res, 200, result);
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
        // Phase 72: capture hostSessionId BEFORE deleting so the
        // binding.removed event can carry it to the orchestrator's
        // pending-approval auto-settle listener. Otherwise the row is
        // gone and downstream listeners can't tell which chat lost its
        // binding.
        const existing = getChannelBinding(deps.db, bindingMatch[1]!);
        const removed = deleteChannelBinding(deps.db, bindingMatch[1]!);
        if (!removed) return send(res, 404, { error: 'unknown_binding' });
        deps.events?.emit({
          type: 'binding.removed',
          bindingId: bindingMatch[1]!,
          ...(existing?.hostSessionId ? { hostSessionId: existing.hostSessionId } : {}),
        });
        return send(res, 200, { ok: true });
      }

      // ── Harness toolchain (Phase 67) ────────────────────────────────────
      //
      // The renderer hits these from the Harness page. Most of them are
      // lightweight wrappers around src/harness/library — the real surface
      // is the MCP tool set used by Cursor agents. The HTTP layer exists so
      // the helm UI doesn't have to speak MCP.

      // ── Engine health (Phase 68) ─────────────────────────────────────
      //
      // GET /api/engine/health → [{ engine, ready, detail, hint? }, ...]
      // Lets the Settings page show "cursor (ready) / claude (missing — Run
      // `claude login`)" alongside the Default engine selector.

      if (url.pathname === '/api/engine/health') {
        if (req.method !== 'GET') return methodNotAllowed(res);
        if (!deps.getEngineHealth) {
          return send(res, 501, {
            error: 'not_implemented', message: 'engine health detection not wired',
          });
        }
        try {
          const healths = await deps.getEngineHealth();
          return send(res, 200, { engines: healths });
        } catch (err) {
          return internalError(res, err);
        }
      }

      if (url.pathname === '/api/harness/tasks') {
        if (req.method === 'GET') {
          const projectPath = url.searchParams.get('projectPath') ?? undefined;
          const tasks = harnessLib.listTasks(deps.db, projectPath ? { projectPath } : {});
          return send(res, 200, { tasks });
        }
        if (req.method === 'POST') {
          let parsed: { taskId?: string; title?: string; projectPath?: string;
            hostSessionId?: string;
            intent?: { background?: string; objective?: string; scopeIn?: string[]; scopeOut?: string[] };
          };
          try { parsed = JSON.parse(ctx.body); } catch { return badRequest(res, 'invalid JSON'); }
          if (!parsed.taskId || !parsed.title || !parsed.projectPath) {
            return badRequest(res, 'taskId, title, projectPath are required');
          }
          try {
            const intentInput = parsed.intent
              ? {
                  ...(parsed.intent.background !== undefined ? { background: parsed.intent.background } : {}),
                  ...(parsed.intent.objective !== undefined ? { objective: parsed.intent.objective } : {}),
                  ...(parsed.intent.scopeIn !== undefined ? { scopeIn: parsed.intent.scopeIn } : {}),
                  ...(parsed.intent.scopeOut !== undefined ? { scopeOut: parsed.intent.scopeOut } : {}),
                }
              : undefined;
            const result = harnessLib.createTask(deps.db, {
              taskId: parsed.taskId,
              title: parsed.title,
              projectPath: parsed.projectPath,
              ...(parsed.hostSessionId ? { hostSessionId: parsed.hostSessionId } : {}),
              ...(intentInput ? { intent: intentInput } : {}),
            });
            return send(res, 200, { task: result.task, relatedFound: result.relatedFound });
          } catch (err) {
            return badRequest(res, (err as Error).message);
          }
        }
        return methodNotAllowed(res);
      }

      const taskByIdMatch = url.pathname.match(/^\/api\/harness\/tasks\/([^/]+)$/);
      if (taskByIdMatch) {
        const taskId = taskByIdMatch[1]!;
        if (req.method === 'GET') {
          try { return send(res, 200, harnessLib.getTask(deps.db, taskId)); }
          catch { return send(res, 404, { error: 'unknown_task' }); }
        }
        return methodNotAllowed(res);
      }

      const advanceMatch = url.pathname.match(/^\/api\/harness\/tasks\/([^/]+)\/advance$/);
      if (advanceMatch) {
        if (req.method !== 'POST') return methodNotAllowed(res);
        let parsed: { toStage?: 'implement' | 'archived'; implementBaseCommit?: string; message?: string };
        try { parsed = JSON.parse(ctx.body); } catch { return badRequest(res, 'invalid JSON'); }
        if (!parsed.toStage) return badRequest(res, 'toStage is required');
        try {
          const updated = harnessLib.advanceStage(deps.db, {
            taskId: advanceMatch[1]!,
            toStage: parsed.toStage,
            ...(parsed.implementBaseCommit ? { implementBaseCommit: parsed.implementBaseCommit } : {}),
            ...(parsed.message ? { message: parsed.message } : {}),
          });
          return send(res, 200, updated);
        } catch (err) {
          return badRequest(res, (err as Error).message);
        }
      }

      const reviewSpawnMatch = url.pathname.match(/^\/api\/harness\/tasks\/([^/]+)\/review$/);
      if (reviewSpawnMatch) {
        if (req.method === 'GET') {
          // List reviews for the task (newest first).
          const reviews = harnessReviewRepos.listReviewsForTask(deps.db, reviewSpawnMatch[1]!);
          return send(res, 200, { reviews });
        }
        if (req.method !== 'POST') return methodNotAllowed(res);
        if (!deps.runHarnessReview) {
          return send(res, 501, {
            error: 'not_implemented',
            message: 'review subprocess factory not wired (claude CLI may be missing)',
          });
        }
        // Run review asynchronously is tempting but MVP: await it. The
        // subprocess timeout is bounded; the renderer fetches with a long
        // timeout. If we ever care about backgrounding, switch to a job
        // queue + status polling.
        try {
          const review = await deps.runHarnessReview(reviewSpawnMatch[1]!);
          return send(res, 200, review);
        } catch (err) {
          return internalError(res, err);
        }
      }

      const reviewByIdMatch = url.pathname.match(/^\/api\/harness\/reviews\/([^/]+)$/);
      if (reviewByIdMatch) {
        if (req.method !== 'GET') return methodNotAllowed(res);
        const review = harnessReviewRepos.getReview(deps.db, reviewByIdMatch[1]!);
        if (!review) return send(res, 404, { error: 'unknown_review' });
        return send(res, 200, review);
      }

      const pushReviewMatch = url.pathname.match(
        /^\/api\/harness\/tasks\/([^/]+)\/push-review\/([^/]+)$/,
      );
      if (pushReviewMatch) {
        if (req.method !== 'POST') return methodNotAllowed(res);
        try {
          const result = harnessLib.pushReviewToImplementChat(
            deps.db,
            { taskId: pushReviewMatch[1]!, reviewId: pushReviewMatch[2]! },
            deps.events,
          );
          return send(res, 200, result);
        } catch (err) {
          return badRequest(res, (err as Error).message);
        }
      }

      const archiveMatch = url.pathname.match(/^\/api\/harness\/tasks\/([^/]+)\/archive$/);
      if (archiveMatch) {
        if (req.method !== 'POST') return methodNotAllowed(res);
        let parsed: {
          oneLiner?: string;
          entities?: string[]; filesTouched?: string[]; modules?: string[];
          patterns?: string[]; downstream?: string[]; rulesApplied?: string[];
        };
        try { parsed = JSON.parse(ctx.body); } catch { return badRequest(res, 'invalid JSON'); }
        if (!parsed.oneLiner) return badRequest(res, 'oneLiner is required');
        try {
          const result = harnessLib.archiveTask(deps.db, {
            taskId: archiveMatch[1]!,
            oneLiner: parsed.oneLiner,
            ...(parsed.entities ? { entities: parsed.entities } : {}),
            ...(parsed.filesTouched ? { filesTouched: parsed.filesTouched } : {}),
            ...(parsed.modules ? { modules: parsed.modules } : {}),
            ...(parsed.patterns ? { patterns: parsed.patterns } : {}),
            ...(parsed.downstream ? { downstream: parsed.downstream } : {}),
            ...(parsed.rulesApplied ? { rulesApplied: parsed.rulesApplied } : {}),
          });
          return send(res, 200, result);
        } catch (err) {
          return badRequest(res, (err as Error).message);
        }
      }

      const reindexMatch = url.pathname.match(/^\/api\/harness\/tasks\/([^/]+)\/reindex$/);
      if (reindexMatch) {
        if (req.method !== 'POST') return methodNotAllowed(res);
        let parsed: { projectPath?: string };
        try { parsed = JSON.parse(ctx.body); } catch { return badRequest(res, 'invalid JSON'); }
        if (!parsed.projectPath) return badRequest(res, 'projectPath required');
        const result = harnessLib.reindexTask(deps.db, parsed.projectPath, reindexMatch[1]!);
        if (!result) return send(res, 404, { error: 'task_md_not_found' });
        return send(res, 200, result);
      }

      if (url.pathname === '/api/harness/archive') {
        if (req.method !== 'GET') return methodNotAllowed(res);
        const projectPath = url.searchParams.get('projectPath') ?? undefined;
        const tokens = (url.searchParams.getAll('q') || []).filter((t) => t.length > 0);
        if (tokens.length > 0) {
          return send(res, 200, {
            cards: harnessLib.searchArchive(deps.db, {
              tokens,
              ...(projectPath ? { projectPath } : {}),
            }),
          });
        }
        return send(res, 200, {
          cards: harnessLib.listArchiveCards(
            deps.db,
            projectPath ? { projectPath } : {},
          ),
        });
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
  // Phase 73: per-doc typing + provenance. New fields are all optional so
  // the existing renderer / older API clients keep working unchanged.
  const KIND_VALUES = ['spec', 'example', 'warning', 'runbook', 'glossary', 'other'] as const;
  const SOURCE_KIND_VALUES = ['lark-doc', 'file', 'inline'] as const;
  type KindLit = (typeof KIND_VALUES)[number];
  type SourceKindLit = (typeof SOURCE_KIND_VALUES)[number];
  const docs: Array<{
    filename: string;
    content: string;
    kind?: KindLit;
    sourceKind?: SourceKindLit;
    origin?: string;
    sourceLabel?: string;
  }> = [];
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
    const doc: typeof docs[number] = { filename: d['filename'], content: d['content'] };
    if (d['kind'] !== undefined) {
      if (typeof d['kind'] !== 'string' || !KIND_VALUES.includes(d['kind'] as KindLit)) {
        return badRequest(ctx.response, `kind must be one of ${KIND_VALUES.join(' / ')}`);
      }
      doc.kind = d['kind'] as KindLit;
    }
    if (d['sourceKind'] !== undefined) {
      if (typeof d['sourceKind'] !== 'string' || !SOURCE_KIND_VALUES.includes(d['sourceKind'] as SourceKindLit)) {
        return badRequest(ctx.response, `sourceKind must be one of ${SOURCE_KIND_VALUES.join(' / ')}`);
      }
      doc.sourceKind = d['sourceKind'] as SourceKindLit;
    }
    if (d['origin'] !== undefined) {
      if (typeof d['origin'] !== 'string') return badRequest(ctx.response, 'origin must be a string');
      doc.origin = d['origin'];
    }
    if (d['sourceLabel'] !== undefined) {
      if (typeof d['sourceLabel'] !== 'string') return badRequest(ctx.response, 'sourceLabel must be a string');
      doc.sourceLabel = d['sourceLabel'];
    }
    docs.push(doc);
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
 * Phase 60b: appended to claude's default system prompt when role-coaching.
 * Kept short — claude already knows how to behave as an agent. We just add
 * the helm-specific job description and the closing-tool hint.
 */
const ROLE_TRAIN_SYSTEM_PROMPT = [
  'You are role-coaching the user to define a new helm role (an AI persona with its own',
  'system prompt + knowledge chunks). Ask clarifying questions, summarize what you',
  'understand, and stop when the user confirms the draft.',
  '',
  'When the user is ready, call the `train_role` MCP tool to save the role:',
  '  train_role({ roleId: "<slug>", name: "<display name>",',
  '               baseSystemPrompt: "<self-contained prompt in 2nd person>",',
  '               documents: [{ filename, content }] })',
  'Use the conversation transcript itself as one document so the user can audit later.',
  '',
  'Hard rules:',
  '  - Never invent expertise the user did not describe.',
  '  - Mirror the user\'s language (Chinese ↔ Chinese, English ↔ English).',
  '  - Keep each turn short — the user is in a chat box, not reading docs.',
  '  - When the user pastes a Lark doc URL, call `read_lark_doc` rather than',
  '    paraphrasing from memory.',
].join('\n');

function handleRoleTrainChat(ctx: RouteContext, deps: HttpApiDeps): void {
  // Phase 68: prefer runConversation (engine-router-routed); fall back to
  // legacy cliAgentFactory (direct ClaudeCodeAgent) so existing test seams
  // that wire only `cliAgentFactory` still work.
  const runConv = deps.runConversation;
  const legacyFactory = deps.cliAgentFactory;
  if (!runConv && !legacyFactory) {
    return send(ctx.response, 501, {
      error: 'not_implemented',
      message:
        'role-train chat backend is not wired. Install Claude Code or Cursor '
        + 'CLI, then check helm Settings → Default engine.',
    });
  }
  let parsed: unknown;
  try { parsed = JSON.parse(ctx.body); }
  catch { return badRequest(ctx.response, 'invalid JSON'); }
  if (!parsed || typeof parsed !== 'object') {
    return badRequest(ctx.response, 'body must be a JSON object');
  }
  const { messages, projectPath } = parsed as { messages?: unknown; projectPath?: unknown };
  if (!Array.isArray(messages) || messages.length === 0) {
    return badRequest(ctx.response, 'messages must be a non-empty array of {role,content}');
  }
  if (projectPath !== undefined && typeof projectPath !== 'string') {
    return badRequest(ctx.response, 'projectPath must be a string when provided');
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

  void (async () => {
    try {
      let result;
      if (runConv) {
        const convInput: import('../engine/types.js').RunConversationInput = {
          messages: validated,
          systemPrompt: ROLE_TRAIN_SYSTEM_PROMPT,
        };
        if (projectPath) convInput.cwd = projectPath;
        const r = await runConv(convInput);
        if (!r) {
          return send(ctx.response, 501, {
            error: 'no_provider',
            message:
              'No engine adapter is currently available. Open helm Settings → '
              + 'Default engine and pick / install one (claude or cursor).',
          });
        }
        result = r;
      } else {
        // Legacy path: ClaudeCodeAgent directly. Kept so test seams that
        // wire `cliAgentFactory` directly still pass.
        const agent = legacyFactory!(projectPath ? { cwd: projectPath } : undefined);
        if (!agent) {
          return send(ctx.response, 501, {
            error: 'no_provider',
            message:
              'Claude Code CLI not detected. Install it from https://code.claude.com '
              + 'and `claude login` once, then retry.',
          });
        }
        try {
          result = await agent.sendConversation(validated, {
            systemPrompt: ROLE_TRAIN_SYSTEM_PROMPT,
          });
        } finally {
          agent.dispose();
        }
      }
      deps.logger?.info('role_train_chat_turn', {
        data: {
          sessionId: result.sessionId,
          msgs: validated.length,
          stderrLen: result.stderr.length,
        },
      });
      return send(ctx.response, 200, {
        message: { role: 'assistant', content: result.text },
        sessionId: result.sessionId,
        ...(result.stderr ? { stderr: result.stderr } : {}),
      });
    } catch (err) {
      // Phase 68 + #68: route claude / cursor errors through the same
      // interpreter so the modal sees an actionable "install / login"
      // message instead of a raw ENOENT / 401 dump. The legacy ClaudeCodeAgent
      // is disposed inside the inner try/finally above (line ~1466), so no
      // outer cleanup needed here.
      const { interpretClaudeError } = await import('../cli-agent/claude.js');
      const interpreted = interpretClaudeError(err);
      deps.logger?.warn('role_train_chat_failed', {
        data: { error: interpreted.raw, hint: interpreted.hint },
      });
      return send(ctx.response, 502, {
        error: 'cli_failed',
        message: interpreted.message,
        hint: interpreted.hint,
      });
    }
  })();
}

// Phase 60b: removed handleRoleTrainChatCommit, parseRoleSpec, slugify.
// The Phase 57 flow asked the LLM to emit a JSON role spec which helm then
// pipelined into trainRole(). With claude as the agent backend, that
// distillation is unnecessary — the agent itself calls the `train_role`
// MCP tool when the user is ready, and helm's MCP server runs the same
// trainRole pipeline directly. One fewer round-trip + one fewer brittle
// JSON-parse step.
