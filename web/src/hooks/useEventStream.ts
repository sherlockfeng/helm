/**
 * Subscribes to /api/events Server-Sent Events. Filters on event type and
 * dispatches typed AppEvent payloads to the caller.
 *
 * Reconnects on error with linear backoff (max 5s) — Mac sleeping the laptop
 * or the backend restarting shouldn't require a full app reload.
 */

import { useEffect, useRef } from 'react';
import type { AppEvent, AppEventType } from '../api/types.js';
import { apiUrl } from '../api/base-url.js';

export interface UseEventStreamOptions {
  /** Filter to a subset of event types; default = all. */
  types?: AppEventType[];
  /** Path to the SSE endpoint; defaults to '/api/events'. */
  path?: string;
}

export function useEventStream(
  onEvent: (event: AppEvent) => void,
  options: UseEventStreamOptions = {},
): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const path = options.path ?? '/api/events';
  const wantedTypes = options.types ? new Set<string>(options.types) : null;

  useEffect(() => {
    let backoffMs = 250;
    let cancelled = false;
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = (): void => {
      if (cancelled) return;
      // Phase 50: under file:// the bare path resolves against the wrong
      // origin; apiUrl() prepends http://127.0.0.1:<port> in that case.
      source = new EventSource(apiUrl(path));

      source.onopen = () => { backoffMs = 250; };

      source.onmessage = (msg: MessageEvent<string>) => {
        // Default unnamed events; not used by helm but harmless to handle.
        dispatch(msg.data);
      };

      // Each AppEvent.type maps to a named event line via `event: <type>` on
      // the server side. EventSource fires `addEventListener` per name.
      const wireType = (type: string): void => {
        if (!source) return;
        source.addEventListener(type, (msg) => dispatch((msg as MessageEvent<string>).data));
      };
      const knownTypes: AppEventType[] = [
        'approval.pending',
        'approval.settled',
        'approval.decision_received',
        'session.started',
        'session.closed',
        'binding.created',
        'binding.removed',
        'channel.message_enqueued',
      ];
      for (const t of knownTypes) wireType(t);

      source.onerror = () => {
        if (cancelled) return;
        source?.close();
        source = null;
        retryTimer = setTimeout(connect, backoffMs);
        backoffMs = Math.min(backoffMs * 2, 5000);
      };
    };

    function dispatch(raw: string): void {
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw) as AppEvent;
        if (wantedTypes && !wantedTypes.has(parsed.type)) return;
        onEventRef.current(parsed);
      } catch {
        // Drop malformed event; SSE should never send invalid JSON, so this is
        // a defense-in-depth path.
      }
    }

    connect();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
}
