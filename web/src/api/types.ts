/**
 * Shared shapes between the helm backend and renderer.
 *
 * These mirror the row types in src/storage/types.ts, but kept in the web
 * workspace as plain interfaces to avoid pulling Node-only deps (like
 * better-sqlite3 types) into the renderer build.
 */

export interface ActiveChat {
  id: string;
  host: string;
  cwd?: string;
  composerMode?: string;
  campaignId?: string;
  cycleId?: string;
  /** @deprecated Phase 25 single-role field. Phase 42 made it a deprecated
   * alias of `roleIds[0]`; new code reads `roleIds`. */
  roleId?: string;
  /** Phase 42: every role bound to this chat, in insertion order. Each
   * role's system prompt + chunks are concatenated into the sessionStart
   * `additional_context`. Empty when no roles are bound. */
  roleIds: string[];
  /** Phase 32: opening user prompt — used as the chat's human-readable label. */
  firstPrompt?: string;
  /** Phase 55: user-set chat label. Wins over firstPrompt when present. */
  displayName?: string;
  status: 'active' | 'closed';
  firstSeenAt: string;
  lastSeenAt: string;
  /**
   * Phase 70: number of channel-queue messages waiting to be drained into
   * this Cursor chat (only fires when the agent next calls `host_stop`).
   * The Active Chats UI surfaces a "📨 N queued" badge so the user knows
   * to nudge Cursor; without it, queued messages look invisible.
   */
  queuedMessageCount?: number;
}

export interface PendingApproval {
  id: string;
  hostSessionId?: string;
  bindingId?: string;
  tool: string;
  command?: string;
  payload?: Record<string, unknown>;
  status: 'pending' | 'allowed' | 'denied' | 'timeout';
  createdAt: string;
  expiresAt: string;
}

export interface Campaign {
  id: string;
  projectPath: string;
  title: string;
  brief?: string;
  status: 'active' | 'completed';
  startedAt: string;
  completedAt?: string;
  summary?: string;
}

