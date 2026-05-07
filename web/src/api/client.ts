/**
 * Helm REST client. Vite proxies /api → http://127.0.0.1:17317 in dev; in
 * the packaged Electron app the renderer hits the same origin.
 */

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

  const res = await fetch(path, init);
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

  approvals: () => request<{ approvals: PendingApproval[] }>('GET', '/api/approvals'),

  decideApproval: (approvalId: string, decision: 'allow' | 'deny', reason?: string) =>
    request<{ ok: true; approvalId: string }>(
      'POST',
      `/api/approvals/${encodeURIComponent(approvalId)}/decide`,
      { decision, ...(reason ? { reason } : {}) },
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
};

export type HelmApi = typeof helmApi;
