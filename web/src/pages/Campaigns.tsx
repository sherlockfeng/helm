/**
 * Campaigns — long-running product/engineering efforts and their cycles.
 *
 * B2: each card now has a "Summarize" button that calls Anthropic via
 * POST /api/campaigns/:id/summarize. When the API key isn't set the
 * endpoint returns 501 and we link the user to Settings → Anthropic.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, helmApi } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';
import { EmptyState } from '../components/EmptyState.js';
import type { Campaign, CampaignSummary } from '../api/types.js';

export function CampaignsPage() {
  const { data, loading, error, reload } = useApi(() => helmApi.campaigns());
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <>
      <h2>Campaigns</h2>
      <p className="muted">Long-running product / engineering efforts. Each campaign runs through cycles in product → dev → test phases.</p>

      {loading && <p className="muted">Loading…</p>}
      {error && <p className="muted" style={{ color: 'var(--danger)' }}>Failed to load: {error.message}</p>}

      {data && data.campaigns.length === 0 && (
        <EmptyState
          title="No campaigns yet."
          hint={<>Run <code>init_workflow</code> from a Cursor chat to start one.</>}
        />
      )}

      {data && data.campaigns.map((c) => (
        <CampaignCard
          key={c.id}
          campaign={c}
          expanded={selected === c.id}
          onToggle={() => setSelected(selected === c.id ? null : c.id)}
          onUpdated={() => reload()}
        />
      ))}
    </>
  );
}

function CampaignCard({
  campaign,
  expanded,
  onToggle,
  onUpdated,
}: {
  campaign: Campaign;
  expanded: boolean;
  onToggle: () => void;
  onUpdated: () => void;
}) {
  return (
    <article className="helm-card">
      <div className="row">
        <div style={{ flex: 1 }}>
          <div className="label">{campaign.status}</div>
          <div style={{ fontWeight: 600, fontSize: 15 }}>{campaign.title}</div>
          {campaign.brief && (
            <div className="muted" style={{ marginTop: 4 }}>{campaign.brief}</div>
          )}
          <div className="label" style={{ marginTop: 8 }}>{campaign.projectPath}</div>
        </div>
        <button onClick={onToggle}>{expanded ? 'Hide details' : 'Show details'}</button>
      </div>

      {expanded && (
        <>
          <CampaignCycles campaignId={campaign.id} />
          <CampaignSummarySection campaign={campaign} onUpdated={onUpdated} />
        </>
      )}
    </article>
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

function CampaignSummarySection({
  campaign,
  onUpdated,
}: {
  campaign: Campaign;
  onUpdated: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsKey, setNeedsKey] = useState(false);
  const [summary, setSummary] = useState<CampaignSummary | null>(() => {
    try {
      return campaign.summary ? JSON.parse(campaign.summary) as CampaignSummary : null;
    } catch { return null; }
  });

  async function summarize(): Promise<void> {
    setSubmitting(true);
    setError(null);
    setNeedsKey(false);
    try {
      const r = await helmApi.summarizeCampaign(campaign.id);
      setSummary(r.summary);
      onUpdated();
    } catch (err) {
      if (err instanceof ApiError && err.status === 501) {
        setNeedsKey(true);
      } else {
        const msg = err instanceof ApiError ? err.message : (err as Error).message;
        setError(msg);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
        <span className="label">Summary</span>
        <button
          className={summary ? undefined : 'primary'}
          disabled={submitting}
          aria-busy={submitting}
          onClick={() => { void summarize(); }}
        >
          {submitting
            ? 'Summarizing…'
            : summary ? 'Regenerate summary' : 'Summarize via Anthropic'}
        </button>
      </div>

      {needsKey && (
        <p className="muted" style={{ marginTop: 10, color: 'var(--warn)' }}>
          Anthropic API key not configured.{' '}
          <Link to="/settings">Set it in Settings →</Link>
        </p>
      )}
      {error && (
        <p className="muted" style={{ marginTop: 10, color: 'var(--danger)' }}>{error}</p>
      )}

      {summary && !needsKey && !error && (
        <div style={{ marginTop: 10 }}>
          <div className="label">Why</div>
          <p className="muted" style={{ marginTop: 4, marginBottom: 12 }}>{summary.why}</p>

          <div className="label">Key decisions</div>
          {summary.keyDecisions.length === 0 ? (
            <p className="muted" style={{ marginTop: 4 }}>(none recorded)</p>
          ) : (
            <ul style={{ margin: '6px 0 14px', paddingLeft: 20 }}>
              {summary.keyDecisions.map((d, i) => <li key={i}>{d}</li>)}
            </ul>
          )}

          <div className="label">Overall path</div>
          <p className="muted" style={{ marginTop: 4, marginBottom: 0 }}>{summary.overallPath}</p>
        </div>
      )}
    </div>
  );
}
