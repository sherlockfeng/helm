/**
 * Approvals — pending list with allow/deny actions.
 *
 * Live updates: SSE pushes refresh the list so the user sees a new request
 * appear without polling. Each card shows the tool, command, host_session
 * id, and time-to-expire so the user can prioritize.
 *
 * Design note: Allow uses .primary (filled blue), Deny uses .danger-outline
 * (red text + border, no fill) so the eye lands on the safe path the user
 * takes ~95% of the time. See docs/design/2026-05-06-polish-pass.md P0-5.
 *
 * A11y note (a11y-audit A7): we deliberately do NOT confirm Allow/Deny
 * clicks. A confirm dialog kills the speed of the flow; users with assistive
 * tech should be aware that space/enter on these buttons is irreversible.
 */

import { useState } from 'react';
import { ApiError, helmApi } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';
import { useEventStream } from '../hooks/useEventStream.js';
import { EmptyState } from '../components/EmptyState.js';
import type { PendingApproval } from '../api/types.js';

function timeUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const days = Math.floor(hr / 24);
  return `${days}d ${hr % 24}h`;
}

function shortId(id: string, len = 12): string {
  return id.length > len ? `${id.slice(0, len)}…` : id;
}

export function ApprovalsPage() {
  const { data, loading, error, reload } = useApi(() => helmApi.approvals());
  const [acting, setActing] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEventStream(() => reload(), {
    types: ['approval.pending', 'approval.settled'],
  });

  const decide = async (id: string, decision: 'allow' | 'deny'): Promise<void> => {
    setActing(id);
    setActionError(null);
    try {
      await helmApi.decideApproval(id, decision);
      reload();
    } catch (err) {
      const msg = err instanceof ApiError ? `${err.status}: ${err.message}` : (err as Error).message;
      setActionError(msg);
    } finally {
      setActing(null);
    }
  };

  return (
    <>
      <h2>Approvals</h2>
      <p className="muted">
        Cursor pauses on Shell / Edit / MCP tool calls until you decide. Allow once, or
        train a policy by adding a rule.
      </p>

      {loading && <p className="muted">Loading…</p>}
      {error && <p className="muted" style={{ color: 'var(--danger)' }}>Failed to load: {error.message}</p>}
      {actionError && <p className="muted" style={{ color: 'var(--danger)' }}>{actionError}</p>}

      {data && data.approvals.length === 0 && (
        <EmptyState
          title="No pending approvals."
          hint="When Cursor needs your decision on a Shell / Edit / MCP call, it will show up here."
        />
      )}

      {data && data.approvals.map((req) => (
        <ApprovalCard
          key={req.id}
          approval={req}
          acting={acting === req.id}
          onAllow={() => decide(req.id, 'allow')}
          onDeny={() => decide(req.id, 'deny')}
        />
      ))}
    </>
  );
}

function ApprovalCard({
  approval,
  acting,
  onAllow,
  onDeny,
}: {
  approval: PendingApproval;
  acting: boolean;
  onAllow: () => void;
  onDeny: () => void;
}) {
  return (
    <article className="helm-card">
      <div className="row">
        <div>
          <div className="label">{approval.tool}</div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>
            {approval.command || '(no command)'}
          </div>
          {approval.hostSessionId && (
            <div className="label" style={{ marginTop: 6 }}>
              session <code title={approval.hostSessionId}>{shortId(approval.hostSessionId)}</code>
            </div>
          )}
        </div>
        <span className="helm-status warn">
          <span className="dot" />
          {timeUntil(approval.expiresAt)} until timeout
        </span>
      </div>

      {approval.payload && Object.keys(approval.payload).length > 0 && (
        <pre>{JSON.stringify(approval.payload, null, 2)}</pre>
      )}

      <div className="actions">
        <button
          className="primary"
          disabled={acting}
          aria-busy={acting}
          onClick={onAllow}
        >
          Allow
        </button>
        <button
          className="danger-outline"
          disabled={acting}
          aria-busy={acting}
          onClick={onDeny}
        >
          Deny
        </button>
      </div>
    </article>
  );
}
