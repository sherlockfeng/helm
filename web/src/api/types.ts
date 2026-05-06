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
  status: 'active' | 'closed';
  firstSeenAt: string;
  lastSeenAt: string;
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
  createdAt: string;
}

export interface PendingBind {
  code: string;
  channel: string;
  externalChat?: string;
  externalThread?: string;
  externalRoot?: string;
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

export interface HelmConfig {
  server: { port: number };
  approval: { defaultTimeoutMs: number; waitPollMs: number };
  lark: { enabled: boolean; cliCommand?: string; env?: Record<string, string> };
  knowledge: { providers: KnowledgeProviderConfig[] };
  docFirst: { enforce: boolean };
  anthropic: { apiKey?: string; model: string; maxTokens: number };
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

// SSE event shapes — must mirror src/events/bus.ts AppEvent.
export type AppEvent =
  | { type: 'approval.pending'; request: PendingApproval }
  | { type: 'approval.settled'; approvalId: string; decision: 'allow' | 'deny' | 'ask'; decidedBy: string; reason?: string }
  | { type: 'approval.decision_received'; decision: { channel: string; approvalId: string; decision: 'allow' | 'deny'; reason?: string } }
  | { type: 'session.started'; session: ActiveChat }
  | { type: 'session.closed'; hostSessionId: string }
  | { type: 'binding.created'; binding: { id: string; channel: string } }
  | { type: 'binding.removed'; bindingId: string }
  | { type: 'channel.message_enqueued'; bindingId: string; messageId: number };

export type AppEventType = AppEvent['type'];
