/**
 * Helm REST client. Vite proxies /api → http://127.0.0.1:17317 in dev; in
 * the packaged Electron app the renderer hits the same origin.
 */

import type {
  ActiveChat,
  BugTaskInput,
  Campaign,
  ChannelBinding,
  Cycle,
  CycleScreenshotInput,
  DocAuditEntry,
  HelmConfig,
  PendingApproval,
  PendingBind,
  Task,
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

  // ── Settings ──
  getConfig: () => request<HelmConfig>('GET', '/api/config'),
  saveConfig: (config: HelmConfig) => request<HelmConfig>('PUT', '/api/config', config),

  // ── Bindings ──
  bindings: () => request<{ bindings: ChannelBinding[] }>('GET', '/api/bindings'),
  pendingBinds: () => request<{ pending: PendingBind[] }>('GET', '/api/bindings/pending'),
  consumePendingBind: (code: string, hostSessionId: string) =>
    request<{ binding: { id: string } }>('POST', '/api/bindings/consume', { code, hostSessionId }),
  unbind: (bindingId: string) =>
    request<{ ok: true }>('DELETE', `/api/bindings/${encodeURIComponent(bindingId)}`),

  // ── Diagnostics ──
  exportDiagnostics: () =>
    request<{ bundleDir: string; manifest: { generatedAt: string; warnings: string[] } }>(
      'POST', '/api/diagnostics',
    ),
};

export type HelmApi = typeof helmApi;
