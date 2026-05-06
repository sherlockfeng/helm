/**
 * CycleDetail — tasks for a single cycle, grouped by role (dev / test) with
 * status badges. Each task links to its TaskDetail page where the audit log
 * for doc-first events is visible.
 *
 * Phase 12 ships read-only views over what the MCP / orchestrator already
 * writes. Buttons that mutate cycle state (complete cycle, create bug
 * tasks, summarize campaign) live in the MCP layer and the renderer
 * surfaces them in a follow-up.
 */

import { Link, useParams } from 'react-router-dom';
import { helmApi } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';
import { EmptyState } from '../components/EmptyState.js';
import type { Task } from '../api/types.js';

const STATUS_TONE: Record<Task['status'], 'ok' | 'warn' | 'err' | ''> = {
  pending: '',
  in_progress: 'warn',
  completed: 'ok',
  failed: 'err',
  cancelled: '',
};

function StatusPill({ status }: { status: Task['status'] }) {
  const tone = STATUS_TONE[status];
  return (
    <span className={`helm-status ${tone}`}>
      <span className="dot" />
      {status.replace('_', ' ')}
    </span>
  );
}

function TaskRow({ task }: { task: Task }) {
  return (
    <Link
      to={`/tasks/${task.id}`}
      className="helm-card"
      style={{ display: 'block', textDecoration: 'none', color: 'inherit', marginBottom: 10 }}
    >
      <div className="row">
        <div style={{ flex: 1 }}>
          <div className="label">{task.role}</div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{task.title}</div>
          {task.description && (
            <div className="muted" style={{ marginTop: 4, marginBottom: 0 }}>{task.description}</div>
          )}
          {task.docAuditToken && task.role === 'dev' && (
            <div className="label" style={{ marginTop: 6 }}>doc-first audit token: {task.docAuditToken}</div>
          )}
        </div>
        <StatusPill status={task.status} />
      </div>
    </Link>
  );
}

export function CycleDetailPage() {
  const { cycleId } = useParams<{ cycleId: string }>();
  const { data, loading, error } = useApi(
    () => helmApi.cycle(cycleId!),
    [cycleId],
  );

  if (loading) return <p className="muted">Loading…</p>;
  if (error) return <p className="muted" style={{ color: 'var(--danger)' }}>{error.message}</p>;
  if (!data) return null;

  const dev = data.tasks.filter((t) => t.role === 'dev');
  const test = data.tasks.filter((t) => t.role === 'test');

  return (
    <>
      <div className="helm-breadcrumb">
        <Link to="/campaigns">← Campaigns</Link>
        {data.campaign && <> / {data.campaign.title}</>}
      </div>
      <h2>Cycle {data.cycle.cycleNum}</h2>
      <div className="helm-page-meta">
        <StatusPill status={data.cycle.status as Task['status']} />
        {data.cycle.startedAt && (
          <span>Started {new Date(data.cycle.startedAt).toLocaleString()}</span>
        )}
      </div>

      {data.cycle.productBrief && (
        <article className="helm-card">
          <div className="label">Product brief</div>
          <pre>{data.cycle.productBrief}</pre>
        </article>
      )}

      <h3>Dev tasks ({dev.length})</h3>
      {dev.length === 0
        ? (
          <EmptyState
            title="No dev tasks."
            hint={<>Run <code>create_tasks</code> from the product agent.</>}
          />
        )
        : dev.map((t) => <TaskRow key={t.id} task={t} />)}

      <h3>Test tasks ({test.length})</h3>
      {test.length === 0
        ? <EmptyState title="No test tasks yet." hint="Created when dev tasks complete." />
        : test.map((t) => <TaskRow key={t.id} task={t} />)}
    </>
  );
}
