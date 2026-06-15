/**
 * Knowledge › 升格 — the "升级" stage of the knowledge lifecycle IA
 * (提取 → 使用 → 维护 → 升级). One page that answers "what's sitting in
 * my personal tier and how do I move it up":
 *
 *   1. 个人层未发布 — chat-captured files the remote hasn't seen,
 *      one-click batch MR (personal sync; still personal-tier).
 *   2. 升格到团队层 — pick a collection, consolidate fragments
 *      (✨AI 整理 inside the modal), open an MR into domains/<域>/.
 */

import { useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import { ApiError, helmApi } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';
import { Button } from '../components/Button.js';
import { Card } from '../components/Card.js';
import { EmptyState } from '../components/EmptyState.js';
import { PageHeader } from '../components/PageHeader.js';
import { StatTile } from '../components/StatTile.js';
import { CardSkeletonList } from '../components/Skeleton.js';
import { PromoteModal } from './Roles.js';
import type { UnpublishedCapturedFile } from '../api/types.js';

/**
 * Group unpublished chat-captured files by their topic (role) — the 3rd path
 * segment of chat-captured/<user>/<role>/<file>.md. Sorted by file count desc
 * so the heaviest topic is first. The 227-file flat list was unreadable.
 */
function groupFilesByTopic(
  files: readonly UnpublishedCapturedFile[],
): Array<[string, UnpublishedCapturedFile[]]> {
  const m = new Map<string, UnpublishedCapturedFile[]>();
  for (const f of files) {
    const seg = f.relPath.split('/');
    const roleId = seg.length >= 4 ? seg[2]! : '(其它)';
    const list = m.get(roleId) ?? [];
    list.push(f);
    m.set(roleId, list);
  }
  return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
}

function roleName(roles: { id: string; name: string }[], id: string): string {
  return roles.find((r) => r.id === id)?.name ?? id;
}

export function KnowledgePromotePage(): ReactElement {
  const reposQuery = useApi(() => helmApi.listKnowledgeRepos('active'), []);
  const rolesQuery = useApi(() => helmApi.roles(), []);
  const wikiRepo = (reposQuery.data?.repos ?? []).find((r) => r.profile === 'llm-wiki');
  const capturedQuery = useApi(
    () => wikiRepo
      ? helmApi.listCapturedUnpublished(wikiRepo.id)
      : Promise.resolve({ files: [] }),
    [wikiRepo?.id],
  );

  const [syncing, setSyncing] = useState(false);
  const [promoteTarget, setPromoteTarget] = useState<{ roleId: string; name: string } | null>(null);

  const files = capturedQuery.data?.files ?? [];
  const allRoles = rolesQuery.data?.roles ?? [];
  // Promotable = personal-layer knowledge with content. Team-layer
  // topics (tier === 'team', imported from domains/ or wiki/) are
  // already mature — Contributing them back to domains/ is a no-op, so
  // they're excluded here just like the card-level Contribute button.
  const promotable = allRoles.filter(
    (r) => !r.isBuiltin && r.chunkCount > 0 && r.tier !== 'team',
  );

  const syncPersonal = async (): Promise<void> => {
    if (!wikiRepo) return;
    setSyncing(true);
    try {
      const r = await helmApi.publishCaptured(wikiRepo.id);
      toast.success(r.prUrl
        ? `个人同步 MR 已创建：${r.prUrl}`
        : `分支已推送：${r.branch}（请手动开 MR）`);
      capturedQuery.reload();
    } catch (err) {
      toast.error(`同步失败: ${err instanceof ApiError ? err.message : String(err)}`);
    } finally { setSyncing(false); }
  };

  return (
    <div className="helm-page">
      <PageHeader
        title="Contribute"
        subtitle={<>升级层：把个人层的知识推向团队。两种 MR 语义不同 —— <strong>个人同步</strong>把 chat-captured 文件推到远端（仍是个人态）；<strong>Contribute</strong> 把整理后的文档送进 domains/&lt;域&gt;/，评审合入后成为团队成熟知识。</>}
        stats={<>
          <StatTile label="未发布碎片" value={files.length} tone={files.length > 0 ? 'warn' : 'muted'} />
          <StatTile label="可 Contribute" value={promotable.length} tone={promotable.length > 0 ? 'live' : 'muted'} />
        </>}
      />

      {!wikiRepo && !reposQuery.loading && (
        <EmptyState
          title="未订阅 llm-wiki 仓库。"
          hint={<>先在 Sources 页订阅 llm-wiki，个人层与 Contribute 通道才会生效。</>}
        />
      )}

      {wikiRepo && (
        <Card>
          <h3 style={{ marginTop: 0 }}>① 个人层未发布（同步 MR）</h3>
          {files.length === 0
            ? <p className="muted" style={{ marginBottom: 0 }}>chat-captured 没有待同步的文件 — 个人层与远端一致。</p>
            : (
              <>
                <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
                  按 topic 聚合，共 {files.length} 个文件待同步。一次同步推送全部（一个 MR）。
                </p>
                {groupFilesByTopic(files).map(([roleId, fs]) => {
                  const modified = fs.filter((f) => !f.isNew).length;
                  const skipped = fs.filter((f) => !f.pointId).length;
                  return (
                    <details key={roleId} style={{ margin: '4px 0' }}>
                      <summary style={{ cursor: 'pointer', fontSize: 13 }}>
                        <strong>{roleName(allRoles, roleId)}</strong>
                        <span className="muted" style={{ fontSize: 12 }}>
                          {' '}· {fs.length} 个文件
                          {modified > 0 && <span style={{ color: '#92400e' }}> · {modified} 已修改</span>}
                          {skipped > 0 && <span style={{ color: '#dc2626' }}> · {skipped} 未入索引（将跳过）</span>}
                        </span>
                      </summary>
                      <ul style={{ margin: '4px 0 8px', paddingLeft: 18, fontSize: 12 }}>
                        {fs.map((f) => (
                          <li key={f.relPath}>
                            <code>{f.relPath.split('/').pop()}</code>
                            {f.title && <span className="muted"> — {f.title}</span>}
                            {!f.isNew && <span style={{ color: '#92400e' }}> · 已修改</span>}
                            {!f.pointId && <span style={{ color: '#dc2626' }}> · 未入索引</span>}
                          </li>
                        ))}
                      </ul>
                    </details>
                  );
                })}
                <Button
                  disabled={syncing || files.every((f) => !f.pointId)}
                  aria-busy={syncing}
                  onClick={() => { void syncPersonal(); }}
                  title="把本地 chat-captured 文件推到远端（开一个 MR）；仍是个人态，不进 domains/"
                  style={{ marginTop: 8 }}
                >
                  {syncing ? '开 MR 中…' : `同步 ${files.filter((f) => f.pointId).length} 条到远端（个人态）`}
                </Button>
              </>
            )}
        </Card>
      )}

      {wikiRepo && (
        <Card>
          <h3 style={{ marginTop: 0 }}>② Contribute 到团队层（domains/）</h3>
          <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
            选一个 topic → 勾碎片 → ✨AI 整理成文档 → MR 进 domains/&lt;域&gt;/。
          </p>
          {rolesQuery.loading && <CardSkeletonList n={2} />}
          {promotable.length === 0 && !rolesQuery.loading && (
            <p className="muted" style={{ marginBottom: 0 }}>还没有带知识点的 topic。先在对话里沉淀一些碎片。</p>
          )}
          {promotable.map((r) => (
            <div
              key={r.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 0', borderBottom: '1px solid var(--border)',
              }}
            >
              <div style={{ flex: 1 }}>
                <strong>{r.name}</strong>
                <span className="muted" style={{ fontSize: 12 }}>
                  {' '}· {r.bindable === false ? 'topic' : 'expert'} · {r.chunkCount} 条知识点
                </span>
              </div>
              <Button
                onClick={() => setPromoteTarget({ roleId: r.id, name: r.name })}
                title={`把 ${r.name} 的碎片整理成文档，Contribute 到 domains/<域>/`}
              >
                Contribute…
              </Button>
            </div>
          ))}
        </Card>
      )}

      {promoteTarget && (
        <PromoteModal
          roleId={promoteTarget.roleId}
          roleName={promoteTarget.name}
          onClose={() => setPromoteTarget(null)}
        />
      )}
    </div>
  );
}
