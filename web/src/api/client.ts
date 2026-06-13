/**
 * Helm REST client. Vite proxies /api → http://127.0.0.1:17317 in dev; in
 * the packaged Electron app the renderer loads via `file://`, so relative
 * `/api/...` paths can't resolve against same-origin — we route through
 * `apiUrl()` which prepends `http://127.0.0.1:<port>` in that case.
 */

import { apiUrl } from './base-url.js';
import type {
  ActiveChat,
  BugTaskInput,
  Campaign,
  CampaignSummary,
  ChannelBinding,
  ChunkVisibility,
  Cycle,
  CycleScreenshotInput,
  DocAuditEntry,
  HelmConfig,
  KnowledgeRepo,
  KnowledgeRepoSeed,
  PendingApproval,
  PendingBind,
  Requirement,
  Role,
  RoleChunk,
  RoleSummary,
  CandidateExternalContext,
  Task,
  TrainRoleInput,
  UnpublishedCapturedFile,
} from './types.js';

export class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly body?: unknown) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };

  const res = await fetch(apiUrl(path), init);
  const text = await res.text();
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : null; }
  catch { parsed = text; }

  if (!res.ok) {
    const message = typeof parsed === 'object' && parsed && 'message' in parsed
      ? String((parsed as { message: unknown }).message)
      : res.statusText;
    throw new ApiError(res.status, message, parsed);
  }
  return parsed as T;
}

