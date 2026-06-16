/**
 * Knowledge › Sources — R-6 (reviewer follow-up).
 *
 * The bidirectional knowledge-repo manager. Lists subscribed repos
 * with sync-status badges; per-row Fetch / Import / Publish actions hit
 * the manager directly. A seed picker enrolls curated repos in one
 * click (e.g. llm-wiki). The PR 5.5c merge-conflict resolver was
 * retired in files-as-truth PR-4 — files win; imports sync the DB.
 *
 * Why this page exists: PR 5.5a–e shipped the full backend
 * (subscribe / fetch / import / publish / conflicts), but the renderer
 * still pointed at the legacy Subscriptions page that only knew about
 * file:// mirror URLs. Without this surface, every git operation
 * required a curl from the terminal.
 */

import { useEffect, useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import { ApiError, helmApi } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';
import { Button } from '../components/Button.js';
import { Card } from '../components/Card.js';
import { Dialog, DialogContent } from '../components/Dialog.js';
import { EmptyState } from '../components/EmptyState.js';
import { PageHeader } from '../components/PageHeader.js';
import { CardSkeletonList } from '../components/Skeleton.js';
import type {
  KnowledgeRepo,
  KnowledgeRepoSeed,
  RoleChunk,
  UnpublishedCapturedFile,
} from '../api/types.js';

export function KnowledgeSourcesPage(): ReactElement {
  const reposQuery = useApi(() => helmApi.listKnowledgeRepos('all'), []);
  const seedsQuery = useApi(() => helmApi.listKnowledgeRepoSeeds(), []);

  const reload = (): void => {
    reposQuery.reload();
  };

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
        <Button onClick={submit} disabled={busy} variant="primary" aria-busy={busy}
          title="克隆这个仓库到本地并订阅，之后可 Fetch / Import 它的知识">
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
            title="订阅这个推荐仓库：克隆到本地并加入知识来源"
          >
            {busyId === s.id ? 'Enrolling…' : 'Subscribe'}
          </Button>
        </li>
      ))}
    </ul>
  );
}

function RepoRow({
  repo, onActed,
}: {
  repo: KnowledgeRepo;
  onActed: () => void;
}): ReactElement {
  const [busy, setBusy] = useState<'fetch' | 'import' | 'unsubscribe' | null>(null);
  const [showPublish, setShowPublish] = useState(false);

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
            title="git fetch：把远端最新内容拉到本地克隆（还不写入索引）"
          >
            {busy === 'fetch' ? 'Fetching…' : 'Fetch'}
          </Button>
          <Button
            disabled={busy !== null}
            aria-busy={busy === 'import'}
            onClick={() => { void run('import', () => helmApi.importKnowledgeRepoNow(repo.id), 'Imported.'); }}
            title="把本地克隆里白名单目录的 .md 解析成 topic 与知识点，写入 helm 索引"
          >
            {busy === 'import' ? 'Importing…' : 'Import'}
          </Button>
          <Button
            disabled={busy !== null}
            onClick={() => setShowPublish(true)}
            title="把本地 topic 的知识点序列化成 .md，推一个分支回这个仓库"
          >
            Publish ↗
          </Button>
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
        {repo.profile === 'llm-wiki' && (
          <>
            <ImportDirsPanel repo={repo} onSaved={onActed} />
            <CapturedPanel repo={repo} busyParent={busy !== null} />
          </>
        )}
      </div>
      {showPublish && (
        <PublishModal
          repo={repo}
          onClose={() => setShowPublish(false)}
        />
      )}
    </Card>
  );
}

/**
 * v28 + 树状选择: import whitelist with two levels. Entries are either
 * a whole top dir ('wiki') or a `top/sub` path ('domains/stability').
 * 全不勾 = import everything; chat-captured/ is always imported.
 */
