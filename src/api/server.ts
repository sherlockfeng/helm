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
  listSessions,
  countSessions,
  removeHostSessionRole,
  setHostSessionDisplayName,
  setHostSessionRole,
  setSessionCaptureDisabled,
  updateHostSession,
} from '../storage/repos/host-sessions.js';
import { getConversationDetail } from './conversation-detail.js';
import { refreshClaudeSessionTitle } from '../host/claude-code/title-refresh.js';
import {
  flipCaseStatus,
  getCase,
  insertCase,
  listAlerts,
  listCases,
  listRunsForCase,
} from '../storage/repos/benchmark.js';
import { enqueueAffectedRuns } from '../verification/auto-trigger.js';
import {
  KnowledgeRepoManager,
  KnowledgeRepoManagerError,
} from '../knowledge-repo/manager.js';
import {
  deleteKnowledgeRepo,
  getKnowledgeRepo,
  listKnowledgeRepos,
  setRepoImportDirs,
} from '../storage/repos/knowledge-repo.js';
import { GitUrlError } from '../knowledge-repo/url.js';
import {
  KNOWLEDGE_REPO_SEEDS,
  findSeedById,
} from '../knowledge-repo/seeds.js';
import { updateChunkWithVersionCheck } from '../storage/repos/roles.js';
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
import { promptCountsByHostSession } from '../storage/repos/host-event-log.js';
import { pendingCountsByHostSession as candidateCountsByHostSession } from '../storage/repos/knowledge-candidates.js';
import {
  deleteRole as deleteRoleRepo,
  deleteSource,
  getChunkById as getChunkByIdRepo,
  setRoleBindable,
  getChunksForRole,
  getRole as getRoleRow,
  getSource,
  listRoles as listRolesRepo,
  listSourcesForRole,
  unarchiveChunk as unarchiveChunkRepo,
  upsertRole as upsertRoleRepo,
} from '../storage/repos/roles.js';
import {
  getChatKnowledgePoint,
  setChatKnowledgePointStatus,
} from '../storage/repos/chat-knowledge.js';
import {
  bulkRejectCandidates,
  getCandidateById,
  listCandidatesForRole,
  listReviewCandidates,
  pendingCountsByRole,
  setCandidateStatus,
  updateCandidateText,
} from '../storage/repos/knowledge-candidates.js';
import { updateRole as updateRoleLibrary } from '../roles/library.js';
import { makePseudoEmbedFn } from '../mcp/embed.js';
import { slugifyPointId } from '../knowledge-repo/slug.js';
import { queryKnowledge } from '../mcp/tools/query-knowledge.js';
import {
  fetchAndCacheCandidateContext,
  getCandidateContexts,
} from '../knowledge/candidate-context.js';
import { draftPromotionDoc } from '../knowledge/promote-draft.js';
import type { KnowledgeProviderRegistry } from '../knowledge/types.js';
import { createHash, randomUUID } from 'node:crypto';
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
import { scanHistory, type ScanHost } from '../history/index.js';

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
   * PR 6 (auto-trigger): optional Verification runner the candidate
   * accept path enqueues affected cases against. Absent = no-op
   * (existing tests + CI without LLM credentials run cleanly).
   */
  verificationRunner?: (caseId: string) => Promise<import('../storage/types.js').BenchmarkRun | null>;
  /**
   * PR 5.5a: optional KnowledgeRepoManager bound to the same DB.
   * Absent = `/api/knowledge-repos` endpoints respond 501 so the
   * renderer can hide the git surface in environments where git is
   * unavailable. Production wires this from orchestrator.
   */
  knowledgeRepoManager?: KnowledgeRepoManager;
  /**
   * Provider registry for POST /api/knowledge-lookup — the renderer's
   * "外部知识对照" button queries external knowledge (custom MCP
   * bridges, depscope, …) with a candidate's text to show org-side
   * context next to chat-captured content. Absent = endpoint responds 501.
   */
  knowledge?: KnowledgeProviderRegistry;
  /**
   * PR-γ2: lazy LLM getter for the AI-整理 promote draft. A getter
   * (not a client) because engine wiring is hot-reloaded with config;
   * it throws when no engine is available.
   */
  promoteDraftLlm?: () => import('../summarizer/campaign.js').LlmClient;
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
   * R-18 wire-up: per-agent hook installer. Returns the HTTP status
   * the endpoint should send back + the body payload. Codex agents
   * legitimately return `{ status: 501, body: { error, message } }`
   * until that adapter's install path lands; the API layer just
   * forwards.
   */
  hostInstaller?: (input: {
    agent: 'cursor' | 'claude-code' | 'codex';
    action: 'install' | 'uninstall' | 'status';
  }) => Promise<{ status: number; body: Record<string, unknown> }>;
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
   * PR-B (Conversations curation): run the LLM-driven curation pass
   * for one chat × role pair. Returns the resulting candidate count.
   * Undefined when no engine is wired — the endpoint surfaces 501.
   */
  runCuration?: (input: {
    hostSessionId: string;
    roleId: string;
  }) => Promise<{ updateCount: number; newCount: number; candidateIds: string[] }>;
  /**
   * v35: force the LLM chat knowledge-point extraction now (the manual
   * "✨ 提取知识点" button). Same pass the Stop hook throttles. Returns the
   * number of new points inserted.
   */
  extractChatKnowledge?: (input: {
    hostSessionId: string;
  }) => Promise<{ inserted: number }>;
  /**
   * PR-C (Path B): create a new role from a chat's unknown entities,
   * then immediately run curation against the new role so the user
   * sees candidates without a second click. Returns the new role id +
   * the curation tally.
   */
  spawnRoleFromChat?: (input: {
    hostSessionId: string;
    entities: string[];
    roleName?: string;
    roleId?: string;
  }) => Promise<{
    roleId: string;
    roleName: string;
    updateCount: number;
    newCount: number;
    candidateIds: string[];
  }>;
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
  /** helm's own version (from package.json) — cross-version debugging. */
  helmVersion?: string;
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

/**
 * Knowledge-tier origin of a role, derived from where its points live in
 * the llm-wiki working copy:
 *   - domains/… , wiki/…  → team-mature layer (already promoted / read-only)
 *   - chat-captured/… , no source_file (in-chat entity bucket) → personal
 *
 * A role is 'team' only when it has points AND every sourced point is
 * team-layer (an import from domains/stability is 100% domains/). Any
 * personal-origin point flips it to 'personal' so a mixed bucket keeps
 * Contribute. The UI uses this to hide Contribute on team-layer topics —
 *升格回 domains/ 对已经在 domains/ 的知识没有意义。
 */
