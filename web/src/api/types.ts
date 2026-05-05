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