function ImportDirsPanel({
  repo, onSaved,
}: { repo: KnowledgeRepo; onSaved: () => void }): ReactElement | null {
  const dirsQuery = useApi(() => helmApi.getRepoDirs(repo.id), [repo.id]);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [saving, setSaving] = useState(false);

  if (dirsQuery.loading || dirsQuery.error) return null;
  const tree = dirsQuery.data?.tree ?? (dirsQuery.data?.dirs ?? []).map((name) => ({ name, children: [] as string[] }));
  if (tree.length === 0) return null;
  const saved = dirsQuery.data?.importDirs ?? null;
  const current = selected ?? new Set(saved ?? []);
  const whitelistActive = saved !== null && saved.length > 0;

  const topState = (name: string, children: string[]): 'all' | 'partial' | 'none' => {
    if (current.has(name)) return 'all';
    return children.some((c) => current.has(`${name}/${c}`)) ? 'partial' : 'none';
  };

  const toggleTop = (name: string, children: string[]): void => {
    const next = new Set(current);
    const state = topState(name, children);
    // any state → flip between "whole dir" and "nothing"
    next.delete(name);
    for (const c of children) next.delete(`${name}/${c}`);
    if (state !== 'all') next.add(name);
    setSelected(next);
  };

  const toggleChild = (top: string, child: string, children: string[]): void => {
    const next = new Set(current);
    if (next.has(top)) {
      // whole-dir → partial: everything except this child
      next.delete(top);
      for (const c of children) if (c !== child) next.add(`${top}/${c}`);
    } else {
      const key = `${top}/${child}`;
      if (next.has(key)) next.delete(key); else next.add(key);
      // all children individually selected → collapse to whole dir
      if (children.length > 0 && children.every((c) => next.has(`${top}/${c}`))) {
        for (const c of children) next.delete(`${top}/${c}`);
        next.add(top);
      }
    }
    setSelected(next);
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const dirsToSave = current.size > 0 ? [...current].sort() : null;
      await helmApi.setRepoImportDirs(repo.id, dirsToSave);
      toast.success(dirsToSave
        ? `已保存白名单（${dirsToSave.length} 条）。重新 Import 生效。`
        : '已清除白名单：导入全部目录。重新 Import 生效。');
      dirsQuery.reload();
      setSelected(null);
      onSaved();
    } catch (err) {
      toast.error(`保存失败: ${err instanceof ApiError ? err.message : String(err)}`);
    } finally { setSaving(false); }
  };

  return (
    <div style={{ marginTop: 4 }}>
      <button onClick={() => setOpen((p) => !p)} style={{ fontSize: 12 }}>
        导入目录：{whitelistActive ? `${saved!.length} 条白名单` : '全部'} {open ? '▴' : '▾'}
      </button>
      {open && (
        <div style={{
          marginTop: 6, padding: '8px 10px', borderRadius: 6,
          border: '1px solid var(--border)',
        }}>
          <p className="muted" style={{ margin: '0 0 6px', fontSize: 11 }}>
            勾选要导入为知识的目录，支持展开选子层级（如 domains/stability）；
            全不勾 = 导入全部。chat-captured/ 永远导入，不在列表中。
            改动后需手动 Import 重建索引；已导入的旧目录数据不会自动清除。
          </p>
          {tree.map(({ name, children }) => {
            const state = topState(name, children);
            const isOpen = expanded.has(name);
            return (
              <div key={name} style={{ marginBottom: 2 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  {children.length > 0 ? (
                    <button
                      onClick={() => setExpanded((prev) => {
                        const n = new Set(prev);
                        if (n.has(name)) n.delete(name); else n.add(name);
                        return n;
                      })}
                      style={{ fontSize: 10, width: 18, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                      aria-label={`expand ${name}`}
                    >
                      {isOpen ? '▾' : '▸'}
                    </button>
                  ) : <span style={{ width: 18, display: 'inline-block' }} />}
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={state === 'all'}
                      ref={(el) => { if (el) el.indeterminate = state === 'partial'; }}
                      onChange={() => toggleTop(name, children)}
                    />
                    <code>{name}/</code>
                    {state === 'partial' && (
                      <span className="muted" style={{ fontSize: 10 }}>
                        （{children.filter((c) => current.has(`${name}/${c}`)).length}/{children.length} 子目录）
                      </span>
                    )}
                  </label>
                </div>
                {isOpen && children.map((c) => (
                  <label key={c} style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    fontSize: 12, marginLeft: 40,
                  }}>
                    <input
                      type="checkbox"
                      checked={current.has(name) || current.has(`${name}/${c}`)}
                      onChange={() => toggleChild(name, c, children)}
                    />
                    <code>{name}/{c}/</code>
                  </label>
                ))}
              </div>
            );
          })}
          <div style={{ marginTop: 8 }}>
            <Button disabled={saving || selected === null} aria-busy={saving}
              onClick={() => { void save(); }}
              title="保存导入白名单：只有勾选的目录会在下次 Import 时写入索引">
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Files-as-truth PR-3: "N 条已沉淀未发布" — captured points sitting in
 * the working copy that the remote hasn't seen. One click opens a
 * single batch MR for all of them (公司仓库必须走 MR).
 */
export function CapturedPanel({
  repo, busyParent,
}: { repo: KnowledgeRepo; busyParent: boolean }): ReactElement | null {
  const capturedQuery = useApi(() => helmApi.listCapturedUnpublished(repo.id), [repo.id]);
  const [publishing, setPublishing] = useState(false);
  const [lastResult, setLastResult] = useState<{ branch: string; prUrl: string } | null>(null);

  const files: UnpublishedCapturedFile[] = capturedQuery.data?.files ?? [];
  if (capturedQuery.loading || files.length === 0) return null;
  // Publishable = indexed knowledge points + benchmark-case files (the latter
  // ride the MR as extraFiles even without a DB pointId). Only files that are
  // neither are genuinely skipped.
  const publishable = files.filter((f) => f.pointId || f.isCase);

  const openMr = async (): Promise<void> => {
    setPublishing(true);
    try {
      const r = await helmApi.publishCaptured(repo.id);
      setLastResult({ branch: r.branch, prUrl: r.prUrl });
      toast.success(r.prUrl
        ? `MR 已创建：${r.prUrl}`
        : `分支已推送：${r.branch}（未检测到 gh/glab，请手动开 MR）`);
      capturedQuery.reload();
    } catch (err) {
      toast.error(`开 MR 失败: ${err instanceof ApiError ? err.message : String(err)}`);
    } finally { setPublishing(false); }
  };

  return (
    <div style={{
      marginTop: 6, padding: '8px 10px', borderRadius: 6,
      backgroundColor: '#eff6ff', border: '1px solid #bfdbfe',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#1d4ed8' }}>
          {files.length} 条已沉淀未发布
        </span>
        <Button
          disabled={publishing || busyParent || publishable.length === 0}
          aria-busy={publishing}
          onClick={() => { void openMr(); }}
          title="批量序列化 chat-captured 知识点 + case 文件，推分支并创建 MR"
        >
          {publishing ? '开 MR 中…' : '开 MR'}
        </Button>
        {lastResult?.prUrl && (
          <a href={lastResult.prUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
            {lastResult.prUrl}
          </a>
        )}
      </div>
      <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12 }}>
        {files.map((f) => (
          <li key={f.relPath}>
            <code>{f.relPath}</code>
            {f.title && <span className="muted"> — {f.title}</span>}
            {!f.isNew && <span style={{ color: '#92400e' }}> · 已修改</span>}
            {f.isCase && <span className="muted"> · case</span>}
            {!f.pointId && !f.isCase && <span style={{ color: '#dc2626' }}> · 未入索引（将跳过）</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PublishModal({
  repo,
  onClose,
}: {
  repo: KnowledgeRepo;
  onClose: () => void;
}): ReactElement {
  const rolesQuery = useApi(() => helmApi.roles(), []);
  const [roleId, setRoleId] = useState<string>('');
  const [chunks, setChunks] = useState<RoleChunk[]>([]);
  const [loadingChunks, setLoadingChunks] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ branch: string; prUrl: string; filesWritten: number } | null>(null);

  // Serialization profile — defaults to the one pinned at subscribe
  // time (v26), overridable per publish. 'generic' has no serializer →
  // degrade to helm-native frontmatter.
  const [profile, setProfile] = useState<'helm-native' | 'llm-wiki'>(
    repo.profile === 'llm-wiki' ? 'llm-wiki' : 'helm-native',
  );

  const roles = rolesQuery.data?.roles ?? [];
  const isPublicRepo = repo.classification === 'public';

  useEffect(() => {
    if (!roleId) { setChunks([]); setSelected(new Set()); return; }
    setLoadingChunks(true);
    helmApi.role(roleId)
      .then((r) => {
        const active = r.chunks.filter((c) => !c.archived);
        setChunks(active);
        setSelected(new Set());
      })
      .catch((err) => {
        toast.error(`Load chunks: ${err instanceof ApiError ? err.message : String(err)}`);
      })
      .finally(() => setLoadingChunks(false));
  }, [roleId]);

  const eligible = (c: RoleChunk): boolean =>
    !isPublicRepo || c.visibility === 'public';

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll(): void {
    setSelected(new Set(chunks.filter(eligible).map((c) => c.id)));
  }

  async function submit(): Promise<void> {
    if (selected.size === 0) return;
    setSubmitting(true);
    try {
      const roleName = roles.find((r) => r.id === roleId)?.name ?? roleId;
      const r = await helmApi.publishKnowledgeRepo(repo.id, {
        pointIds: Array.from(selected),
        message: message.trim()
          || `docs(knowledge): publish ${selected.size} point${selected.size === 1 ? '' : 's'} from helm role ${roleName}`,
        profile,
      });
      setResult(r);
    } catch (err) {
      toast.error(`Publish: ${err instanceof ApiError ? err.message : String(err)}`);
    } finally { setSubmitting(false); }
  }

  return (
    <Dialog open={true} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        width={Math.min(640, typeof window !== 'undefined' ? window.innerWidth * 0.9 : 640)}
        aria-label="Publish knowledge to repo"
      >
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Publish 回 {repo.url.split('/').pop()?.replace(/\.git$/, '')}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            选中的知识点会被序列化成 .md，推一个分支到 <code>{repo.branch}</code> 之上
            {isPublicRepo && '。公开仓库只能发布 visibility=public 的 chunk（R-0）'}
          </div>
        </div>

        {result ? (
          <div>
            <p style={{ fontSize: 13 }}>
              ✅ 已推送 <strong>{result.filesWritten}</strong> 个文件到分支{' '}
              <code>{result.branch}</code>
            </p>
            {result.prUrl ? (
              <p style={{ fontSize: 13 }}>
                MR: <a href={result.prUrl} target="_blank" rel="noreferrer">{result.prUrl}</a>
              </p>
            ) : (
              <p className="muted" style={{ fontSize: 12 }}>
                未自动创建 MR（本机没有该平台的 CLI）。分支已在远端，去仓库页面手动开 MR 即可。
              </p>
            )}
            <div style={{ marginTop: 12 }}>
              <Button onClick={onClose}>完成</Button>
            </div>
          </div>
        ) : (
          <>
            <label style={{ display: 'block', marginBottom: 10 }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Role</div>
              <select
                value={roleId}
                onChange={(e) => setRoleId(e.target.value)}
                style={{ width: '100%', padding: '6px 8px', fontSize: 13 }}
              >
                <option value="">选择要发布的 topic…</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>{r.name} ({r.chunkCount} chunks)</option>
                ))}
              </select>
            </label>

            {loadingChunks && <p className="muted" style={{ fontSize: 12 }}>加载 chunks…</p>}

            {!loadingChunks && roleId && chunks.length === 0 && (
              <p className="muted" style={{ fontSize: 12 }}>这个 topic 还没有知识 chunks。</p>
            )}

            {chunks.length > 0 && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                  <span className="muted" style={{ fontSize: 12 }}>
                    已选 {selected.size} / {chunks.filter(eligible).length} 可发布
                  </span>
                  <button type="button" onClick={selectAll} style={{ fontSize: 12 }}>全选</button>
                </div>
                <ul style={{
                  listStyle: 'none', margin: 0, padding: 0,
                  maxHeight: 260, overflowY: 'auto',
                  border: '1px solid var(--border)', borderRadius: 6,
                }}>
                  {chunks.map((c) => {
                    const ok = eligible(c);
                    return (
                      <li key={c.id} style={{
                        display: 'flex', gap: 8, alignItems: 'flex-start',
                        padding: '6px 10px', borderBottom: '1px solid var(--border)',
                        opacity: ok ? 1 : 0.45,
                      }}>
                        <input
                          type="checkbox"
                          checked={selected.has(c.id)}
                          disabled={!ok}
                          onChange={() => toggle(c.id)}
                          style={{ marginTop: 3 }}
                        />
                        <div style={{ minWidth: 0, fontSize: 12 }}>
                          <div style={{
                            overflow: 'hidden', textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap', color: 'var(--text)',
                          }}>
                            {(c.chunkText.split('\n')[0] ?? '').slice(0, 90) || c.id}
                          </div>
                          <div className="muted" style={{ fontSize: 11 }}>
                            {c.kind}{c.sourceFile ? ` · ${c.sourceFile}` : ''}
                            {!ok && ' · internal — 公开仓库不可发布'}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}

            <label style={{ display: 'block', marginTop: 12 }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Commit / MR 信息（可选，留空自动生成）</div>
              <input
                type="text"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="docs(knowledge): …"
                style={{
                  width: '100%', padding: '6px 10px', fontSize: 13,
                  border: '1px solid var(--border)', borderRadius: 6,
                }}
              />
            </label>

            <label style={{ display: 'block', marginTop: 10 }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>序列化格式</div>
              <select
                value={profile}
                onChange={(e) => setProfile(e.target.value as 'helm-native' | 'llm-wiki')}
                style={{ padding: '4px 8px', fontSize: 12 }}
              >
                <option value="llm-wiki">llm-wiki（# 标题 + concept 块，顶层目录=topic）</option>
                <option value="helm-native">helm-native（frontmatter，roles/&lt;id&gt;/points/）</option>
              </select>
            </label>

            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <Button
                variant="primary"
                disabled={submitting || selected.size === 0}
                onClick={() => { void submit(); }}
                title="把勾选的知识点序列化成 .md，推一个分支回这个仓库"
              >
                {submitting ? '推送中…' : `Publish ${selected.size} 个知识点`}
              </Button>
              <button type="button" onClick={onClose} disabled={submitting}>取消</button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
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
