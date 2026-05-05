/**
 * In-process typed event bus.
 *
 * The orchestrator emits a small, fixed set of high-level events here; the
 * HTTP API's /api/events SSE endpoint subscribes and forwards them to the
 * renderer. Future channels (LarkChannel) and engines plug in without the
 * SSE layer needing to know about them.
 *
 * Listener errors are isolated per-handler so a buggy subscriber can't take
 * the rest down or crash the publisher.
 */

import type { ApprovalRequest, ChannelBinding, HostSession } from '../storage/types.js';
import type { ApprovalDecision } from '../channel/types.js';

export type AppEvent =
  | { type: 'approval.pending'; request: ApprovalRequest }
  | { type: 'approval.settled'; approvalId: string; decision: 'allow' | 'deny' | 'ask'; decidedBy: string; reason?: string }
  | { type: 'approval.decision_received'; decision: ApprovalDecision }
  | { type: 'session.started'; session: HostSession }
  | { type: 'session.closed'; hostSessionId: string }
  | { type: 'binding.created'; binding: ChannelBinding }
  | { type: 'binding.removed'; bindingId: string }
  | { type: 'channel.message_enqueued'; bindingId: string; messageId: number };

export type AppEventType = AppEvent['type'];
export type AppEventOf<T extends AppEventType> = Extract<AppEvent, { type: T }>;

export type Unsubscribe = () => void;

type AnyHandler = (event: AppEvent) => void | Promise<void>;

export interface EventBus {
  emit(event: AppEvent): void;
  on(handler: AnyHandler): Unsubscribe;
  /** Listener count, exported for tests / metrics. */
  listenerCount(): number;
  /** Drop every handler. Used at shutdown. */
  clear(): void;
}

export interface EventBusOptions {
  /** Surfaced when a listener throws; defaults to a no-op so observability doesn't crash the bus. */
  onListenerError?: (err: Error, eventType: AppEventType) => void;
}

export function createEventBus(options: EventBusOptions = {}): EventBus {
  const handlers = new Set<AnyHandler>();
  const onListenerError = options.onListenerError ?? (() => {});

  return {
    emit(event: AppEvent): void {
      // Snapshot before iteration so a handler that subscribes (or unsubscribes
      // itself) during dispatch doesn't see the event it just registered for,
      // mirroring the LocalChannel listener semantics.
      const snapshot = [...handlers];
      for (const h of snapshot) {
        try {
          const result = h(event);
          if (result && typeof (result as Promise<void>).catch === 'function') {
            (result as Promise<void>).catch((err) => onListenerError(err as Error, event.type));
          }
        } catch (err) {
          onListenerError(err as Error, event.type);
        }
      }
    },
    on(handler: AnyHandler): Unsubscribe {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    listenerCount(): number {
      return handlers.size;
    },
    clear(): void {
      handlers.clear();
    },
  };
}
