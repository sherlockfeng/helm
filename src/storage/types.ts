// ── Relay-origin tables ────────────────────────────────────────────────────

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

export interface Screenshot {
  filePath: string;
  description: string;
  capturedAt: string;
}

export interface Cycle {
  id: string;
  campaignId: string;
  cycleNum: number;
  status: 'pending' | 'product' | 'dev' | 'test' | 'completed';
  productBrief?: string;
  screenshots?: Screenshot[];
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
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  result?: string;
  docAuditToken?: string;
  comments?: string[];
  createdAt: string;
  completedAt?: string;
}

export interface Role {
  id: string;
  name: string;
  systemPrompt: string;
  docPath?: string;
  isBuiltin: boolean;
  createdAt: string;
}

/**
 * Phase 73: chunk kind discriminator. Lets agents narrow `search_knowledge`
 * by content type ("only give me runbooks for this incident") instead of
 * relying on cosine + topK alone. Six categories cover the patterns we've
 * seen in trained roles; default `'other'` keeps the new column non-NULL
 * while leaving older / unannotated chunks usable.
 */
export type KnowledgeChunkKind =
  | 'spec'
  | 'example'
  | 'warning'
  | 'runbook'
  | 'glossary'
  | 'other';

export const KNOWLEDGE_CHUNK_KINDS: readonly KnowledgeChunkKind[] = [
  'spec', 'example', 'warning', 'runbook', 'glossary', 'other',
];

/**
 * Phase 73: type of raw-doc origin a `KnowledgeSource` row came from.
 * - `lark-doc`: ingested via the `read_lark_doc` path / a Lark URL
 * - `file`:     a local Markdown / text file uploaded by the user
 * - `inline`:   a text blob passed directly to train_role / update_role
 *               that doesn't have a stable origin URL or filepath
 */
export type KnowledgeSourceKind = 'lark-doc' | 'file' | 'inline';

/**
 * Phase 73: one row per "this chunk came from THAT raw doc" ingestion
 * event. Cascade-deleted when a role is removed. Cascades to its chunks
 * when the source itself is dropped — gives users a one-shot way to
 * retract a Lark doc and have all derived knowledge disappear.
 */
export interface KnowledgeSource {
  id: string;
  roleId: string;
  kind: KnowledgeSourceKind;
  /** URL (lark-doc), absolute path (file), or `inline-<short hash>` (inline). */
  origin: string;
  /** SHA-256 of (filename + '\n' + content) — lets `update_role` reuse the
   * same source row when an identical doc is re-ingested. */
  fingerprint: string;
  /** Optional human-readable label set by the user / agent. */
  label?: string;
  createdAt: string;
}

export interface KnowledgeChunk {
  id: string;
  roleId: string;
  sourceFile?: string;
  chunkText: string;
  embedding?: Float32Array;
  /** Phase 73: kind discriminator — see KnowledgeChunkKind. Default `'other'`. */
  kind: KnowledgeChunkKind;
  /** Phase 73: which `knowledge_sources` row this chunk derived from. After
   * the v12 clean-slate migration, every chunk has a non-null source_id. */
  sourceId?: string;
  createdAt: string;
}

