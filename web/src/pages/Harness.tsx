/**
 * Harness page (Phase 67).
 *
 * Lists every Harness task helm knows about, grouped by stage. Each card
 * exposes the operations the user is most likely to want at that stage:
 *
 *   new_feature → "Open task.md" + "Bind chat" + (no actions; user opens
 *                 the chat and the agent advances via MCP)
 *   implement   → "Open task.md" + "Run review"
 *   archived    → "View archive card" + (read-only)
 *
 * The page is intentionally a thin shell over `helmApi.harness*`. The real
 * work happens in the implement chat (via MCP tools) — this page is the
 * status board + escape hatch for manual interventions.
 */

import { useState } from 'react';
import { helmApi, type HarnessReviewView, type HarnessTaskView } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';
import { EmptyState } from '../components/EmptyState.js';

export function HarnessPage() {
  const { data, loading, error, reload } = useApi(() => helmApi.harnessTasks());
  const [creating, setCreating] = useState(false);

  const tasks = data?.tasks ?? [];
  const grouped = groupByStage(tasks);

  return (
    <>
      <h2>Harness</h2>
      <p className="muted">
        AI-assisted feature development workflow: <code>new_feature → implement → archive</code>,
        with a fresh-chat <code>review</code> checkpoint at the implement→archive boundary.
        Tasks live on disk in <code>.harness/</code> (source of truth); helm DB indexes them.
      </p>

      <div style={{ marginBottom: 16 }}>
        <button className="primary" onClick={() => setCreating(true)}>
          + New Harness task
        </button>
        <span className="muted" style={{ marginLeft: 12, fontSize: 12 }}>
          Creates <code>.harness/tasks/&lt;id&gt;/task.md</code> and seeds Related Tasks
          from any matching archive cards.
        </span>
      </div>

      {creating && (
        <CreateTaskForm
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); reload(); }}
        />
      )}

      {loading && <p className="muted">Loading…</p>}
      {error && <p className="muted" style={{ color: 'var(--danger)' }}>{error.message}</p>}

      {data && tasks.length === 0 && !loading && (
        <EmptyState
          title="No Harness tasks yet."
          hint={<>
            Click <strong>+ New Harness task</strong> above. The first task is the bootstrap
            moment — its archive card is what every future task searches against.
          </>}
        />
      )}

      {grouped.new_feature.length > 0 && (
        <Section title="new_feature" subtitle="Scoping; no code is written here.">
          {grouped.new_feature.map((t) => (
            <TaskCard key={t.id} task={t} onChanged={reload} />
          ))}
        </Section>
      )}
      {grouped.implement.length > 0 && (
        <Section title="implement" subtitle="Building + testing; review at the end.">
          {grouped.implement.map((t) => (
            <TaskCard key={t.id} task={t} onChanged={reload} />
          ))}
        </Section>
      )}
      {grouped.archived.length > 0 && (
        <Section title="archived" subtitle="Read-only; queryable by future tasks.">
          {grouped.archived.map((t) => (
            <TaskCard key={t.id} task={t} onChanged={reload} />
          ))}
        </Section>
      )}
    </>
  );
}

function groupByStage(tasks: HarnessTaskView[]): Record<HarnessTaskView['currentStage'], HarnessTaskView[]> {
  const out = { new_feature: [], implement: [], archived: [] } as Record<HarnessTaskView['currentStage'], HarnessTaskView[]>;
  for (const t of tasks) out[t.currentStage].push(t);
  return out;
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 24 }}>
      <h3 style={{ marginBottom: 4 }}>{title}</h3>
      {subtitle && <p className="muted" style={{ marginTop: 0 }}>{subtitle}</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>
    </section>
  );
}

