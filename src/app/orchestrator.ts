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
import { LarkChannel } from '../channel/lark/adapter.js';
import { createLarkCliRunner } from '../channel/lark/cli-runner.js';
import { aggregateSessionContext } from '../knowledge/aggregator.js';
import { LocalRolesProvider } from '../knowledge/local-roles-provider.js';
import { DepscopeProvider } from '../knowledge/depscope-provider.js';
import { KnowledgeProviderRegistry, type KnowledgeProvider } from '../knowledge/types.js';
import { DepscopeProviderConfigSchema, type HelmConfig } from '../config/schema.js';
import { createHttpApi, type HttpApiHandle } from '../api/server.js';
import { createDiagnosticsBundle } from '../diagnostics/bundle.js';
import { DEFAULT_TIMEOUTS, PATHS, SESSION_CONTEXT_MAX_BYTES } from '../constants.js';
import { getHostSession, upsertHostSession } from '../storage/repos/host-sessions.js';
import {
  dequeueMessages,
  listBindingsForSession,
} from '../storage/repos/channel-bindings.js';
import { makePseudoEmbedFn } from '../mcp/embed.js';
import type { Logger, LoggerFactory } from '../logger/index.js';
import { createEventBus, type EventBus } from '../events/bus.js';
import { attachLarkChannel, type LarkWiringHandle } from './lark-wiring.js';
import type { HostStopRequest, HostStopResponse } from '../bridge/protocol.js';

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
  /**
   * Lark channel — opt-in. When provided, the orchestrator builds a LarkChannel
   * and wires its events into the registry / approval policy / channel queue.
   * Tests inject a pre-built channel; production reads `helm config` and
   * fills in `cliCommand` / env to hand to createLarkCliRunner.
   */
  lark?: {
    channel?: LarkChannel;
    cliCommand?: string;
    env?: NodeJS.ProcessEnv;
  };
  /**
   * host_stop wait-poll budget (ms). Defaults to DEFAULT_TIMEOUTS.waitPollMs
   * (10 minutes). Tests dial it down so the long-poll resolves promptly.
   */
  waitPollMs?: number;
  /**
   * Optional config (from `~/.helm/config.json`). When set, registers
   * configured KnowledgeProviders (DepscopeProvider et al.) into the
   * registry alongside the always-on LocalRolesProvider. Tests usually
   * skip this and add providers manually via `app.knowledge.register`.
   */
  config?: HelmConfig;
}

