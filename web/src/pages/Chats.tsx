/**
 * Active Chats — every host_session that's still open.
 *
 * Phase 25: each chat row has a role picker. Selecting a role binds the chat
 * to that role; the next session_start hook auto-injects the role's system
 * prompt + chunks via LocalRolesProvider.
 */

import { useState } from 'react';
import { ApiError, helmApi } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';
import { useEventStream } from '../hooks/useEventStream.js';
import { EmptyState } from '../components/EmptyState.js';

function formatRelative(iso: string): string {
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function shortId(id: string, len = 12): string {
  return id.length > len ? `${id.slice(0, len)}…` : id;
}

function truncate(s: string, max = 80): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

export function ChatsPage() {
  const { data, loading, error, reload } = useApi(() => helmApi.activeChats());
  const { data: rolesData } = useApi(() => helmApi.roles());
  useEventStream(() => reload(), { types: ['session.started', 'session.closed'] });
  const [savingId, setSavingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  async function changeRole(hostSessionId: string, roleId: string | null): Promise<void> {
    setSavingId(hostSessionId);
    setRowError(null);
    try {
      await helmApi.setChatRole(hostSessionId, roleId);
      reload();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setRowError({ id: hostSessionId, message: msg });
    } finally {
      setSavingId(null);
    }
  }

  const roles = rolesData?.roles ?? [];

  return (
    <>
      <h2>Active Chats</h2>
      <p className="muted">
        Cursor sessions Helm is currently observing. Bind a role to a chat and
        Helm injects that role's system prompt + knowledge on the next
        session_start.
      </p>

      {loading && <p className="muted">Loading…</p>}
      {error && <p className="muted" style={{ color: 'var(--danger)' }}>Failed to load: {error.message}</p>}

      {data && data.chats.length === 0 && (
        <EmptyState
          title="No active Cursor chats."
          hint="Start one and Helm will pick it up automatically."
        />
      )}

      {data && data.chats.map((chat) => (
        <article key={chat.id} className="helm-card">
          <div className="row">
            <div>
              <div className="label">{chat.host}</div>
              {/* Phase 32: first user prompt is the most human-readable label —
                  Cursor's chat title isn't surfaced to hooks. Falls back to
                  cwd → session id so brand-new chats (no prompt yet) still
                  show something useful. */}
              <div style={{ fontWeight: 600, fontSize: 14 }} title={chat.firstPrompt ?? chat.cwd ?? chat.id}>
                {chat.firstPrompt
                  ? truncate(chat.firstPrompt)
                  : (chat.cwd ?? '(awaiting first message)')}
              </div>
              <div className="label" style={{ marginTop: 6 }}>
                {chat.firstPrompt && chat.cwd ? <>{chat.cwd} • </> : null}
                session <code title={chat.id}>{shortId(chat.id)}</code>
              </div>
            </div>
            <span className="helm-status ok">
              <span className="dot" />
              last seen {formatRelative(chat.lastSeenAt)}
            </span>
          </div>

          <div className="helm-form-row" style={{ marginTop: 12 }}>
            <div className="muted">Role</div>
            <select
              aria-label={`Role for chat ${chat.id}`}
              value={chat.roleId ?? ''}
              disabled={savingId === chat.id || roles.length === 0}
              onChange={(e) => {
                const next = e.target.value || null;
                void changeRole(chat.id, next);
              }}
              style={{ minWidth: 220 }}
            >
              <option value="">(none — no auto-inject)</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}{r.isBuiltin ? ' (built-in)' : ''}
                </option>
              ))}
            </select>
            {savingId === chat.id && <span className="muted" style={{ fontSize: 11 }}>saving…</span>}
          </div>
          {rowError && rowError.id === chat.id && (
            <p className="muted" style={{ color: 'var(--danger)', fontSize: 12, marginTop: 6 }}>
              {rowError.message}
            </p>
          )}
        </article>
      ))}
    </>
  );
}