function TaskCard({ task, onChanged }: { task: HarnessTaskView; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [latestReview, setLatestReview] = useState<HarnessReviewView | null>(null);
  const [showReport, setShowReport] = useState(false);

  const runReview = async () => {
    setBusy('review');
    setErr(null);
    try {
      const r = await helmApi.harnessRunReview(task.id);
      setLatestReview(r);
      setShowReport(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(null); }
  };

  const pushReview = async () => {
    if (!latestReview) return;
    setBusy('push');
    setErr(null);
    try {
      await helmApi.harnessPushReview(task.id, latestReview.id);
      // success → leave the panel open so the user knows we did something.
      setErr('Pushed to implement chat\'s queue. The agent will see it on its next host_stop.');
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(null); }
  };

  const archive = async () => {
    const oneLiner = window.prompt('One-line summary for the archive card:');
    if (!oneLiner) return;
    const filesTouched = window.prompt('Files touched (comma-separated):') ?? '';
    const entities = window.prompt('Entities (comma-separated):') ?? '';
    setBusy('archive');
    setErr(null);
    try {
      await helmApi.harnessArchive(task.id, {
        oneLiner,
        filesTouched: filesTouched ? filesTouched.split(',').map((s) => s.trim()).filter(Boolean) : [],
        entities: entities ? entities.split(',').map((s) => s.trim()).filter(Boolean) : [],
      });
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(null); }
  };

  return (
    <article className="helm-card">
      <div className="row">
        <div style={{ flex: 1 }}>
          <div className="label">
            <code title={task.id}>{task.id}</code>
          </div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{task.title}</div>
          <div className="muted" style={{ marginTop: 4 }}>
            stage: <strong>{task.currentStage}</strong>
            {' · '}project: <code>{task.projectPath}</code>
            {task.hostSessionId && <> · chat: <code>{task.hostSessionId.slice(0, 8)}</code></>}
            {task.implementBaseCommit && <> · base: <code>{task.implementBaseCommit.slice(0, 8)}</code></>}
          </div>
          {task.intent?.objective && (
            <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
              <em>{task.intent.objective}</em>
            </div>
          )}
          {task.relatedTasks.length > 0 && (
            <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
              Related: {task.relatedTasks.map((r) => r.taskId).join(', ')}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {task.currentStage === 'implement' && (
            <button onClick={runReview} disabled={busy !== null}>
              {busy === 'review' ? 'Running…' : 'Run review'}
            </button>
          )}
          {latestReview && (
            <button onClick={() => setShowReport((v) => !v)}>
              {showReport ? 'Hide report' : 'View report'}
            </button>
          )}
          {task.currentStage !== 'archived' && (
            <button onClick={archive} disabled={busy !== null}>
              {busy === 'archive' ? 'Archiving…' : 'Archive'}
            </button>
          )}
        </div>
      </div>

      {showReport && latestReview && (
        <div style={{ marginTop: 12, padding: 12, background: 'var(--surface-2)', borderRadius: 6 }}>
          <div className="label">
            review · {latestReview.status} · {latestReview.completedAt ?? '(running)'}
          </div>
          {latestReview.error && <p style={{ color: 'var(--danger)' }}>{latestReview.error}</p>}
          {latestReview.reportText && (
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, marginTop: 8 }}>
              {latestReview.reportText}
            </pre>
          )}
          {latestReview.status === 'completed' && task.hostSessionId && (
            <button onClick={pushReview} disabled={busy !== null} style={{ marginTop: 8 }}>
              {busy === 'push' ? 'Pushing…' : 'Push to implement chat'}
            </button>
          )}
          {latestReview.status === 'completed' && !task.hostSessionId && (
            <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
              No Cursor chat is bound to this task. Bind a chat first to enable push.
            </p>
          )}
        </div>
      )}

      {err && <p className="muted" style={{ color: 'var(--danger)', marginTop: 8 }}>{err}</p>}
    </article>
  );
}

function CreateTaskForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [background, setBackground] = useState('');
  const [objective, setObjective] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const taskId = `${today}-${slug || 'untitled'}`;

  const submit = async () => {
    if (!title.trim() || !slug.trim() || !projectPath.trim()) {
      setErr('Title, slug, and project path are required.');
      return;
    }
    setBusy(true); setErr(null);
    try {
      await helmApi.harnessCreateTask({
        taskId,
        title: title.trim(),
        projectPath: projectPath.trim(),
        intent: {
          background: background.trim() || undefined,
          objective: objective.trim() || undefined,
        } as { background?: string; objective?: string },
      });
      onCreated();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <article className="helm-card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>New Harness task</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label>Title <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What feature is this?" style={{ width: '100%' }} /></label>
        <label>Slug (kebab-case) <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="add-search-filters" style={{ width: '100%' }} /></label>
        <div className="muted" style={{ fontSize: 12 }}>Task ID: <code>{taskId}</code></div>
        <label>Project path (absolute) <input value={projectPath} onChange={(e) => setProjectPath(e.target.value)} placeholder="/Users/you/projects/your-repo" style={{ width: '100%' }} /></label>
        <label>Background (optional) <textarea value={background} onChange={(e) => setBackground(e.target.value)} rows={3} style={{ width: '100%' }} /></label>
        <label>Objective (optional) <textarea value={objective} onChange={(e) => setObjective(e.target.value)} rows={2} style={{ width: '100%' }} /></label>
        {err && <p style={{ color: 'var(--danger)' }}>{err}</p>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="primary" onClick={submit} disabled={busy}>
            {busy ? 'Creating…' : 'Create'}
          </button>
          <button onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </div>
    </article>
  );
}
