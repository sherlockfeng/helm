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
 *
 * Phase 46d: per-card "Remember as policy rule" toggle. When checked, the
 * decision posts `remember: true` and (optionally) `scope`; the backend
 * derives a sensible default scope from the pending request (toolScope for
 * mcp__ tools, commandPrefix=firstToken for shell commands) so most flows
 * need no further input from the user. Mirrors Lark's `/allow! <scope>`.
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

  const decide = async (
    id: string,
    decision: 'allow' | 'deny',
    options: { remember?: boolean; scope?: string } = {},
  ): Promise<void> => {
    setActing(id);
    setActionError(null);
    try {
      await helmApi.decideApproval(id, decision, options);
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
          onAllow={(opts) => decide(req.id, 'allow', opts)}
          onDeny={() => decide(req.id, 'deny')}
        />
      ))}
    </>
  );
}

/**
 * Phase 46d: client-side preview of the rule the backend will create when
 * `remember` is checked. Pure cosmetic — the backend derives the rule
 * authoritatively. We just want users to see roughly what they're committing
 * to before they click Allow.
 */
function suggestScope(approval: PendingApproval): string {
  if (approval.tool.startsWith('mcp__')) return `${approval.tool} (entire tool)`;
  const cmd = (approval.command ?? '').trim();
  if (!cmd) return `${approval.tool} (entire tool)`;
  const first = cmd.split(/\s+/, 1)[0] ?? '';
  return first ? `${approval.tool} commands starting with "${first}"` : `${approval.tool} (entire tool)`;
}

function ApprovalCard({
  approval,
  acting,
  onAllow,
  onDeny,
}: {
  approval: PendingApproval;
  acting: boolean;
  onAllow: (options: { remember?: boolean; scope?: string }) => void;
  onDeny: () => void;
}) {
  const [remember, setRemember] = useState(false);
  const [scope, setScope] = useState('');
  const checkboxId = `remember-${approval.id}`;
  const scopeId = `scope-${approval.id}`;
  const effectiveScope = scope.trim() || suggestScope(approval);

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

      <div className="approval-remember">
        <label htmlFor={checkboxId} className="approval-remember-toggle">
          <input
            id={checkboxId}
            type="checkbox"
            checked={remember}
            disabled={acting}
            onChange={(e) => setRemember(e.target.checked)}
          />
          <span>Remember as a policy rule</span>
        </label>
        {remember && (
          <div className="approval-remember-detail">
            <input
              id={scopeId}
              type="text"
              className="approval-scope-input"
              placeholder={suggestScope(approval)}
              value={scope}
              disabled={acting}
              onChange={(e) => setScope(e.target.value)}
              aria-label="Policy scope"
            />
            <p className="muted" style={{ margin: '4px 0 0', fontSize: 12 }}>
              On Allow: <code>{effectiveScope}</code> will auto-approve future requests.
              Manage rules in Settings.
            </p>
          </div>
        )}
      </div>

      <div className="actions">
        <button
          className="primary"
          disabled={acting}
          aria-busy={acting}
          onClick={() => onAllow(remember ? { remember: true, ...(scope.trim() ? { scope: scope.trim() } : {}) } : {})}
        >
          {remember ? 'Allow & remember' : 'Allow'}
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
