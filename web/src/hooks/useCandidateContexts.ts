/**
 * PR-β (knowledge tiers): batch-load the prefetched org-side context
 * for a page of candidates + per-candidate manual refresh. Shared by
 * the Review inbox, Roles candidates tab and conversation detail.
 */

import { useEffect, useState } from 'react';
import { helmApi } from '../api/client.js';
import type { CandidateExternalContext } from '../api/types.js';

export function useCandidateContexts(candidateIds: readonly string[]): {
  contexts: Record<string, CandidateExternalContext>;
  refreshing: ReadonlySet<string>;
  refresh: (candidateId: string) => Promise<void>;
} {
  const [contexts, setContexts] = useState<Record<string, CandidateExternalContext>>({});
  const [refreshing, setRefreshing] = useState<Set<string>>(new Set());
  const key = candidateIds.join(',');

  useEffect(() => {
    if (candidateIds.length === 0) { setContexts({}); return undefined; }
    let alive = true;
    void helmApi.getCandidateContexts([...candidateIds])
      .then((r) => { if (alive) setContexts(r.contexts); })
      .catch(() => { /* context is an enhancement — never break the page */ });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const refresh = async (candidateId: string): Promise<void> => {
    setRefreshing((prev) => new Set(prev).add(candidateId));
    try {
      const r = await helmApi.refreshCandidateContext(candidateId);
      if (r.context) {
        const ctx = r.context;
        setContexts((prev) => ({ ...prev, [candidateId]: ctx }));
      }
    } catch { /* leave the previous state; the button stays available */ }
    finally {
      setRefreshing((prev) => {
        const next = new Set(prev);
        next.delete(candidateId);
        return next;
      });
    }
  };

  return { contexts, refreshing, refresh };
}
