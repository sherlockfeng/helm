/**
 * Active Chats — every host_session that's still open.
 *
 * v1: read-only list. Phase 12+ adds the chat detail panel where the user
 * can pick a role, inject a requirement, or bind to a Lark thread.
 */

import { helmApi } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';
import { useEventStream } from '../hooks/useEventStream.js';

function formatRelative(iso: string): string {
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export function ChatsPage() {
  const { data, loading, error, reload } = useApi(() => helmApi.activeChats());
  useEventStream(() => reload(), { types: ['session.started', 'session.closed'] });

  return (
    <>
      <h2>Active Chats</h2>
      <p className="muted">Cursor sessions Helm is currently observing.</p>

      {loading && <p className="muted">Loading…</p>}
      {error && <p className="muted" style={{ color: 'var(--danger)' }}>Failed to load: {error.message}</p>}

      {data && data.chats.length === 0 && (
        <div className="helm-empty">No active Cursor chats. Start one and Helm will pick it up automatically.</div>
      )}

      {data && data.chats.map((chat) => (
        <article key={chat.id} className="helm-card">
          <div className="row">
            <div>
              <div className="label">{chat.host}</div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{chat.cwd ?? '(unknown cwd)'}</div>
              <div className="label" style={{ marginTop: 6 }}>session {chat.id}</div>
            </div>
            <span className="helm-status ok">
              <span className="dot" />
              last seen {formatRelative(chat.lastSeenAt)}
            </span>
          </div>
        </article>
      ))}
    </>
  );
}
