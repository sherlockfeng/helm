/**
 * App shell — sidebar + active route's main pane.
 *
 * Sidebar nav badges (e.g. pending approvals count) are derived from the
 * SSE event stream so they stay live without polling.
 */

import { NavLink, Outlet } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { helmApi } from '../api/client.js';
import { useEventStream } from '../hooks/useEventStream.js';

interface NavItem {
  to: string;
  label: string;
}

const NAV: NavItem[] = [
  { to: '/approvals', label: 'Approvals' },
  { to: '/chats', label: 'Active Chats' },
  { to: '/bindings', label: 'Bindings' },
  { to: '/campaigns', label: 'Campaigns' },
  { to: '/roles', label: 'Roles' },
  { to: '/requirements', label: 'Requirements' },
  { to: '/harness', label: 'Harness' }, // Phase 67
  { to: '/settings', label: 'Settings' },
];

export function Layout() {
  const [pendingCount, setPendingCount] = useState<number>(0);
  const [healthy, setHealthy] = useState<boolean>(true);

  // Initial fetch + reconcile on every approval event.
  const refreshCount = async (): Promise<void> => {
    try {
      const r = await helmApi.approvals();
      setPendingCount(r.approvals.length);
      setHealthy(true);
    } catch { setHealthy(false); }
  };

  useEffect(() => {
    void refreshCount();
    const id = setInterval(refreshCount, 30_000);
    return () => clearInterval(id);
  }, []);

  // Phase 46: also refresh on `approval.decision_received`. Some decision
  // paths fire that event without a follow-up `approval.settled` (race
  // with another channel beating it to settle), which used to leave the
  // sidebar badge stuck. The 30s interval is the ultimate backstop.
  useEventStream(() => { void refreshCount(); }, {
    types: ['approval.pending', 'approval.settled', 'approval.decision_received'],
  });

  // Phase 70: when a channel message lands in the queue (typically a Lark
  // → Cursor relay), fire a desktop notification. Reason: the message
  // sits in `channel_message_queue` until Cursor's next `host_stop`
  // fires (turn end / new prompt) — until the user nudges Cursor, the
  // message is invisible. A native notification turns the silent wait
  // into a visible "go nudge Cursor" prompt.
  //
  // Lifecycle:
  //   - First event: request permission lazily (no popup at boot)
  //   - Subsequent events: fire a notification if permission granted,
  //     otherwise drop silently (the in-app badge already shows the
  //     queue depth)
  //
  // We don't fire when the helm window is focused — the user is already
  // looking at helm, the badge in Active Chats is enough. Notifications
  // are most useful when helm is in the background.
  useEventStream(() => {
    if (typeof Notification === 'undefined') return; // non-Electron / non-browser env
    if (document.hasFocus()) return;
    const send = (): void => {
      try {
        new Notification('helm', {
          body: 'Channel message queued for Cursor. Send any prompt in your Cursor chat to receive it.',
          tag: 'helm-channel-queue', // dedupe — coalesce bursts into one notification
        });
      } catch { /* notifications disabled at OS level — silent */ }
    };
    if (Notification.permission === 'granted') {
      send();
    } else if (Notification.permission !== 'denied') {
      void Notification.requestPermission().then((p) => { if (p === 'granted') send(); });
    }
  }, { types: ['channel.message_enqueued'] });

  return (
    <div className="helm-app">
      <aside className="helm-sidebar">
        <h1>Helm</h1>
        <nav className="helm-nav" aria-label="Main">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => isActive ? 'active' : undefined}
            >
              <span>{item.label}</span>
              {item.to === '/approvals' && pendingCount > 0 && (
                <span
                  className="badge"
                  aria-label={`${pendingCount} pending`}
                >{pendingCount}</span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="helm-sidebar-footer">
          <span
            className={`helm-status ${healthy ? 'ok' : 'err'}`}
            role="status"
            aria-live="polite"
          >
            <span className="dot" />
            {healthy ? 'Connected' : 'Backend offline'}
          </span>
        </div>
      </aside>
      <main className="helm-main">
        <Outlet />
      </main>
    </div>
  );
}
