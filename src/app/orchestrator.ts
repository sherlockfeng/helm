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
  HostAgentResponseRequest,
  HostAgentResponseResponse,
  HostApprovalRequestRequest,
  HostApprovalRequestResponse,
  HostPromptSubmitRequest,
  HostPromptSubmitResponse,
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
import { seedBuiltinRoles, trainRole } from '../roles/library.js';
import { DepscopeProvider } from '../knowledge/depscope-provider.js';
import { RequirementsArchiveProvider } from '../knowledge/requirements-archive-provider.js';
import { KnowledgeProviderRegistry, type KnowledgeProvider } from '../knowledge/types.js';
import { DepscopeProviderConfigSchema, type HelmConfig } from '../config/schema.js';
import { createHttpApi, type HttpApiHandle } from '../api/server.js';
import { createDiagnosticsBundle } from '../diagnostics/bundle.js';
import { saveHelmConfig } from '../config/loader.js';
import { WorkflowEngine } from '../workflow/engine.js';
import { CursorLlmClient } from '../summarizer/cursor-client.js';
import { summarizeCampaign } from '../summarizer/campaign.js';
import { HelmConfigSchema } from '../config/schema.js';
import { consumePendingBind } from './lark-wiring.js';
import { DEFAULT_TIMEOUTS, PATHS, SESSION_CONTEXT_MAX_BYTES } from '../constants.js';
import {
  closeStaleHostSessions,
  getHostSession,
  setHostSessionFirstPrompt,
  upsertHostSession,
} from '../storage/repos/host-sessions.js';
import {
  dequeueMessages,
  listBindingsForSession,
} from '../storage/repos/channel-bindings.js';
import { makePseudoEmbedFn } from '../mcp/embed.js';
import { createMcpServer } from '../mcp/server.js';
import { createCursorAgentSpawner } from '../spawner/cursor-spawner.js';
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
   * Phase 47: cutoff age (ms) for stale-pruning host_sessions on boot.
   * Sessions whose `last_seen_at` is older than `now - cutoff` are flipped to
   * status='closed'. Defaults to 24h. Tests dial this down to a few ms to
   * exercise the prune deterministically.
   */
  staleSessionCutoffMs?: number;
  /**
   * Phase 53: per-provider budget (ms) for `getSessionContext`. Defaults to
   * `DEFAULT_TIMEOUTS.knowledgeGetContextMs` (5 s). The aggregator's
   * hanging-provider e2e (`tests/e2e/session-start-injection/attack`) used
   * to take 5 s on its own — 60% of the entire e2e wall time — because it
   * had to wait the full default budget. Tests dial this to ~200 ms to
   * exercise the same code path 25× faster.
   */
  knowledgeGetContextMs?: number;
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
  /**
   * Override the on-disk config path. Default `~/.helm/config.json`. Tests
   * point this at a tmpfile so PUT /api/config doesn't clobber the user's
   * real config. Wires straight through to `saveHelmConfig({ path })`.
   */
  configPath?: string;
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
  readonly workflowEngine: WorkflowEngine;
  /** Resolved port after start. */
  httpPort(): number | null;
}

