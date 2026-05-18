/**
 * App shell — sidebar + active route's main pane.
 *
 * Sidebar nav badges (e.g. pending approvals count) are derived from the
 * SSE event stream so they stay live without polling.
 */

import { NavLink, Outlet } from 'react-router-dom';
import { useEffect, useState, type ComponentType, type SVGProps } from 'react';
import { helmApi } from '../api/client.js';
import { useEventStream } from '../hooks/useEventStream.js';
import {
  MessagesSquare, Link2, ShieldCheck,
  BookOpen, Cloud, Plug,
  Workflow, Settings,
} from './Icons.js';

type IconCmp = ComponentType<SVGProps<SVGSVGElement>>;

interface NavItem {
  to: string;
  label: string;
  /** helm-design PR 4: every nav row carries a lucide icon (18 px, leading). */
  icon: IconCmp;
}

interface NavGroup {
  /** Group header label rendered uppercase. */
  label: string;
  /** Items render indented under the header. */
  items: NavItem[];
}

type NavEntry = NavItem | NavGroup;

function isGroup(entry: NavEntry): entry is NavGroup {
  return 'items' in entry;
}

// Phase 79 follow-up: chat-adjacent surfaces (Active / Bindings / Approvals)
// nest under a "Chats" group header — they're all "this Cursor chat I'm
// observing" viewed from a different angle.
//
// helm-design PR 4: introduces a parallel "Knowledge" group for surfaces
// that feed roles (Roles + Subscriptions + Plugins, the latter two
// lifted out of Settings in PR 5). Harness stays top-level (different
// subject). Settings stays top-level but is pinned to the bottom of the
// sidebar via the .helm-nav-spacer flex element.
//
// Campaigns + Requirements remain hidden from the nav; routes still
// resolve for anyone with a direct link.
const NAV: NavEntry[] = [
  {
    label: 'Chats',
    items: [
      { to: '/chats', label: 'Active', icon: MessagesSquare },
      { to: '/bindings', label: 'Bindings', icon: Link2 },
      { to: '/approvals', label: 'Approvals', icon: ShieldCheck },
    ],
  },
  {
    label: 'Knowledge',
    items: [
      { to: '/roles', label: 'Roles', icon: BookOpen },
      { to: '/subscriptions', label: 'Subscriptions', icon: Cloud },
      { to: '/plugins', label: 'Plugins', icon: Plug },
    ],
  },
  { to: '/harness', label: 'Harness', icon: Workflow },
  // Settings is rendered separately so we can drop a flex spacer above
  // it and pin it to the bottom of the sidebar.
];

const SETTINGS_ITEM: NavItem = { to: '/settings', label: 'Settings', icon: Settings };

/**
 * Brand row — plain wordmark for now (helm-design PR 4 spec). The wrapper
 * exists so a future PR can drop a real logo SVG next to the wordmark
 * without touching `<Layout/>`.
 */
function HelmBrand() {
  return (
    <h1 className="helm-brand font-semibold tracking-tight">Helm</h1>
  );
}

/**
 * One sidebar nav row: icon + label, with the approvals count badge when
 * applicable. Extracted from the inline JSX so the top-level grouped vs
 * flat branches both render identically (icons + a11y).
 */
function NavRow({
  item, pendingCount, nested,
}: { item: NavItem; pendingCount: number; nested?: boolean }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      className={({ isActive }) => {
        const parts = [nested ? 'nested' : ''];
        if (isActive) parts.push('active');
        return parts.filter(Boolean).join(' ') || undefined;
      }}
    >
      {/* aria-hidden — the label already names the row for screen readers. */}
      <Icon className="helm-nav-icon" aria-hidden="true" width={18} height={18} />
      <span className="helm-nav-label">{item.label}</span>
      {item.to === '/approvals' && pendingCount > 0 && (
        <span className="badge" aria-label={`${pendingCount} pending`}>
          {pendingCount}
        </span>
      )}
    </NavLink>
  );
}

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
        <HelmBrand />
        <nav className="helm-nav" aria-label="Main">
          {NAV.map((entry) => isGroup(entry) ? (
            <div key={entry.label} className="helm-nav-group">
              <div className="helm-nav-group-label">{entry.label}</div>
              {entry.items.map((item) => (
                <NavRow key={item.to} item={item} pendingCount={pendingCount} nested />
              ))}
            </div>
          ) : (
            <NavRow key={entry.to} item={entry} pendingCount={pendingCount} />
          ))}
          {/* helm-design PR 4: spacer pushes Settings to the bottom of the
              sidebar — it's the only "infrequent / admin" item in the IA. */}
          <div className="helm-nav-spacer" aria-hidden="true" />
          <NavRow item={SETTINGS_ITEM} pendingCount={pendingCount} />
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