export interface Cycle {
  id: string;
  campaignId: string;
  cycleNum: number;
  status: 'pending' | 'product' | 'dev' | 'test' | 'completed';
  productBrief?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface Task {
  id: string;
  cycleId: string;
  role: 'dev' | 'test';
  title: string;
  description?: string;
  acceptance?: string[];
  e2eScenarios?: string[];
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  result?: string;
  docAuditToken?: string;
  comments?: string[];
  createdAt: string;
  completedAt?: string;
}

export interface DocAuditEntry {
  token: string;
  taskId?: string;
  filePath: string;
  contentHash: string;
  createdAt: string;
}

export interface ChannelBinding {
  id: string;
  channel: string;
  hostSessionId: string;
  externalChat?: string;
  externalThread?: string;
  externalRoot?: string;
  waitEnabled: boolean;
  metadata?: Record<string, unknown>;
  /** Phase 36: free-form user annotation captured from `bind chat <label>`. */
  label?: string;
  createdAt: string;
}

export interface PendingBind {
  code: string;
  channel: string;
  externalChat?: string;
  externalThread?: string;
  externalRoot?: string;
  /** Phase 36: user annotation captured from the bind command. */
  label?: string;
  expiresAt: string;
}

// Mirror of src/config/schema.ts HelmConfig — kept loose so the renderer
// doesn't need Zod. Backend rejects unknown keys; renderer just edits what
// it knows about.
export interface DepscopeMappingConfig {
  cwdPrefix: string;
  scmName: string;
}

export interface KnowledgeProviderConfig {
  id: string;
  enabled: boolean;
  config?: Record<string, unknown>;
}

/** Phase 77: knowledge lifecycle thresholds — user-tunable in Settings. */
export interface KnowledgeLifecycleConfig {
  /** Min chunk age (days, since createdAt) before archive becomes eligible. Default 90. */
  archiveAfterDays: number;
  /** Max access_count for a chunk to still count as "cold". Default 3. */
  archiveBelowAccessCount: number;
  /** Time constant (days) for exp(-Δt/τ) decay during fusion re-rank. Default 30. */
  decayTauDays: number;
  /** Max boost / penalty α the decay re-rank can apply. 0 disables. Default 0.3. */
  decayAlpha: number;
}

export interface HelmConfig {
  server: { port: number };
  approval: { defaultTimeoutMs: number; waitPollMs: number };
  lark: { enabled: boolean; cliCommand?: string; env?: Record<string, string> };
  knowledge: {
    providers: KnowledgeProviderConfig[];
    /** Phase 77: lifecycle block. Optional on the type so old configs parse;
     * backend supplies defaults. */
    lifecycle?: KnowledgeLifecycleConfig;
  };
  docFirst: { enforce: boolean };
  cursor: { apiKey?: string; model: string; mode: 'local' | 'cloud' };
  // Phase 67: global Harness conventions, injected into every reviewer
  // subprocess. Optional in the type so older saved configs still parse.
  harness?: { conventions: string };
  // Phase 68: global default engine. Drives Roles modal, Harness reviewer,
  // and Campaign summarizer. Optional so old configs parse; server applies
  // a 'claude' default when missing.
  engine?: { default: 'cursor' | 'claude' };
  // Phase 60b removed `anthropic` — role-trainer now shells out to claude CLI
  // and uses its own auth (`claude login`).
}

/** Phase 68: per-engine readiness shown alongside the Default engine selector. */
export interface EngineHealth {
  engine: 'cursor' | 'claude';
  ready: boolean;
  detail: string;
  hint?: string;
}

export interface CampaignSummary {
  why: string;
  cycles: Array<{
    cycleNum: number;
    productBrief?: string;
    devWork: string[];
    testResults: string;
    screenshots: Array<{ description: string }>;
  }>;
  keyDecisions: string[];
  overallPath: string;
}

export interface BugTaskInput {
  title: string;
  description?: string;
  expected?: string;
  actual?: string;
  screenshotDescription?: string;
}

export interface CycleScreenshotInput {
  filePath: string;
  description: string;
  capturedAt?: string;
}

export interface Role {
  id: string;
  name: string;
  systemPrompt: string;
  docPath?: string;
  isBuiltin: boolean;
  createdAt: string;
}

export interface RoleSummary extends Role {
  chunkCount: number;
}

/** Phase 73: chunk type discriminator — surfaced as a badge in the UI. */
export type KnowledgeChunkKind = 'spec' | 'example' | 'warning' | 'runbook' | 'glossary' | 'other';

/** Phase 73: raw-doc origin type. */
export type KnowledgeSourceKind = 'lark-doc' | 'file' | 'inline';

export interface RoleChunk {
  id: string;
  sourceFile?: string;
  chunkText: string;
  /** Phase 73 — defaults to `'other'`. */
  kind: KnowledgeChunkKind;
  /** Phase 73 — FK to `KnowledgeSource.id`. Always set on chunks created
   * after migration v12; absent on legacy chunks (none should remain after
   * the v12 clean-slate wipe, but the field stays optional defensively). */
  sourceId?: string;
  createdAt: string;
  /** Phase 77 — number of search hits returned for this chunk. Drives the
   * "accessed N times" label on each chunk card. */
  accessCount: number;
  /** Phase 77 — ISO timestamp of the most recent search hit; undefined when
   * the chunk has never been queried. */
  lastAccessedAt?: string;
  /** Phase 77 — soft-archive flag. Archived chunks render in a folded
   * "Archived (N)" section with an "unarchive" button. */
  archived: boolean;
}

/** Phase 73: one row in the Sources block of the Role detail page. */
export interface KnowledgeSource {
  id: string;
  roleId: string;
  kind: KnowledgeSourceKind;
  origin: string;
  fingerprint: string;
  label?: string;
  chunkCount: number;
  createdAt: string;
}

export interface TrainRoleInput {
  name: string;
  documents: Array<{
    filename: string;
    content: string;
    // Phase 73 — optional typing + provenance per document.
    kind?: KnowledgeChunkKind;
    sourceKind?: KnowledgeSourceKind;
    origin?: string;
    sourceLabel?: string;
  }>;
  baseSystemPrompt?: string;
}

export interface RequirementTodo {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
}

export interface Requirement {
  id: string;
  name: string;
  purpose?: string;
  context: string;
  summary?: string;
  relatedDocs?: string[];
  changes?: string[];
  tags?: string[];
  todos?: RequirementTodo[];
  projectPath?: string;
  status: 'draft' | 'confirmed';
  createdAt: string;
  updatedAt: string;
}

// SSE event shapes — must mirror src/events/bus.ts AppEvent.
export type AppEvent =
  | { type: 'approval.pending'; request: PendingApproval }
  | { type: 'approval.settled'; approvalId: string; decision: 'allow' | 'deny' | 'ask'; decidedBy: string; reason?: string }
  | { type: 'approval.decision_received'; decision: { channel: string; approvalId: string; decision: 'allow' | 'deny'; reason?: string } }
  | { type: 'session.started'; session: ActiveChat }
  | { type: 'session.closed'; hostSessionId: string }
  | { type: 'binding.created'; binding: { id: string; channel: string; hostSessionId?: string } }
  // Phase 72: hostSessionId added so renderer paths can scope reactions.
  | { type: 'binding.removed'; bindingId: string; hostSessionId?: string }
  | { type: 'channel.message_enqueued'; bindingId: string; messageId: number }
  // Phase 70: fires when host_stop drains the queue (Cursor turn end /
  // new prompt). Renderer uses it to clear the "📨 queued" badge.
  | { type: 'channel.message_consumed'; hostSessionId: string; count: number };

export type AppEventType = AppEvent['type'];
