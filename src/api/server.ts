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
import type { ApprovalRegistry } from '../approval/registry.js';
import type { Logger } from '../logger/index.js';
import type { EventBus } from '../events/bus.js';

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
