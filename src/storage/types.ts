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
  /** Phase 80 (helm-design PR A): monotonic counter bumped on every
   *  meaningful content change (train, update, drop chunk/source).
   *  PR B will gate auto-push by comparing this to lastPushedVersion;
   *  PR C will gate pull-apply by comparing it to the bundle's
   *  `roleVersion`. Fresh roles + back-migrated rows start at 1. */
  version: number;
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
  /** PR-B: chat-specific cognitive artifacts — these only appear as
   *  candidates extracted from conversations, not as authored chunks.
   *  - decision      : a choice and its rationale ("we picked X over Y because Z")
   *  - open_question : explicit unknown the chat surfaces ("we don't know how X behaves")
   *  - workaround    : a known-temporary hack with stated limits */
  | 'decision'
  | 'open_question'
  | 'workaround'
  | 'other';

export const KNOWLEDGE_CHUNK_KINDS: readonly KnowledgeChunkKind[] = [
  'spec', 'example', 'warning', 'runbook', 'glossary',
  'decision', 'open_question', 'workaround',
  'other',
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

/**
 * Conversation-knowledge redesign (PR 2 / migration v20): which kind of
 * provenance produced this KnowledgePoint. Drives the source-trace badge
 * in KnowledgePoint Detail (§5.4) and gates the publish profile selector.
 */
export type KnowledgeChunkSourceKind = 'conversation' | 'subscription' | 'manual';

/**
 * §3.5 / R-1: a point is `internal` by default (chat captures lean
 * defensive — never auto-publish to a public destination) and is
 * promoted to `public` only via an explicit user action recorded in
 * visibility_audit. The §7.4 R-0 publish gate reads this column.
 */
export type KnowledgePointVisibility = 'internal' | 'public';

export interface KnowledgeChunk {
  id: string;
  /**
   * Legacy 1..1 role pointer. PR 2 introduces the N..N
   * `knowledge_point_roles` table; new readers should prefer
   * `getRolesForPoint(id)`. This column stays for back-compat so the
   * existing single-role queries keep returning rows during the
   * transition. PR 4 finishes the swap.
   */
  roleId: string;
  /**
   * PR 2 (migration v20): all roles a point belongs to, read from the
   * `knowledge_point_roles` join table. Optional on the type because
   * not every read path needs it (BM25 hit reading by id stays cheap).
   * Population is up to the caller.
   */
  roleIds?: string[];
  sourceFile?: string;
  chunkText: string;
  embedding?: Float32Array;
  /** Phase 73: kind discriminator — see KnowledgeChunkKind. Default `'other'`. */
  kind: KnowledgeChunkKind;
  /** Phase 73: which `knowledge_sources` row this chunk derived from. After
   * the v12 clean-slate migration, every chunk has a non-null source_id. */
  sourceId?: string;
  createdAt: string;
  /**
   * PR 2 (migration v20): user-facing title for the point — h1 if the
   * body has one, else first-line heuristic. Backfilled lazily on the
   * renderer side after migration, so existing chunks can transiently
   * be NULL until the next boot scans them. Display-side callers
   * substitute the first 60 chars of chunkText when this is absent.
   */
  title?: string;
  /**
   * PR 2 (migration v20): provenance discriminator + free-form ref. The
   * shape is JSON-encoded in the source column. Manual creations write
   * `{kind: 'manual'}`; capture writes `{kind: 'conversation', ref:
   * conversationId}`; subscription pulls write `{kind: 'subscription',
   * ref: repoUrl}`. Optional because legacy rows have NULL.
   */
  source?: { kind: KnowledgeChunkSourceKind; ref?: string };
  /**
   * PR 2 (migration v20): timestamp of the most recent retrieval that
   * surfaced this point (epoch ms). Drives §14 stale detection and the
   * Role health badge. NULL = never retrieved (or pre-migration).
   */
  lastReferencedAt?: number;
  /**
   * PR 2 (migration v20): optimistic-locking counter. Every successful
   * UPDATE bumps it; callers pass the version they read and writes that
   * don't match fail without trampling concurrent edits. Guards the G4
   * race between Helm UI and Cursor MCP touching the same point.
   * Default 1 on inserts; never NULL.
   */
  editVersion?: number;
  /**
   * PR 2 (migration v20) / R-1: default 'internal' so chat-derived
   * knowledge is never auto-published. UI requires explicit per-point
   * promotion to 'public' (with reason logged to visibility_audit).
   */
  visibility?: KnowledgePointVisibility;
  /**
   * PR 2 (migration v20): per-chunk monotonic version distinct from the
   * role-level `roles.version` counter introduced in Phase 80 PR A. Bumps
   * when content changes; PR 6 uses it to compute the local fingerprint
   * for benchmark `knowledgeStateSha`.
   */
  versionExt?: number;
  /**
   * Phase 77 (lifecycle): how many times this chunk has been returned by
   * `searchKnowledge`. Fire-and-forget incremented after each search; cold
   * chunks (access_count < N) become candidates for the archival sweep.
   *
   * Optional on the type so callers constructing `KnowledgeChunk` for
   * `insertChunk` don't need to pre-fill it — the SQL DEFAULT (0) covers
   * the insert path. Readers (`getChunksForRole`, etc.) ALWAYS populate
   * it, so search-side / UI-side code can treat it as definitely-present.
   */
  accessCount?: number;
  /**
   * Phase 77: ISO timestamp of the most recent search hit. NULL for chunks
   * that have never been accessed. The decay function (`scoreDecay`)
   * substitutes `createdAt` when this is undefined so newly-trained chunks
   * are not unfairly demoted before they have a chance to be queried.
   */
  lastAccessedAt?: string;
  /**
   * Phase 77: soft-archived flag. Archived chunks default OUT of every
   * retrieval leg (BM25 / cosine / entity). Set by the background sweep
   * when the chunk is both old and rarely accessed; cleared by the Roles
   * UI's "unarchive" button. NEVER hard-deleted — hard deletion goes
   * through `drop_knowledge_source` (user-explicit).
   *
   * Optional on the type for the same reason as `accessCount` — SQL
   * DEFAULT (0 = false) covers the insert path; readers always populate.
   */
  archived?: boolean;
}

/**
 * Phase 78: knowledge-capture candidate. Lifecycle is independent of the
 * underlying knowledge_chunks table — a candidate represents
 * "agent said something in chat X that looks like role Y's knowledge".
 * The user reviews via the Roles UI's Candidates tab and Accept (→ becomes
 * a real chunk via updateRole) / Reject (terminal, won't be re-suggested) /
 * Edit-then-Accept (trim before accept).
 *
 * Status machine:
 *   pending → accepted | rejected | expired   (terminal: all three)
 *   accepted is the only state that drives a side effect (updateRole call);
 *   the other two flip a flag + populate decided_at and stop.
 */
export type CandidateStatus = 'pending' | 'accepted' | 'rejected' | 'expired';

/**
 * Phase 79: where did this candidate row come from? Drives the
 * provenance badge in the Roles UI's Candidates tab and lets future
 * analytics distinguish "agent-emitted in chat" vs "peer pushed via
 * subscription".
 */
export type CandidateProvenance = 'chat_capture' | 'subscription';

export const CANDIDATE_STATUSES: readonly CandidateStatus[] = [
  'pending', 'accepted', 'rejected', 'expired',
];

export interface KnowledgeCandidate {
  id: string;
  roleId: string;
  /** Chat the agent response was emitted in. Nullable when the chat row is
   * deleted — candidate survives so the audit trail isn't lost. */
  hostSessionId?: string;
  chunkText: string;
  /** 0-based index of this segment within the splitter's output for the
   * original agent response. Useful when debugging why one chunk became a
   * candidate and an adjacent one didn't. */
  sourceSegmentIndex: number;
  /** Heuristic kind: fenced code blocks → `'example'`, everything else
   * → `'other'`. Decision §11 — keep guessing conservative; the user can
   * change kind in the Edit-then-Accept modal. */
  kind: KnowledgeChunkKind;
  /** # of entity-overlap hits (≥2 required to qualify; stored so the UI
   * can render "5 entities matched" badge). */
  scoreEntity: number;
  /** Max cosine vs the role's non-archived chunks at write time
   * (≥0.6 required to qualify; stored for the UI + so future retunes can
   * back-test thresholds). */
  scoreCosine: number;
  /** SHA-256 of chunkText. Drives the dedup unique index — a re-suggest of
   * the same text within the same role's pending/rejected pool is rejected
   * by SQLite, which `writeCandidateIfNew` turns into "skip, no error". */
  textHash: string;
  status: CandidateStatus;
  createdAt: string;
  /** Populated when status transitions away from `pending`. */
  decidedAt?: string;
  /** Phase 79: chat_capture (Phase 78 default) vs subscription (peer push). */
  provenance: CandidateProvenance;
  /** PR3: LLM-generated one-line headline used by Conversations detail to
   *  show "📘 spec  Brief description" instead of the raw 2-line excerpt. */
  gist?: string;
  /** PR-B: when set, this candidate refines an existing chunk (UPDATE
   *  action vs NEW action). The renderer shows a diff against the
   *  target's current text on hover/click. */
  targetChunkId?: string;
}

/**
 * Phase 79: a subscription is helm's promise to periodically poll a
 * remote bundle URL, diff it against the local role, and surface
 * additions / changes as knowledge_candidates the user can Accept.
 *
 * sourceType is parsed from sourceUrl's scheme (`tos://…` → `'tos'`).
 * Stored as its own field because the URL string can change validly
 * without changing the scheme (e.g., user fixes a typo in the bucket
 * name); pinning the scheme prevents helm from accidentally re-routing
 * an old subscription to a new plugin.
 *
 * autoApply=true means "trusted source": skip the candidates queue,
 * write chunks directly. Use sparingly; almost always false.
 */
/**
 * Phase 80 (PR C): `conflict` added. Set when the sync engine detects
 * that local and remote both moved past `last_pulled_version` —
 * applying would clobber local edits. User resolves via the
 * `/resolve-conflict` endpoint (use_remote / keep_local).
 */
export type SubscriptionStatus = 'active' | 'paused' | 'error' | 'conflict';

export interface RoleSubscription {
  id: string;
  roleId: string;
  sourceType: string;
  sourceUrl: string;
  /** Storage-backend opaque change-detection token (etag for HTTP-style;
   * content hash for fs-style). Compared on each sync to decide whether
   * to GET the full bundle. */
  lastEtag?: string;
  /** sha256(canonical JSON of last successfully-unpacked bundle's chunks).
   * Defense-in-depth: even if the backend's etag is misleading or absent,
   * a matching content hash means "no change". */
  lastContentHash?: string;
  lastSyncAt?: string;
  /** Populated when status === 'error' OR 'conflict'; cleared on next
   *  successful sync / on explicit conflict-resolution. */
  lastError?: string;
  syncIntervalMinutes: number;
  autoApply: boolean;
  status: SubscriptionStatus;
  /** Phase 80 (PR C): bundle's `roleVersion` at the moment of the last
   *  successful apply. NULL = never pulled (first sync skips the
   *  4-case conflict gate). Compared with local `role.version` +
   *  remote `bundle.roleVersion` to detect divergent edits. */
  lastPulledVersion?: number;
  createdAt: string;
}

/**
 * Phase 80 (helm-design PR B): auto-push config for a role's .helmrole
 * bundle. When enabled, the in-process MirrorRunner debounces version
 * bumps and uploads the freshly-packed bundle to `targetUrl` via the
 * matching storage plugin. `last_pushed_version` lets a catch-up sweep
 * rescue pushes missed across restart / transient failure.
 */
export interface RoleMirror {
  roleId: string;
  /** Storage-plugin URL (e.g. `tos://bucket/helm-role/<roleId>.helmrole`). */
  targetUrl: string;
  /** When false the runner ignores this row entirely (no pushes, no sweep). */
  enabled: boolean;
  /** roles.version at the moment of the last successful upload. Catch-up
   *  sweep pushes when `last_pushed_version < roles.version`. NULL means
   *  "never pushed". */
  lastPushedVersion?: number;
  /** Storage backend's opaque change-detection token returned by the last
   *  successful upload. Recorded for diagnostics — not consulted by the
   *  push logic. */
  lastPushedEtag?: string;
  lastPushedAt?: string;
  /** Last error message; cleared on next successful push. */
  lastError?: string;
  createdAt: string;
  updatedAt: string;
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

/**
 * PR 2 (migration v20): agent runtime discriminator for the
 * Conversations facet tabs (§5.1). Distinct from `host` so we can
 * introduce new hosts (Codex per PR 7) without rewriting downstream
 * filters that key on the old single-value column.
 */
export type AgentKind = 'cursor' | 'claude_code' | 'codex';

/**
 * PR 2 (migration v20): per-point alias, normalized out of what used to
 * be a JSON-in-TEXT column (caught in design rev 5 review — reverse
 * lookup needed an index). `source` carries provenance so the UI can
 * distinguish a user-typed alias from an LLM-suggested one.
 */
export interface KnowledgePointAlias {
  pointId: string;
  alias: string;
  source: 'manual' | 'llm-suggested' | 'imported';
  createdAt: number;
}

/**
 * PR 2 (migration v20): typed edge in the knowledge graph between two
 * points. `includes` is "X contains Y as a sub-concept"; `correspondsTo`
 * is "X and Y describe the same thing from different angles";
 * `supersedes` marks deprecation chains. §4.4.2 walks one hop after
 * RRF fusion using these.
 */
export type KnowledgePointRelKind = 'includes' | 'correspondsTo' | 'supersedes';

export interface KnowledgePointRel {
  fromPointId: string;
  toPointId: string;
  relKind: KnowledgePointRelKind;
  createdAt: number;
}

/**
 * PR 2 (migration v20): a single retrieve() invocation against the
 * KnowledgePointProvider. Header row keeps the query metadata; the
 * actual point hits land in retrieval_log_points so reverse lookup
 * ("which conversations cited this point?") goes through an index
 * instead of a JSON scan.
 */
export interface RetrievalLog {
  id: string;
  hostSessionId: string;
  turn: number;
  queryText?: string;
  ts: number;
}

/**
 * PR 2 (migration v20): one row per (retrieve call × point returned).
 * `legContrib` is a JSON blob describing which RRF legs (bm25 / cosine
 * / entity / rel-expansion) contributed — write-many, read-rarely so
 * JSON is OK; we never filter on it. `injected` flags whether the
 * point actually made it into the LLM context (some hits are dropped
 * by the diversification cap).
 */
export interface RetrievalLogPoint {
  logId: string;
  pointId: string;
  rank: number;
  fusionScore: number;
  legContrib?: {
    bm25Rank?: number;
    cosineRank?: number;
    entityRank?: number;
    relExpansionFrom?: string;
  };
  injected: boolean;
}

export interface HostSession {
  id: string;
  host: 'cursor' | string;
  /**
   * PR 2 (migration v20): facet discriminator for the Conversations
   * tabs. Backfilled from `host` for legacy rows. New sessions opened
   * by the Claude Code or Codex adapters set this directly (PR 7).
   */
  agentKind?: AgentKind;
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
  /**
   * PR3 (conv detail TL;DR): LLM-generated 2-line summary of the chat,
   * surfaced at the top of the detail pane. Regenerated on Stop, throttled
   * by callers via `summaryGeneratedAt`. Absent when generation hasn't
   * happened or failed.
   */
  summary?: string;
  summaryGeneratedAt?: string;
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

// ── Verification (PR 5 / migration v21) ─────────────────────────────────────
//
// docs/design/2026-06-06-conversation-knowledge-redesign.md §3.5 + §4.7.
// A BenchmarkCase is a small "did this knowledge point teach the agent
// the right answer?" probe. The §4.7 case-proposal flow keeps writing
// new cases as `status='proposed'`; only confirmed cases participate
// in regression detection or coverage stats (R-5).

/** Where the case came from. Drives the §5.6 review-dialog badge. */
export type BenchmarkCaseProposedSource = 'manual' | 'llm-on-edit' | 'imported';

/** What write-action proposed the case. NULL on manual creations. */
export type BenchmarkCaseProposedEvent =
  | 'candidate_accept'
  | 'point_edit'
  | 'subscription_pull'
  | 'manual';

/**
 * Case lifecycle. `proposed` is the holding pen — does not feed
 * regression / coverage / Insights. `confirmed` is the only state
 * with score baseline meaning. `rejected` and `archived` are terminal.
 */
export type BenchmarkCaseStatus = 'proposed' | 'confirmed' | 'rejected' | 'archived';

export interface BenchmarkCase {
  id: string;
  name: string;
  question: string;
  expectedTruth: string;
  goldenPointIds: readonly string[];
  targetRoleIds: readonly string[];
  agentKindHint?: AgentKind;
  notes?: string;
  sourceRepoUrl?: string;
  sourceRevision?: string;
  proposedSource: BenchmarkCaseProposedSource;
  proposedAt: number;
  proposedFromPointId?: string;
  proposedFromEvent?: BenchmarkCaseProposedEvent;
  proposedQuestionHash?: string;
  status: BenchmarkCaseStatus;
  confirmedBy?: string;
  confirmedAt?: number;
  rejectedReason?: string;
  createdAt: number;
  updatedAt: number;
}

export type BenchmarkTriggeringEventKind =
  | 'candidate_accept'
  | 'subscription_pull'
  | 'mirror_merge'
  | 'manual';

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
  /**
   * Composite git-as-substrate fingerprint of the knowledge state
   * that produced this score. sha256 of sorted (repoUrl, repoSha)
   * tuples, or `local-<contentHash+editVersion>` when one of the
   * golden points was edited locally without being committed.
   */
  knowledgeStateSha: string;
  isReproducible: boolean;
  reproducedFromRunId?: string;
  triggeringEventKind?: BenchmarkTriggeringEventKind;
  triggeringEventRefId?: string;
  baselineRunId?: string;
}

/** Per-(runId, repoUrl) repo state. Joined to benchmark_run by runId. */
export interface BenchmarkRunRepoState {
  runId: string;
  repoUrl: string;
  repoSha: string;
}

export type RegressionAlertStatus = 'open' | 'acknowledged' | 'resolved';

export interface RegressionAlert {
  id: string;
  caseId: string;
  prevRunId: string;
  currentRunId: string;
  prevScore: number;
  currentScore: number;
  /** `currentScore - prevScore`. Negative = regression. */
  delta: number;
  triggeringEventKind: BenchmarkTriggeringEventKind;
  triggeringEventRefId: string;
  status: RegressionAlertStatus;
  resolvedNote?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Daily cost roll-up powering §4.7.6 caps. `roleId=null` row is the
 * global aggregate for that date; non-null rows are per-collection.
 */
export interface BenchmarkCostAuditRow {
  id: string;
  date: string;
  roleId?: string;
  llmCalls: number;
  estimatedCostUsd: number;
  updatedAt: number;
}

// ── Knowledge Repo (PR 5.5a / migration v22) ───────────────────────────────

/** §7.4 host-allow-list outcome. Drives R-0 publish gating. */
export type KnowledgeRepoClassification = 'internal' | 'public';

/** Lifecycle of a subscribed repo. `paused` is opt-out without delete. */
export type KnowledgeRepoStatus = 'active' | 'paused' | 'error' | 'conflict';

export interface KnowledgeRepo {
  id: string;
  url: string;
  branch: string;
  localPath: string;
  lastFetchedSha?: string;
  lastFetchedAt?: number;
  syncIntervalMinutes: number;
  autoApply: boolean;
  classification: KnowledgeRepoClassification;
  status: KnowledgeRepoStatus;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  /**
   * Migration v26 — layout/serialization profile fixed at subscribe
   * time. Mirrors knowledge-repo/profiles.ts KnowledgeRepoProfile;
   * duplicated as a literal union here so storage types stay free of
   * knowledge-repo imports.
   */
  profile: 'helm-native' | 'llm-wiki' | 'generic';
}

// ── KnowledgeMergeConflict (PR 5.5c / migration v23) ───────────────────────

export type KnowledgeMergeConflictStatus = 'open' | 'resolved';

export interface KnowledgeMergeConflict {
  id: string;
  repoId: string;
  pointId: string;
  localBody: string;
  remoteBody: string;
  /** edit_version the local chunk was at when the conflict was recorded. */
  localVersion: number;
  /** Commit SHA the remote body came from. */
  remoteRevision: string;
  status: KnowledgeMergeConflictStatus;
  resolvedBody?: string;
  resolvedAt?: number;
  createdAt: number;
  updatedAt: number;
}
