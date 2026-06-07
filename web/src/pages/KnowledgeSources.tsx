/**
 * Knowledge › Sources — R-6 (reviewer follow-up).
 *
 * The bidirectional knowledge-repo manager. Lists subscribed repos
 * with sync-status badges; per-row Fetch / Import / Publish / Conflicts
 * actions hit the manager directly. A seed picker enrolls curated
 * repos in one click (e.g. llm-wiki).
 *
 * Why this page exists: PR 5.5a–e shipped the full backend
 * (subscribe / fetch / import / publish / conflicts), but the renderer
 * still pointed at the legacy Subscriptions page that only knew about
 * file:// mirror URLs. Without this surface, every git operation
 * required a curl from the terminal.
 */

import { useMemo, useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ApiError, helmApi } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';
import { Button } from '../components/Button.js';
import { Card } from '../components/Card.js';
import { EmptyState } from '../components/EmptyState.js';
import { PageHeader } from '../components/PageHeader.js';
import { CardSkeletonList } from '../components/Skeleton.js';
import type { KnowledgeMergeConflict, KnowledgeRepo, KnowledgeRepoSeed } from '../api/types.js';

export function KnowledgeSourcesPage(): ReactElement {
  const reposQuery = useApi(() => helmApi.listKnowledgeRepos('all'), []);
  const seedsQuery = useApi(() => helmApi.listKnowledgeRepoSeeds(), []);
  const conflictsQuery = useApi(() => helmApi.listKnowledgeRepoConflicts({ status: 'open' }), []);

  const reload = (): void => {
    reposQuery.reload();
    conflictsQuery.reload();
  };

  const conflictsByRepo = useMemo(() => {
    const map = new Map<string, KnowledgeMergeConflict[]>();
    for (const c of conflictsQuery.data?.conflicts ?? []) {
      const list = map.get(c.repoId) ?? [];
      list.push(c);
      map.set(c.repoId, list);
    }
    return map;
  }, [conflictsQuery.data]);

  return (
    <div className="helm-page">
      <PageHeader
        title="Knowledge sources"
        subtitle="Git repos helm pulls knowledge from + pushes back to. Internal repos can hold internal points; public repos cannot (R-0)."
      />

      <Card>
        <h3 style={{ marginTop: 0 }}>Subscribe to a repo</h3>
        <SubscribeForm onSubscribed={reload} />
      </Card>

      <Card>
        <h3 style={{ marginTop: 0 }}>One-click seeds</h3>
        <SeedList seeds={seedsQuery.data?.seeds ?? []} loading={seedsQuery.loading} onSubscribed={reload} />
      </Card>

      {reposQuery.loading && !reposQuery.data && <CardSkeletonList n={3} />}

      {reposQuery.error && (
        <EmptyState
          title="Could not load repos."
          hint={reposQuery.error instanceof Error ? reposQuery.error.message : String(reposQuery.error)}
        />
      )}

      {!reposQuery.loading && (reposQuery.data?.repos.length ?? 0) === 0 && (
        <EmptyState
          title="No subscriptions yet."
          hint="Paste a git URL above, or pick a one-click seed."
        />
      )}

      {(reposQuery.data?.repos ?? []).map((r) => (
        <RepoRow
          key={r.id}
          repo={r}
          conflicts={conflictsByRepo.get(r.id) ?? []}
          onActed={reload}
        />
      ))}
    </div>
  );
}

