/**
 * TaskDetail — task fields, comments, doc-first audit log.
 *
 * The audit log is the user-visible record that the dev agent ran
 * `update_doc_first` before claiming the task complete. Phase 7 enforces
 * this server-side; this page is the human-readable trail.
 */

import { Link, useParams } from 'react-router-dom';
import { helmApi } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';
import type { Task } from '../api/types.js';

const STATUS_TONE: Record<Task['status'], 'ok' | 'warn' | 'err' | ''> = {
  pending: '',
  in_progress: 'warn',
  completed: 'ok',
  failed: 'err',
  cancelled: '',
};

export function TaskDetailPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const { data, loading, error } = useApi(
    () => helmApi.task(taskId!),
    [taskId],
  );

  if (loading) return <p className="muted">Loading…</p>;
  if (error) return <p className="muted" style={{ color: 'var(--danger)' }}>{error.message}</p>;
  if (!data) return null;

  const { task, auditLog } = data;
  const tone = STATUS_TONE[task.status];

  return (
    <>
      <div className="muted" style={{ marginBottom: 4 }}>
        <Link to={`/campaigns`} style={{ color: 'var(--text-secondary)' }}>← Campaigns</Link>
        {' / '}
        <Link to={`/cycles/${task.cycleId}`} style={{ color: 'var(--text-secondary)' }}>cycle</Link>
      </div>
      <h2>{task.title}</h2>
      <p className="muted">
        <span className="label" style={{ display: 'inline-block', marginRight: 12 }}>{task.role}</span>
        <span className={`helm-status ${tone}`}>
          <span className="dot" />
          {task.status.replace('_', ' ')}
        </span>
      </p>

      {task.description && (
        <article className="helm-card">
          <div className="label">Description</div>
          <pre>{task.description}</pre>
        </article>
      )}

      {task.acceptance && task.acceptance.length > 0 && (
        <article className="helm-card">
          <div className="label">Acceptance criteria</div>
          <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
            {task.acceptance.map((a, i) => <li key={i}>{a}</li>)}
          </ul>
        </article>
      )}

      {task.e2eScenarios && task.e2eScenarios.length > 0 && (
        <article className="helm-card">
          <div className="label">e2e scenarios</div>
          <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
            {task.e2eScenarios.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </article>
      )}

      {task.result && (
        <article className="helm-card">
          <div className="label">Result</div>
          <pre>{task.result}</pre>
        </article>
      )}

      {task.role === 'dev' && (
        <article className="helm-card">
          <div className="label">doc-first audit log</div>
          {auditLog.length === 0 ? (
            <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>
              No <code>update_doc_first</code> calls recorded for this task yet.
              Dev tasks must accumulate at least one audit-log entry before they
              can be marked complete.
            </p>
          ) : (
            <ul style={{ margin: '8px 0 0', paddingLeft: 0, listStyle: 'none' }}>
              {auditLog.map((entry) => (
                <li key={entry.token} style={{ marginBottom: 6 }}>
                  <code style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                    {new Date(entry.createdAt).toLocaleTimeString()}
                  </code>
                  {'  '}
                  <code>{entry.filePath}</code>
                  {'  '}
                  <span className="label">{entry.token.slice(0, 10)}…</span>
                </li>
              ))}
            </ul>
          )}
        </article>
      )}

      {task.comments && task.comments.length > 0 && (
        <article className="helm-card">
          <div className="label">Comments</div>
          <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
            {task.comments.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        </article>
      )}
    </>
  );
}
