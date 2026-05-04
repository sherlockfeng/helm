/**
 * Approvals — pending list with allow/deny actions.
 *
 * Live updates: SSE pushes refresh the list so the user sees a new request
 * appear without polling. Each card shows the tool, command, host_session
 * id, and time-to-expire so the user can prioritize.
 */

import { useState } from 'react';
import { ApiError, helmApi } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';
import { useEventStream } from '../hooks/useEventStream.js';
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
        <div className="helm-empty">No pending approvals.</div>
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
              session {approval.hostSessionId}
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
        <button className="primary" disabled={acting} onClick={onAllow}>
          Allow
        </button>
        <button className="danger" disabled={acting} onClick={onDeny}>
          Deny
        </button>
      </div>
    </article>
  );
}