function SubscribeForm({ onSubscribed }: { onSubscribed: () => void }): ReactElement {
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (!url.trim()) {
      toast.error('Git URL is required.');
      return;
    }
    setBusy(true);
    try {
      await helmApi.subscribeKnowledgeRepo({
        url: url.trim(),
        ...(branch.trim() ? { branch: branch.trim() } : {}),
      });
      toast.success('Subscribed + cloned.');
      setUrl(''); setBranch('');
      onSubscribed();
    } catch (err) {
      if (err instanceof ApiError && err.status === 501) {
        toast.error('Git repo subscriptions are disabled in this helm build.');
      } else {
        toast.error(`Subscribe failed: ${err instanceof ApiError ? err.message : String(err)}`);
      }
    } finally { setBusy(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <label>Git URL
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="git@github.com:org/wiki.git or https://github.com/org/wiki"
          style={{ width: '100%' }}
          aria-label="Git URL"
        />
      </label>
      <label>Branch (optional)
        <input
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          placeholder="main"
          style={{ width: '100%' }}
          aria-label="Branch"
        />
      </label>
      <div>
        <Button onClick={submit} disabled={busy} variant="primary" aria-busy={busy}>
          {busy ? 'Cloning…' : 'Subscribe'}
        </Button>
      </div>
    </div>
  );
}

function SeedList({
  seeds, loading, onSubscribed,
}: {
  seeds: KnowledgeRepoSeed[];
  loading: boolean;
  onSubscribed: () => void;
}): ReactElement {
  const [busyId, setBusyId] = useState<string | null>(null);

  const enroll = async (id: string): Promise<void> => {
    setBusyId(id);
    try {
      await helmApi.subscribeKnowledgeRepoSeed(id);
      toast.success('Seed enrolled.');
      onSubscribed();
    } catch (err) {
      toast.error(`Enroll failed: ${err instanceof ApiError ? err.message : String(err)}`);
    } finally { setBusyId(null); }
  };

  if (loading) return <CardSkeletonList n={2} />;
  if (seeds.length === 0) {
    return <p className="muted" style={{ fontSize: 12 }}>No curated seeds available.</p>;
  }

  return (
    <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
      {seeds.map((s) => (
        <li key={s.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong>{s.label}</strong>
            <ClassificationBadge classification={s.classification} />
            <div className="muted" style={{ fontSize: 12 }}>{s.description}</div>
            <code style={{ fontSize: 11 }}>{s.url}</code>
          </div>
          <Button
            disabled={busyId === s.id}
            onClick={() => { void enroll(s.id); }}
            variant="primary"
            aria-busy={busyId === s.id}
          >
            {busyId === s.id ? 'Enrolling…' : 'Subscribe'}
          </Button>
        </li>
      ))}
    </ul>
  );
}

function RepoRow({
  repo, conflicts, onActed,
}: {
  repo: KnowledgeRepo;
  conflicts: KnowledgeMergeConflict[];
  onActed: () => void;
}): ReactElement {
  const [busy, setBusy] = useState<'fetch' | 'import' | 'unsubscribe' | null>(null);
  const [showConflicts, setShowConflicts] = useState(false);

  const run = async <T,>(label: typeof busy, fn: () => Promise<T>, successMsg: string): Promise<void> => {
    setBusy(label);
    try {
      await fn();
      toast.success(successMsg);
      onActed();
    } catch (err) {
      toast.error(`${label} failed: ${err instanceof ApiError ? err.message : String(err)}`);
    } finally { setBusy(null); }
  };

  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <div>
            <strong>{repo.url}</strong>
            <span className="muted" style={{ fontSize: 12 }}> · {repo.branch}</span>
          </div>
          <div style={{ fontSize: 11 }}>
            <ClassificationBadge classification={repo.classification} />
            <StatusBadge status={repo.status} />
            {conflicts.length > 0 && (
              <span style={{
                padding: '1px 6px', borderRadius: 4, fontSize: 11,
                backgroundColor: '#fef3c7', color: '#92400e',
                marginLeft: 4, fontWeight: 600,
              }}>
                {conflicts.length} conflict{conflicts.length === 1 ? '' : 's'}
              </span>
            )}
          </div>
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          {repo.lastFetchedSha
            ? <>last sha <code>{repo.lastFetchedSha.slice(0, 8)}</code>
              {repo.lastFetchedAt ? ` · ${new Date(repo.lastFetchedAt).toLocaleString()}` : ''}</>
            : 'never fetched'}
          {repo.lastError && <span style={{ color: '#dc2626' }}> · {repo.lastError}</span>}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          <Button
            disabled={busy !== null}
            aria-busy={busy === 'fetch'}
            onClick={() => { void run('fetch', () => helmApi.fetchKnowledgeRepoNow(repo.id), 'Fetched.'); }}
          >
            {busy === 'fetch' ? 'Fetching…' : 'Fetch'}
          </Button>
          <Button
            disabled={busy !== null}
            aria-busy={busy === 'import'}
            onClick={() => { void run('import', () => helmApi.importKnowledgeRepoNow(repo.id), 'Imported.'); }}
          >
            {busy === 'import' ? 'Importing…' : 'Import'}
          </Button>
          {conflicts.length > 0 && (
            <button onClick={() => setShowConflicts((p) => !p)}>
              {showConflicts ? 'Hide' : 'Resolve'} conflicts
            </button>
          )}
          <Link to={`/knowledge/library?publishTarget=${encodeURIComponent(repo.id)}`}>
            <Button>Publish ↗</Button>
          </Link>
          <span style={{ marginLeft: 'auto' }}>
            <button
              disabled={busy !== null}
              onClick={() => {
                void run('unsubscribe', () => helmApi.unsubscribeKnowledgeRepo(repo.id, true), 'Unsubscribed.');
              }}
              style={{ color: '#dc2626' }}
              title="Removes the row + wipes the local clone."
            >
              Unsubscribe
            </button>
          </span>
        </div>
        {showConflicts && (
          <ConflictResolver conflicts={conflicts} onResolved={onActed} />
        )}
      </div>
    </Card>
  );
}

function ConflictResolver({
  conflicts, onResolved,
}: {
  conflicts: KnowledgeMergeConflict[];
  onResolved: () => void;
}): ReactElement {
  return (
    <details open style={{ marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
      <summary style={{ cursor: 'pointer', fontSize: 12 }}>
        {conflicts.length} open conflict{conflicts.length === 1 ? '' : 's'}
      </summary>
      {conflicts.map((c) => <ConflictRow key={c.id} conflict={c} onResolved={onResolved} />)}
    </details>
  );
}

function ConflictRow({
  conflict, onResolved,
}: {
  conflict: KnowledgeMergeConflict;
  onResolved: () => void;
}): ReactElement {
  const [body, setBody] = useState(conflict.remoteBody);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      await helmApi.resolveKnowledgeRepoConflict(conflict.id, body);
      toast.success('Resolved.');
      onResolved();
    } catch (err) {
      toast.error(`Resolve failed: ${err instanceof ApiError ? err.message : String(err)}`);
    } finally { setBusy(false); }
  };

  return (
    <div style={{ padding: 8, border: '1px solid var(--border)', borderRadius: 4, marginTop: 6 }}>
      <div className="muted" style={{ fontSize: 11 }}>
        point <code>{conflict.pointId}</code> · local v{conflict.localVersion} vs remote <code>{conflict.remoteRevision.slice(0, 8)}</code>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 6, fontSize: 11 }}>
        <div>
          <div className="muted">Local</div>
          <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto', margin: 0 }}>{conflict.localBody}</pre>
        </div>
        <div>
          <div className="muted">Remote</div>
          <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto', margin: 0 }}>{conflict.remoteBody}</pre>
        </div>
      </div>
      <label style={{ display: 'block', marginTop: 6 }}>Resolved body
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={6}
          style={{ width: '100%', fontFamily: 'inherit', fontSize: 12 }}
        />
      </label>
      <div>
        <Button onClick={submit} disabled={busy} variant="primary" aria-busy={busy}>
          {busy ? 'Resolving…' : 'Apply resolution'}
        </Button>
      </div>
    </div>
  );
}

function ClassificationBadge({ classification }: { classification: 'internal' | 'public' }): ReactElement {
  const isInternal = classification === 'internal';
  return (
    <span style={{
      backgroundColor: isInternal ? '#fee2e2' : '#dcfce7',
      color: isInternal ? '#991b1b' : '#166534',
      padding: '1px 6px', borderRadius: 4, marginLeft: 6,
      fontSize: 11, textTransform: 'uppercase', fontWeight: 600,
    }}>{classification}</span>
  );
}

function StatusBadge({ status }: { status: KnowledgeRepo['status'] }): ReactElement {
  const style: Record<KnowledgeRepo['status'], { bg: string; fg: string }> = {
    active:   { bg: '#dcfce7', fg: '#166534' },
    paused:   { bg: '#e5e7eb', fg: '#374151' },
    error:    { bg: '#fee2e2', fg: '#991b1b' },
    conflict: { bg: '#fef3c7', fg: '#92400e' },
  };
  const s = style[status];
  return (
    <span style={{
      backgroundColor: s.bg, color: s.fg,
      padding: '1px 6px', borderRadius: 4, marginLeft: 4,
      fontSize: 11, textTransform: 'uppercase', fontWeight: 600,
    }}>{status}</span>
  );
}