export const helmApi = {
  health: () => request<{ ok: boolean; name: string; version: string }>('GET', '/api/health'),

  activeChats: (status: 'active' | 'closed' | 'all' = 'active') =>
    request<{ chats: ActiveChat[]; total: number }>(
      'GET',
      `/api/active-chats${status === 'active' ? '' : `?status=${status}`}`,
    ),

  scanHistory: (host: 'claude-code' | 'cursor' | 'codex' | 'all' = 'all') =>
    request<{ results: { host: string; imported: number; skipped: number; turns: number }[] }>(
      'POST',
      '/api/history/scan',
      { host },
    ),

  /**
   * Per-conversation aggregate: session header + timeline + knowledge-in-play
   * (retrievals with hydrated chunk metadata) + pending knowledge candidates.
   * Backed by src/api/conversation-detail.ts.
   */
  conversationDetail: (hostSessionId: string) =>
    request<import('./types.js').ConversationDetail>(
      'GET',
      `/api/conversations/${encodeURIComponent(hostSessionId)}/detail`,
    ),

  /**
   * PR-B: trigger LLM curation for one chat × role. The server runs the
   * pass synchronously and returns the count of update / new candidates
   * created. Caller refetches conversationDetail to pull the new rows.
   */
  extractForRole: (hostSessionId: string, roleId: string) =>
    request<{ updateCount: number; newCount: number; candidateIds: string[] }>(
      'POST',
      `/api/conversations/${encodeURIComponent(hostSessionId)}/extract`,
      { roleId },
    ),

  /**
   * PR-C: spawn a new role from this chat's unknown entities, train it
   * on the relevant passages, and auto-run curation. Returns the new
   * role id + curation tally.
   */
  spawnRoleFromChat: (
    hostSessionId: string,
    input: { entities: string[]; roleName?: string; roleId?: string },
  ) =>
    request<{
      roleId: string;
      roleName: string;
      updateCount: number;
      newCount: number;
      candidateIds: string[];
    }>(
      'POST',
      `/api/conversations/${encodeURIComponent(hostSessionId)}/spawn-role`,
      input,
    ),

  // Phase 25 / 42: legacy single-role setter — replaces the chat's entire
  // role list with this one role (or empty when null). Kept for clients that
  // haven't switched to addChatRole / removeChatRole.
  setChatRole: (hostSessionId: string, roleId: string | null) =>
    request<{ chat: ActiveChat }>(
      'PUT',
      `/api/active-chats/${encodeURIComponent(hostSessionId)}/role`,
      { roleId },
    ),

  // Phase 42: stack multiple roles on a chat (e.g. Goofy + 容灾大盘).
  addChatRole: (hostSessionId: string, roleId: string) =>
    request<{ chat: ActiveChat }>(
      'POST',
      `/api/active-chats/${encodeURIComponent(hostSessionId)}/roles`,
      { roleId },
    ),
  removeChatRole: (hostSessionId: string, roleId: string) =>
    request<{ chat: ActiveChat }>(
      'DELETE',
      `/api/active-chats/${encodeURIComponent(hostSessionId)}/roles/${encodeURIComponent(roleId)}`,
    ),

  // Phase 36: close (default — soft) or delete (?cascade=true — hard, cascades
  // to channel_bindings + queued messages) a host_session. Emits session.closed
  // so the renderer auto-refreshes.
  closeChat: (hostSessionId: string, options: { cascade?: boolean } = {}) => {
    const qs = options.cascade ? '?cascade=true' : '';
    return request<{ ok: true; hostSessionId: string; cascade: boolean }>(
      'DELETE',
      `/api/active-chats/${encodeURIComponent(hostSessionId)}${qs}`,
    );
  },

  // v34: per-chat capture mute toggle.
  setChatCapture: (hostSessionId: string, enabled: boolean) =>
    request<{ hostSessionId: string; captureEnabled: boolean }>(
      'PUT',
      `/api/active-chats/${encodeURIComponent(hostSessionId)}/capture`,
      { enabled },
    ),
  // Topics cleanup: delete a non-builtin collection/expert (chunks cascade).
  deleteRole: (roleId: string) =>
    request<{ roleId: string; deleted: true }>(
      'DELETE', `/api/roles/${encodeURIComponent(roleId)}`,
    ),
  // Phase 55: rename / clear the user-facing chat label. Pass null or empty
  // string to clear back to the firstPrompt-based fallback.
  setChatLabel: (hostSessionId: string, label: string | null) =>
    request<{ chat: ActiveChat }>(
      'PUT',
      `/api/active-chats/${encodeURIComponent(hostSessionId)}/label`,
      { label },
    ),

  approvals: () => request<{ approvals: PendingApproval[] }>('GET', '/api/approvals'),

  decideApproval: (
    approvalId: string,
    decision: 'allow' | 'deny',
    options: { reason?: string; remember?: boolean; scope?: string } = {},
  ) =>
    request<{
      ok: true;
      approvalId: string;
      rememberedRule?: { id: string; tool: string; decision: 'allow' | 'deny' };
    }>(
      'POST',
      `/api/approvals/${encodeURIComponent(approvalId)}/decide`,
      {
        decision,
        ...(options.reason ? { reason: options.reason } : {}),
        ...(options.remember ? { remember: true } : {}),
        ...(options.scope ? { scope: options.scope } : {}),
      },
    ),

  campaigns: () => request<{ campaigns: Campaign[] }>('GET', '/api/campaigns'),

  campaignCycles: (campaignId: string) =>
    request<{ cycles: Cycle[] }>('GET', `/api/campaigns/${encodeURIComponent(campaignId)}/cycles`),

  cycle: (cycleId: string) =>
    request<{ cycle: Cycle; campaign: Campaign | null; tasks: Task[] }>(
      'GET', `/api/cycles/${encodeURIComponent(cycleId)}`,
    ),

  task: (taskId: string) =>
    request<{ task: Task; auditLog: DocAuditEntry[] }>(
      'GET', `/api/tasks/${encodeURIComponent(taskId)}`,
    ),

  // ── Cycle mutations (B1) ──
  completeCycle: (
    cycleId: string,
    body: { passRate?: number; failedTests?: string[]; screenshots?: CycleScreenshotInput[] } = {},
  ) =>
    request<{ cycle: Cycle }>(
      'POST',
      `/api/cycles/${encodeURIComponent(cycleId)}/complete`,
      body,
    ),

  createBugTasks: (cycleId: string, bugs: BugTaskInput[]) =>
    request<{ tasks: Task[] }>(
      'POST',
      `/api/cycles/${encodeURIComponent(cycleId)}/bug-tasks`,
      { bugs },
    ),

  summarizeCampaign: (campaignId: string) =>
    request<{ summary: CampaignSummary }>(
      'POST',
      `/api/campaigns/${encodeURIComponent(campaignId)}/summarize`,
    ),

  // ── Settings ──
  getConfig: () => request<HelmConfig>('GET', '/api/config'),
  saveConfig: (config: HelmConfig) => request<HelmConfig>('PUT', '/api/config', config),

  // ── Bindings ──
  bindings: () => request<{ bindings: ChannelBinding[] }>('GET', '/api/bindings'),
  pendingBinds: () => request<{ pending: PendingBind[] }>('GET', '/api/bindings/pending'),
  consumePendingBind: (code: string, hostSessionId: string) =>
    request<{ binding: { id: string } }>('POST', '/api/bindings/consume', { code, hostSessionId }),
  // Phase 39: cancel a pending bind without consuming it. Useful for clearing
  // accidental / stale codes instead of waiting out the 10-minute TTL.
  cancelPendingBind: (code: string) =>
    request<{ ok: true; code: string }>(
      'DELETE',
      `/api/bindings/pending/${encodeURIComponent(code)}`,
    ),
  unbind: (bindingId: string) =>
    request<{ ok: true }>('DELETE', `/api/bindings/${encodeURIComponent(bindingId)}`),
  // Phase 62: from Active Chats "Mirror to Lark" — mints a pending_binds
  // code without requiring the user to first send `@bot bind chat` in Lark.
  // Returns 501 when Lark isn't wired (renderer should hide the button or
  // surface "Configure Lark in Settings").
  // Phase 64: pass hostSessionId so the Lark-side `@bot bind <code>`
  // consume handler knows which Cursor chat to attach without the user
  // needing to revisit the helm Pending Binds list.
  initiateLarkBind: (opts: { label?: string; hostSessionId?: string } = {}) =>
    request<{ code: string; expiresAt: string; instruction: string }>(
      'POST', '/api/bindings/initiate', {
        ...(opts.label ? { label: opts.label } : {}),
        ...(opts.hostSessionId ? { hostSessionId: opts.hostSessionId } : {}),
      },
    ),
  // Phase 63: register helm's MCP server with Claude Code or Cursor
  // directly from the Roles page button (no `helm` CLI on PATH needed).
  setupMcp: (target: 'claude' | 'cursor') =>
    request<{
      target: 'claude' | 'cursor';
      changed: boolean;
      message: string;
      location: string;
    }>('POST', '/api/setup-mcp', { target }),

  // ── Roles (B3) ──
  roles: () => request<{ roles: RoleSummary[] }>('GET', '/api/roles'),
  role: (roleId: string) =>
    // Phase 73: `sources` block surfaces the knowledge_source rows + chunk
    // counts so the Roles page can show a Sources list with Drop buttons.
    request<{ role: Role; chunks: RoleChunk[]; sources: import('./types.js').KnowledgeSource[] }>(
      'GET', `/api/roles/${encodeURIComponent(roleId)}`,
    ),
  trainRole: (roleId: string, input: TrainRoleInput) =>
    request<{ role: Role }>(
      'POST', `/api/roles/${encodeURIComponent(roleId)}/train`, input,
    ),
  /** Phase 73: cascade-delete a knowledge source AND every chunk derived from it. */
  dropKnowledgeSource: (sourceId: string) =>
    request<{ removed: boolean; chunksDeleted: number; source: import('./types.js').KnowledgeSource }>(
      'DELETE', `/api/knowledge-sources/${encodeURIComponent(sourceId)}`,
    ),
  /**
   * Phase 77: rescue a single soft-archived chunk. Drives the "unarchive"
   * button inside the Roles page's "Archived (N)" folded section.
   * Re-bumps `last_accessed_at` so the freshly-rescued chunk doesn't get
   * re-archived on the very next sweep.
   */
  unarchiveChunk: (chunkId: string) =>
    request<{ chunkId: string; restored: boolean }>(
      'POST', `/api/knowledge-chunks/${encodeURIComponent(chunkId)}/unarchive`,
    ),
  /**
   * Phase 78 — list knowledge-capture candidates for a role.
   * Status defaults to `pending`; pass `'all'` to also see accepted /
   * rejected / expired rows (audit trail).
   */
  listCandidates: (
    roleId: string,
    status: import('./types.js').CandidateStatus | 'all' = 'pending',
  ) =>
    request<{ candidates: import('./types.js').KnowledgeCandidate[] }>(
      'GET',
      `/api/roles/${encodeURIComponent(roleId)}/candidates?status=${encodeURIComponent(status)}`,
    ),
  /** Phase 78 — accept a pending candidate (creates a chunk via updateRole). */
  acceptCandidate: (candidateId: string) =>
    request<{ candidateId: string; status: 'accepted'; flipped: boolean; chunksAdded: number; wikiFiles?: string[] }>(
      'POST', `/api/knowledge-candidates/${encodeURIComponent(candidateId)}/accept`,
    ),
  /** Phase 78 — reject a pending candidate (terminal state). */
  rejectCandidate: (candidateId: string) =>
    request<{ candidateId: string; status: 'rejected'; flipped: boolean }>(
      'POST', `/api/knowledge-candidates/${encodeURIComponent(candidateId)}/reject`,
    ),
  /** Phase 78 — update candidate text + then accept in one round-trip. */
  editAndAcceptCandidate: (candidateId: string, chunkText: string) =>
    request<{ candidateId: string; status: 'accepted'; flipped: boolean; chunksAdded: number; wikiFiles?: string[] }>(
      'POST',
      `/api/knowledge-candidates/${encodeURIComponent(candidateId)}/edit-and-accept`,
      { chunkText },
    ),

  /**
   * PR 4 — cross-role list of candidates for the global Review inbox
   * (§5.3 wireframe). Pass `roleId` to scope to a single role.
   * `sort='score'` ranks by entity-overlap + cosine (matches §4.4
   * weights). Defaults: status=pending, sort=recent.
   */
  listReviewCandidates: (opts?: {
    status?: import('./types.js').CandidateStatus | 'all';
    sort?: 'score' | 'recent';
    roleId?: string;
    limit?: number;
  }) => {
    const params = new URLSearchParams();
    if (opts?.status)  params.set('status', opts.status);
    if (opts?.sort)    params.set('sort',   opts.sort);
    if (opts?.roleId)  params.set('roleId', opts.roleId);
    if (opts?.limit)   params.set('limit',  String(opts.limit));
    const qs = params.toString();
    return request<{ candidates: import('./types.js').KnowledgeCandidate[] }>(
      'GET',
      `/api/review/candidates${qs ? `?${qs}` : ''}`,
    );
  },

  /**
   * PR 4 — bulk reject. By design (R-5) there is no bulk accept;
   * every accept is a separate human decision.
   */
  bulkRejectCandidates: (candidateIds: readonly string[]) =>
    request<{ flipped: number }>(
      'POST', '/api/review/bulk-reject', { candidateIds },
    ),

  // ── Verification (PR 5 + PR 6) ──────────────────────────────────
  /**
   * List cases. Defaults to confirmed; pass status='proposed' for the
   * §4.7 R-5 review queue or 'all' for the full audit log.
   */
  listVerificationCases: (opts?: {
    status?: import('./types.js').BenchmarkCaseStatus | 'all';
    roleId?: string;
    limit?: number;
  }) => {
    const p = new URLSearchParams();
    if (opts?.status) p.set('status', opts.status);
    if (opts?.roleId) p.set('roleId', opts.roleId);
    if (opts?.limit)  p.set('limit', String(opts.limit));
    const qs = p.toString();
    return request<{ cases: import('./types.js').BenchmarkCase[] }>(
      'GET',
      `/api/verification/cases${qs ? `?${qs}` : ''}`,
    );
  },

  getVerificationCase: (id: string) =>
    request<{ case: import('./types.js').BenchmarkCase }>(
      'GET', `/api/verification/cases/${encodeURIComponent(id)}`,
    ),

  createVerificationCase: (input: {
    name: string;
    question: string;
    expectedTruth: string;
    goldenPointIds?: readonly string[];
    targetRoleIds?: readonly string[];
    agentKindHint?: import('./types.js').BenchmarkAgentKindHint;
    notes?: string;
    proposedSource?: import('./types.js').BenchmarkCaseProposedSource;
  }) =>
    request<{ case: import('./types.js').BenchmarkCase }>(
      'POST', '/api/verification/cases', input,
    ),

  confirmVerificationCase: (id: string, confirmedBy?: string) =>
    request<{ caseId: string; status: 'confirmed' }>(
      'POST',
      `/api/verification/cases/${encodeURIComponent(id)}/confirm`,
      confirmedBy ? { confirmedBy } : undefined,
    ),

  rejectVerificationCase: (id: string, reason?: string) =>
    request<{ caseId: string; status: 'rejected' }>(
      'POST',
      `/api/verification/cases/${encodeURIComponent(id)}/reject`,
      reason ? { reason } : undefined,
    ),

  listVerificationRunsForCase: (caseId: string, limit?: number) => {
    const qs = limit ? `?limit=${limit}` : '';
    return request<{ runs: import('./types.js').BenchmarkRun[] }>(
      'GET',
      `/api/verification/cases/${encodeURIComponent(caseId)}/runs${qs}`,
    );
  },

  listVerificationAlerts: (opts?: {
    status?: import('./types.js').RegressionAlertStatus | 'all';
    limit?: number;
  }) => {
    const p = new URLSearchParams();
    if (opts?.status) p.set('status', opts.status);
    if (opts?.limit)  p.set('limit', String(opts.limit));
    const qs = p.toString();
    return request<{ alerts: import('./types.js').RegressionAlert[] }>(
      'GET',
      `/api/verification/alerts${qs ? `?${qs}` : ''}`,
    );
  },

  /** Sidebar badge counts: proposed cases + open regression alerts. */
  verificationCounts: () =>
    request<import('./types.js').VerificationCounts>(
      'GET', '/api/verification/counts',
    ),

  /**
   * Trigger a synchronous run of one case. Returns the new run row on
   * success. 503 when no provider config is wired (the renderer
   * surfaces a "configure ~/.helm/benchmark/providers.json" hint).
   */
  runVerificationCase: (id: string) =>
    request<{ run: import('./types.js').BenchmarkRun }>(
      'POST', `/api/verification/cases/${encodeURIComponent(id)}/run`,
    ),

  // ── Role mirrors (Phase 80 / helm-design PR B) ────────────────────────
  // Auto-push a role's .helmrole bundle to a remote URL on every
  // version bump. The mirror runner debounces a few seconds + has a
  // catch-up sweep, so the UI fire-and-forget pattern is safe.

  /** Returns the role's mirror config, or null when none is set. */
  /** Create or update the role's mirror config. PUT is idempotent. */

  // Phase 60b: conversational role training. Each turn POSTs the full
  // transcript; helm spawns `claude -p` with helm's MCP injected so the
  // agent can call `train_role` itself when the user is ready. The old
  // `/commit` endpoint is gone — the agent owns the save step.
  roleTrainChat: (
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    options: { projectPath?: string } = {},
  ) =>
    request<{
      message: { role: 'assistant'; content: string };
      sessionId: string;
      /** claude's stderr — surfaced in the modal's debug area on warnings. */
      stderr?: string;
    }>('POST', '/api/roles/train-chat', {
      messages,
      // projectPath becomes the spawned subprocess's cwd, so claude's
      // built-in `read` / `grep` / `glob` see the user's actual codebase.
      ...(options.projectPath ? { projectPath: options.projectPath } : {}),
    }),

  // ── Requirements (B3) ──
  requirements: (query?: string) =>
    request<{ requirements: Requirement[] }>(
      'GET',
      query ? `/api/requirements?q=${encodeURIComponent(query)}` : '/api/requirements',
    ),
  requirement: (id: string) =>
    request<{ requirement: Requirement }>(
      'GET', `/api/requirements/${encodeURIComponent(id)}`,
    ),

  // ── Diagnostics ──
  exportDiagnostics: () =>
    request<{ bundleDir: string; manifest: { generatedAt: string; warnings: string[] } }>(
      'POST', '/api/diagnostics',
    ),

  // ── Engine health (Phase 68) ──
  engineHealth: () =>
    request<{ engines: import('./types.js').EngineHealth[] }>('GET', '/api/engine/health'),

  // ── Harness toolchain (Phase 67) ──
  harnessTasks: (projectPath?: string) =>
    request<{ tasks: HarnessTaskView[] }>(
      'GET',
      projectPath ? `/api/harness/tasks?projectPath=${encodeURIComponent(projectPath)}` : '/api/harness/tasks',
    ),
  harnessCreateTask: (input: {
    taskId: string; title: string; projectPath: string;
    hostSessionId?: string;
    intent?: { background?: string; objective?: string; scopeIn?: string[]; scopeOut?: string[] };
  }) =>
    request<{ task: HarnessTaskView; relatedFound: { taskId: string; oneLiner: string; archivePath: string }[] }>(
      'POST', '/api/harness/tasks', input,
    ),
  harnessGetTask: (taskId: string) =>
    request<HarnessTaskView>('GET', `/api/harness/tasks/${encodeURIComponent(taskId)}`),
  harnessAdvance: (taskId: string, body: { toStage: 'implement' | 'archived'; implementBaseCommit?: string; message?: string }) =>
    request<HarnessTaskView>('POST', `/api/harness/tasks/${encodeURIComponent(taskId)}/advance`, body),
  harnessRunReview: (taskId: string) =>
    request<HarnessReviewView>('POST', `/api/harness/tasks/${encodeURIComponent(taskId)}/review`),
  harnessListReviews: (taskId: string) =>
    request<{ reviews: HarnessReviewView[] }>(
      'GET', `/api/harness/tasks/${encodeURIComponent(taskId)}/review`,
    ),
  harnessGetReview: (reviewId: string) =>
    request<HarnessReviewView>('GET', `/api/harness/reviews/${encodeURIComponent(reviewId)}`),
  harnessPushReview: (taskId: string, reviewId: string) =>
    request<{ bindingId: string; messageId: number; delivered: boolean }>(
      'POST',
      `/api/harness/tasks/${encodeURIComponent(taskId)}/push-review/${encodeURIComponent(reviewId)}`,
    ),
  harnessArchive: (taskId: string, body: {
    oneLiner: string;
    entities?: string[]; filesTouched?: string[]; modules?: string[];
    patterns?: string[]; downstream?: string[]; rulesApplied?: string[];
  }) =>
    request<{ task: HarnessTaskView; card: HarnessArchiveCardView }>(
      'POST', `/api/harness/tasks/${encodeURIComponent(taskId)}/archive`, body,
    ),
  harnessReindex: (taskId: string, projectPath: string) =>
    request<HarnessTaskView>(
      'POST', `/api/harness/tasks/${encodeURIComponent(taskId)}/reindex`, { projectPath },
    ),
  harnessArchiveCards: (opts: { projectPath?: string; tokens?: string[] } = {}) => {
    const params = new URLSearchParams();
    if (opts.projectPath) params.set('projectPath', opts.projectPath);
    for (const t of opts.tokens ?? []) params.append('q', t);
    const qs = params.toString();
    return request<{ cards: HarnessArchiveCardView[] }>(
      'GET',
      qs ? `/api/harness/archive?${qs}` : '/api/harness/archive',
    );
  },

  // ── R-7: chunk visibility toggle (the R-0 escape hatch) ──
  setChunkVisibility: (
    chunkId: string,
    visibility: ChunkVisibility,
    expectedEditVersion: number,
  ) =>
    request<{ chunkId: string; visibility: ChunkVisibility; editVersion: number }>(
      'PATCH',
      `/api/knowledge-chunks/${encodeURIComponent(chunkId)}/visibility`,
      { visibility, expectedEditVersion },
    ),

  // ── R-6: KnowledgeRepo subscriptions ──
  listKnowledgeRepos: (status?: 'active' | 'paused' | 'error' | 'conflict' | 'all') => {
    const qs = status ? `?status=${status}` : '';
    return request<{ repos: KnowledgeRepo[] }>('GET', `/api/knowledge-repos${qs}`);
  },
  subscribeKnowledgeRepo: (input: {
    url: string;
    branch?: string;
    syncIntervalMinutes?: number;
    autoApply?: boolean;
  }) => request<{ repo: KnowledgeRepo }>('POST', '/api/knowledge-repos', input),
  fetchKnowledgeRepoNow: (repoId: string) =>
    request<{ repoId: string; moved: boolean; headSha: string }>(
      'POST', `/api/knowledge-repos/${encodeURIComponent(repoId)}/fetch-now`,
    ),
  importKnowledgeRepoNow: (
    repoId: string,
    profile?: 'helm-native' | 'llm-wiki' | 'generic',
  ) =>
    request<{
      repoId: string;
      summary: {
        rolesImported: number;
        pointsUpserted: number;
        conflictsDetected: number;
        errors: Record<string, string>;
      };
    }>(
      'POST',
      `/api/knowledge-repos/${encodeURIComponent(repoId)}/import-now`,
      profile ? { profile } : {},
    ),
  publishKnowledgeRepo: (
    repoId: string,
    input: {
      pointIds: string[];
      message: string;
      branchName?: string;
      profile?: 'helm-native' | 'llm-wiki' | 'generic';
      anonymous?: boolean;
    },
  ) =>
    request<{ branch: string; prUrl: string; filesWritten: number }>(
      'POST', `/api/knowledge-repos/${encodeURIComponent(repoId)}/publish`, input,
    ),
  // PR-δ: flip Expert / Collection.
  setRoleBindable: (roleId: string, bindable: boolean) =>
    request<{ roleId: string; bindable: boolean }>(
      'PATCH', `/api/roles/${encodeURIComponent(roleId)}/bindable`, { bindable },
    ),
  // PR-β: candidate external-context cache.
  getCandidateContexts: (candidateIds: string[]) =>
    request<{ contexts: Record<string, CandidateExternalContext> }>(
      'POST', '/api/knowledge-candidates/context', { candidateIds },
    ),
  refreshCandidateContext: (candidateId: string) =>
    request<{ context: CandidateExternalContext | null }>(
      'POST', `/api/knowledge-candidates/${encodeURIComponent(candidateId)}/refresh-context`,
    ),
  // Ad-hoc external-knowledge lookup (外部知识对照 button).
  lookupKnowledge: (query: string, providers?: string[]) =>
    request<{
      snippets: Array<{ source: string; title: string; body: string; score?: number; citation?: string }>;
      diagnostics: Array<{ provider: string; status: 'ok' | 'skipped' | 'error' | 'timeout'; snippetCount: number; reason?: string }>;
    }>('POST', '/api/knowledge-lookup', { query, ...(providers ? { providers } : {}) }),
  // v28: import-directory whitelist (+PR-γ: parent= lists sub-dirs).
  getRepoDirs: (repoId: string, parent?: string) =>
    request<{
      dirs: string[];
      /** Tree-select picker: top dirs + one level of children. Absent when parent= given. */
      tree?: Array<{ name: string; children: string[] }>;
      importDirs: string[] | null;
    }>(
      'GET', `/api/knowledge-repos/${encodeURIComponent(repoId)}/dirs${parent ? `?parent=${encodeURIComponent(parent)}` : ''}`,
    ),
  // PR-γ: 升格 — consolidated personal knowledge → domains/ MR.
  promoteToDomain: (repoId: string, input: { domain: string; title: string; body: string }) =>
    request<{ branch: string; prUrl: string; filesWritten: number; relPath: string }>(
      'POST', `/api/knowledge-repos/${encodeURIComponent(repoId)}/promote`, input,
    ),
  // PR-γ2: AI 整理 — LLM polishes fragments into a draft (external refs included).
  promoteDraft: (repoId: string, input: { fragments: string[]; domain?: string; title?: string }) =>
    request<{ draft: string; usedExternalContext: boolean }>(
      'POST', `/api/knowledge-repos/${encodeURIComponent(repoId)}/promote-draft`, input,
    ),
  setRepoImportDirs: (repoId: string, importDirs: string[] | null) =>
    request<{ repo: KnowledgeRepo }>(
      'PATCH', `/api/knowledge-repos/${encodeURIComponent(repoId)}`, { importDirs },
    ),
  // Files-as-truth PR-3: captured-points batch publish.
  listCapturedUnpublished: (repoId: string) =>
    request<{ files: UnpublishedCapturedFile[] }>(
      'GET', `/api/knowledge-repos/${encodeURIComponent(repoId)}/captured`,
    ),
  publishCaptured: (repoId: string, input: { message?: string } = {}) =>
    request<{
      branch: string; prUrl: string; filesWritten: number;
      pointIds: string[]; skipped: string[];
    }>(
      'POST', `/api/knowledge-repos/${encodeURIComponent(repoId)}/publish-captured`, input,
    ),
  unsubscribeKnowledgeRepo: (repoId: string, removeData?: boolean) => {
    const qs = removeData ? '?removeData=true' : '';
    return request<{ ok: true; repoId: string }>(
      'DELETE',
      `/api/knowledge-repos/${encodeURIComponent(repoId)}${qs}`,
    );
  },
  listKnowledgeRepoSeeds: () =>
    request<{ seeds: KnowledgeRepoSeed[] }>('GET', '/api/knowledge-repos/seeds'),
  subscribeKnowledgeRepoSeed: (seedId: string) =>
    request<{ repo: KnowledgeRepo; seedId: string }>(
      'POST', `/api/knowledge-repos/seeds/${encodeURIComponent(seedId)}/subscribe`,
    ),

  // ── R-18 wire-up: per-agent hooks install / status ──
  installHostHooks: (agent: 'cursor' | 'claude-code' | 'codex') =>
    request<Record<string, unknown>>(
      'POST', `/api/host/${agent}/hooks/install`, {},
    ),
  uninstallHostHooks: (agent: 'cursor' | 'claude-code' | 'codex') =>
    request<Record<string, unknown>>(
      'POST', `/api/host/${agent}/hooks/uninstall`, {},
    ),
  getHostHooksStatus: (agent: 'cursor' | 'claude-code' | 'codex') =>
    request<{ installed: boolean | 'unknown'; hooksPath?: string }>(
      'GET', `/api/host/${agent}/hooks/status`,
    ),
};

export interface HarnessTaskView {
  id: string;
  title: string;
  currentStage: 'new_feature' | 'implement' | 'archived';
  projectPath: string;
  hostSessionId?: string;
  intent?: { background: string; objective: string; scopeIn: string[]; scopeOut: string[] };
  structure?: { entities: string[]; relations: string[]; plannedFiles: string[] };
  decisions: string[];
  risks: string[];
  relatedTasks: { taskId: string; oneLiner: string; archivePath: string }[];
  stageLog: { at: string; stage: string; message: string }[];
  implementBaseCommit?: string;
  createdAt: string;
  updatedAt: string;
}

export interface HarnessReviewView {
  id: string;
  taskId: string;
  status: 'pending' | 'completed' | 'failed';
  reportText?: string;
  baseCommit?: string;
  headCommit?: string;
  error?: string;
  spawnedAt: string;
  completedAt?: string;
}

export interface HarnessArchiveCardView {
  taskId: string;
  entities: string[];
  filesTouched: string[];
  modules: string[];
  patterns: string[];
  downstream: string[];
  rulesApplied: string[];
  oneLiner: string;
  fullDocPointer: string;
  projectPath: string;
  archivedAt: string;
}

export type HelmApi = typeof helmApi;