export interface HelmAppHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  // Exposed for tests + the Electron shell:
  readonly knowledge: KnowledgeProviderRegistry;
  readonly approval: ApprovalRegistry;
  readonly policy: ApprovalPolicyEngine;
  readonly channel: LocalChannel;
  readonly larkChannel: LarkChannel | null;
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

  // Knowledge — LocalRolesProvider always on; additional providers come from
  // `deps.config.knowledge.providers` (Phase 14 wires DepscopeProvider).
  const knowledge = new KnowledgeProviderRegistry();
  knowledge.register(new LocalRolesProvider({
    db: deps.db,
    embedFn: makePseudoEmbedFn(),
  }));
  for (const provider of buildConfiguredProviders(deps, log)) {
    knowledge.register(provider);
  }

  // Approval policy + registry. Registry restores any pending rows that survived
  // a previous restart so the user still sees the in-flight UI items.
  const policy = new ApprovalPolicyEngine(deps.db);
  const registry = new ApprovalRegistry(deps.db, {
    defaultTimeoutMs: deps.approvalTimeoutMs
      ?? deps.config?.approval?.defaultTimeoutMs
      ?? DEFAULT_TIMEOUTS.approvalMs,
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

  // host_stop — drains channel_message_queue and returns followup_message.
  // Long-polls via the EventBus so a channel-side message arriving mid-poll
  // resolves the request immediately instead of waiting for the next poll tick.
  const waitPollMs = deps.waitPollMs
    ?? deps.config?.approval?.waitPollMs
    ?? DEFAULT_TIMEOUTS.waitPollMs;
  bridge.registerHandler('host_stop', async (req: HostStopRequest): Promise<HostStopResponse> => {
    return runHostStopLongPoll(deps.db, events, req.host_session_id, waitPollMs);
  });

  // ── Lark channel (opt-in) ───────────────────────────────────────────────

  let larkChannel: LarkChannel | null = null;
  let larkWiring: LarkWiringHandle | null = null;
  const larkRequested = Boolean(deps.lark) || Boolean(deps.config?.lark?.enabled);
  if (larkRequested) {
    larkChannel = deps.lark?.channel ?? new LarkChannel({
      cli: createLarkCliRunner({
        command: deps.lark?.cliCommand ?? deps.config?.lark?.cliCommand,
        env: deps.lark?.env ?? deps.config?.lark?.env ?? process.env,
      }),
      onListenerError: (err, where) => deps.loggers.module('channel.lark').warn('listener_error', {
        event: where, data: { error: err.message },
      }),
      onListenerStatus: (status) => deps.loggers.module('channel.lark').info('listener_status', {
        event: status,
      }),
    });
    larkWiring = attachLarkChannel({
      db: deps.db,
      channel: larkChannel,
      registry,
      policy,
      events,
      log: deps.loggers.module('channel.lark.wiring'),
    });
  }

  // HTTP API — for the renderer to drive UI without the bridge.
  const httpApi = createHttpApi(
    {
      db: deps.db, registry, events, logger: deps.loggers.module('api'),
      createDiagnosticsBundle: () => createDiagnosticsBundle({ db: deps.db }),
    },
    { port: deps.httpPort ?? deps.config?.server?.port ?? 0 },
  );

  let started = false;

  return {
    knowledge, approval: registry, policy, channel, larkChannel, bridge, httpApi, events,
    httpPort: () => httpApi.port(),

    async start(): Promise<void> {
      if (started) throw new Error('HelmApp already started');
      log.info('boot_start');
      await bridge.start();
      log.info('bridge_started', { data: { socket: deps.bridgeSocketPath ?? PATHS.bridgeSocket } });
      await channel.start();
      log.info('local_channel_started');
      if (larkChannel) {
        await larkChannel.start();
        log.info('lark_channel_started');
      }
      await httpApi.start();
      log.info('http_api_started', { data: { port: httpApi.port() } });
      started = true;
      log.info('boot_complete');
    },

    async stop(): Promise<void> {
      if (!started) return;
      log.info('shutdown_start');
      await httpApi.stop();
      if (larkWiring) larkWiring.detach();
      if (larkChannel) await larkChannel.stop();
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

/**
 * host_stop long-poll. Returns immediately when there's already a queued
 * message; otherwise waits up to `waitPollMs` for `channel.message_enqueued`
 * to fire for any binding tied to this host_session.
 *
 * Multiple queued messages collapse into a single `followup_message` joined
 * by blank lines so Cursor sees them as one prompt-injection block.
 */
async function runHostStopLongPoll(
  db: Database.Database,
  events: EventBus,
  hostSessionId: string,
  waitPollMs: number,
): Promise<HostStopResponse> {
  const drain = (): string | null => {
    const bindings = listBindingsForSession(db, hostSessionId);
    const lines: string[] = [];
    for (const binding of bindings) {
      const messages = dequeueMessages(db, binding.id);
      for (const m of messages) {
        if (m.text) lines.push(m.text);
      }
    }
    return lines.length === 0 ? null : lines.join('\n\n');
  };

  // Drain once up-front so a message that arrived between two host_stop
  // calls returns immediately.
  const immediate = drain();
  if (immediate) return { followup_message: immediate };

  // Index the bindings we care about so the listener match is O(1).
  const watchedBindings = new Set(
    listBindingsForSession(db, hostSessionId).map((b) => b.id),
  );
  if (watchedBindings.size === 0) {
    // No bindings → nothing can ever enqueue for us. Resolve fast.
    return {};
  }

  return new Promise<HostStopResponse>((resolve) => {
    const finish = (response: HostStopResponse): void => {
      cleanup();
      resolve(response);
    };

    const timer = setTimeout(() => finish({}), waitPollMs);
    timer.unref?.();

    const unsubscribe = events.on((event) => {
      if (event.type !== 'channel.message_enqueued') return;
      if (!watchedBindings.has(event.bindingId)) return;
      const drained = drain();
      if (drained) finish({ followup_message: drained });
    });

    function cleanup(): void {
      clearTimeout(timer);
      unsubscribe();
    }
  });
}

/**
 * Materialize KnowledgeProviders declared in config.knowledge.providers.
 *
 * Validation errors per-provider don't crash the boot: log a warning and skip.
 * The local-roles provider is always registered separately by the caller.
 */
function buildConfiguredProviders(deps: HelmAppDeps, log: Logger): KnowledgeProvider[] {
  const decls = deps.config?.knowledge?.providers ?? [];
  const providers: KnowledgeProvider[] = [];

  for (const decl of decls) {
    if (!decl.enabled) continue;
    if (decl.id === 'depscope') {
      const parsed = DepscopeProviderConfigSchema.safeParse(decl.config ?? {});
      if (!parsed.success) {
        log.warn('knowledge_provider_config_invalid', {
          data: { id: decl.id, issues: parsed.error.issues },
        });
        continue;
      }
      providers.push(new DepscopeProvider({
        endpoint: parsed.data.endpoint,
        authToken: parsed.data.authToken,
        mappings: parsed.data.mappings,
        cacheTtlMs: parsed.data.cacheTtlMs,
        requestTimeoutMs: parsed.data.requestTimeoutMs,
        onWarning: (msg, ctx) => deps.loggers.module('knowledge.depscope').warn(msg, { data: ctx }),
      }));
      continue;
    }
    log.warn('knowledge_provider_unknown_id', { data: { id: decl.id } });
  }

  return providers;
}
