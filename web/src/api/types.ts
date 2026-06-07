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
  cursor: {
    apiKey?: string;
    model: string;
    mode: 'local' | 'cloud';
    /** R-18: auto-write helm's MCP entry into Cursor's MCP config. */
    mcpAutoRegister?: boolean;
  };
  /** R-18: Claude Code CLI config. Optional — backend supplies defaults. */
  claudeCode?: {
    binaryPath?: string;
    model: string;
    trainerModel: string;
    mcpAutoRegister: boolean;
  };
  /** R-18: Codex CLI config — symmetric with claudeCode. */
  codex?: {
    binaryPath?: string;
    model: string;
    trainerModel: string;
    mcpAutoRegister: boolean;
  };
  // Phase 67: global Harness conventions, injected into every reviewer
  // subprocess. Optional in the type so older saved configs still parse.
  harness?: { conventions: string };
  // Phase 68 + R-18: global default engine + default trainer engine.
  // Optional so old configs parse; server applies defaults when missing.
  engine?: {
    default: 'cursor' | 'claude';
    /** R-18: which CLI agent helm spawns as the train-via-chat subprocess. */
    trainerDefault?: 'claude' | 'codex';
  };
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
  /** Phase 80 (helm-design PR A): monotonic counter bumped on every
   *  meaningful content change (train, update, drop chunk/source).
   *  Fresh roles + back-migrated rows start at 1. */
  version: number;
}

