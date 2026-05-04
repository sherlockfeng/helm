/**
 * Helm app orchestrator — boots all subsystems in the order from §7.3 and
 * wires them together. The Electron main process is a thin shell on top of
 * this; tests boot it headless.
 *
 * Boot order (subset of §7.3 implemented this PR; tray / window / single-
 * instance lock land in Phase 9):
 *   1. SQLite + migrations + seedBuiltinRoles
 *   2. KnowledgeProviderRegistry + LocalRolesProvider
 *   3. ApprovalRegistry + ApprovalPolicyEngine
 *   4. LocalChannel + handler wiring
 *   5. BridgeServer + handler registration
 *   6. HttpApi
 *
 * Wiring:
 *   registry.onPendingCreated → localChannel.sendApprovalRequest
 *   localChannel.onApprovalDecision → registry.settle (with decidedBy='local-ui')
 *   bridge.host_session_start → aggregateSessionContext + persist host_session row
 *   bridge.host_approval_request → createApprovalHandler() from Phase 4
 *
 * Shutdown reverses the order so in-flight pendings get settled before the
 * registry tears down its DB connection.
 */

import type Database from 'better-sqlite3';
import { ApprovalPolicyEngine } from '../approval/policy.js';
import { ApprovalRegistry } from '../approval/registry.js';
import { createApprovalHandler } from '../approval/handler.js';
import type {
  HostApprovalRequestRequest,
  HostApprovalRequestResponse,
  HostSessionStartRequest,
  HostSessionStartResponse,
} from '../bridge/protocol.js';
import { BridgeServer } from '../bridge/server.js';
import { LocalChannel } from '../channel/local/adapter.js';
import { type Notifier } from '../channel/local/notifier.js';
import { aggregateSessionContext } from '../knowledge/aggregator.js';
import { LocalRolesProvider } from '../knowledge/local-roles-provider.js';
import { KnowledgeProviderRegistry } from '../knowledge/types.js';
import { createHttpApi, type HttpApiHandle } from '../api/server.js';
import { DEFAULT_TIMEOUTS, PATHS, SESSION_CONTEXT_MAX_BYTES } from '../constants.js';
import { getHostSession, upsertHostSession } from '../storage/repos/host-sessions.js';
import { makePseudoEmbedFn } from '../mcp/embed.js';
import type { Logger, LoggerFactory } from '../logger/index.js';
import { createEventBus, type EventBus } from '../events/bus.js';

export interface HelmAppDeps {
  db: Database.Database;
  loggers: LoggerFactory;
  /** Optional injected notifier; defaults to the channel's NoopNotifier. */
  notifier?: Notifier;
  /** Override paths for tests. */
  bridgeSocketPath?: string;
  /** Override HTTP port; 0 = ephemeral. */
  httpPort?: number;
  /** Override approval default timeout (ms). Defaults to DEFAULT_TIMEOUTS.approvalMs. */
  approvalTimeoutMs?: number;
}

export interface HelmAppHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  // Exposed for tests + the Electron shell:
  readonly knowledge: KnowledgeProviderRegistry;
  readonly approval: ApprovalRegistry;
  readonly policy: ApprovalPolicyEngine;
  readonly channel: LocalChannel;
  readonly bridge: BridgeServer;
  readonly httpApi: HttpApiHandle;
  readonly events: EventBus;
  /** Resolved port after start. */
  httpPort(): number | null;
}

