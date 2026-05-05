/**
 * Campaigns — long-running product/engineering efforts and their cycles.
 *
 * v1: list view + selected-campaign cycles. Detail panes (per-cycle tasks,
 * doc-first audit log, screenshots) land in Phase 12.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { helmApi } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';

export function CampaignsPage() {
  const { data, loading, error } = useApi(() => helmApi.campaigns());
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <>
      <h2>Campaigns</h2>
      <p className="muted">Long-running product / engineering efforts. Each campaign runs through cycles in product → dev → test phases.</p>

      {loading && <p className="muted">Loading…</p>}
      {error && <p className="muted" style={{ color: 'var(--danger)' }}>Failed to load: {error.message}</p>}

      {data && data.campaigns.length === 0 && (
        <div className="helm-empty">
          No campaigns yet. Run <code>init_workflow</code> from a Cursor chat to start one.
        </div>
      )}

      {data && data.campaigns.map((c) => (
        <article key={c.id} className="helm-card">
          <div className="row">
            <div style={{ flex: 1 }}>
              <div className="label">{c.status}</div>
              <div style={{ fontWeight: 600, fontSize: 15 }}>{c.title}</div>
              {c.brief && <div className="muted" style={{ marginTop: 4 }}>{c.brief}</div>}
              <div className="label" style={{ marginTop: 8 }}>{c.projectPath}</div>
            </div>
            <button onClick={() => setSelected(selected === c.id ? null : c.id)}>
              {selected === c.id ? 'Hide cycles' : 'Show cycles'}
            </button>
          </div>
          {selected === c.id && <CampaignCycles campaignId={c.id} />}
        </article>
      ))}
    </>
  );
}

function CampaignCycles({ campaignId }: { campaignId: string }) {
  const { data, loading, error } = useApi(() => helmApi.campaignCycles(campaignId), [campaignId]);

  if (loading) return <p className="muted" style={{ marginTop: 12 }}>Loading cycles…</p>;
  if (error) return <p className="muted" style={{ marginTop: 12, color: 'var(--danger)' }}>{error.message}</p>;
  if (!data || data.cycles.length === 0) return <p className="muted" style={{ marginTop: 12 }}>No cycles yet.</p>;

  return (
    <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      {data.cycles.map((cy) => (
        <Link
          key={cy.id}
          to={`/cycles/${cy.id}`}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            padding: '6px 4px',
            borderRadius: 'var(--radius-sm)',
            color: 'inherit',
            textDecoration: 'none',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = ''; }}
        >
          <span>Cycle {cy.cycleNum}</span>
          <span className="helm-status">
            <span className="dot" />
            {cy.status}
          </span>
        </Link>
      ))}
    </div>
  );
}
