/**
 * App shell — sidebar + active route's main pane.
 *
 * Sidebar nav badges (e.g. pending approvals count) are derived from the
 * SSE event stream so they stay live without polling.
 */

import { NavLink, Outlet } from 'react-router-dom';
import { useCallback, useEffect, useState, type ComponentType, type SVGProps } from 'react';
import { helmApi } from '../api/client.js';
import { useEventStream } from '../hooks/useEventStream.js';
import {
  // Primary nav — ordered by the knowledge lifecycle:
  // 提取 (Conversations) → 使用/维护 (Topics) → 升级 (Contribute) → 维护 (Sources)
  // P1 (de-redundancy): Experts merged into Topics — an expert is a
  // topic with a persona (prompt + bindable); one noun, one page.
  MessagesSquare, Layers, ArrowUpToLine, Cloud,
  ListChecks, History, Target,
  Settings,
} from './Icons.js';
// R-18: removed the helm.ui.advanced flag entirely. Approvals /
// Bindings / Harness are now reachable from Settings › Advanced (and
// always via direct URL); no more sidebar-visibility toggle.

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
      // 知识主题（实体桶 + 导入主题域 + 带人格的专家主题）
      { to: '/knowledge/topics', label: 'Topics', icon: Layers },
      // 升级：个人层 → 团队层（未发布同步 + Contribute MR）
      { to: '/knowledge/promote', label: 'Contribute', icon: ArrowUpToLine },
      // 维护：仓库订阅 / 同步 / 导入目录
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

// R-18: ADVANCED_GROUP removed. Approvals / Bindings / Harness are
// surfaced as link cards under Settings › Advanced (and remain
// reachable by direct URL). The renderer e2e assertions for these
// pages now drive them through the Settings route or via direct
// navigation.

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
 * One sidebar nav row: icon + label, with the approvals / verification
 * count badges when applicable. Extracted from the inline JSX so the
 * top-level grouped vs flat branches both render identically (icons +
 * a11y).
 *
 * verificationBadge is a combined count of proposed cases + open
 * regression alerts — the renderer pulls users into the Verification
 * section whenever either is non-zero. Showing them as a single number
 * keeps the sidebar tidy; the page itself surfaces the split.
 */
function NavRow({
  item, pendingCount, verificationBadge, nested,
}: {
  item: NavItem;
  pendingCount: number;
  verificationBadge: number;
  nested?: boolean;
}) {
  const Icon = item.icon;
  const isApprovals = item.to === '/approvals';
  // The verification badge (= proposed cases + open alerts) belongs on
  // Cases only — that's where the queue is reviewed. Showing the same
  // count on Runs + Coverage made it look like each had N items.
  const isVerification = item.to === '/verification/cases';
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
      {isApprovals && pendingCount > 0 && (
        <span className="badge" aria-label={`${pendingCount} pending`}>
          {pendingCount}
        </span>
      )}
      {isVerification && verificationBadge > 0 && (
        <span className="badge" aria-label={`${verificationBadge} need attention`}>
          {verificationBadge}
        </span>
      )}
    </NavLink>
  );
}

export function Layout() {
  const [pendingCount, setPendingCount] = useState<number>(0);
  const [verificationBadge, setVerificationBadge] = useState<number>(0);
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

  // PR 7: Verification badge. Refreshed live on `verification.changed`
  // and polled on a slow cadence (60s) as a backstop — the failure path
  // is benign so a network blip just leaves the previous count visible.
  // Combined count = proposed cases + open alerts.
  const refreshVerificationBadge = useCallback(async (): Promise<void> => {
    try {
      const c = await helmApi.verificationCounts();
      setVerificationBadge(c.proposed + c.openAlerts);
    } catch { /* tolerate offline */ }
  }, []);

  useEffect(() => {
    void refreshVerificationBadge();
    const id = setInterval(() => { void refreshVerificationBadge(); }, 60_000);
    return () => clearInterval(id);
  }, [refreshVerificationBadge]);

  // Refresh the badge the instant a case mutation lands (confirm /
  // reject / confirm-batch / backfill) instead of waiting up to 60s.
  useEventStream(() => { void refreshVerificationBadge(); }, {
    types: ['verification.changed'],
  });

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
                <NavRow key={item.to} item={item} pendingCount={pendingCount} verificationBadge={verificationBadge} nested />
              ))}
            </div>
          ) : (
            <NavRow key={entry.to} item={entry} pendingCount={pendingCount} verificationBadge={verificationBadge} />
          ))}
          {/* R-18: Advanced sidebar group removed; Approvals / Bindings /
              Harness reachable from Settings › Advanced + direct URL. */}
          {/* Spacer pushes Settings to the bottom of the sidebar — the
              "infrequent / admin" item per the IA. */}
          <div className="helm-nav-spacer" aria-hidden="true" />
          <NavRow item={SETTINGS_ITEM} pendingCount={pendingCount} verificationBadge={verificationBadge} />
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