export interface AgentSession {
  provider: string;
  roleId: string;
  sessionId: string;
  externalId: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocAuditEntry {
  token: string;
  taskId?: string;
  filePath: string;
  contentHash: string;
  createdAt: string;
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

export interface CaptureSession {
  id: string;
  requirementId?: string;
  phase: 'questioning' | 'confirming' | 'done';
  answers: Record<string, string>;
  draft?: Partial<Requirement>;
  createdAt: string;
  updatedAt: string;
}

// ── Helm-new tables ────────────────────────────────────────────────────────

export interface HostSession {
  id: string;
  host: 'cursor' | string;
  cwd?: string;
  composerMode?: string;
  campaignId?: string;
  cycleId?: string;
  /** @deprecated Phase 25 single-role column. Phase 42 moved bindings into
   * the `host_session_roles` join table; this column is dead weight kept
   * only because SQLite DROP COLUMN is awkward. New code reads `roleIds`. */
  roleId?: string;
  /** Phase 42: zero-or-more role bindings. LocalRolesProvider concatenates
   * each role's system prompt + chunks at sessionStart so the user can stack
   * e.g. Goofy 专家 + 容灾大盘专家 onto one chat. Optional in the type but
   * the repo always populates it on read (empty array when no roles bound);
   * callers constructing HostSession instances for upsert can leave it
   * undefined. */
  roleIds?: readonly string[];
  /** Phase 32: first user prompt seen on this session. Captured by the
   * host_prompt_submit handler on the first message and never overwritten,
   * so the UI has a stable human-readable label per chat. */
  firstPrompt?: string;
  /** Phase 55: user-set chat label. The Active Chats UI renders this when
   * present, falling back to firstPrompt → cwd basename → id prefix.
   * Editable inline; cleared by setting to null/empty. */
  displayName?: string;
  /** Phase 56: snapshot of the role-id set we last injected into this chat
   * (sorted, JSON-encoded). Compared on every host_prompt_submit against
   * the chat's current bound roleIds — when they differ, the orchestrator
   * re-injects the role context as a `user_message` prefix so a role
   * bound mid-chat actually takes effect. Empty / null = nothing injected
   * yet (i.e. the next prompt-submit will inject if any roles are bound). */
  lastInjectedRoleIds?: readonly string[];
  /** Phase 71: which version of the Helm tool guide has been injected
   * into this chat. Compared against `HELM_TOOL_GUIDE_VERSION` on every
   * session-start + prompt-submit; mismatch triggers (re-)injection so
   * chats that pre-existed the guide (or that were live when we bumped
   * the version) pick up the freshened text on their next interaction. */
  lastInjectedGuideVersion?: number;
  status: 'active' | 'closed';
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ChannelBinding {
  id: string;
  channel: 'lark' | 'local' | string;
  hostSessionId: string;
  externalChat?: string;
  externalThread?: string;
  externalRoot?: string;
  waitEnabled: boolean;
  metadata?: Record<string, unknown>;
  /** Phase 36: free-form user annotation captured from the bind command
   * (e.g. "dr" in `@bot dr bind chat`). Surfaces in the Bindings UI so the
   * user can match a binding back to their own mental tag. */
  label?: string;
  createdAt: string;
}

export interface ChannelMessageQueueItem {
  id: number;
  bindingId: string;
  externalId?: string;
  text: string;
  createdAt: string;
  consumedAt?: string;
}

export interface PendingBind {
  code: string;
  channel: string;
  externalChat?: string;
  externalThread?: string;
  externalRoot?: string;
  /** Phase 36: user-supplied annotation from the bind command, carried
   * forward to channel_bindings.label on consume. */
  label?: string;
  /** Phase 64: which Cursor chat owns this code. Set when the user clicks
   * "Mirror to Lark" in helm UI; absent when the code originated from
   * `@bot bind chat` in Lark (legacy flow — caller must supply chat at
   * consume time). */
  hostSessionId?: string;
  expiresAt: string;
}

export interface ApprovalRequest {
  id: string;
  hostSessionId?: string;
  bindingId?: string;
  tool: string;
  command?: string;
  payload?: Record<string, unknown>;
  status: 'pending' | 'allowed' | 'denied' | 'timeout';
  decidedBy?: 'local-ui' | 'lark' | 'policy' | 'timeout';
  reason?: string;
  createdAt: string;
  decidedAt?: string;
  expiresAt: string;
}

export interface ApprovalPolicy {
  id: string;
  tool: string;
  commandPrefix?: string;
  pathPrefix?: string;
  toolScope: boolean;
  decision: 'allow' | 'deny';
  hits: number;
  createdAt: string;
  lastUsedAt?: string;
}

export interface HostEventLogEntry {
  id: number;
  hostSessionId: string;
  kind: 'prompt' | 'response' | 'tool_use' | 'tool_result' | 'progress';
  payload: Record<string, unknown>;
  createdAt: string;
}

// ── Harness toolchain (Phase 67) ───────────────────────────────────────────
//
// These types mirror the on-disk .harness/ files. Source of truth lives on
// disk (.harness/tasks/<id>/task.md, .harness/archive/<id>.md); helm DB
// holds an index for fast queries (search by entity / file / project).
//
// NOTE: stages are forward-monotonic. Going backwards is a programming error
// (advanceStage refuses to do it). If scope changes mid-implement, the
// implementer keeps current_stage = 'implement' and edits the Intent /
// Structure / Risks fields in place.

export type HarnessStage = 'new_feature' | 'implement' | 'archived';

/** Intent block — three substantive bullets. Free-form prose, no schema rigour. */
export interface HarnessIntent {
  background: string;
  objective: string;
  scopeIn: string[];
  scopeOut: string[];
}

export interface HarnessStructure {
  entities: string[];
  relations: string[];
  /** Each entry is "path/to/file.ts — one-line reason" — kept as raw lines for grepability. */
  plannedFiles: string[];
}

export interface HarnessStageLogEntry {
  at: string;        // ISO timestamp
  stage: HarnessStage;
  message: string;
}

export interface HarnessRelatedTask {
  taskId: string;
  oneLiner: string;
  archivePath: string; // pointer into .harness/archive
}

export interface HarnessTask {
  id: string;
  title: string;
  currentStage: HarnessStage;
  projectPath: string;
  hostSessionId?: string;
  intent?: HarnessIntent;
  structure?: HarnessStructure;
  /** Free-form decisions list. Visible to implementer, HIDDEN from reviewer. */
  decisions: string[];
  risks: string[];
  relatedTasks: HarnessRelatedTask[];
  stageLog: HarnessStageLogEntry[];
  implementBaseCommit?: string;
  createdAt: string;
  updatedAt: string;
}

export interface HarnessArchiveCard {
  taskId: string;
  entities: string[];
  filesTouched: string[];
  modules: string[];
  patterns: string[];
  downstream: string[];
  rulesApplied: string[];
  oneLiner: string;
  /** Relative path inside the project — e.g. ".harness/archive/<task_id>.md". */
  fullDocPointer: string;
  projectPath: string;
  archivedAt: string;
}

export type HarnessReviewStatus = 'pending' | 'completed' | 'failed';

export interface HarnessReview {
  id: string;
  taskId: string;
  status: HarnessReviewStatus;
  reportText?: string;
  baseCommit?: string;
  headCommit?: string;
  error?: string;
  spawnedAt: string;
  completedAt?: string;
}
