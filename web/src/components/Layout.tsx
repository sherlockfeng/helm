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

  useEventStream(() => { void refreshCount(); }, {
    types: ['approval.pending', 'approval.settled'],
  });

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