export function createHelmApp(deps: HelmAppDeps): HelmAppHandle {
  const log: Logger = deps.loggers.module('app');

  // Event bus — orchestrator publishes high-level events here; the HTTP API's
  // /api/events SSE endpoint subscribes and forwards to the renderer.
  const events = createEventBus({
    onListenerError: (err, type) => log.warn('event_listener_threw', {
      event: type, data: { error: err.message },
    }),
  });

  // Knowledge — register LocalRolesProvider over the seeded built-in roles.
  // Any future provider (DepscopeProvider in Phase 13) registers here too.
  const knowledge = new KnowledgeProviderRegistry();
  knowledge.register(new LocalRolesProvider({
    db: deps.db,
    embedFn: makePseudoEmbedFn(),
  }));

  // Approval policy + registry. Registry restores any pending rows that survived
  // a previous restart so the user still sees the in-flight UI items.
  const policy = new ApprovalPolicyEngine(deps.db);
  const registry = new ApprovalRegistry(deps.db, {
    defaultTimeoutMs: deps.approvalTimeoutMs ?? DEFAULT_TIMEOUTS.approvalMs,
    onWarning: (msg, ctx) => deps.loggers.module('approval.registry').warn(msg, { data: ctx }),
  });
  registry.reloadFromDatabase();

  // LocalChannel — push approvals to OS notification + UI list.
  const channel = new LocalChannel({
    notifier: deps.notifier,
    onApprovalPushed: (req) => {
      log.session(req.hostSessionId ?? 'unknown').info('approval_pushed_local', {
        data: { approvalId: req.id, tool: req.tool },
      });
    },
  });

  // Wire registry → channel (push) + EventBus emission so the SSE stream
  // notifies the renderer in real time.
  registry.onPendingCreated((req) => {
    events.emit({ type: 'approval.pending', request: req });
    void channel.sendApprovalRequest(req).catch((err) => {
      log.warn('local_channel_push_failed', { data: { approvalId: req.id, err: (err as Error).message } });
    });
  });
  channel.onApprovalDecision((decision) => {
    events.emit({ type: 'approval.decision_received', decision });
    const settled = registry.settle(decision.approvalId, {
      permission: decision.decision,
      reason: decision.reason,
      decidedBy: 'local-ui',
    });
    if (!settled) {
      log.warn('local_channel_decision_no_pending', { data: { approvalId: decision.approvalId } });
      return;
    }
    events.emit({
      type: 'approval.settled',
      approvalId: decision.approvalId,
      decision: decision.decision,
      decidedBy: 'local-ui',
      reason: decision.reason,
    });
  });

  // Bridge handlers. Phase 8 wires only the two flows we have engines for:
  // host_session_start (knowledge injection) + host_approval_request (registry/policy).
  const bridge = new BridgeServer({
    socketPath: deps.bridgeSocketPath ?? PATHS.bridgeSocket,
    onError: (err, where) => deps.loggers.module('bridge').error('bridge_io_error', {
      event: where, data: { error: err.message },
    }),
  });

  const approvalHandler = createApprovalHandler({
    policy,
    registry,
    resolveCwd: (sessionId) => sessionId ? getHostSession(deps.db, sessionId)?.cwd : undefined,
  });

  bridge.registerHandler('host_session_start', async (req: HostSessionStartRequest): Promise<HostSessionStartResponse> => {
    const now = new Date().toISOString();
    upsertHostSession(deps.db, {
      id: req.host_session_id,
      host: 'cursor',
      cwd: req.cwd,
      composerMode: req.composer_mode,
      status: 'active',
      firstSeenAt: now,
      lastSeenAt: now,
    });
    const persisted = getHostSession(deps.db, req.host_session_id);
    if (persisted) events.emit({ type: 'session.started', session: persisted });

    if (!req.cwd) {
      log.session(req.host_session_id).info('session_start', {
        event: 'session_start', data: { cwd: undefined },
      });
      return {};
    }

    const result = await aggregateSessionContext(
      knowledge,
      { hostSessionId: req.host_session_id, cwd: req.cwd },
      {
        canHandleTotalMs: DEFAULT_TIMEOUTS.knowledgeCanHandleTotalMs,
        getContextTimeoutMs: DEFAULT_TIMEOUTS.knowledgeGetContextMs,
        maxBytes: SESSION_CONTEXT_MAX_BYTES,
        onWarning: (msg, ctx) => deps.loggers.module('knowledge.aggregator').warn(msg, { data: ctx }),
      },
    );

    log.session(req.host_session_id).info('session_start', {
      event: 'session_start',
      data: { cwd: req.cwd, providers: result.diagnostics },
    });
    return result.context ? { additional_context: result.context } : {};
  });

  bridge.registerHandler('host_approval_request', async (req: HostApprovalRequestRequest): Promise<HostApprovalRequestResponse> => {
    log.session(req.host_session_id).info('approval_request', {
      event: 'approval_request', data: { tool: req.tool },
    });
    return approvalHandler(req);
  });

  // HTTP API — for the renderer to drive UI without the bridge.
  const httpApi = createHttpApi(
    { db: deps.db, registry, events, logger: deps.loggers.module('api') },
    { port: deps.httpPort ?? 0 },
  );

  let started = false;

  return {
    knowledge, approval: registry, policy, channel, bridge, httpApi, events,
    httpPort: () => httpApi.port(),

    async start(): Promise<void> {
      if (started) throw new Error('HelmApp already started');
      log.info('boot_start');
      await bridge.start();
      log.info('bridge_started', { data: { socket: deps.bridgeSocketPath ?? PATHS.bridgeSocket } });
      await channel.start();
      log.info('local_channel_started');
      await httpApi.start();
      log.info('http_api_started', { data: { port: httpApi.port() } });
      started = true;
      log.info('boot_complete');
    },

    async stop(): Promise<void> {
      if (!started) return;
      log.info('shutdown_start');
      await httpApi.stop();
      await channel.stop();
      // Settle pendings BEFORE tearing down the bridge so any awaiting
      // host_approval_request handler can flush its response back through
      // the socket. Otherwise bridge.stop() destroys the socket while the
      // handler is still awaiting registry.settled.
      registry.shutdown('helm app shutdown');
      // Yield a few ticks so resolved handlers complete their writes before
      // we close the server.
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
      await bridge.stop();
      started = false;
      log.info('shutdown_complete');
    },
  };
}
