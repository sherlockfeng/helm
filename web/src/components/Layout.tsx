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
  // Primary nav (PR 1 — conversations-knowledge IA)
  MessagesSquare, BookOpen, Inbox, Cloud,
  ListChecks, History, Target,
  Settings,
  // Advanced (opt-in)
  ShieldCheck, Link2, Workflow,
} from './Icons.js';
import { autoEnableIfHistoricalData, isAdvancedEnabled } from '../lib/advanced-flag.js';

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

// PR 1 — conversations-knowledge IA per docs/design/2026-06-06-conversation-
// knowledge-redesign.md §2. Four top-level groups: Conversations / Knowledge
// / Verification / Settings.
//
// Approvals / Bindings / Harness are not top-level anymore. They live under
// Settings › Advanced and only appear in the sidebar when the
// `helm.ui.advanced` localStorage flag is on. The routes themselves always
// resolve so deep links keep working.
//
// Campaigns + Requirements + Cycle/TaskDetail remain hidden from nav (same
// as before PR 1); routes still resolve for direct links.
/** Exported so the renderer e2e suite can assert IA structure. */
export const PRIMARY_NAV: NavEntry[] = [
  { to: '/conversations', label: 'Conversations', icon: MessagesSquare },
  {
    label: 'Knowledge',
    items: [
      { to: '/knowledge/library', label: 'Library', icon: BookOpen },
      { to: '/knowledge/review', label: 'Review', icon: Inbox },
      { to: '/knowledge/sources', label: 'Sources', icon: Cloud },
    ],
  },
  {
    label: 'Verification',
    items: [
      { to: '/verification/cases', label: 'Cases', icon: ListChecks },
      { to: '/verification/runs', label: 'Runs', icon: History },
      { to: '/verification/coverage', label: 'Coverage', icon: Target },
    ],
  },
];

/** Exported so the renderer e2e suite can assert IA structure. */
export const ADVANCED_GROUP: NavGroup = {
  label: 'Advanced',
  items: [
    { to: '/approvals', label: 'Approvals', icon: ShieldCheck },
    { to: '/bindings', label: 'Bindings', icon: Link2 },
    { to: '/harness', label: 'Harness', icon: Workflow },
  ],
};

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
  const [advancedOn, setAdvancedOn] = useState<boolean>(isAdvancedEnabled());

  // Initial fetch + reconcile on every approval event.
  const refreshCount = async (): Promise<void> => {
    try {
      const r = await helmApi.approvals();
      setPendingCount(r.approvals.length);
      setHealthy(true);
      // First-launch auto-enable: if user clearly has historical Advanced
      // data (pending approvals from before the IA reshuffle), surface
      // the section by default. This only runs if no decision is stored
      // yet (see autoEnableIfHistoricalData).
      autoEnableIfHistoricalData({ hasHistoricalAdvancedData: r.approvals.length > 0 });
      setAdvancedOn(isAdvancedEnabled());
    } catch { setHealthy(false); }
  };

  useEffect(() => {
    void refreshCount();
    const id = setInterval(refreshCount, 30_000);
    return () => clearInterval(id);
  }, []);

  // Keep the sidebar in sync with the Settings › Advanced toggle without
  // a full reload. `setAdvancedEnabled` fires a synthetic event for the
  // same-tab case (browsers only fire `storage` cross-tab).
  useEffect(() => {
    const onChange = (): void => setAdvancedOn(isAdvancedEnabled());
    window.addEventListener('helm:advanced-changed', onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener('helm:advanced-changed', onChange);
      window.removeEventListener('storage', onChange);
    };
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
          {PRIMARY_NAV.map((entry) => isGroup(entry) ? (
            <div key={entry.label} className="helm-nav-group">
              <div className="helm-nav-group-label">{entry.label}</div>
              {entry.items.map((item) => (
                <NavRow key={item.to} item={item} pendingCount={pendingCount} nested />
              ))}
            </div>
          ) : (
            <NavRow key={entry.to} item={entry} pendingCount={pendingCount} />
          ))}
          {advancedOn && (
            <div className="helm-nav-group" data-testid="helm-nav-advanced">
              <div className="helm-nav-group-label">{ADVANCED_GROUP.label}</div>
              {ADVANCED_GROUP.items.map((item) => (
                <NavRow key={item.to} item={item} pendingCount={pendingCount} nested />
              ))}
            </div>
          )}
          {/* Spacer pushes Settings to the bottom of the sidebar — the
              "infrequent / admin" item per the IA. */}
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
