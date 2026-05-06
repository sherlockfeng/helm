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
import { listActiveSessions } from '../storage/repos/host-sessions.js';
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
import type { Logger } from '../logger/index.js';
import type { EventBus } from '../events/bus.js';
import type { HelmConfig } from '../config/schema.js';

export interface HttpApiDeps {
  db: Database.Database;
  registry: ApprovalRegistry;
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
  const { decision, reason } = parsed as { decision?: unknown; reason?: unknown };
  if (decision !== 'allow' && decision !== 'deny') {
    return badRequest(ctx.response, 'decision must be "allow" or "deny"');
  }
  if (reason !== undefined && typeof reason !== 'string') {
    return badRequest(ctx.response, 'reason must be a string when provided');
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

  deps.logger?.info('approval_decide', { data: { approvalId, decision } });
  return send(ctx.response, 200, { ok: true, approvalId });
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