function classifyRoleTier(
  chunks: ReadonlyArray<{ sourceFile?: string | null }>,
): 'team' | 'personal' {
  let sawTeam = false;
  for (const c of chunks) {
    const sf = c.sourceFile ?? '';
    if (sf.startsWith('domains/') || sf.startsWith('wiki/')) {
      sawTeam = true;
    } else {
      // chat-captured/… or no source_file (entity bucket) → personal.
      return 'personal';
    }
  }
  return sawTeam ? 'team' : 'personal';
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

      const body = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH'
        ? await readBody(req) : '';
      const ctx: RouteContext = { url, request: req, response: res, body };

      if (url.pathname === '/api/health') {
        if (req.method !== 'GET') return methodNotAllowed(res);
        return send(res, 200, { ok: true, name: appName, version: appVersion });
      }

      // PR 3 (Conversation Detail): GET /api/conversations/:id returns the
      // joined detail (header + timeline + knowledge_in_play + candidates).
      // Aliased under both /api/conversations/ (new IA naming) and the
      // legacy /api/active-chats/:id/detail for renderers that haven't
      // migrated.
      const conversationDetailMatch = url.pathname.match(
        /^\/api\/(?:conversations|active-chats)\/([^/]+)\/detail$/,
      );
      if (conversationDetailMatch) {
        if (req.method !== 'GET') return methodNotAllowed(res);
        // Lazy title sync: claude code has no rename hook, so an idle
        // chat renamed in the TUI never syncs via Stop. Opening the
        // detail is the natural "user is looking at this chat" moment
        // to catch up. Best-effort — failures must not break the read.
        try { refreshClaudeSessionTitle(deps.db, conversationDetailMatch[1]!); }
        catch { /* transcript unreadable — keep the stored name */ }
        const detail = getConversationDetail(deps.db, conversationDetailMatch[1]!);
        if (!detail) return send(res, 404, { error: 'Conversation not found' });
        return send(res, 200, detail);
      }

      // PR-C: create a role from this chat's unknown entities, train
      // it on the chat passages mentioning those entities, and auto-run
      // curation. One round-trip from the renderer's "新建 role" modal.
      const conversationSpawnRoleMatch = url.pathname.match(
        /^\/api\/conversations\/([^/]+)\/spawn-role$/,
      );
      if (conversationSpawnRoleMatch) {
        if (req.method !== 'POST') return methodNotAllowed(res);
        if (!deps.spawnRoleFromChat) {
          return send(res, 501, {
            error: 'not_implemented',
            message: 'Spawn-role engine not wired — open Settings → Default engine to enable.',
          });
        }
        let body: { entities?: unknown; roleName?: unknown; roleId?: unknown };
        try { body = JSON.parse(ctx.body) as typeof body; }
        catch { return send(res, 400, { error: 'invalid_json' }); }
        const entities = Array.isArray(body.entities)
          ? body.entities.filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
          : [];
        if (entities.length === 0) {
          return send(res, 400, { error: 'invalid_request', message: 'entities[] required' });
        }
        const roleName = typeof body.roleName === 'string' ? body.roleName.trim() : undefined;
        const roleId = typeof body.roleId === 'string' ? body.roleId.trim() : undefined;
        try {
          const result = await deps.spawnRoleFromChat({
            hostSessionId: conversationSpawnRoleMatch[1]!,
            entities,
            ...(roleName ? { roleName } : {}),
            ...(roleId ? { roleId } : {}),
          });
          return send(res, 200, result);
        } catch (err) {
          return send(res, 500, {
            error: 'spawn_role_failed',
            message: (err as Error).message,
          });
        }
      }

      // PR-B: trigger LLM curation for one chat × role pair. Called from
      // the renderer when the user clicks "extract" on a role suggestion.
      // Best-effort — returns counts but doesn't block on candidate
      // dedup / SSE; the caller refetches /detail after the round-trip.
      const conversationExtractMatch = url.pathname.match(
        /^\/api\/conversations\/([^/]+)\/extract$/,
      );
      if (conversationExtractMatch) {
        if (req.method !== 'POST') return methodNotAllowed(res);
        if (!deps.runCuration) {
          return send(res, 501, {
            error: 'not_implemented',
            message: 'Curation engine is not wired — open Settings → Default engine to enable.',
          });
        }
        let body: { roleId?: unknown };
        try { body = JSON.parse(ctx.body) as typeof body; }
        catch { return send(res, 400, { error: 'invalid_json' }); }
        const roleId = typeof body.roleId === 'string' ? body.roleId.trim() : '';
        if (!roleId) {
          return send(res, 400, { error: 'invalid_request', message: 'roleId is required' });
        }
        try {
          const result = await deps.runCuration({
            hostSessionId: conversationExtractMatch[1]!,
            roleId,
          });
          return send(res, 200, result);
        } catch (err) {
          return send(res, 500, {
            error: 'curation_failed',
            message: (err as Error).message,
          });
        }
      }

      if (url.pathname === '/api/active-chats') {
        if (req.method !== 'GET') return methodNotAllowed(res);
        // ?status=active (default, back-compat) | closed | all — the
        // History view passes closed/all to surface ended sessions.
        const statusParam = url.searchParams.get('status');
        const filter = statusParam === 'closed' || statusParam === 'all'
          ? statusParam : 'active';
        // History can hold thousands of closed sessions after a backfill;
        // cap the rail at the most-recent N and report the true total so the
        // UI can show "显示最近 N / 共 M". Active is never capped (few rows).
        const HISTORY_LIMIT = 500;
        const limit = filter === 'active' ? undefined : HISTORY_LIMIT;
        const sessions = listSessions(deps.db, filter, limit);
        const total = filter === 'active' ? sessions.length : countSessions(deps.db, filter);
        // Three aggregate queries (queued messages, prompt count = turns,
        // pending candidates) hydrate every Active Chats row in one
        // round-trip. The rail uses these to render compact 2-line cards
        // ("Goofy 专家 · 12 turns · 5m · 2 candidates") without needing a
        // detail fetch per row.
        const queueDepth = pendingMessageCountsByHostSession(deps.db);
        const turnsBySession = promptCountsByHostSession(deps.db);
        const candidatesBySession = candidateCountsByHostSession(deps.db);
        const enriched = sessions.map((s) => ({
          ...s,
          ...(queueDepth[s.id] ? { queuedMessageCount: queueDepth[s.id] } : {}),
          ...(turnsBySession[s.id] ? { turnCount: turnsBySession[s.id] } : {}),
          ...(candidatesBySession[s.id]
            ? { pendingCandidateCount: candidatesBySession[s.id] }
            : {}),
        }));
        return send(res, 200, { chats: enriched, total });
      }

      // History backfill: scan a host's on-disk transcripts and import
      // pre-helm conversations as closed sessions. Idempotent — re-scanning
      // skips sessions already in the DB.
      if (url.pathname === '/api/history/scan') {
        if (req.method !== 'POST') return methodNotAllowed(res);
        let body: { host?: string } = {};
        if (ctx.body) {
          try { body = JSON.parse(ctx.body) as typeof body; }
          catch { return badRequest(res, 'invalid JSON body'); }
        }
        const host = body.host;
        const valid = host === 'claude-code' || host === 'cursor'
          || host === 'codex' || host === 'all' || host === undefined;
        if (!valid) return badRequest(res, `unknown host: ${String(host)}`);
        const results = scanHistory(deps.db, (host ?? 'all') as ScanHost);
        return send(res, 200, { results });
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
      // v34: per-chat capture mute toggle.
      //   PUT /api/active-chats/:id/capture  body { enabled: boolean }
      const chatCaptureMatch = url.pathname.match(
        /^\/api\/active-chats\/([^/]+)\/capture$/,
      );
      if (chatCaptureMatch) {
        if (req.method !== 'PUT') return methodNotAllowed(res);
        let body: { enabled?: unknown };
        try { body = JSON.parse(ctx.body) as typeof body; }
        catch { return badRequest(res, 'invalid JSON body'); }
        if (typeof body.enabled !== 'boolean') {
          return badRequest(res, 'enabled must be a boolean');
        }
        const ok = setSessionCaptureDisabled(deps.db, chatCaptureMatch[1]!, !body.enabled);
        if (!ok) return notFound(res);
        return send(res, 200, { hostSessionId: chatCaptureMatch[1]!, captureEnabled: body.enabled });
      }
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
        const roles = listRolesRepo(deps.db).map((r) => {
          const chunks = getChunksForRole(deps.db, r.id);
          return {
            ...r,
            chunkCount: chunks.length,
            // Knowledge-tier origin: a topic whose points were imported
            // from the team-mature layer (domains/ or wiki/) is already
            // there — Contributing it back to domains/ is a no-op. The UI
            // hides Contribute for 'team'. Personal-layer origins
            // (chat-captured/, or in-chat entity buckets with no
            // source_file yet) keep Contribute. 'team' only when the role
            // is purely team-sourced; any personal chunk → 'personal'.
            tier: classifyRoleTier(chunks),
            pendingCandidateCount: pendingByRole.get(r.id) ?? 0,
          };
        });
        return send(res, 200, { roles });
      }
      // Topics cleanup: DELETE /api/roles/:id — remove a non-builtin
      // collection/expert with everything attached (chunks cascade via
      // FK). Guarded: built-ins are seeded from src and must stay.
      const roleDeleteMatch = url.pathname.match(/^\/api\/roles\/([^/]+)$/);
      if (roleDeleteMatch && req.method === 'DELETE') {
        const role = getRoleRow(deps.db, roleDeleteMatch[1]!);
        if (!role) return notFound(res);
        if (role.isBuiltin) {
          return send(res, 403, { error: 'builtin', message: 'Built-in roles cannot be deleted.' });
        }
        deleteRoleRepo(deps.db, role.id);
        return send(res, 200, { roleId: role.id, deleted: true });
      }
      // PR-δ: flip Expert / Collection.
      //   PATCH /api/roles/:id/bindable  body { bindable: boolean }
      const roleBindableMatch = url.pathname.match(/^\/api\/roles\/([^/]+)\/bindable$/);
      if (roleBindableMatch) {
        if (req.method !== 'PATCH') return methodNotAllowed(res);
        let body: { bindable?: unknown };
        try { body = JSON.parse(ctx.body) as typeof body; }
        catch { return badRequest(res, 'invalid JSON body'); }
        if (typeof body.bindable !== 'boolean') {
          return badRequest(res, 'bindable must be a boolean');
        }
        const ok = setRoleBindable(deps.db, roleBindableMatch[1]!, body.bindable);
        if (!ok) return notFound(res);
        return send(res, 200, { roleId: roleBindableMatch[1]!, bindable: body.bindable });
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
          // R-7: visibility drives the Internal / Public toggle in
          // Library. editVersion is the optimistic-lock cookie the
          // PATCH endpoint validates against.
          visibility: c.visibility,
          editVersion: c.editVersion,
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

      // R-7 (reviewer follow-up): PATCH /api/knowledge-chunks/:id/visibility
      //   body { visibility: 'internal' | 'public', expectedEditVersion }
      // Flipping to 'public' is the manual escape hatch the R-0 publish
      // gate needs — without this surface, an internal chunk can never
      // be promoted into a publishable point. Optimistic-locked on
      // editVersion so two flippers can't silently overwrite.
      const visibilityMatch = url.pathname.match(/^\/api\/knowledge-chunks\/([^/]+)\/visibility$/);
      if (visibilityMatch) {
        if (req.method !== 'PATCH' && req.method !== 'POST') {
          return methodNotAllowed(res);
        }
        const chunkId = visibilityMatch[1]!;
        let body: Record<string, unknown>;
        try { body = JSON.parse(ctx.body) as Record<string, unknown>; }
        catch { return badRequest(res, 'invalid JSON body'); }
        const visibility = body['visibility'];
        if (visibility !== 'internal' && visibility !== 'public') {
          return badRequest(res, "visibility must be 'internal' or 'public'");
        }
        const expectedEditVersion = body['expectedEditVersion'];
        if (typeof expectedEditVersion !== 'number' || !Number.isFinite(expectedEditVersion)) {
          return badRequest(res, 'expectedEditVersion must be a number');
        }
        const before = getChunkByIdRepo(deps.db, chunkId);
        if (!before) return notFound(res);
        const result = updateChunkWithVersionCheck(
          deps.db, chunkId, expectedEditVersion, { visibility },
        );
        if (!result.applied) {
          return send(res, 409, {
            error: 'stale',
            message: 'Chunk has been edited since you loaded it. Refresh and retry.',
            currentEditVersion: before.editVersion,
          });
        }
        deps.logger?.info('knowledge_chunk_visibility_changed', {
          data: { chunkId, roleId: before.roleId, from: before.visibility, to: visibility },
        });
        return send(res, 200, {
          chunkId,
          visibility,
          editVersion: result.newEditVersion,
        });
      }

      // PR 4 (Review inbox): cross-role candidate list for the top-level
      // Review surface (§5.3). Filters and sort are passed as query
      // params; defaults to pending + recent. The single-role
      // /api/roles/:id/candidates path below stays for the legacy Roles
      // UI Candidates tab.
      // PR 5 (Verification API): read-friendly endpoints for the
      // Cases / Runs / Coverage placeholder pages from PR 1.
      //
      //   GET  /api/verification/cases?status&roleId&limit
      //   POST /api/verification/cases  body { id?, name, question,
      //         expectedTruth, goldenPointIds[], targetRoleIds[],
      //         agentKindHint?, notes?, proposedSource?, ... }
      //   GET  /api/verification/cases/:id
      //   POST /api/verification/cases/:id/confirm  body { confirmedBy? }
      //   POST /api/verification/cases/:id/reject   body { reason? }
      //   GET  /api/verification/cases/:id/runs?limit
      //   GET  /api/verification/alerts?status&limit
      //
      // POST /api/verification/cases/:id/run is intentionally absent
      // from PR 5 — the runner requires an LLM provider config, which
      // is the next PR's wiring. Keeping it out keeps this PR
      // reviewable: schema + repo + provider validator + (mockable)
      // runner library.
      if (url.pathname === '/api/verification/cases') {
        if (req.method === 'GET') {
          const statusParam = url.searchParams.get('status') ?? 'confirmed';
          const VALID = ['proposed', 'confirmed', 'rejected', 'archived', 'all'] as const;
          if (!(VALID as readonly string[]).includes(statusParam)) {
            return badRequest(res, `invalid status: '${statusParam}'`);
          }
          const roleId = url.searchParams.get('roleId') ?? undefined;
          const limitParam = url.searchParams.get('limit');
          const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
          const cases = listCases(deps.db, {
            status: statusParam as typeof VALID[number],
            ...(roleId ? { roleId } : {}),
            ...(limit && Number.isFinite(limit) ? { limit } : {}),
          });
          return send(res, 200, { cases });
        }
        if (req.method === 'POST') {
          let body: Record<string, unknown>;
          try { body = JSON.parse(ctx.body) as Record<string, unknown>; }
          catch { return badRequest(res, 'invalid JSON body'); }
          const required = ['name', 'question', 'expectedTruth'] as const;
          for (const k of required) {
            if (typeof body[k] !== 'string' || (body[k] as string).length === 0) {
              return badRequest(res, `${k} is required and must be a non-empty string`);
            }
          }
          const id = typeof body['id'] === 'string' ? body['id'] : `bc-${randomUUID()}`;
          const goldenPointIds = Array.isArray(body['goldenPointIds'])
            ? (body['goldenPointIds'] as unknown[]).filter((x): x is string => typeof x === 'string')
            : [];
          const targetRoleIds = Array.isArray(body['targetRoleIds'])
            ? (body['targetRoleIds'] as unknown[]).filter((x): x is string => typeof x === 'string')
            : [];
          insertCase(deps.db, {
            id,
            name: body['name'] as string,
            question: body['question'] as string,
            expectedTruth: body['expectedTruth'] as string,
            goldenPointIds,
            targetRoleIds,
            ...(typeof body['agentKindHint'] === 'string'
              ? { agentKindHint: body['agentKindHint'] as 'cursor' | 'claude_code' | 'codex' }
              : {}),
            ...(typeof body['notes'] === 'string' ? { notes: body['notes'] } : {}),
            ...(typeof body['proposedSource'] === 'string'
              ? { proposedSource: body['proposedSource'] as 'manual' | 'llm-on-edit' | 'imported' }
              : {}),
          });
          const created = getCase(deps.db, id);
          return send(res, 201, { case: created });
        }
        return methodNotAllowed(res);
      }

      const caseIdMatch = url.pathname.match(/^\/api\/verification\/cases\/([^/]+)$/);
      if (caseIdMatch) {
        if (req.method !== 'GET') return methodNotAllowed(res);
        const c = getCase(deps.db, caseIdMatch[1]!);
        if (!c) return notFound(res);
        return send(res, 200, { case: c });
      }

      const caseConfirmMatch = url.pathname.match(
        /^\/api\/verification\/cases\/([^/]+)\/(confirm|reject)$/,
      );
      if (caseConfirmMatch) {
        if (req.method !== 'POST') return methodNotAllowed(res);
        const caseId = caseConfirmMatch[1]!;
        const action = caseConfirmMatch[2] as 'confirm' | 'reject';
        let body: Record<string, unknown> = {};
        if (ctx.body) {
          try { body = JSON.parse(ctx.body) as Record<string, unknown>; }
          catch { return badRequest(res, 'invalid JSON body'); }
        }
        const ok = flipCaseStatus(
          deps.db, caseId,
          action === 'confirm' ? 'confirmed' : 'rejected',
          typeof body['confirmedBy'] === 'string' ? body['confirmedBy'] : undefined,
          typeof body['reason'] === 'string' ? body['reason'] : undefined,
        );
        if (!ok) {
          return send(res, 409, {
            error: 'not_proposed',
            message: `Case is not in 'proposed' state; only proposed cases can be confirmed/rejected.`,
          });
        }
        return send(res, 200, { caseId, status: action === 'confirm' ? 'confirmed' : 'rejected' });
      }

      const caseRunsMatch = url.pathname.match(/^\/api\/verification\/cases\/([^/]+)\/runs$/);
      if (caseRunsMatch) {
        if (req.method !== 'GET') return methodNotAllowed(res);
        const limitParam = url.searchParams.get('limit');
        const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
        const runs = listRunsForCase(deps.db, caseRunsMatch[1]!, Number.isFinite(limit) ? limit : 50);
        return send(res, 200, { runs });
      }

      // PR 5b: POST /api/verification/cases/:id/run synchronously
      // executes the case via the bound runner and returns the new
      // run row. 503 when no runner is configured — UI surfaces a
      // "configure providers.json" hint. The auto-trigger from PR 6
      // still fires through this same runner on candidate accept;
      // this endpoint is the explicit "run now" path.
      const caseRunMatch = url.pathname.match(/^\/api\/verification\/cases\/([^/]+)\/run$/);
      if (caseRunMatch) {
        if (req.method !== 'POST') return methodNotAllowed(res);
        if (!deps.verificationRunner) {
          return send(res, 503, {
            error: 'no_runner',
            message: 'Verification runner is not configured. Set up '
              + '`~/.helm/benchmark/providers.json` (schema same as '
              + 'llm-wiki) and restart helm.',
          });
        }
        const caseId = caseRunMatch[1]!;
        const c = getCase(deps.db, caseId);
        if (!c) return notFound(res);
        try {
          const run = await deps.verificationRunner(caseId);
          if (!run) {
            return send(res, 500, { error: 'runner_returned_null' });
          }
          return send(res, 200, { run });
        } catch (err) {
          deps.logger?.warn('verification_run_failed', {
            data: { caseId, message: (err as Error).message },
          });
          return send(res, 500, {
            error: 'run_failed',
            message: (err as Error).message,
          });
        }
      }

      // PR 6: cheap badge count for the sidebar Verification entry
      // and the proposals review surface. Returns just numbers so the
      // renderer can poll without paying for the full row payload.
      if (url.pathname === '/api/verification/counts') {
        if (req.method !== 'GET') return methodNotAllowed(res);
        const proposed = (deps.db.prepare(
          `SELECT COUNT(*) AS n FROM benchmark_case WHERE status = 'proposed'`,
        ).get() as { n: number }).n;
        const openAlerts = (deps.db.prepare(
          `SELECT COUNT(*) AS n FROM regression_alert WHERE status = 'open'`,
        ).get() as { n: number }).n;
        return send(res, 200, { proposed, openAlerts });
      }

      // PR 5.5a: KnowledgeRepo subscription surface.
      //   GET    /api/knowledge-repos                — list
      //   POST   /api/knowledge-repos                — subscribe (body { url, branch?, syncIntervalMinutes?, autoApply? })
      //   POST   /api/knowledge-repos/:id/fetch-now  — pull on demand
      //   DELETE /api/knowledge-repos/:id?removeData=true  — unsubscribe
      // 501 surface when no manager is wired so the renderer can hide
      // the git surface gracefully on environments without git.
      if (url.pathname === '/api/knowledge-repos') {
        if (req.method === 'GET') {
          const statusParam = url.searchParams.get('status') ?? 'all';
          const VALID = ['active', 'paused', 'error', 'conflict', 'all'] as const;
          if (!(VALID as readonly string[]).includes(statusParam)) {
            return badRequest(res, `invalid status: '${statusParam}'`);
          }
          const repos = listKnowledgeRepos(deps.db, {
            status: statusParam as typeof VALID[number],
          });
          return send(res, 200, { repos });
        }
        if (req.method === 'POST') {
          if (!deps.knowledgeRepoManager) {
            return send(res, 501, {
              error: 'no_repo_manager',
              message: 'Git repo subscription is not enabled in this helm build.',
            });
          }
          let body: Record<string, unknown>;
          try { body = JSON.parse(ctx.body) as Record<string, unknown>; }
          catch { return badRequest(res, 'invalid JSON body'); }
          if (typeof body['url'] !== 'string' || body['url'].length === 0) {
            return badRequest(res, 'url is required');
          }
          try {
            const subscribeOpts: Parameters<KnowledgeRepoManager['subscribe']>[1] = {};
            if (typeof body['branch'] === 'string') subscribeOpts.branch = body['branch'];
            if (typeof body['syncIntervalMinutes'] === 'number') {
              subscribeOpts.syncIntervalMinutes = body['syncIntervalMinutes'];
            }
            if (typeof body['autoApply'] === 'boolean') {
              subscribeOpts.autoApply = body['autoApply'];
            }
            if (body['profile'] === 'helm-native' || body['profile'] === 'llm-wiki'
                || body['profile'] === 'generic') {
              subscribeOpts.profile = body['profile'];
            }
            const repo = await deps.knowledgeRepoManager.subscribe(
              body['url'] as string, subscribeOpts,
            );
            return send(res, 201, { repo });
          } catch (err) {
            if (err instanceof GitUrlError) {
              return badRequest(res, err.message);
            }
            if (err instanceof KnowledgeRepoManagerError) {
              return send(res, 409, { error: 'subscribe_failed', message: err.message });
            }
            return internalError(res, err);
          }
        }
        return methodNotAllowed(res);
      }

      // PR 5.5c merge-conflict endpoints removed in files-as-truth PR-4:
      // the working-copy file is the source of truth, imports always
      // sync the DB row to it, and the knowledge_merge_conflict table
      // was dropped (migration v27).

      // PR 5.5e: curated seed list. GET returns the catalogue;
      // POST /:id/subscribe enrolls the seed via the manager.
      if (url.pathname === '/api/knowledge-repos/seeds') {
        if (req.method !== 'GET') return methodNotAllowed(res);
        return send(res, 200, { seeds: KNOWLEDGE_REPO_SEEDS });
      }
      const seedSubMatch = url.pathname.match(/^\/api\/knowledge-repos\/seeds\/([^/]+)\/subscribe$/);
      if (seedSubMatch) {
        if (req.method !== 'POST') return methodNotAllowed(res);
        if (!deps.knowledgeRepoManager) {
          return send(res, 501, { error: 'no_repo_manager' });
        }
        const seed = findSeedById(seedSubMatch[1]!);
        if (!seed) return notFound(res);
        try {
          const repo = await deps.knowledgeRepoManager.subscribe(seed.url, {
            branch: seed.branch,
            // v26: pin the seed's profile so import / publish / the
            // scheduled sync sweep all use the right layout without
            // re-inferring from the URL.
            profile: seed.profile,
          });
          return send(res, 201, { repo, seedId: seed.id });
        } catch (err) {
          return send(res, 409, {
            error: 'subscribe_failed', message: (err as Error).message,
          });
        }
      }

      // PR 5.5d: push selected local KnowledgePoints back to the
      // subscribed repo as a new branch + PR.
      //   POST /api/knowledge-repos/:id/publish
      //   body { pointIds, message, branchName?, profile?, anonymous? }
      const repoPublishMatch = url.pathname.match(/^\/api\/knowledge-repos\/([^/]+)\/publish$/);
      if (repoPublishMatch) {
        if (req.method !== 'POST') return methodNotAllowed(res);
        if (!deps.knowledgeRepoManager) {
          return send(res, 501, { error: 'no_repo_manager' });
        }
        let body: Record<string, unknown>;
        try { body = JSON.parse(ctx.body) as Record<string, unknown>; }
        catch { return badRequest(res, 'invalid JSON body'); }
        if (!Array.isArray(body['pointIds'])
            || !body['pointIds'].every((x): x is string => typeof x === 'string')
            || body['pointIds'].length === 0) {
          return badRequest(res, 'pointIds must be a non-empty string array');
        }
        if (typeof body['message'] !== 'string' || body['message'].length === 0) {
          return badRequest(res, 'message is required');
        }
        try {
          const result = await deps.knowledgeRepoManager.publish({
            repoId: repoPublishMatch[1]!,
            pointIds: body['pointIds'] as string[],
            message: body['message'] as string,
            ...(typeof body['branchName'] === 'string'
              ? { branchName: body['branchName'] } : {}),
            ...(typeof body['profile'] === 'string'
              ? { profile: body['profile'] as 'helm-native' | 'llm-wiki' } : {}),
            ...(typeof body['anonymous'] === 'boolean'
              ? { anonymous: body['anonymous'] } : {}),
          });
          return send(res, 200, result);
        } catch (err) {
          if (err instanceof Error && err.name === 'PublishError') {
            const stage = (err as { stage?: string }).stage ?? 'unknown';
            const status = stage === 'precheck' ? 403 : 500;
            return send(res, status, {
              error: 'publish_failed', stage, message: err.message,
            });
          }
          return internalError(res, err);
        }
      }

      // Ad-hoc external-knowledge lookup for the renderer.
      //   POST /api/knowledge-lookup  body { query, providers? }
      // Used by the "外部知识对照" button next to candidates: query org
      // knowledge with the captured text and show both side by side.
      // When `providers` is omitted, defaults to the enabled providers
      // declared in config (custom MCP bridges / depscope) — NOT the
      // always-on local providers, whose content the page already shows.
      if (url.pathname === '/api/knowledge-lookup') {
        if (req.method !== 'POST') return methodNotAllowed(res);
        if (!deps.knowledge) {
          return send(res, 501, { error: 'no_knowledge_registry' });
        }
        let body: { query?: unknown; providers?: unknown };
        try { body = JSON.parse(ctx.body) as typeof body; }
        catch { return badRequest(res, 'invalid JSON body'); }
        if (typeof body.query !== 'string' || body.query.trim().length === 0) {
          return badRequest(res, 'query must be a non-empty string');
        }
        let providers = Array.isArray(body.providers)
          && body.providers.every((p): p is string => typeof p === 'string')
          && body.providers.length > 0
          ? body.providers
          : undefined;
        if (!providers && deps.getConfig) {
          const configured = deps.getConfig().knowledge.providers
            .filter((p) => p.enabled)
            .map((p) => p.id)
            .filter((id) => id.length > 0);
          if (configured.length > 0) providers = configured;
        }
        try {
          const result = await queryKnowledge(
            deps.knowledge,
            { query: body.query, ...(providers ? { providers } : {}) },
            // External RAG round-trips regularly exceed the 5s default
            // used for session-context fetches.
            { searchTimeoutMs: 20_000 },
          );
          return send(res, 200, result);
        } catch (err) {
          return internalError(res, err);
        }
      }

      // 知识阶梯 PR-γ: 升格 — consolidated personal knowledge → domains/ MR.
      //   POST /api/knowledge-repos/:id/promote  body { domain, title, body }
      const repoPromoteMatch = url.pathname.match(
        /^\/api\/knowledge-repos\/([^/]+)\/promote$/,
      );
      if (repoPromoteMatch) {
        if (req.method !== 'POST') return methodNotAllowed(res);
        if (!deps.knowledgeRepoManager) {
          return send(res, 501, { error: 'no_repo_manager' });
        }
        let body: { domain?: unknown; title?: unknown; body?: unknown };
        try { body = JSON.parse(ctx.body) as typeof body; }
        catch { return badRequest(res, 'invalid JSON body'); }
        if (typeof body.domain !== 'string' || typeof body.title !== 'string'
            || typeof body.body !== 'string') {
          return badRequest(res, 'domain, title and body are required strings');
        }
        try {
          const result = await deps.knowledgeRepoManager.promoteToDomain({
            repoId: repoPromoteMatch[1]!,
            domain: body.domain,
            title: body.title,
            body: body.body,
          });
          return send(res, 200, result);
        } catch (err) {
          if (err instanceof KnowledgeRepoManagerError) {
            return send(res, 409, { error: 'promote_failed', message: err.message });
          }
          if (err instanceof Error && err.name === 'PublishError') {
            const stage = (err as { stage?: string }).stage ?? 'unknown';
            return send(res, stage === 'precheck' ? 403 : 500, {
              error: 'publish_failed', stage, message: err.message,
            });
          }
          return internalError(res, err);
        }
      }

      // PR-γ2: AI 整理 — polish selected fragments into a promotion
      // draft, with external sources as reference.
      //   POST /api/knowledge-repos/:id/promote-draft
      //     body { fragments: string[], domain?, title? }
      const repoPromoteDraftMatch = url.pathname.match(
        /^\/api\/knowledge-repos\/([^/]+)\/promote-draft$/,
      );
      if (repoPromoteDraftMatch) {
        if (req.method !== 'POST') return methodNotAllowed(res);
        if (!deps.promoteDraftLlm) {
          return send(res, 501, { error: 'no_draft_llm' });
        }
        let llm: import('../summarizer/campaign.js').LlmClient;
        try { llm = deps.promoteDraftLlm(); }
        catch {
          return send(res, 503, {
            error: 'engine_unavailable',
            message: 'No LLM engine configured — set up claude or a cursor key in Settings.',
          });
        }
        let body: { fragments?: unknown; domain?: unknown; title?: unknown };
        try { body = JSON.parse(ctx.body) as typeof body; }
        catch { return badRequest(res, 'invalid JSON body'); }
        if (!Array.isArray(body.fragments)
            || !body.fragments.every((f): f is string => typeof f === 'string')
            || body.fragments.length === 0) {
          return badRequest(res, 'fragments must be a non-empty string array');
        }
        // Reference context from the configured external providers —
        // best-effort, the draft works without it.
        let externalContext = '';
        if (deps.knowledge) {
          try {
            const enabled = (deps.getConfig?.().knowledge.providers ?? [])
              .filter((p) => p.enabled).map((p) => p.id);
            const lookup = await queryKnowledge(
              deps.knowledge,
              {
                query: body.fragments.join('\n').slice(0, 300),
                ...(enabled.length > 0 ? { providers: enabled } : {}),
              },
              { searchTimeoutMs: 20_000 },
            );
            externalContext = lookup.snippets
              .map((sn) => `【${sn.source}】\n${sn.body.trim()}`)
              .join('\n\n');
          } catch { /* reference is optional */ }
        }
        const draft = await draftPromotionDoc({
          fragments: body.fragments,
          ...(typeof body.domain === 'string' && body.domain ? { domain: body.domain } : {}),
          ...(typeof body.title === 'string' && body.title ? { title: body.title } : {}),
          ...(externalContext ? { externalContext } : {}),
          llm,
          model: deps.getConfig?.().cursor.model ?? 'claude-sonnet-4-6',
        });
        if (draft === null) {
          return send(res, 502, { error: 'draft_failed', message: 'LLM 未返回可用草稿，请重试或手动编辑。' });
        }
        return send(res, 200, { draft, usedExternalContext: externalContext.length > 0 });
      }

      // Files-as-truth PR-3: captured-points batch publish.
      //   GET  /api/knowledge-repos/:id/captured         — list unpublished
      //   POST /api/knowledge-repos/:id/publish-captured — one MR for all
      const repoCapturedMatch = url.pathname.match(/^\/api\/knowledge-repos\/([^/]+)\/captured$/);
      if (repoCapturedMatch) {
        if (req.method !== 'GET') return methodNotAllowed(res);
        if (!deps.knowledgeRepoManager) {
          return send(res, 501, { error: 'no_repo_manager' });
        }
        try {
          const files = await deps.knowledgeRepoManager.listUnpublishedCaptured(
            repoCapturedMatch[1]!,
          );
          return send(res, 200, { files });
        } catch (err) {
          if (err instanceof KnowledgeRepoManagerError) {
            return send(res, 404, { error: 'captured_list_failed', message: err.message });
          }
          return internalError(res, err);
        }
      }
      const repoPublishCapturedMatch = url.pathname.match(
        /^\/api\/knowledge-repos\/([^/]+)\/publish-captured$/,
      );
      if (repoPublishCapturedMatch) {
        if (req.method !== 'POST') return methodNotAllowed(res);
        if (!deps.knowledgeRepoManager) {
          return send(res, 501, { error: 'no_repo_manager' });
        }
        let body: { message?: unknown; anonymous?: unknown } = {};
        if (ctx.body) {
          try { body = JSON.parse(ctx.body) as typeof body; }
          catch { return badRequest(res, 'invalid JSON body'); }
        }
        try {
          const result = await deps.knowledgeRepoManager.publishCaptured({
            repoId: repoPublishCapturedMatch[1]!,
            ...(typeof body.message === 'string' && body.message.length > 0
              ? { message: body.message } : {}),
            ...(typeof body.anonymous === 'boolean'
              ? { anonymous: body.anonymous } : {}),
          });
          return send(res, 200, result);
        } catch (err) {
          if (err instanceof KnowledgeRepoManagerError) {
            return send(res, 409, { error: 'publish_captured_failed', message: err.message });
          }
          if (err instanceof Error && err.name === 'PublishError') {
            const stage = (err as { stage?: string }).stage ?? 'unknown';
            return send(res, stage === 'precheck' ? 403 : 500, {
              error: 'publish_failed', stage, message: err.message,
            });
          }
          return internalError(res, err);
        }
      }

      // PR 5.5b: walk the cloned repo and import its .md files into
      // knowledge_chunks / knowledge_point_alias / knowledge_point_rel.
      //   POST /api/knowledge-repos/:id/import-now  body { profile? }
      const repoImportMatch = url.pathname.match(/^\/api\/knowledge-repos\/([^/]+)\/import-now$/);
      if (repoImportMatch) {
        if (req.method !== 'POST') return methodNotAllowed(res);
        if (!deps.knowledgeRepoManager) {
          return send(res, 501, { error: 'no_repo_manager' });
        }
        let body: { profile?: unknown } = {};
        if (ctx.body) {
          try { body = JSON.parse(ctx.body) as { profile?: unknown }; }
          catch { return badRequest(res, 'invalid JSON body'); }
        }
        const VALID_PROFILES = ['helm-native', 'llm-wiki', 'generic'] as const;
        // v26: omitted profile now falls through to the one pinned at
        // subscribe time (manager resolves). Explicit body.profile is a
        // per-call override.
        const profile = typeof body.profile === 'string'
          && (VALID_PROFILES as readonly string[]).includes(body.profile)
          ? body.profile as typeof VALID_PROFILES[number]
          : undefined;
        try {
          const summary = deps.knowledgeRepoManager.importNow(repoImportMatch[1]!, profile);
          return send(res, 200, summary);
        } catch (err) {
          if (err instanceof KnowledgeRepoManagerError) {
            return send(res, 404, { error: 'import_failed', message: err.message });
          }
          return send(res, 500, { error: 'import_failed', message: (err as Error).message });
        }
      }

      const repoFetchMatch = url.pathname.match(/^\/api\/knowledge-repos\/([^/]+)\/fetch-now$/);
      if (repoFetchMatch) {
        if (req.method !== 'POST') return methodNotAllowed(res);
        if (!deps.knowledgeRepoManager) {
          return send(res, 501, { error: 'no_repo_manager' });
        }
        try {
          const outcome = await deps.knowledgeRepoManager.fetchNow(repoFetchMatch[1]!);
          return send(res, 200, outcome);
        } catch (err) {
          if (err instanceof KnowledgeRepoManagerError) {
            return send(res, err.message.startsWith('unknown repo') ? 404 : 409, {
              error: 'fetch_failed', message: err.message,
            });
          }
          return send(res, 500, { error: 'fetch_failed', message: (err as Error).message });
        }
      }

      // v28: import-directory whitelist.
      //   GET   /api/knowledge-repos/:id/dirs   — selectable top-level dirs
      //   PATCH /api/knowledge-repos/:id        — body { importDirs: string[] | null }
      const repoDirsMatch = url.pathname.match(/^\/api\/knowledge-repos\/([^/]+)\/dirs$/);
      if (repoDirsMatch) {
        if (req.method !== 'GET') return methodNotAllowed(res);
        if (!deps.knowledgeRepoManager) {
          return send(res, 501, { error: 'no_repo_manager' });
        }
        try {
          const repo = getKnowledgeRepo(deps.db, repoDirsMatch[1]!);
          if (!repo) return notFound(res);
          // PR-γ: ?parent=domains lists sub-domains for the promote modal.
          const parent = url.searchParams.get('parent') ?? undefined;
          if (parent) {
            const dirs = deps.knowledgeRepoManager.listRepoTopDirs(repo.id, parent);
            return send(res, 200, { dirs, importDirs: repo.importDirs ?? null });
          }
          // Tree-select picker: top dirs + one level of children.
          const tree = deps.knowledgeRepoManager.listRepoDirTree(repo.id);
          return send(res, 200, {
            dirs: tree.map((t) => t.name),
            tree,
            importDirs: repo.importDirs ?? null,
          });
        } catch (err) {
          if (err instanceof KnowledgeRepoManagerError) {
            return send(res, 404, { error: 'dirs_failed', message: err.message });
          }
          return internalError(res, err);
        }
      }
      const repoIdMatch = url.pathname.match(/^\/api\/knowledge-repos\/([^/]+)$/);
      if (repoIdMatch) {
        if (req.method === 'GET') {
          const repo = getKnowledgeRepo(deps.db, repoIdMatch[1]!);
          if (!repo) return notFound(res);
          return send(res, 200, { repo });
        }
        if (req.method === 'PATCH') {
          const repo = getKnowledgeRepo(deps.db, repoIdMatch[1]!);
          if (!repo) return notFound(res);
          let body: { importDirs?: unknown };
          try { body = JSON.parse(ctx.body) as typeof body; }
          catch { return badRequest(res, 'invalid JSON body'); }
          if (body.importDirs !== null
              && !(Array.isArray(body.importDirs)
                && body.importDirs.every((d): d is string => typeof d === 'string'))) {
            return badRequest(res, 'importDirs must be a string array or null');
          }
          setRepoImportDirs(deps.db, repo.id, body.importDirs as string[] | null);
          const updated = getKnowledgeRepo(deps.db, repo.id)!;
          return send(res, 200, { repo: updated });
        }
        if (req.method === 'DELETE') {
          const removeData = url.searchParams.get('removeData') === 'true';
          if (deps.knowledgeRepoManager) {
            deps.knowledgeRepoManager.unsubscribe(repoIdMatch[1]!, { removeData });
          } else {
            // Even without a manager (no git), let the user clear the
            // row so the UI doesn't trap them.
            deleteKnowledgeRepo(deps.db, repoIdMatch[1]!);
          }
          return send(res, 200, { ok: true });
        }
        return methodNotAllowed(res);
      }

      if (url.pathname === '/api/verification/alerts') {
        if (req.method !== 'GET') return methodNotAllowed(res);
        const statusParam = url.searchParams.get('status') ?? 'open';
        const VALID_ALERT = ['open', 'acknowledged', 'resolved', 'all'] as const;
        if (!(VALID_ALERT as readonly string[]).includes(statusParam)) {
          return badRequest(res, `invalid status: '${statusParam}'`);
        }
        const limitParam = url.searchParams.get('limit');
        const limit = limitParam ? Number.parseInt(limitParam, 10) : 100;
        const alerts = listAlerts(
          deps.db,
          statusParam as 'open' | 'acknowledged' | 'resolved' | 'all',
          Number.isFinite(limit) ? limit : 100,
        );
        return send(res, 200, { alerts });
      }

      if (url.pathname === '/api/review/candidates') {
        if (req.method !== 'GET') return methodNotAllowed(res);
        const statusParam = url.searchParams.get('status') ?? 'pending';
        const VALID_STATUSES_REVIEW = ['pending', 'accepted', 'rejected', 'expired', 'all'] as const;
        if (!(VALID_STATUSES_REVIEW as readonly string[]).includes(statusParam)) {
          return badRequest(res, `invalid status: '${statusParam}'`);
        }
        const sortParam = url.searchParams.get('sort') ?? 'recent';
        if (sortParam !== 'recent' && sortParam !== 'score') {
          return badRequest(res, `invalid sort: '${sortParam}'. Expected 'recent' or 'score'.`);
        }
        const roleId = url.searchParams.get('roleId') ?? undefined;
        const limitParam = url.searchParams.get('limit');
        const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
        if (limitParam && (!Number.isFinite(limit) || (limit ?? 0) < 1)) {
          return badRequest(res, `invalid limit: '${limitParam}'`);
        }
        const candidates = listReviewCandidates(deps.db, {
          status: statusParam as 'pending' | 'accepted' | 'rejected' | 'expired' | 'all',
          sort: sortParam,
          ...(roleId ? { roleId } : {}),
          ...(limit ? { limit } : {}),
        });
        return send(res, 200, { candidates });
      }

      // PR 4 (Review inbox): bulk reject — never bulk accept (R-5).
      //   POST /api/review/bulk-reject  body { candidateIds: string[] }
      if (url.pathname === '/api/review/bulk-reject') {
        if (req.method !== 'POST') return methodNotAllowed(res);
        let body: { candidateIds?: unknown };
        try { body = JSON.parse(ctx.body); }
        catch { return badRequest(res, 'invalid JSON body'); }
        if (!Array.isArray(body.candidateIds)
            || !body.candidateIds.every((x): x is string => typeof x === 'string')) {
          return badRequest(res, 'candidateIds must be a string array');
        }
        const flipped = bulkRejectCandidates(deps.db, body.candidateIds, new Date().toISOString());
        return send(res, 200, { flipped });
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

      // PR-β (knowledge tiers): external-context surface.
      //   POST /api/knowledge-candidates/context          body { candidateIds }
      //     — batch-read the prefetched org-side context for a page of
      //       candidates (Review inbox / Roles / conversation detail).
      //   POST /api/knowledge-candidates/:id/refresh-context
      //     — re-query the configured providers now (prefetch missed,
      //       provider config changed, …).
      if (url.pathname === '/api/knowledge-candidates/context') {
        if (req.method !== 'POST') return methodNotAllowed(res);
        let body: { candidateIds?: unknown };
        try { body = JSON.parse(ctx.body) as typeof body; }
        catch { return badRequest(res, 'invalid JSON body'); }
        if (!Array.isArray(body.candidateIds)
            || !body.candidateIds.every((x): x is string => typeof x === 'string')) {
          return badRequest(res, 'candidateIds must be a string array');
        }
        const contexts = getCandidateContexts(deps.db, body.candidateIds.slice(0, 200));
        return send(res, 200, { contexts });
      }
      const candidateCtxRefreshMatch = url.pathname.match(
        /^\/api\/knowledge-candidates\/([^/]+)\/refresh-context$/,
      );
      if (candidateCtxRefreshMatch) {
        if (req.method !== 'POST') return methodNotAllowed(res);
        if (!deps.knowledge) {
          return send(res, 501, { error: 'no_knowledge_registry' });
        }
        const cand = getCandidateById(deps.db, candidateCtxRefreshMatch[1]!);
        if (!cand) return notFound(res);
        const enabled = (deps.getConfig?.().knowledge.providers ?? [])
          .filter((p) => p.enabled)
          .map((p) => p.id);
        const context = await fetchAndCacheCandidateContext(deps.db, deps.knowledge, {
          candidateId: cand.id,
          queryText: cand.chunkText,
          ...(enabled.length > 0 ? { providers: enabled } : {}),
        });
        return send(res, 200, { context });
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

        // Files-as-truth PR-2: when an active llm-wiki repo is subscribed
        // AND the user configured their wiki username, the accepted
        // candidate also lands as chat-captured/<user>/<role>/<slug>.md
        // in the repo's working copy. The chunk id is pre-picked as a
        // human-readable slug so the file name, doc-lsp concept id and
        // DB row all agree.
        const wikiRepo = deps.knowledgeRepoManager
          ? listKnowledgeRepos(deps.db, { status: 'active' })
              .find((r) => r.profile === 'llm-wiki')
          : undefined;
        const wikiUsername = deps.getConfig?.().knowledge.wikiUsername?.trim();
        const captureTarget = wikiRepo && wikiUsername
          ? { repo: wikiRepo, username: wikiUsername }
          : undefined;
        let pointIdBase: string | undefined;
        if (captureTarget) {
          const fallbackId = `capture-${candidateId.slice(0, 8)}`;
          const seed = slugifyPointId(before.gist ?? finalText, fallbackId);
          pointIdBase = seed;
          for (let n = 2; getChunkByIdRepo(deps.db, pointIdBase); n += 1) {
            // Bounded probe; past -9 give up on readability and use the
            // candidate-derived id (unique because accept is one-shot).
            if (n > 9) { pointIdBase = fallbackId; break; }
            pointIdBase = `${seed}-${n}`;
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
              ...(pointIdBase ? { pointIdBase } : {}),
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
          // Files-as-truth PR-2: materialize the promoted chunk(s) as
          // chat-captured files. Best-effort — the chunk is already in
          // the DB; a failed file write is logged and retried naturally
          // on the next publish/import cycle, never blocks the accept.
          const wikiFiles: string[] = [];
          if (captureTarget) {
            for (const chunkId of result.chunkIds) {
              try {
                const written = await deps.knowledgeRepoManager!.writeCapturedPoint({
                  repoId: captureTarget.repo.id,
                  chunkId,
                  username: captureTarget.username,
                });
                wikiFiles.push(written.relPath);
              } catch (err) {
                deps.logger?.warn('wiki_capture_write_failed', {
                  data: { candidateId, chunkId, message: (err as Error).message },
                });
              }
            }
          }
          // PR 6 (auto-trigger): when a Verification runner is wired,
          // enqueue affected cases so the next time the user looks at
          // the case it reflects the just-accepted knowledge. Done
          // asynchronously without blocking the HTTP response — the
          // candidate accept itself is the user-visible action.
          if (deps.verificationRunner) {
            const runner = deps.verificationRunner;
            void enqueueAffectedRuns(deps.db, {
              roleIds: [before.roleId],
              triggeringEventKind: 'candidate_accept',
              triggeringEventRefId: candidateId,
              runner,
            }).catch((err) => {
              deps.logger?.warn('verification_auto_trigger_failed', {
                data: { candidateId, message: (err as Error).message },
              });
            });
          }
          return send(res, 200, {
            candidateId, status: 'accepted', flipped,
            chunksAdded: result.chunksAdded,
            ...(wikiFiles.length > 0 ? { wikiFiles } : {}),
          });
        } catch (err) {
          return internalError(res, err);
        }
      }

      // v35: force the LLM chat knowledge-point extraction for one chat.
      //   POST /api/conversations/:id/extract-knowledge
      const extractKnowledgeMatch = url.pathname.match(
        /^\/api\/conversations\/([^/]+)\/extract-knowledge$/,
      );
      if (extractKnowledgeMatch) {
        if (req.method !== 'POST') return methodNotAllowed(res);
        if (!deps.extractChatKnowledge) {
          return send(res, 503, { error: 'no_engine', message: 'No LLM engine wired.' });
        }
        try {
          const result = await deps.extractChatKnowledge({ hostSessionId: extractKnowledgeMatch[1]! });
          return send(res, 200, result);
        } catch (err) { return internalError(res, err); }
      }

      // v35: chat knowledge-point lifecycle.
      //   POST /api/chat-knowledge/:id/accept   body { targetRoleId?, newTopicName? }
      //   POST /api/chat-knowledge/:id/dismiss
      const ckpMatch = url.pathname.match(
        /^\/api\/chat-knowledge\/([^/]+)\/(accept|dismiss)$/,
      );
      if (ckpMatch) {
        if (req.method !== 'POST') return methodNotAllowed(res);
        const pointId = ckpMatch[1]!;
        const action = ckpMatch[2] as 'accept' | 'dismiss';
        const point = getChatKnowledgePoint(deps.db, pointId);
        if (!point) return notFound(res);
        if (point.status !== 'pending') {
          return send(res, 409, { error: 'not_pending', currentStatus: point.status });
        }
        const now = new Date().toISOString();

        if (action === 'dismiss') {
          setChatKnowledgePointStatus(deps.db, pointId, 'dismissed', now);
          return send(res, 200, { pointId, status: 'dismissed' });
        }

        // Resolve the home topic: explicit override → suggested existing →
        // create from explicit/suggested new-topic name.
        let body: { targetRoleId?: unknown; newTopicName?: unknown } = {};
        if (ctx.body) {
          try { body = JSON.parse(ctx.body) as typeof body; }
          catch { return badRequest(res, 'invalid JSON body'); }
        }
        let roleId = typeof body.targetRoleId === 'string' && body.targetRoleId
          ? body.targetRoleId
          : point.suggestedRoleId;
        if (!roleId) {
          const newName = (typeof body.newTopicName === 'string' && body.newTopicName.trim())
            ? body.newTopicName.trim()
            : point.suggestedTopicName;
          if (!newName) return badRequest(res, 'no target topic (provide targetRoleId or newTopicName)');
          // Create a plain (non-bindable) topic to hold the point.
          const baseId = slugifyPointId(newName, `topic-${pointId.slice(0, 8)}`);
          let id = baseId;
          for (let n = 2; getRoleRow(deps.db, id); n += 1) {
            if (n > 99) { id = `topic-${pointId.slice(0, 8)}`; break; }
            id = `${baseId}-${n}`;
          }
          upsertRoleRepo(deps.db, {
            id, name: newName, systemPrompt: '', isBuiltin: false,
            bindable: false, createdAt: now,
          });
          roleId = id;
        }

        try {
          const result = await updateRoleLibrary(deps.db, {
            roleId,
            appendDocuments: [{
              filename: `ckp-${pointId}`,
              content: point.body,
              kind: point.kind,
              sourceKind: 'inline',
              origin: `ckp-${pointId}`,
              sourceLabel: `Extracted from chat ${point.hostSessionId.slice(0, 8)}`,
              pointIdBase: slugifyPointId(point.title, `ckp-${pointId.slice(0, 8)}`),
            }],
            embedFn: makePseudoEmbedFn(),
          });
          if (result.status === 'conflicts') {
            return send(res, 409, {
              error: 'conflicts',
              message: '采纳会产生近似重复的知识点；到该 topic 里处理后重试。',
              conflicts: result.conflicts,
            });
          }
          setChatKnowledgePointStatus(deps.db, pointId, 'accepted', now);
          // Files-as-truth: materialize as chat-captured (best-effort).
          const wikiRepo = deps.knowledgeRepoManager
            ? listKnowledgeRepos(deps.db, { status: 'active' }).find((r) => r.profile === 'llm-wiki')
            : undefined;
          const wikiUsername = deps.getConfig?.().knowledge.wikiUsername?.trim();
          if (wikiRepo && wikiUsername) {
            for (const chunkId of result.chunkIds) {
              try {
                await deps.knowledgeRepoManager!.writeCapturedPoint({
                  repoId: wikiRepo.id, chunkId, username: wikiUsername,
                });
              } catch (err) {
                deps.logger?.warn('wiki_capture_write_failed', {
                  data: { pointId, chunkId, message: (err as Error).message },
                });
              }
            }
          }
          return send(res, 200, { pointId, status: 'accepted', roleId, chunksAdded: result.chunksAdded });
        } catch (err) { return internalError(res, err); }
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

      // ── Phase 79: storage plugins (read-only) ───────────────────────
      // GET /api/plugins → list every plugin helm tried to load (OK +
      //   failed). Drives the Settings → Storage plugins section.
      // .helmrole bundle ecosystem removed (plugins / role-subscriptions /
      // export-upload) — superseded by files-as-truth llm-wiki MR flows.

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

      // R-18 wire-up: per-engine hook install / status endpoints.
      // Replaces the toast-only stub in Settings › Engines. Cursor has
      // a real installer (`installCursorHooks` → `~/.cursor/hooks.json`);
      // claude-code / codex install paths route through the existing
      // setupMcp flow because their "hooks" are MCP notifications, not
      // a separate file.
      //
      //   POST   /api/host/:agent/hooks/install    body { force? }
      //   POST   /api/host/:agent/hooks/uninstall
      //   GET    /api/host/:agent/hooks/status
      //
      // `:agent` must be one of cursor | claude-code | codex.
      const hooksMatch = url.pathname.match(
        /^\/api\/host\/(cursor|claude-code|codex)\/hooks\/(install|uninstall|status)$/,
      );
      if (hooksMatch) {
        const agent = hooksMatch[1] as 'cursor' | 'claude-code' | 'codex';
        const action = hooksMatch[2] as 'install' | 'uninstall' | 'status';
        if (action === 'status') {
          if (req.method !== 'GET') return methodNotAllowed(res);
        } else {
          if (req.method !== 'POST') return methodNotAllowed(res);
        }
        if (!deps.hostInstaller) {
          return send(res, 501, {
            error: 'not_implemented',
            message: 'host installer not wired into this helm build',
          });
        }
        try {
          const result = await deps.hostInstaller({ agent, action });
          deps.logger?.info('host_install_action', { data: { agent, action, ...result } });
          return send(res, result.status, result.body);
        } catch (err) {
          return send(res, 500, {
            error: 'host_install_failed', message: (err as Error).message,
          });
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