/** Phase 80 (helm-design PR B): auto-push config for a role. */
export interface RoleMirror {
  roleId: string;
  targetUrl: string;
  enabled: boolean;
  lastPushedVersion?: number;
  lastPushedEtag?: string;
  lastPushedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RoleSummary extends Role {
  chunkCount: number;
  /** Phase 78 — # of pending knowledge-capture candidates for this role.
   * Drives the `(N)` badge next to the role name in the Roles list. */
  pendingCandidateCount: number;
}

/** Phase 78 — candidate row from the Roles UI's Candidates tab. */
export type CandidateStatus = 'pending' | 'accepted' | 'rejected' | 'expired';

/** Phase 79 — where a candidate came from (chat capture vs subscription pull). */
export type CandidateProvenance = 'chat_capture' | 'subscription';

export interface KnowledgeCandidate {
  id: string;
  roleId: string;
  /** ID of the chat the agent response came from; absent when the chat row
   * was deleted but the candidate survives for audit. */
  hostSessionId?: string;
  chunkText: string;
  sourceSegmentIndex: number;
  /** Heuristic kind: code-fenced segments → 'example', else 'other'. The
   * Edit-then-Accept modal lets the user change this before saving. */
  kind: KnowledgeChunkKind;
  /** Phase 78 — entity overlap count vs the role's entity index. */
  scoreEntity: number;
  /** Phase 78 — max cosine vs the role's existing chunks at write time. */
  scoreCosine: number;
  textHash: string;
  status: CandidateStatus;
  createdAt: string;
  decidedAt?: string;
  /** Phase 79 — chat_capture (Phase 78 default) vs subscription (peer push). */
  provenance: CandidateProvenance;
}

/** Phase 79 — one row in the Settings → Storage plugins list. */
export type StoragePluginInfo =
  | { ok: true; id: string; scheme: string; version: string; apiVersion: number; loadedFrom: string }
  | { ok: false; id: string; reason: string };

/** Phase 79 — subscription row.
 *  Phase 80 (PR C): `'conflict'` added — set when sync detects that
 *  both local and remote moved past last_pulled_version. */
export type SubscriptionStatus = 'active' | 'paused' | 'error' | 'conflict';

export interface RoleSubscription {
  id: string;
  roleId: string;
  sourceType: string;
  sourceUrl: string;
  lastEtag?: string;
  lastContentHash?: string;
  lastSyncAt?: string;
  lastError?: string;
  syncIntervalMinutes: number;
  autoApply: boolean;
  status: SubscriptionStatus;
  /** Phase 80 (PR C): bundle's roleVersion at last successful apply. */
  lastPulledVersion?: number;
  createdAt: string;
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
  /** R-7 — Internal (default) chunks cannot be published to a public
   * repo via the R-0 gate; flip to Public to enable publishing. */
  visibility?: ChunkVisibility;
  /** Optimistic-lock cookie sent back on visibility / body PATCHes. */
  editVersion?: number;
}

/** R-7 — chunk publish gate. Defaults to 'internal' for safety. */
export type ChunkVisibility = 'internal' | 'public';

/** R-6 — one KnowledgeRepo subscription row. */
export interface KnowledgeRepo {
  id: string;
  url: string;
  branch: string;
  localPath: string;
  classification: 'internal' | 'public';
  status: 'active' | 'paused' | 'error' | 'conflict';
  syncIntervalMinutes: number;
  autoApply: boolean;
  lastFetchedSha?: string;
  lastFetchedAt?: number;
  lastError?: string;
  createdAt: number;
}

/** R-6 — curated seed catalogue entry (e.g. llm-wiki one-click). */
export interface KnowledgeRepoSeed {
  id: string;
  label: string;
  description: string;
  url: string;
  branch?: string;
  classification: 'internal' | 'public';
}

/** R-6 — 3-way merge conflict surfaced by the importer. */
export interface KnowledgeMergeConflict {
  id: string;
  repoId: string;
  pointId: string;
  localBody: string;
  remoteBody: string;
  localVersion: number;
  remoteRevision: string;
  status: 'open' | 'resolved';
  createdAt: number;
  resolvedAt?: number;
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

// ── Verification (PR 5 + PR 6 surface for the renderer) ────────────────────

export type BenchmarkCaseProposedSource = 'manual' | 'llm-on-edit' | 'imported';
export type BenchmarkCaseStatus = 'proposed' | 'confirmed' | 'rejected' | 'archived';
export type BenchmarkAgentKindHint = 'cursor' | 'claude_code' | 'codex';
export type BenchmarkTriggeringEventKind =
  | 'candidate_accept'
  | 'subscription_pull'
  | 'mirror_merge'
  | 'manual';
export type RegressionAlertStatus = 'open' | 'acknowledged' | 'resolved';

export interface BenchmarkCase {
  id: string;
  name: string;
  question: string;
  expectedTruth: string;
  goldenPointIds: readonly string[];
  targetRoleIds: readonly string[];
  agentKindHint?: BenchmarkAgentKindHint;
  notes?: string;
  sourceRepoUrl?: string;
  sourceRevision?: string;
  proposedSource: BenchmarkCaseProposedSource;
  proposedAt: number;
  proposedFromPointId?: string;
  proposedFromEvent?: string;
  proposedQuestionHash?: string;
  status: BenchmarkCaseStatus;
  confirmedBy?: string;
  confirmedAt?: number;
  rejectedReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface BenchmarkRun {
  id: string;
  caseId: string;
  runAt: number;
  answerProviderId: string;
  judgeProviderId: string;
  recallPct: number;
  alignmentPct: number;
  answerText: string;
  judgeVerdictText: string;
  judgeVerdictJson: string;
  durationMs: number;
  estimatedCostUsd?: number;
  llmCallCount?: number;
  knowledgeStateSha: string;
  isReproducible: boolean;
  reproducedFromRunId?: string;
  triggeringEventKind?: BenchmarkTriggeringEventKind;
  triggeringEventRefId?: string;
  baselineRunId?: string;
}

export interface RegressionAlert {
  id: string;
  caseId: string;
  prevRunId: string;
  currentRunId: string;
  prevScore: number;
  currentScore: number;
  delta: number;
  triggeringEventKind: BenchmarkTriggeringEventKind;
  triggeringEventRefId: string;
  status: RegressionAlertStatus;
  resolvedNote?: string;
  createdAt: number;
  updatedAt: number;
}

export interface VerificationCounts {
  proposed: number;
  openAlerts: number;
}
