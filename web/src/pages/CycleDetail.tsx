/**
 * CycleDetail — tasks for a single cycle, grouped by role (dev / test) with
 * status badges. Each task links to its TaskDetail page where the audit log
 * for doc-first events is visible.
 *
 * B1: this page now has the cycle action buttons that wire to the MCP-equivalent
 * REST endpoints — Complete cycle (/api/cycles/:id/complete) and Add bug
 * task (/api/cycles/:id/bug-tasks). The buttons reflect the cycle status:
 * Complete is only enabled when status === 'test'; Add bug is allowed from
 * either dev or test phases (Phase 7 engine sends the cycle back to dev).
 */

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, helmApi } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';
import { EmptyState } from '../components/EmptyState.js';
import type { BugTaskInput, Task } from '../api/types.js';

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

function CompleteCycleAction({
  cycleId,
  cycleStatus,
  onCompleted,
}: {
  cycleId: string;
  cycleStatus: string;
  onCompleted: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [passRate, setPassRate] = useState<string>('');
  const [failed, setFailed] = useState<string>('');

  const enabled = cycleStatus === 'test';

  async function complete(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      const body: { passRate?: number; failedTests?: string[] } = {};
      const trimmed = passRate.trim();
      if (trimmed) {
        const n = Number(trimmed);
        if (!Number.isFinite(n) || n < 0 || n > 100) {
          setError('passRate must be a number between 0 and 100.');
          setSubmitting(false);
          return;
        }
        body.passRate = n;
      }
      const failedList = failed.split('\n').map((s) => s.trim()).filter(Boolean);
      if (failedList.length > 0) body.failedTests = failedList;

      await helmApi.completeCycle(cycleId, body);
      setOpen(false);
      setPassRate('');
      setFailed('');
      onCompleted();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  if (!enabled) {
    return (
      <p className="muted" style={{ fontSize: 12, margin: 0 }}>
        Cycle completion available once status reaches <code>test</code>.
      </p>
    );
  }

  if (!open) {
    return (
      <button className="primary" onClick={() => setOpen(true)}>
        Complete cycle
      </button>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <label className="helm-form-row">
        <div className="muted">Pass rate (0–100, optional)</div>
        <input
          type="number"
          min={0}
          max={100}
          step="any"
          value={passRate}
          placeholder="e.g. 92"
          onChange={(e) => setPassRate(e.target.value)}
          style={{ width: 140 }}
        />
      </label>
      <label className="helm-form-row">
        <div className="muted">Failed tests (one per line, optional)</div>
        <textarea
          rows={3}
          value={failed}
          placeholder={'spec/foo.test.ts > "rejects empty input"\n…'}
          onChange={(e) => setFailed(e.target.value)}
          style={{ width: '100%', fontFamily: 'inherit' }}
        />
      </label>
      {error && (
        <p className="muted" style={{ color: 'var(--danger)', margin: 0 }}>{error}</p>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className="primary"
          disabled={submitting}
          aria-busy={submitting}
          onClick={() => { void complete(); }}
        >
          {submitting ? 'Completing…' : 'Complete'}
        </button>
        <button onClick={() => { setOpen(false); setError(null); }} disabled={submitting}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function BugTaskAction({
  cycleId,
  onCreated,
}: {
  cycleId: string;
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [expected, setExpected] = useState('');
  const [actual, setActual] = useState('');

  async function create(): Promise<void> {
    if (!title.trim()) {
      setError('Title is required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const bug: BugTaskInput = {
        title: title.trim(),
        description: description.trim() || undefined,
        expected: expected.trim() || undefined,
        actual: actual.trim() || undefined,
      };
      await helmApi.createBugTasks(cycleId, [bug]);
      setOpen(false);
      setTitle('');
      setDescription('');
      setExpected('');
      setActual('');
      onCreated();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return <button onClick={() => setOpen(true)}>+ Add bug task</button>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <label className="helm-form-row">
        <div className="muted">Title (required)</div>
        <input
          type="text"
          value={title}
          placeholder="Brief one-line summary"
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label className="helm-form-row">
        <div className="muted">Description (optional)</div>
        <textarea
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          style={{ width: '100%', fontFamily: 'inherit' }}
        />
      </label>
      <label className="helm-form-row">
        <div className="muted">Expected behaviour (optional)</div>
        <input
          type="text"
          value={expected}
          onChange={(e) => setExpected(e.target.value)}
        />
      </label>
      <label className="helm-form-row">
        <div className="muted">Actual behaviour (optional)</div>
        <input
          type="text"
          value={actual}
          onChange={(e) => setActual(e.target.value)}
        />
      </label>
      {error && (
        <p className="muted" style={{ color: 'var(--danger)', margin: 0 }}>{error}</p>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className="primary"
          disabled={submitting}
          aria-busy={submitting}
          onClick={() => { void create(); }}
        >
          {submitting ? 'Creating…' : 'Create bug task'}
        </button>
        <button onClick={() => { setOpen(false); setError(null); }} disabled={submitting}>
          Cancel
        </button>
      </div>
      <p className="muted" style={{ fontSize: 11, margin: 0 }}>
        Creating a bug task sends the cycle back to <code>dev</code> phase.
      </p>
    </div>
  );
}

export function CycleDetailPage() {
  const { cycleId } = useParams<{ cycleId: string }>();
  const { data, loading, error, reload } = useApi(
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

      <h3>Cycle actions</h3>
      <article className="helm-card">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <CompleteCycleAction
            cycleId={data.cycle.id}
            cycleStatus={data.cycle.status}
            onCompleted={() => reload()}
          />
          <BugTaskAction cycleId={data.cycle.id} onCreated={() => reload()} />
        </div>
      </article>

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
