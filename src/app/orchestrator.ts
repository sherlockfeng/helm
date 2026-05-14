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
import { seedBuiltinRoles, setLifecycleSweepTrigger, trainRole } from '../roles/library.js';
import { runArchivalSweep } from '../roles/lifecycle.js';
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
import { consumePendingBind, createPendingLarkBind } from './lark-wiring.js';
import { setupMcp as runSetupMcp } from '../cli/setup-mcp.js';
import { DEFAULT_TIMEOUTS, PATHS, SESSION_CONTEXT_MAX_BYTES } from '../constants.js';
import {
  closeStaleHostSessions,
  getHostSession,
  setHostSessionFirstPrompt,
  setLastInjectedGuideVersion,
  setLastInjectedRoleIds,
  upsertHostSession,
} from '../storage/repos/host-sessions.js';
import {
  dequeueMessages,
  enqueueMessage,
  listBindingsForSession,
} from '../storage/repos/channel-bindings.js';
import { makePseudoEmbedFn } from '../mcp/embed.js';
import { createMcpServer } from '../mcp/server.js';
import { runReview as runHarnessReview } from '../harness/review-runner.js';
import { EngineRouter, EngineNotAvailableError } from '../engine/router.js';
import { buildClaudeAdapter } from '../engine/adapters/claude-adapter.js';
import { buildCursorAdapter } from '../engine/adapters/cursor-adapter.js';
import { detectEngines } from '../engine/detect.js';
import { detectCursorAgentCli } from '../cli-agent/cursor.js';
import type { EngineAdapter, EngineId } from '../engine/types.js';
import { getHarnessTaskByHostSession } from '../storage/repos/harness.js';
import { assembleHarnessSessionContext } from '../harness/session-inject.js';
import {
  HELM_TOOL_GUIDE,
  HELM_TOOL_GUIDE_VERSION,
  wrapToolGuideForPromptInjection,
} from './helm-tool-guide.js';
import { detectClaudeCli } from '../cli-agent/claude.js';
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

  // Phase 77: knowledge-lifecycle wiring.
  //
  //   - On boot: one immediate sweep so a long-idle install catches up.
  //   - Every 24h: cron-style sweep across every role with chunks.
  //   - On mutation (trainRole / updateRole / drop_knowledge_source): a
  //     fire-and-forget per-role sweep, via the library + MCP triggers.
  //
  // The sweep reads thresholds from `liveConfig.knowledge.lifecycle`
  // through a closure so a Settings edit takes effect on the NEXT sweep
  // — no orchestrator restart needed. `unref` on the interval so test
  // suites that forget to call `.stop()` don't deadlock the event loop.
  const lifecycleLog = deps.loggers.module('knowledge.lifecycle');
  function runSweepWithLogging(roleId?: string): void {
    try {
      const result = runArchivalSweep(deps.db, {
        ...(roleId ? { roleId } : {}),
        thresholds: liveConfig.knowledge?.lifecycle,
      });
      // Decision §11: log-only reporting, no UI. Skip noisy empty sweeps
      // (no candidates anywhere) — only log when at least one role had
      // candidates to consider OR at least one chunk got archived.
      if (result.archived > 0 || result.scanned > 0) {
        lifecycleLog.info('archival_sweep_completed', {
          data: {
            ...(roleId ? { roleId } : { scope: 'all_roles' }),
            scanned: result.scanned,
            archived: result.archived,
            skipped: result.skipped,
            durationMs: result.durationMs,
            byRole: result.byRole.filter((r) => r.scanned > 0),
          },
        });
      }
    } catch (err) {
      lifecycleLog.warn('archival_sweep_failed', {
        data: { error: (err as Error).message, ...(roleId ? { roleId } : {}) },
      });
    }
  }
  // Mutation-driven sweep: library + MCP fire this fire-and-forget. We
  // do the actual SQL on a microtask so the caller's promise resolves
  // before the sweep starts hitting the DB.
  setLifecycleSweepTrigger((roleId) => {
    queueMicrotask(() => runSweepWithLogging(roleId));
  });
  // Boot sweep — synchronous so failures show up in the boot log.
  runSweepWithLogging();
  // 24h cron tick.
  const LIFECYCLE_CRON_MS = 24 * 60 * 60 * 1000;
  const lifecycleCron: NodeJS.Timeout = setInterval(() => {
    runSweepWithLogging();
  }, LIFECYCLE_CRON_MS);
  lifecycleCron.unref?.();

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

  // Phase 72: when a binding is removed, auto-settle any pending approvals
  // belonging to that chat if the chat now has NO remaining Lark binding.
  // Rationale: the Phase 46 gate auto-allows new approvals for unbound
  // chats. Without this listener, approvals that landed BEFORE the unbind
  // sit in pending state until they hit the timeout (~10 min default) —
  // the user sees a "approval needed" notification long after they've
  // disconnected the chat from Lark. We settle with `permission='allow'`
  // to match the gate's "no remote channel → auto-allow" semantics. The
  // decided-by tag distinguishes this from the regular policy / UI paths
  // in the audit trail.
  events.on((e) => {
    if (e.type !== 'binding.removed') return;
    const hostSessionId = e.hostSessionId;
    if (!hostSessionId) return;
    // Only auto-settle if the chat has no remaining Lark binding —
    // matches the requireApproval gate. If another Lark thread is still
    // bound, the user might still expect the approval to flow through
    // there; leave the pending row alone.
    const remaining = listBindingsForSession(deps.db, hostSessionId);
    if (remaining.some((b) => b.channel === 'lark')) return;

    const pending = registry.listPending().filter((r) => r.hostSessionId === hostSessionId);
    for (const req of pending) {
      const settled = registry.settle(req.id, {
        permission: 'allow',
        decidedBy: 'policy',
        reason: 'binding removed — chat no longer remote-mediated, helm auto-allowed',
      });
      if (settled) {
        events.emit({
          type: 'approval.settled',
          approvalId: req.id,
          decision: 'allow',
          decidedBy: 'policy',
          reason: 'binding removed',
        });
      }
    }
    if (pending.length > 0) {
      log.info('binding_removed_auto_settled_pending', {
        data: { hostSessionId, count: pending.length },
      });
    }
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
        getContextTimeoutMs: DEFAULT_TIMEOUTS.knowledgeGetContextMs,
        maxBytes: SESSION_CONTEXT_MAX_BYTES,
        onWarning: (msg, ctx) => deps.loggers.module('knowledge.aggregator').warn(msg, { data: ctx }),
      },
    );

    // Phase 56: record the role-id set we just injected so the
    // host_prompt_submit handler doesn't re-inject the same content on the
    // very first prompt. Always record (even on empty result) — that gives
    // us a clean "synced empty state" baseline.
    const currentRoleIds = persisted?.roleIds ?? [];
    setLastInjectedRoleIds(deps.db, req.host_session_id, currentRoleIds);

    // Phase 67: Harness stage prompt injection. When a Cursor chat is bound
    // to a Harness task, layer the appropriate stage's system prompt on top
    // of the (possibly-empty) role context. This is the primary mechanism
    // by which the chat learns "you're in implement mode for task X" — no
    // user paste-in required. The injected block also points at the on-disk
    // task.md so the agent reads the durable memory itself.
    const harnessTask = getHarnessTaskByHostSession(deps.db, req.host_session_id);
    const harnessBlock = harnessTask ? assembleHarnessSessionContext(harnessTask) : '';
    // Phase 71: append the Helm tool guide. Always inject at session_start —
    // it's short and sits next to the (much larger) role context. Record
    // the version so the host_prompt_submit fallback path doesn't double-
    // inject. Done LAST so the guide appears at the end of the system block;
    // role + harness context come first since they're chat-specific.
    const merged = [result.context ?? '', harnessBlock, HELM_TOOL_GUIDE]
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .join('\n\n---\n\n');
    setLastInjectedGuideVersion(deps.db, req.host_session_id, HELM_TOOL_GUIDE_VERSION);

    log.session(req.host_session_id).info('session_start', {
      event: 'session_start',
      data: {
        cwd: req.cwd,
        providers: result.diagnostics,
        injectedRoleIds: currentRoleIds,
        harnessTaskId: harnessTask?.id ?? null,
        harnessStage: harnessTask?.currentStage ?? null,
        guideVersion: HELM_TOOL_GUIDE_VERSION,
      },
    });
    return merged ? { additional_context: merged } : {};
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

    // Phase 56: re-inject role context when the chat's bound roles changed
    // since helm last injected. Use case: user is mid-chat, realizes they
    // need Goofy 专家, binds it via the Active Chats UI. Cursor's
    // `sessionStart` already fired so `additional_context` won't reach this
    // chat again; the only response field we have here is `user_message`,
    // so we prefix the role markdown into the user's prompt with a clearly-
    // marked helm block. The agent treats the block as system context (the
    // marker is explicit), and subsequent prompts skip injection until the
    // binding changes again.
    //
    // "never injected" (column null) vs "synced empty state" (column = [])
    // are treated as DIFFERENT — the first prompt-submit always writes a
    // baseline so subsequent comparisons have a stable anchor.
    const session = getHostSession(deps.db, req.host_session_id);
    // Blocks we want to prefix into the user's message, in the order they
    // should appear. Each path appends independently; we assemble once.
    const prefixBlocks: string[] = [];

    if (session && session.cwd) {
      const currentRoleIds = [...(session.roleIds ?? [])].sort();
      const sameSet = session.lastInjectedRoleIds !== undefined
        && session.lastInjectedRoleIds.length === currentRoleIds.length
        && [...session.lastInjectedRoleIds].sort().every((id, i) => id === currentRoleIds[i]);
      const lastInjected = [...(session.lastInjectedRoleIds ?? [])].sort();

      if (!sameSet) {
        // Always record the new baseline — even when current is empty (user
        // unbound everything) so the next prompt-submit doesn't re-trigger.
        setLastInjectedRoleIds(deps.db, req.host_session_id, currentRoleIds);

        if (currentRoleIds.length > 0) {
          const result = await aggregateSessionContext(
            knowledge,
            { hostSessionId: req.host_session_id, cwd: session.cwd },
            {
              canHandleTotalMs: DEFAULT_TIMEOUTS.knowledgeCanHandleTotalMs,
              getContextTimeoutMs: DEFAULT_TIMEOUTS.knowledgeGetContextMs,
              maxBytes: SESSION_CONTEXT_MAX_BYTES,
              onWarning: (msg, ctx) => deps.loggers.module('knowledge.aggregator').warn(msg, { data: ctx }),
            },
          );

          if (result.context) {
            const block = [
              '<helm:role-context>',
              `<!-- helm injected ${new Date().toISOString()} — bound roles changed mid-chat. -->`,
              '<!-- The following is system context for the agent, not user input. -->',
              result.context,
              '</helm:role-context>',
            ].join('\n');
            prefixBlocks.push(block);
            log.session(req.host_session_id).info('prompt_submit_role_inject', {
              event: 'prompt_submit_role_inject',
              data: {
                prevRoleIds: lastInjected,
                nextRoleIds: currentRoleIds,
                contextLen: result.context.length,
                providers: result.diagnostics,
              },
            });
          }
        } else {
          log.session(req.host_session_id).info('prompt_submit_role_unbound', {
            event: 'prompt_submit_role_unbound',
            data: { prevRoleIds: lastInjected },
          });
        }
      }

      // Phase 71: inject the Helm tool guide if this chat hasn't yet
      // received the current version. Catches:
      //   - chats that existed BEFORE helm started (sessionStart never fired)
      //   - chats where the guide text was bumped (lastInjectedGuideVersion
      //     lags HELM_TOOL_GUIDE_VERSION)
      // Idempotent: after injecting we mark the version, so subsequent
      // prompts in the same chat skip this path. We do NOT block on the
      // role path being a no-op — the guide injects even when no role
      // change happened, as long as the version is stale.
      if (session.lastInjectedGuideVersion !== HELM_TOOL_GUIDE_VERSION) {
        prefixBlocks.push(wrapToolGuideForPromptInjection());
        setLastInjectedGuideVersion(deps.db, req.host_session_id, HELM_TOOL_GUIDE_VERSION);
        log.session(req.host_session_id).info('prompt_submit_guide_inject', {
          event: 'prompt_submit_guide_inject',
          data: {
            from: session.lastInjectedGuideVersion ?? null,
            to: HELM_TOOL_GUIDE_VERSION,
          },
        });
      }
    }

    if (prefixBlocks.length > 0) {
      const rewritten = `${prefixBlocks.join('\n\n')}\n\n${req.prompt ?? ''}`;
      return { continue: true, user_message: rewritten };
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

    // Phase 61: bind-ack — when a Lark binding lands, post an immediate ack
    // to the bound thread AND enqueue a one-shot confirm-request for the
    // Cursor side. The Lark post is instant (doesn't depend on Cursor being
    // open); the queued message fires on the next `host_stop` long-poll so
    // the user also sees a "Cursor agent is alive" reply mirrored back to
    // Lark. Both are best-effort — failures here never undo the bind.
    const ackLog = deps.loggers.module('lark.bind-ack');
    events.on((e) => {
      if (e.type !== 'binding.created') return;
      const binding = e.binding;
      if (binding.channel !== 'lark' || !larkChannel) return;
      const session = binding.hostSessionId
        ? getHostSession(deps.db, binding.hostSessionId)
        : undefined;
      const cwd = session?.cwd ?? '(cwd unknown)';
      const labelSuffix = binding.label ? ` (${binding.label})` : '';
      const shortSession = (binding.hostSessionId ?? '').slice(0, 8) || '?';

      // 1. Direct Lark ack — instant feedback, doesn't depend on Cursor.
      const ackText = [
        `✅ Helm 已绑定到 Cursor chat${labelSuffix}`,
        `cwd: \`${cwd}\``,
        `chat: \`${shortSession}\``,
        '',
        '在这个 thread 里发的消息会被转发到 Cursor。',
      ].join('\n');
      void larkChannel.sendMessage(binding, ackText, { kind: 'notice' })
        .catch((err) => ackLog.warn('lark_post_failed', {
          data: { error: (err as Error).message, bindingId: binding.id },
        }));

      // 2. Cursor-side confirm-request — fires on next host_stop. Phrased to
      // discourage real work; we just want a one-line "alive" reply that
      // the afterAgentResponse mirror will bounce back to Lark.
      const confirmPrompt = [
        '【Helm 绑定确认 · 自动注入，请勿当作真实 user 任务】',
        '',
        `Helm 刚把这个 chat 绑定到 Lark。请用一句话回复"已收到来自 Lark 的连接确认（cwd: ${cwd}）"，不要做任何工具调用、代码修改或推理 — 这只是连通性测试。`,
      ].join('\n');
      try {
        const messageRowId = enqueueMessage(deps.db, {
          bindingId: binding.id,
          text: confirmPrompt,
          createdAt: new Date().toISOString(),
        });
        events.emit({
          type: 'channel.message_enqueued',
          bindingId: binding.id,
          messageId: messageRowId,
        });
        ackLog.info('bind_ack_enqueued', {
          data: { bindingId: binding.id, messageId: messageRowId },
        });
      } catch (err) {
        ackLog.warn('enqueue_failed', {
          data: { error: (err as Error).message, bindingId: binding.id },
        });
      }
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
  //
  // Phase 68: now routes through EngineRouter so the user's global default
  // engine choice flows through. Cursor path keeps the existing semantics;
  // claude path produces JSON via `claude -p` and gets a format-pass retry
  // wrapped around it (see claude-adapter + json-retry).
  function summarizeFn(): (campaignId: string) => Promise<unknown> {
    return async (campaignId: string) => {
      const adapter = engineRouter.current();
      return summarizeCampaign(deps.db, campaignId, {
        llm: adapter.summarize,
        // `model` only matters to the cursor adapter; claude ignores it.
        model: liveConfig.cursor.model,
        maxTokens: 2048,
      });
    };
  }

  // Phase 68: EngineRouter. Adapters are rebuilt on every Settings save
  // (because the underlying cursor SDK config depends on liveConfig.cursor)
  // via `refreshEngineRouter()`; the router itself holds onto a mutable
  // adapter map so the rebuild swap is atomic from caller POV.
  let currentAdapters: Partial<Record<EngineId, EngineAdapter>> = {};
  function buildAdapters(): Partial<Record<EngineId, EngineAdapter>> {
    const httpPort = httpApi.port();
    const helmMcpUrl = httpPort
      ? `http://127.0.0.1:${httpPort}/mcp/sse`
      : undefined;
    const map: Partial<Record<EngineId, EngineAdapter>> = {};
    if (claudeAvailable) {
      const claudeDeps: Parameters<typeof buildClaudeAdapter>[0] = {};
      if (helmMcpUrl) claudeDeps.helmMcpUrl = helmMcpUrl;
      map.claude = buildClaudeAdapter(claudeDeps);
    }
    // The cursor adapter's summarize/review work without cursor-agent (they
    // go through the SDK), but runConversation needs the CLI. We always
    // register the adapter when the Cursor SDK can be constructed; the
    // adapter itself throws EngineCapabilityUnsupportedError on the
    // conversational path when cursorAgentAvailable === false.
    try {
      const cursorDeps: Parameters<typeof buildCursorAdapter>[0] = {
        cursor: {
          mode: liveConfig.cursor.mode,
          model: liveConfig.cursor.model,
          ...(liveConfig.cursor.apiKey ? { apiKey: liveConfig.cursor.apiKey } : {}),
        },
        cursorAgentAvailable,
      };
      if (helmMcpUrl) cursorDeps.helmMcpUrl = helmMcpUrl;
      map.cursor = buildCursorAdapter(cursorDeps);
    } catch (err) {
      // CursorLlmClient throws in cloud mode when no API key is configured.
      // That's a config issue, not a "binary missing" — log + skip so the
      // router reports "cursor not available" with the actionable hint.
      log.info('cursor_adapter_skip', {
        data: { reason: (err as Error).message },
      });
    }
    return map;
  }
  function refreshEngineRouter(): void {
    currentAdapters = buildAdapters();
  }
  const engineRouter = new EngineRouter({
    adapters: new Proxy({} as Partial<Record<EngineId, EngineAdapter>>, {
      // Always read the latest currentAdapters — so refreshEngineRouter()
      // takes effect on the next router.current() call, no caching.
      get(_t, key) { return currentAdapters[key as EngineId]; },
      ownKeys() { return Object.keys(currentAdapters); },
      getOwnPropertyDescriptor(_t, key) {
        if (currentAdapters[key as EngineId]) {
          return { configurable: true, enumerable: true };
        }
        return undefined;
      },
    }),
    defaultGetter: () => liveConfig.engine.default,
  });
  // NOTE: we DON'T call `refreshEngineRouter()` here because
  // `buildAdapters()` reads `httpApi.port()` to assemble helmMcpUrl, and
  // httpApi is declared below. The initial build runs right after
  // `httpApi = createHttpApi(...)` (search "refreshEngineRouter()" below).

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
      // Phase 54: pass the live Lark channel so `send_lark_attachment` can
      // upload screenshots from agent → bound thread without spawning a
      // second lark-cli process.
      ...(larkChannel ? { larkChannel } : {}),
      // Phase 59: pass a lark-cli runner so `read_lark_doc` can fetch
      // wiki/docx markdown for any Cursor agent connected to helm's MCP
      // SSE — including the role-trainer's Cursor backend, mainstream
      // Cursor IDE chats, and Claude Desktop. Constructed lazily; if
      // lark-cli isn't on PATH the tool itself surfaces an actionable
      // error rather than the factory throwing.
      ...((): { larkCli?: ReturnType<typeof createLarkCliRunner> } => {
        try {
          return {
            larkCli: createLarkCliRunner({
              command: liveConfig.lark.cliCommand,
              env: liveConfig.lark.env ?? process.env,
            }),
          };
        } catch {
          return {};
        }
      })(),
      // Phase 67: Harness reviewer subprocesses pull conventions from the
      // global Settings field (helm Settings → Harness Conventions). Read
      // lazily so a Settings save updates the next review without restart.
      harnessConventions: () => liveConfig.harness?.conventions ?? '',
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
        // Phase 68: rebuild engine adapters so a Settings save (e.g.
        // cursor.mode toggle or cursor.apiKey change) takes effect on the
        // next router.current(). Note: liveConfig.engine.default itself is
        // re-read on every router.current() via defaultGetter, so the user
        // flipping the default doesn't even need this rebuild — only
        // ADAPTER-internal config does.
        refreshEngineRouter();
        log.info('config_saved_providers_reloaded', {
          data: {
            configuredIds: [...configuredProviderIds],
            engineDefault: liveConfig.engine.default,
          },
        });
        return liveConfig;
      },
      consumePendingBind: (code, hostSessionId) => {
        const created = consumePendingBind(deps.db, events, code, hostSessionId);
        return created ? { id: created.id } : null;
      },
      // Phase 62: only expose the "Mirror to Lark" path when Lark is
      // actually wired — otherwise the renderer's button gets a 501 and
      // can show "Lark not configured" instead of failing in a weirder way
      // later (e.g. the user types the code in Lark, lark-wiring isn't
      // even subscribed → consumption never happens).
      ...(larkChannel
        ? {
          initiateLarkBind: (opts) =>
            // Phase 64: opts now includes hostSessionId; createPendingLarkBind
            // stores it on the pending row so the Lark-side consume handler
            // can stitch the binding without a renderer round-trip.
            createPendingLarkBind(deps.db, opts ?? {}),
        }
        : {}),
      // Phase 63: register helm's MCP server with the user's CLI/IDE
      // straight from the renderer button — same `setupMcp()` the helm
      // CLI exposes, but accessible without `helm` being on PATH. URL
      // resolves at call time so a custom `config.server.port` flows
      // through to the registration.
      setupMcp: (target) => {
        const port = httpApi.port();
        const url = port
          ? `http://127.0.0.1:${port}/mcp/sse`
          : 'http://127.0.0.1:17317/mcp/sse';
        return runSetupMcp(target, { url });
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
      // Phase 60b / 68: role-trainer conversation runner. Goes through the
      // EngineRouter so the user's default engine (claude or cursor) drives
      // the chat. Returns null when no adapter supports runConversation —
      // the endpoint then 501s with an actionable message.
      runConversation: async (input) => {
        let adapter;
        try {
          adapter = engineRouter.current();
        } catch (err) {
          // EngineNotAvailableError → null so endpoint 501s.
          if (err instanceof EngineNotAvailableError) return null;
          throw err;
        }
        return adapter.runConversation(input);
      },
      // Phase 68: engine health report for the Settings page. Re-runs the
      // detection probes each call (cheap — two `--version` execs) so the
      // user sees the live state of `claude` / `cursor-agent` whenever
      // they open Settings.
      getEngineHealth: () => detectEngines(),
      // Phase 67 / 68: Harness review runner. Now uses the engine router so
      // the active engine's `review()` capability is called. Conventions
      // come from helm Settings (lazy-read; Settings save updates next
      // review without restart).
      runHarnessReview: async (taskId: string) => {
        return runHarnessReview(
          {
            db: deps.db,
            getConventions: async () => liveConfig.harness?.conventions ?? '',
            runReviewerEngine: async (payload, systemPrompt, cwd) => {
              const adapter = engineRouter.current();
              const httpPort = httpApi.port();
              const reviewInput: Parameters<typeof adapter.review>[0] = {
                userPayload: payload,
                systemPrompt,
                cwd,
              };
              if (httpPort) reviewInput.helmMcpUrl = `http://127.0.0.1:${httpPort}/mcp/sse`;
              return adapter.review(reviewInput);
            },
          },
          { taskId },
        );
      },
    },
    { port: deps.httpPort ?? deps.config?.server?.port ?? 0 },
  );

  // Phase 60b / 68: CLI availability flags, optimistically true. Async
  // probes below flip them to the real value once `--version` resolves;
  // the engine adapters honor whichever value is current when
  // `refreshEngineRouter()` runs. Declared BEFORE the initial refresh
  // because buildAdapters() reads them.
  let claudeAvailable = true;
  let cursorAgentAvailable = true;

  // Phase 68: with `httpApi` now built, do the initial engine adapter
  // build — adapters need `httpApi.port()` to assemble the helmMcpUrl
  // they'll inject into subprocess MCP configs. The async CLI probes
  // below may later call refreshEngineRouter() again to drop adapters
  // whose binary turned out to be missing.
  refreshEngineRouter();

  let started = false;

  void detectClaudeCli().then((info) => {
    claudeAvailable = info != null;
    log.info('cli_agent_probe', {
      data: { engine: 'claude', info: info ?? null },
    });
    refreshEngineRouter();
  });
  void detectCursorAgentCli().then((info) => {
    cursorAgentAvailable = info != null;
    log.info('cli_agent_probe', {
      data: { engine: 'cursor-agent', info: info ?? null },
    });
    refreshEngineRouter();
  });

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
      // Phase 77: stop the lifecycle cron + unhook the mutation trigger
      // first so a stray train/update/drop call during shutdown doesn't
      // schedule new sweep work onto a tearing-down DB connection.
      clearInterval(lifecycleCron);
      setLifecycleSweepTrigger(null);
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
    let drainedCount = 0;
    for (const binding of bindings) {
      const messages = dequeueMessages(db, binding.id);
      drainedCount += messages.length;
      for (const m of messages) {
        if (m.text) lines.push(m.text);
      }
    }
    // Phase 70: tell the UI we ate N messages so the "📨 queued" badge
    // can disappear without waiting for the next 30s reconcile. Only
    // emit when we actually drained something; empty drains are silent.
    if (drainedCount > 0) {
      events.emit({ type: 'channel.message_consumed', hostSessionId, count: drainedCount });
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
