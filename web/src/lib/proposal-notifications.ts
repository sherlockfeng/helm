/**
 * R-9 — LLM-proposal notification cache.
 *
 * The §4.7 flow inserts cases as `status='proposed'` (LLM suggested,
 * not yet human-confirmed). Until the reviewer follow-up this PR
 * implements, the only nudge surfacing those cases to the user was a
 * single sidebar badge.
 *
 * This module:
 *   - on app boot, fetches proposed cases once and emits a toast
 *     ("N proposed cases waiting for review") if any exist
 *   - exposes a per-role count via the cache so role cards can show a
 *     small chip without each role row hammering the API
 *
 * The fetch is debounced via sessionStorage so a renderer reload during
 * a single helm-app session doesn't re-fire the toast every time. Pure
 * UX nicety — clearing sessionStorage just means one extra toast.
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { helmApi } from '../api/client.js';
import type { BenchmarkCase } from '../api/types.js';

const SESSION_TOAST_KEY = 'helm.proposal-toast-shown';

interface CacheShape {
  fetchedAt: number;
  cases: BenchmarkCase[];
}

let cache: CacheShape | null = null;
let inflight: Promise<CacheShape> | null = null;
const subscribers = new Set<() => void>();

function notifySubscribers(): void {
  for (const sub of subscribers) sub();
}

/**
 * Ensure the cache is populated. Multiple callers in the same tick
 * share the same in-flight promise so we don't issue N parallel
 * `/api/verification/cases` requests on first paint.
 */
async function loadProposed(): Promise<CacheShape> {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = helmApi
    .listVerificationCases({ status: 'proposed', limit: 500 })
    .then((r) => {
      const next: CacheShape = { fetchedAt: Date.now(), cases: r.cases };
      cache = next;
      inflight = null;
      notifySubscribers();
      return next;
    })
    .catch((err) => {
      inflight = null;
      throw err;
    });
  return inflight;
}

/** Manual cache invalidation, e.g. after a confirm/reject action. */
export function invalidateProposalCache(): void {
  cache = null;
  notifySubscribers();
}

/** Count of proposed cases targeting `roleId`. 0 when cache is empty. */
export function getProposedCountForRole(roleId: string): number {
  if (!cache) return 0;
  let n = 0;
  for (const c of cache.cases) {
    if (c.targetRoleIds.includes(roleId)) n += 1;
  }
  return n;
}

/** Total proposed cases across all roles. */
export function getTotalProposedCount(): number {
  return cache?.cases.length ?? 0;
}

/**
 * React hook: ensures the cache loads on mount and re-renders when it
 * updates. Components consume `getProposedCountForRole(roleId)` from
 * inside their render after this hook resolves.
 */
export function useProposedCases(): { total: number; loaded: boolean } {
  const [, setTick] = useState(0);

  useEffect(() => {
    const onChange = (): void => setTick((t) => t + 1);
    subscribers.add(onChange);
    void loadProposed().catch(() => {
      // Notification path: failure here is non-fatal. Counts stay 0,
      // chip stays hidden, toast skipped.
    });
    return () => { subscribers.delete(onChange); };
  }, []);

  return { total: getTotalProposedCount(), loaded: cache !== null };
}

/**
 * Top-level boot effect: fires a single toast per renderer-session if
 * proposed cases exist. Mount once near the App root.
 */
export function useProposalBootToast(): void {
  useEffect(() => {
    void (async () => {
      try {
        const { cases } = await loadProposed();
        if (cases.length === 0) return;
        if (sessionStorage.getItem(SESSION_TOAST_KEY)) return;
        sessionStorage.setItem(SESSION_TOAST_KEY, '1');
        toast.message(
          `${cases.length} proposed verification case${cases.length === 1 ? '' : 's'} waiting for review.`,
          {
            description: 'Open Verification › Cases (status: Proposed) to confirm or reject.',
            duration: 8000,
          },
        );
      } catch {
        // No-op — surfacing a fetch failure here would be noisier than
        // the missing toast it's covering for.
      }
    })();
  }, []);
}
