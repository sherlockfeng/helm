/**
 * Approval registry.
 *
 * Owns the lifecycle of *pending* approval requests: created when a host_approval_request
 * comes in without a matching policy, settled when a channel (LocalChannel UI / LarkChannel
 * decision message / explicit timeout) tells us the user decided.
 *
 * Storage is mirrored: every state change is reflected in the `approval_requests`
 * SQLite table so the app survives a restart with pending visible (per §9.2 note
 * "持久化的好处：app 崩溃重启后能看到当时的 pending"). The in-memory map holds
 * the Promise resolvers and timers; the DB is the source of truth for status.
 *
 * Concurrency rules:
 *   - settle(id, ...) is idempotent — first settle wins, subsequent calls return false
 *   - the timeout timer fires settle({ permission: 'timeout', decidedBy: 'timeout' })
 *   - shutdown() settles every pending as 'timeout' so awaiters are released
 *
 * Channels (LocalChannel + Phase 2's LarkChannel) subscribe via
 * onPendingCreated() to be notified when a new approval needs user attention.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  getApprovalRequest,
  insertApprovalRequest,
  listPendingRequests,
  settleApprovalRequest,
} from '../storage/repos/approval.js';
import type { ApprovalRequest } from '../storage/types.js';
import type { PendingApprovalInput, SettleInput, SettledApproval } from './types.js';

interface PendingEntry {
  request: ApprovalRequest;
  resolve: (value: SettledApproval) => void;
  timer: NodeJS.Timeout;
}

export interface ApprovalRegistryOptions {
  /** Default timeout in ms; used when input doesn't supply expiresAt. */
  defaultTimeoutMs: number;
  /** Optional logger for unexpected paths (settle for unknown id, etc.). */
  onWarning?: (msg: string, ctx: Record<string, unknown>) => void;
}

export class ApprovalRegistry {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly listeners = new Set<(req: ApprovalRequest) => void>();
  private isShutdown = false;

  constructor(
    private readonly db: Database.Database,
    private readonly options: ApprovalRegistryOptions,
  ) {}

  /**
   * Create a pending approval. Persists `pending` row to SQLite, registers a timer,
   * fires onPendingCreated listeners, and returns a Promise that resolves when the
   * approval is settled. Caller (bridge handler) awaits this promise.
   */
  create(input: PendingApprovalInput): { request: ApprovalRequest; settled: Promise<SettledApproval> } {
    if (this.isShutdown) {
      throw new Error('ApprovalRegistry has been shut down');
    }

    const now = new Date();
    const expiresAtIso = input.expiresAt
      ?? new Date(now.getTime() + this.options.defaultTimeoutMs).toISOString();

    const request: ApprovalRequest = {
      id: `apr_${randomUUID()}`,
      hostSessionId: input.hostSessionId,
      bindingId: input.bindingId,
      tool: input.tool,
      command: input.command,
      payload: input.payload,
      status: 'pending',
      createdAt: now.toISOString(),
      expiresAt: expiresAtIso,
    };
    insertApprovalRequest(this.db, request);

    const settled = new Promise<SettledApproval>((resolve) => {
      const ms = Math.max(0, new Date(expiresAtIso).getTime() - now.getTime());
      const timer = setTimeout(() => this.timeoutPending(request.id), ms);
      // Don't keep the event loop alive solely for an idle approval.
      timer.unref?.();
      this.pending.set(request.id, { request, resolve, timer });
    });

    for (const listener of this.listeners) {
      try { listener(request); }
      catch (err) {
        this.options.onWarning?.('listener threw', { error: (err as Error).message, requestId: request.id });
      }
    }

    return { request, settled };
  }

  /**
   * Settle a pending approval. Returns true if this call actually settled the
   * request; false if it was unknown or already settled.
   */
  settle(id: string, outcome: SettleInput): boolean {
    const entry = this.pending.get(id);
    if (!entry) {
      this.options.onWarning?.('settle for unknown or already-settled id', { id });
      return false;
    }
    this.pending.delete(id);
    clearTimeout(entry.timer);

    const dbStatus: ApprovalRequest['status']
      = outcome.permission === 'timeout' ? 'timeout'
      : outcome.permission === 'allow' ? 'allowed'
      : 'denied';

    settleApprovalRequest(this.db, id, {
      status: dbStatus,
      decidedBy: outcome.decidedBy,
      reason: outcome.reason,
    });

    const userPermission: 'allow' | 'deny' | 'ask'
      = outcome.permission === 'allow' ? 'allow'
      : outcome.permission === 'deny' ? 'deny'
      : 'ask';

    entry.resolve({
      id,
      permission: userPermission,
      reason: outcome.reason,
      decidedBy: outcome.decidedBy,
    });
    return true;
  }

  /** List pending requests from the in-memory mirror (fast path for UI / channels). */
  listPending(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  /**
   * Reload pending state from the DB. Useful at startup so that approvals which
   * outlived a previous app restart re-appear (their expiry timer is re-armed).
   */
  reloadFromDatabase(): number {
    if (this.isShutdown) throw new Error('cannot reload after shutdown');
    const dbPending = listPendingRequests(this.db);
    let restored = 0;
    for (const row of dbPending) {
      if (this.pending.has(row.id)) continue;
      const expiresMs = Math.max(0, new Date(row.expiresAt).getTime() - Date.now());
      const settled = new Promise<SettledApproval>((resolve) => {
        const timer = setTimeout(() => this.timeoutPending(row.id), expiresMs);
        timer.unref?.();
        this.pending.set(row.id, { request: row, resolve, timer });
      });
      // The Promise itself isn't reachable to a caller after restart — these are
      // "orphan" pendings whose original awaiter is gone. They still must be
      // settled so the DB reflects the user's eventual decision and the timer
      // doesn't leak. Drop the awaiter handle.
      void settled;
      restored += 1;
    }
    return restored;
  }

  /**
   * Subscribe to "new pending created" events. Returns an unsubscribe fn.
   * Channels register here so they can push the approval to the user.
   */
  onPendingCreated(handler: (request: ApprovalRequest) => void): () => void {
    this.listeners.add(handler);
    return () => { this.listeners.delete(handler); };
  }

  /**
   * Snapshot a single request's current state from the DB (which may differ
   * from the in-memory mirror after timeout / settle).
   */
  get(id: string): ApprovalRequest | undefined {
    return getApprovalRequest(this.db, id);
  }

  /**
   * Stop accepting new requests, settle all in-flight pending as timeout so
   * awaiters are released, and clear listeners.
   */
  shutdown(reason: string = 'registry shutdown'): void {
    this.isShutdown = true;
    const ids = [...this.pending.keys()];
    for (const id of ids) {
      this.settle(id, { permission: 'timeout', decidedBy: 'timeout', reason });
    }
    this.listeners.clear();
  }

  private timeoutPending(id: string): void {
    if (!this.pending.has(id)) return;
    this.settle(id, { permission: 'timeout', decidedBy: 'timeout', reason: 'approval timed out' });
  }
}
