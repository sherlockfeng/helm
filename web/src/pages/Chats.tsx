/**
 * Active Chats — every host_session that's still open.
 *
 * Phase 25: each chat row had a single-role picker dropdown.
 * Phase 36: Close + Delete buttons (soft / cascade).
 * Phase 42: dropdown → multi-select chips. Each bound role shows as a chip
 * with an inline ✕ to remove. An "+ Add role" picker beneath lets the user
 * stack more (e.g. Goofy + 容灾大盘 + Developer). The next session_start
 * concatenates every role's prompt + chunks into the injected context.
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

  async function addRole(hostSessionId: string, roleId: string): Promise<void> {
    setSavingId(hostSessionId);
    setRowError(null);
    try {
      await helmApi.addChatRole(hostSessionId, roleId);
      reload();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setRowError({ id: hostSessionId, message: msg });
    } finally {
      setSavingId(null);
    }
  }

  async function removeRole(hostSessionId: string, roleId: string): Promise<void> {
    setSavingId(hostSessionId);
    setRowError(null);
    try {
      await helmApi.removeChatRole(hostSessionId, roleId);
      reload();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setRowError({ id: hostSessionId, message: msg });
    } finally {
      setSavingId(null);
    }
  }

  async function closeChat(hostSessionId: string, cascade: boolean): Promise<void> {
    const verb = cascade ? 'permanently delete this chat' : 'close this chat';
    const detail = cascade
      ? 'The session row, its bindings, and any queued Lark messages will be removed.'
      : "It'll disappear from this list but the row + bindings stay for history.";
    if (!window.confirm(`${verb}?\n\n${detail}`)) return;
    setSavingId(hostSessionId);
    setRowError(null);
    try {
      await helmApi.closeChat(hostSessionId, { cascade });
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

          {/* Phase 42: every bound role renders as a chip with inline ✕.
              "+ Add role" dropdown lists only roles NOT yet attached. */}
          <div style={{ marginTop: 12 }}>
            <div className="muted" style={{ marginBottom: 6 }}>Roles</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              {chat.roleIds.length === 0 && (
                <span className="muted" style={{ fontSize: 12 }}>(none — no auto-inject)</span>
              )}
              {chat.roleIds.map((rid) => {
                const role = roles.find((r) => r.id === rid);
                const display = role
                  ? `${role.name}${role.isBuiltin ? ' (built-in)' : ''}`
                  : `${rid} (unknown)`;
                return (
                  <span
                    key={rid}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      padding: '2px 8px', borderRadius: 12,
                      background: 'var(--surface-2, #eef)',
                      fontSize: 12, fontWeight: 500,
                    }}
                  >
                    {display}
                    <button
                      type="button"
                      aria-label={`Remove role ${role?.name ?? rid} from chat ${chat.id}`}
                      disabled={savingId === chat.id}
                      onClick={() => { void removeRole(chat.id, rid); }}
                      style={{
                        all: 'unset', cursor: 'pointer', fontSize: 14,
                        opacity: savingId === chat.id ? 0.4 : 0.7, lineHeight: 1,
                      }}
                    >
                      ✕
                    </button>
                  </span>
                );
              })}
              {(() => {
                const addable = roles.filter((r) => !chat.roleIds.includes(r.id));
                if (addable.length === 0) return null;
                return (
                  <select
                    aria-label={`Add role to chat ${chat.id}`}
                    value=""
                    disabled={savingId === chat.id}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v) void addRole(chat.id, v);
                    }}
                    style={{ fontSize: 12, padding: '2px 4px' }}
                  >
                    <option value="">+ Add role…</option>
                    {addable.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}{r.isBuiltin ? ' (built-in)' : ''}
                      </option>
                    ))}
                  </select>
                );
              })()}
              {savingId === chat.id && <span className="muted" style={{ fontSize: 11 }}>saving…</span>}
            </div>
          </div>
          {rowError && rowError.id === chat.id && (
            <p className="muted" style={{ color: 'var(--danger)', fontSize: 12, marginTop: 6 }}>
              {rowError.message}
            </p>
          )}

          {/* Phase 36: chat lifecycle controls. Close is soft (history kept);
              Delete cascades to channel_bindings + queued messages. Both
              prompt for confirmation via window.confirm. */}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button
              type="button"
              disabled={savingId === chat.id}
              onClick={() => { void closeChat(chat.id, false); }}
              aria-label={`Close chat ${chat.id}`}
            >
              Close
            </button>
            <button
              type="button"
              className="danger-outline"
              disabled={savingId === chat.id}
              onClick={() => { void closeChat(chat.id, true); }}
              aria-label={`Delete chat ${chat.id} and all bindings`}
            >
              Delete
            </button>
          </div>
        </article>
      ))}
    </>
  );
}
