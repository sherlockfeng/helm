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
  Cycle,
  CycleScreenshotInput,
  DocAuditEntry,
  HelmConfig,
  PendingApproval,
  PendingBind,
  Requirement,
  Role,
  RoleChunk,
  RoleSummary,
  Task,
  TrainRoleInput,
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

  activeChats: () => request<{ chats: ActiveChat[] }>('GET', '/api/active-chats'),

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
    request<{ role: Role; chunks: RoleChunk[] }>(
      'GET', `/api/roles/${encodeURIComponent(roleId)}`,
    ),
  trainRole: (roleId: string, input: TrainRoleInput) =>
    request<{ role: Role }>(
      'POST', `/api/roles/${encodeURIComponent(roleId)}/train`, input,
    ),

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