export function createHelmApp(deps: HelmAppDeps): HelmAppHandle {
  const log: Logger = deps.loggers.module('app');

  // Phase 34: seed built-in roles on boot. The class docstring (§7.3 step 1)
  // already promised this, but the code only did it inside createMcpServer —
  // so until Cursor first invoked the MCP stdio subprocess, the roles table
  // was empty and the Active Chats UI's role dropdown was disabled
  // (`roles.length === 0` short-circuit). Idempotent: skips rows that already
  // exist by id.
  seedBuiltinRoles(deps.db);

  // Phase 47: stale-prune host_sessions. Cursor doesn't fire any "chat ended"
  // signal when the user Cmd-W's a tab, so without this every chat ever
  // opened sits as 'active' forever and inflates the menubar tray's "active
  // chats" count + the Active Chats list. 24h cutoff is generous — anything
  // genuinely in use will have a hook event within that window (sessionStart,
  // beforeSubmitPrompt, afterAgentResponse all bump last_seen_at).
  const staleCutoff = new Date(
    Date.now() - (deps.staleSessionCutoffMs ?? 24 * 60 * 60 * 1000),
  ).toISOString();
  const pruned = closeStaleHostSessions(deps.db, staleCutoff);
  if (pruned > 0) {
    log.info('boot_pruned_stale_sessions', {
      data: { count: pruned, cutoff: staleCutoff },
    });
  }

  // Event bus — orchestrator publishes high-level events here; the HTTP API's
  // /api/events SSE endpoint subscribes and forwards to the renderer.
  const events = createEventBus({
    onListenerError: (err, type) => log.warn('event_listener_threw', {
      event: type, data: { error: err.message },
    }),
  });

  // Live config snapshot the renderer reads / writes via /api/config. Hoisted
  // ahead of provider wiring (Phase 27 / D4) so reconfigureProviders can read
  // it on every saveConfig.
  let liveConfig = deps.config ?? HelmConfigSchema.parse({});

  // Knowledge — LocalRolesProvider + RequirementsArchiveProvider always on
  // (canHandle gates per-session — no `requirements/` dir = quietly skipped).
  // Additional providers come from `liveConfig.knowledge.providers` and are
  // re-registered whenever PUT /api/config rewrites them (D4).
  //
  // Phase 42: resolveRoleId now returns the full set of role bindings from
  // the host_session_roles join table. LocalRolesProvider concatenates each
  // role's system prompt + chunks at sessionStart so the user can stack
  // multiple experts (e.g. Goofy 专家 + 容灾大盘专家) on a single chat.
  // Empty array → provider is a no-op (no surprise injection).
  const knowledge = new KnowledgeProviderRegistry();
  knowledge.register(new LocalRolesProvider({
    db: deps.db,
    embedFn: makePseudoEmbedFn(),
    resolveRoleId: (ctx) => {
      if (!ctx.hostSessionId) return undefined;
      const session = getHostSession(deps.db, ctx.hostSessionId);
      return session?.roleIds ?? [];
    },
  }));
  knowledge.register(new RequirementsArchiveProvider());

  // Phase 27 (D4): re-registerable set of providers driven by liveConfig.
  // Tracks the IDs we own so saveConfig can drop the old set before adding
  // the new one — without touching the always-on providers above.
  let configuredProviderIds = new Set<string>();
  function reconfigureKnowledgeProviders(): void {
    for (const id of configuredProviderIds) {
      knowledge.unregister(id);
    }
    configuredProviderIds = new Set<string>();
    for (const provider of buildConfiguredProviders(liveConfig, deps.loggers, log)) {
      knowledge.register(provider);
      configuredProviderIds.add(provider.id);
    }
  }
  reconfigureKnowledgeProviders();

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

  // Phase 46: dismiss the OS toast the moment the approval is finalized.
  // Covers every settle path — local UI click, Lark `/allow`, policy rule,
  // timeout — because `approval.settled` is the canonical "the gate
  // cleared" signal. closeForApproval is a no-op when the notifier doesn't
  // implement it (NoopNotifier in tests / headless) or when this id was
  // never shown.
  events.on((e) => {
    if (e.type !== 'approval.settled') return;
    deps.notifier?.closeForApproval?.(e.approvalId);
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
    // Phase 46: only chats with at least one remote-channel binding (Lark
    // today) need helm's extra approval gate. Unbound chats are auto-
    // allowed — the user clearly isn't using helm to remote-mediate this
    // session, so creating pending rows for them is just noise.
    requireApproval: (sessionId) => {
      if (!sessionId) return false;
      const bindings = listBindingsForSession(deps.db, sessionId);
      return bindings.some((b) => b.channel === 'lark');
    },
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
        getContextTimeoutMs: deps.knowledgeGetContextMs ?? DEFAULT_TIMEOUTS.knowledgeGetContextMs,
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

  // host_prompt_submit — Phase 32. Capture the chat's opening user message
  // as `host_sessions.first_prompt` so the Active Chats UI has a stable,
  // human-readable label. Cursor's auto-generated chat title isn't surfaced
  // by any hook payload (it's invented client-side after the first reply),
  // so the first prompt is the next-best signal we can grab.
  //
  // - First call on a session writes the prompt; subsequent calls are no-ops
  //   (the SQL has `WHERE first_prompt IS NULL`).
  // - Always returns `{ continue: true }` so we never block Cursor's flow.
  // - lastSeenAt also bumps so Active Chats stays accurate during long chats
  //   that don't fire other hooks for a while.
  bridge.registerHandler('host_prompt_submit', async (req: HostPromptSubmitRequest): Promise<HostPromptSubmitResponse> => {
    // Phase 43: auto-register the session if helm hasn't seen it yet. Common
    // when a Cursor chat was already open before helm booted (or before the
    // hooks were installed) — the user can now just send any message and the
    // chat appears in Active Chats. Idempotent: existing rows update
    // last_seen_at via the upsert ON CONFLICT path.
    autoUpsertSession(deps.db, events, log, req.host_session_id, req.cwd);
    const trimmed = (req.prompt ?? '').trim();
    if (trimmed) {
      setHostSessionFirstPrompt(deps.db, req.host_session_id, trimmed);
      log.session(req.host_session_id).info('prompt_submit', {
        event: 'prompt_submit',
        data: { promptLen: trimmed.length, cwd: req.cwd },
      });
    }
    return { continue: true };
  });

  // host_agent_response — Phase 38. After Cursor's agent finishes its reply,
  // mirror the response text back to every Lark binding for this session so
  // the user sees the bidirectional conversation in their Lark thread without
  // having to toggle to Cursor.
  //
  // Returns `{ ok: true, suppressed }` always — never blocks Cursor on Lark
  // delivery problems. `suppressed=true` when no bindings → caller knows it
  // was intentionally a no-op (vs. quietly failing).
  bridge.registerHandler('host_agent_response', async (req: HostAgentResponseRequest): Promise<HostAgentResponseResponse> => {
    // Phase 43: auto-register on agent reply too — covers chats that emit a
    // response before any user prompt this session (rare, but graceful).
    autoUpsertSession(deps.db, events, log, req.host_session_id);
    const text = (req.response_text ?? '').trim();
    if (!text) return { ok: true, suppressed: true };

    const allBindings = listBindingsForSession(deps.db, req.host_session_id);
    const larkBindings = allBindings.filter((b) => b.channel === 'lark');
    if (larkBindings.length === 0) return { ok: true, suppressed: true };

    if (!larkChannel) {
      log.warn('agent_response_no_lark_channel', {
        data: { hostSessionId: req.host_session_id, bindings: larkBindings.length },
      });
      return { ok: true, suppressed: true };
    }

    // Fire-and-forget per binding. One Lark thread failing must not block
    // delivery to others or the host_agent_response RPC itself.
    for (const binding of larkBindings) {
      void larkChannel.sendMessage(binding, text).catch((err) => {
        log.warn('lark_send_agent_response_failed', {
          data: { bindingId: binding.id, error: (err as Error).message },
        });
      });
    }
    log.session(req.host_session_id).info('agent_response_mirrored', {
      event: 'agent_response',
      data: { bindings: larkBindings.length, textLen: text.length },
    });
    return { ok: true };
  });

  // host_stop — drains channel_message_queue and returns followup_message.
  // Long-polls via the EventBus so a channel-side message arriving mid-poll
  // resolves the request immediately instead of waiting for the next poll tick.
  const waitPollMs = deps.waitPollMs
    ?? deps.config?.approval?.waitPollMs
    ?? DEFAULT_TIMEOUTS.waitPollMs;
  bridge.registerHandler('host_stop', async (req: HostStopRequest): Promise<HostStopResponse> => {
    autoUpsertSession(deps.db, events, log, req.host_session_id);
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
      // Phase 37: stderr is downgraded to info (it's mostly version notices
      // + proxy warnings from lark-cli — not actual errors). Real problems
      // (spawn failures, parse errors, real process exits) stay at warn.
      onListenerError: (err, where) => {
        const log = deps.loggers.module('channel.lark');
        if (where === 'stderr') {
          log.info('listener_stderr', { event: where, data: { line: err.message } });
        } else {
          log.warn('listener_error', { event: where, data: { error: err.message } });
        }
      },
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

  // Workflow engine — `isDocFirstEnforced` reads liveConfig per call so a
  // PUT /api/config that toggles `docFirst.enforce` takes effect on the
  // next completeTask without a process restart. The engine is reused
  // here AND inside the MCP server (Phase 7); both honor the same flag.
  const workflowEngine = new WorkflowEngine(deps.db, {
    isDocFirstEnforced: () => liveConfig.docFirst.enforce,
  });

  // Cursor LLM client for summarize_campaign (Phase 24, replaces Phase 22's
  // Anthropic path). Local mode reuses the user's Cursor app auth — no
  // extra key needed. Cloud mode falls back to CURSOR_API_KEY env. The
  // client is rebuilt inside summarizeFn so a Settings edit + Save
  // propagates on the next call without restart.
  function summarizeFn(): (campaignId: string) => Promise<unknown> {
    return async (campaignId: string) => {
      const llm = new CursorLlmClient({
        apiKey: liveConfig.cursor.apiKey,
        modelId: liveConfig.cursor.model,
        mode: liveConfig.cursor.mode,
      });
      return summarizeCampaign(deps.db, campaignId, {
        llm,
        model: liveConfig.cursor.model,
        // Cursor's Agent.prompt ignores maxTokens (model-config layer owns
        // it); pass through for the LlmClient interface contract.
        maxTokens: 2048,
      });
    };
  }

  // Phase 45: MCP HTTP/SSE factory. Builds a fresh McpServer per SSE
  // connection, reusing the orchestrator's already-built knowledge registry
  // + workflow engine. Spawner / LLM client read liveConfig at factory
  // invocation time so a Settings save → next-Cursor-reconnect picks up
  // the new config without restarting helm itself.
  function mcpFactory() {
    let spawner;
    try {
      spawner = createCursorAgentSpawner({
        mode: liveConfig.cursor.mode,
        apiKey: liveConfig.cursor.apiKey,
        modelId: liveConfig.cursor.model,
      });
    } catch {
      // start_relay_chat_session will return an actionable errorResult.
      spawner = undefined;
    }
    const llm = new CursorLlmClient({
      apiKey: liveConfig.cursor.apiKey,
      modelId: liveConfig.cursor.model,
      mode: liveConfig.cursor.mode,
    });
    return createMcpServer({
      db: deps.db,
      knowledge,
      ...(spawner ? { spawner } : {}),
      llm,
    });
  }

  // HTTP API — for the renderer to drive UI without the bridge.
  const httpApi = createHttpApi(
    {
      db: deps.db, registry, policy, events, logger: deps.loggers.module('api'),
      mcpFactory,
      createDiagnosticsBundle: () => createDiagnosticsBundle({ db: deps.db }),
      getConfig: () => liveConfig,
      saveConfig: (input) => {
        const saveOpts = deps.configPath ? { path: deps.configPath } : {};
        liveConfig = saveHelmConfig(input, saveOpts);
        // Phase 27 (D4): provider hot-reload — drop the old configured
        // providers and rebuild from liveConfig so a Settings save takes
        // effect without a Helm restart. Always-on providers
        // (LocalRolesProvider / RequirementsArchiveProvider) are untouched.
        reconfigureKnowledgeProviders();
        log.info('config_saved_providers_reloaded', {
          data: { configuredIds: [...configuredProviderIds] },
        });
        return liveConfig;
      },
      consumePendingBind: (code, hostSessionId) => {
        const created = consumePendingBind(deps.db, events, code, hostSessionId);
        return created ? { id: created.id } : null;
      },
      workflowEngine,
      // Phase 24: Cursor SDK summarize. Local mode reuses the user's Cursor
      // app auth — no helm-side key required. The factory is always wired;
      // runtime errors from CursorLlmClient (Cursor not installed / not
      // signed in) bubble as 500. Tests bypass by overriding the dep.
      summarizeCampaign: summarizeFn(),
      // B3: train the same roles LocalRolesProvider reads from. The shared
      // pseudo-embed function keeps the embeddings consistent between
      // training-time and search-time so the chunks match.
      trainRole: async (input) => trainRole(deps.db, {
        ...input,
        embedFn: makePseudoEmbedFn(),
      }),
    },
    { port: deps.httpPort ?? deps.config?.server?.port ?? 0 },
  );

  let started = false;

  return {
    knowledge, approval: registry, policy, channel, larkChannel, bridge, httpApi, events, workflowEngine,
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
 * Materialize KnowledgeProviders declared in `config.knowledge.providers`.
 *
 * Pure function of the config snapshot — no `deps.config` reads — so the
 * Phase 27 (D4) hot-reload path can pass a fresh `liveConfig` after a
 * /api/config PUT and get the new provider set with no boot-vs-runtime drift.
 *
 * Validation errors per-provider don't crash: log a warning and skip the
 * offender. Always-on providers (LocalRolesProvider / RequirementsArchive)
 * are registered separately by the caller and unaffected.
 */
function buildConfiguredProviders(
  config: HelmConfig,
  loggers: LoggerFactory,
  log: Logger,
): KnowledgeProvider[] {
  const decls = config.knowledge?.providers ?? [];
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
        onWarning: (msg, ctx) => loggers.module('knowledge.depscope').warn(msg, { data: ctx }),
      }));
      continue;
    }
    log.warn('knowledge_provider_unknown_id', { data: { id: decl.id } });
  }

  return providers;
}

/**
 * Phase 43: ensure a host_session row exists for the given id, creating a
 * minimal one if not. Called from every bridge handler so a Cursor chat
 * that pre-existed before helm booted (or before the hooks were installed)
 * gets registered the moment ANY hook event fires for it — instead of
 * being invisible until the user reopens the chat.
 *
 * Idempotent: existing rows just bump last_seen_at via the upsert ON
 * CONFLICT path. Emits `session.started` only on first sight so the
 * renderer's Active Chats refreshes in real time.
 */
function autoUpsertSession(
  db: Database.Database,
  events: EventBus,
  log: Logger,
  hostSessionId: string,
  cwd?: string,
): void {
  const existing = getHostSession(db, hostSessionId);
  const now = new Date().toISOString();
  upsertHostSession(db, {
    id: hostSessionId,
    host: 'cursor',
    cwd: cwd ?? existing?.cwd,
    composerMode: existing?.composerMode,
    status: 'active',
    firstSeenAt: existing?.firstSeenAt ?? now,
    lastSeenAt: now,
  });
  if (!existing) {
    const persisted = getHostSession(db, hostSessionId);
    if (persisted) {
      events.emit({ type: 'session.started', session: persisted });
      log.session(hostSessionId).info('auto_register_session', {
        event: 'auto_register',
        data: { cwd: cwd ?? null, source: 'mid-event' },
      });
    }
  }
}
