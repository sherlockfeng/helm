/**
 * Verification › Runs — PR 7 functional cut.
 *
 * Two modes:
 *   - default: aggregates the latest few runs across all cases for a
 *     quick "what's running" sense
 *   - case-detail (URL /verification/cases/:id/runs): full history of
 *     one case, with sha + alignment + recall + delta vs baseline
 *
 * Cost roll-up + bisect tooling per §5.7 ride alongside; this PR
 * surfaces the data shape so the renderer is correct without yet
 * adding the bisect/restore buttons (those need git-substrate
 * helpers landing in PR 5.5).
 */

import { useMemo, useState, type ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';
import { helmApi } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';
import { Card } from '../components/Card.js';
import { EmptyState } from '../components/EmptyState.js';
import { PageHeader } from '../components/PageHeader.js';
import { CardSkeletonList } from '../components/Skeleton.js';
import type { BenchmarkRun } from '../api/types.js';

export function VerificationRunsPage(): ReactElement {
  const { caseId } = useParams<{ caseId?: string }>();
  return caseId ? <CaseRunsView caseId={caseId} /> : <GlobalRunsView />;
}

/** Detail view: full history for one case. */
function CaseRunsView({ caseId }: { caseId: string }): ReactElement {
  const caseQuery = useApi(
    () => helmApi.getVerificationCase(caseId),
    [caseId],
  );
  const runsQuery = useApi(
    () => helmApi.listVerificationRunsForCase(caseId, 100),
    [caseId],
  );
  const c = caseQuery.data?.case;
  const runs = useMemo(() => runsQuery.data?.runs ?? [], [runsQuery.data]);

  // For each run, compute its delta against the previous non-reproduce
  // run, mirroring what the regression detector does on the backend.
  const enrichedRuns = useMemo(() => deriveDeltas(runs), [runs]);

  if (caseQuery.error || runsQuery.error) {
    return (
      <div className="helm-page">
        <PageHeader title="Verification runs" />
        <EmptyState
          title="Could not load runs."
          hint={(caseQuery.error ?? runsQuery.error)?.toString() ?? ''}
        />
      </div>
    );
  }

  return (
    <div className="helm-page">
      <PageHeader
        title={c ? c.name : 'Verification runs'}
        subtitle={c ? c.question : 'Per-case run history.'}
        actions={<Link to="/verification/cases">← back to cases</Link>}
      />

      {(caseQuery.loading || runsQuery.loading) && !runs.length && (
        <CardSkeletonList n={3} />
      )}

      {!runsQuery.loading && runs.length === 0 && (
        <EmptyState
          title="No runs yet."
          hint="Runs land here when a candidate accept or manual rerun triggers this case."
        />
      )}

      {enrichedRuns.map(({ run, delta }) => (
        <RunCard key={run.id} run={run} delta={delta} />
      ))}
    </div>
  );
}

/** Global view: latest cases + their most recent alignment + a recent-alerts strip. */
function GlobalRunsView(): ReactElement {
  const casesQuery = useApi(
    () => helmApi.listVerificationCases({ status: 'confirmed', limit: 50 }),
    [],
  );
  const alertsQuery = useApi(
    () => helmApi.listVerificationAlerts({ status: 'open', limit: 25 }),
    [],
  );
  const cases = useMemo(() => casesQuery.data?.cases ?? [], [casesQuery.data]);
  const alerts = useMemo(() => alertsQuery.data?.alerts ?? [], [alertsQuery.data]);

  return (
    <div className="helm-page">
      <PageHeader
        title="Verification runs"
        subtitle="Most recent activity across cases. Open one to see its full history."
      />

      {alerts.length > 0 && (
        <Card>
          <h3 style={{ marginTop: 0 }}>Open regression alerts ({alerts.length})</h3>
          {alerts.map((a) => (
            <div key={a.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
              <Link to={`/verification/cases/${a.caseId}/runs`}>{a.caseId}</Link>
              <span>{a.prevScore.toFixed(1)}% → {a.currentScore.toFixed(1)}% ({a.delta.toFixed(1)})</span>
            </div>
          ))}
        </Card>
      )}

      {casesQuery.loading && !cases.length && <CardSkeletonList n={3} />}

      {!casesQuery.loading && cases.length === 0 && (
        <EmptyState
          title="No confirmed cases yet."
          hint={<>Create one in <Link to="/verification/cases">Cases</Link>.</>}
        />
      )}

      {cases.map((c) => (
        <Card key={c.id}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <strong>{c.name}</strong>
              <div className="muted" style={{ fontSize: 12 }}>{c.question}</div>
            </div>
            <Link to={`/verification/cases/${c.id}/runs`}>history ↗</Link>
          </div>
        </Card>
      ))}
    </div>
  );
}

/** Parse the judge verdict JSON for a human summary; fall back to raw text. */
function judgeSummary(run: BenchmarkRun): string {
  try {
    const v = JSON.parse(run.judgeVerdictJson) as { summary?: string; aligned?: boolean; score?: number };
    if (v && typeof v.summary === 'string' && v.summary.trim()) return v.summary.trim();
  } catch { /* fall through */ }
  return run.judgeVerdictText || '(no verdict text)';
}

function RunCard({ run, delta }: { run: BenchmarkRun; delta?: number }): ReactElement {
  const [open, setOpen] = useState(false);
  const shortSha = run.knowledgeStateSha.startsWith('local-')
    ? run.knowledgeStateSha.slice(0, 14)
    : run.knowledgeStateSha.slice(0, 8);
  const triggered = run.triggeringEventKind
    ? `from ${run.triggeringEventKind}`
    : 'manual run';
  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <div>
          <strong>{run.alignmentPct.toFixed(1)}%</strong>
          {' alignment · '}
          <span>{run.recallPct.toFixed(1)}%</span>{' recall'}
          {' '}
          {delta != null && (
            <span style={{ color: delta < -5 ? '#dc2626' : delta < 0 ? '#d97706' : '#16a34a' }}>
              {delta > 0 ? '+' : ''}{delta.toFixed(1)}
            </span>
          )}
          {run.isReproducible
            ? <span title="all golden points are in a tracked git repo"> · ♻ reproducible</span>
            : <span title="includes local-only edits; not reproducible from a shared repo"> · ⚠ local state</span>}
        </div>
        <div className="muted" style={{ fontSize: 12, textAlign: 'right' }}>
          <code>{shortSha}</code>
          <div>{new Date(run.runAt).toLocaleString()}</div>
          <div>{triggered}</div>
        </div>
      </div>
      <button
        type="button"
        className="helm-conv-link-button"
        onClick={() => setOpen((v) => !v)}
        style={{ marginTop: 8, fontSize: 12 }}
      >
        {open ? '收起详情' : '展开详情（答案 + 裁判打分）'}
      </button>
      {open && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 2 }}>
              AI 答案（用召回的 golden 知识点作答）
            </div>
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: 0 }}>{run.answerText || '(empty)'}</pre>
          </div>
          <div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 2 }}>
              裁判判定（对比 expected truth → 对齐分 {run.alignmentPct.toFixed(0)}）
            </div>
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: 0 }}>{judgeSummary(run)}</pre>
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            {run.answerProviderId} / {run.judgeProviderId}
            {typeof run.llmCallCount === 'number' && <> · {run.llmCallCount} LLM calls</>}
            {typeof run.durationMs === 'number' && <> · {(run.durationMs / 1000).toFixed(1)}s</>}
          </div>
        </div>
      )}
    </Card>
  );
}

function deriveDeltas(runs: readonly BenchmarkRun[]): Array<{ run: BenchmarkRun; delta?: number }> {
  // runs come in run_at DESC order. For each non-reproduce run, find
  // the next older non-reproduce run; delta = current - baseline.
  const out: Array<{ run: BenchmarkRun; delta?: number }> = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    if (run.reproducedFromRunId) {
      out.push({ run });
      continue;
    }
    let baseline: BenchmarkRun | undefined;
    for (let j = i + 1; j < runs.length; j++) {
      const r = runs[j]!;
      if (!r.reproducedFromRunId) { baseline = r; break; }
    }
    out.push(baseline
      ? { run, delta: run.alignmentPct - baseline.alignmentPct }
      : { run });
  }
  return out;
}
