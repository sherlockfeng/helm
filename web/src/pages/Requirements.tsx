/**
 * Requirements — list view over `recallRequirements` (B3).
 *
 * Capture is a multi-step Q&A handled by the agent via the
 * `capture_requirement` MCP tool — it doesn't translate cleanly to a
 * single-form page. This page is read-only: list, search by name/tag,
 * expand for full body. The agent populates the table; the UI surfaces
 * what's there for the user to review or share.
 */

import { useEffect, useState } from 'react';
import { ApiError, helmApi } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';
import { EmptyState } from '../components/EmptyState.js';
import type { Requirement } from '../api/types.js';

function RequirementCard({ req }: { req: Requirement }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <article className="helm-card">
      <div className="row">
        <div style={{ flex: 1 }}>
          <div className="label">
            {req.status}
            {req.tags && req.tags.length > 0 && (
              <> · {req.tags.map((t) => (
                <code key={t} style={{ marginRight: 4 }}>{t}</code>
              ))}</>
            )}
          </div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{req.name}</div>
          {req.purpose && (
            <div className="muted" style={{ marginTop: 4, marginBottom: 0 }}>{req.purpose}</div>
          )}
          {req.projectPath && (
            <div className="label" style={{ marginTop: 6 }}>{req.projectPath}</div>
          )}
        </div>
        <button onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Hide' : 'Show'}
        </button>
      </div>

      {expanded && (
        <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          {req.context && (
            <>
              <div className="label">Context</div>
              <pre style={{ marginBottom: 12 }}>{req.context}</pre>
            </>
          )}
          {req.summary && (
            <>
              <div className="label">Summary</div>
              <pre style={{ marginBottom: 12 }}>{req.summary}</pre>
            </>
          )}
          {req.relatedDocs && req.relatedDocs.length > 0 && (
            <>
              <div className="label">Related docs</div>
              <ul style={{ margin: '4px 0 12px', paddingLeft: 20 }}>
                {req.relatedDocs.map((d, i) => <li key={i}><code>{d}</code></li>)}
              </ul>
            </>
          )}
          {req.changes && req.changes.length > 0 && (
            <>
              <div className="label">Changes</div>
              <ul style={{ margin: '4px 0 12px', paddingLeft: 20 }}>
                {req.changes.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </>
          )}
          {req.todos && req.todos.length > 0 && (
            <>
              <div className="label">Todos</div>
              <ul style={{ margin: '4px 0 12px', paddingLeft: 0, listStyle: 'none' }}>
                {req.todos.map((t) => (
                  <li key={t.id} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                    <input type="checkbox" checked={t.done} disabled style={{ marginTop: 4 }} />
                    <span style={{ textDecoration: t.done ? 'line-through' : 'none' }}>{t.text}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="muted" style={{ fontSize: 11, margin: 0 }}>
            Created {new Date(req.createdAt).toLocaleString()}
            {req.updatedAt !== req.createdAt && (
              <> · updated {new Date(req.updatedAt).toLocaleString()}</>
            )}
          </p>
        </div>
      )}
    </article>
  );
}

export function RequirementsPage() {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Debounce the search box so we don't hammer the endpoint on each keystroke.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(id);
  }, [query]);

  const { data, loading, error: apiError } = useApi(
    () => helmApi.requirements(debounced || undefined).catch((err) => {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setError(msg);
      throw err;
    }),
    [debounced],
  );

  return (
    <>
      <h2>Requirements</h2>
      <p className="muted">
        Captured by the agent via <code>capture_requirement</code>. Surfaced
        here for review + sharing — capture itself stays in Cursor where the
        Q&amp;A flow lives.
      </p>

      <div style={{ marginBottom: 16 }}>
        <input
          type="search"
          value={query}
          placeholder="Search by name, tag, or text…"
          aria-label="Search requirements"
          onChange={(e) => { setQuery(e.target.value); setError(null); }}
          style={{ width: '100%' }}
        />
      </div>

      {loading && <p className="muted">Loading…</p>}
      {(apiError || error) && (
        <p className="muted" style={{ color: 'var(--danger)' }}>{(apiError ?? new Error(error!)).message}</p>
      )}

      {data && data.requirements.length === 0 && (
        <EmptyState
          title={debounced ? `No requirements match "${debounced}".` : 'No requirements captured yet.'}
          hint={debounced
            ? 'Try a shorter or more specific query.'
            : <>Run <code>capture_requirement</code> from a Cursor chat to record one.</>}
        />
      )}

      {data && data.requirements.map((r) => (
        <RequirementCard key={r.id} req={r} />
      ))}
    </>
  );
}
