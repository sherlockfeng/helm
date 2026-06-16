/**
 * Roles — list + detail + train form (B3).
 *
 * Built-in roles (product / developer / qa from Phase 7) are seeded at boot.
 * User-trained roles add markdown documents that get chunked + embedded so
 * `query_knowledge` (and the cross-role search inside LocalRolesProvider)
 * can surface them at session_start.
 *
 * Train form uses <input type="file" multiple accept=".md"> + FileReader to
 * read the contents client-side, then POSTs to /api/roles/:id/train. No
 * upload-progress UI for v1 — chunking + embedding takes a few seconds even
 * for a 10-file set, gated on aria-busy.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ApiError, helmApi } from '../api/client.js';
import { useCandidateContexts } from '../hooks/useCandidateContexts.js';
import { ExternalContextBox } from '../components/ExternalContextBox.js';
import { useApi } from '../hooks/useApi.js';
import { EmptyState } from '../components/EmptyState.js';
import { Button } from '../components/Button.js';
import { Card } from '../components/Card.js';
import { ConfirmDialog, Dialog, DialogContent } from '../components/Dialog.js';
import { PageHeader } from '../components/PageHeader.js';
import { StatTile } from '../components/StatTile.js';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/Tabs.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/Select.js';
import { CardSkeletonList } from '../components/Skeleton.js';
import type { KnowledgeChunkKind, RoleSummary } from '../api/types.js';
import {
  getProposedCountForRole,
  useProposedCases,
} from '../lib/proposal-notifications.js';

/**
 * Phase 73 — palette for the chunk-kind badge. Reuses existing semantic
 * tokens (--danger, --success) where they fit so colors stay coherent
 * across helm without introducing new tokens.
 */
const KIND_BADGE_STYLE: Record<KnowledgeChunkKind, { bg: string; fg: string; label: string }> = {
  spec:     { bg: '#3b82f6', fg: '#fff', label: 'spec' },
  example:  { bg: '#10b981', fg: '#fff', label: 'example' },
  warning:  { bg: '#ef4444', fg: '#fff', label: 'warning' },
  runbook:  { bg: '#8b5cf6', fg: '#fff', label: 'runbook' },
  glossary: { bg: '#6b7280', fg: '#fff', label: 'glossary' },
  other:    { bg: 'var(--border)', fg: 'var(--text-secondary)', label: 'other' },
};

function KindBadge({ kind }: { kind: KnowledgeChunkKind }) {
  const style = KIND_BADGE_STYLE[kind];
  return (
    <span style={{
      display: 'inline-block',
      background: style.bg, color: style.fg,
      fontSize: 10, fontWeight: 600, padding: '1px 6px',
      borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.5,
    }}>{style.label}</span>
  );
}

const KIND_OPTIONS: KnowledgeChunkKind[] = ['other', 'spec', 'example', 'warning', 'runbook', 'glossary'];

/**
 * R-7 — chip + toggle for the R-0 publish gate. Internal is the
 * default + safe direction; flipping to Public requires a confirm
 * because R-0 lets the chunk land on a public git repo afterwards.
 */
function VisibilityChip({ visibility }: { visibility: 'internal' | 'public' }) {
  const isInternal = visibility === 'internal';
  return (
    <span style={{
      display: 'inline-block',
      background: isInternal ? '#fee2e2' : '#dcfce7',
      color: isInternal ? '#991b1b' : '#166534',
      fontSize: 10, fontWeight: 600, padding: '1px 6px',
      borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.5,
    }} title={isInternal
      ? 'Internal — cannot be published to a public repo.'
      : 'Public — eligible for publish to public repos.'}>
      {visibility}
    </span>
  );
}

/** R-9 — proposed verification cases targeting this role. Hidden at 0. */
function ProposedCaseChip({ roleId }: { roleId: string }) {
  useProposedCases();
  const n = getProposedCountForRole(roleId);
  if (n === 0) return null;
  return (
    <span
      className="helm-status"
      style={{ background: '#fef3c7', color: '#92400e' }}
      title={`${n} proposed verification case${n === 1 ? '' : 's'} target this topic — confirm or reject in Verification › Cases (Proposed).`}
    >
      {n} proposed
    </span>
  );
}

function VisibilityToggle({
  chunkId, visibility, editVersion, busy, confirm, onAskConfirm, onFlip,
}: {
  chunkId: string;
  visibility: 'internal' | 'public';
  editVersion: number;
  busy: boolean;
  confirm: { chunkId: string; editVersion: number } | null;
  onAskConfirm: (c: { chunkId: string; editVersion: number } | null) => void;
  onFlip: (next: 'internal' | 'public', expectedEditVersion: number) => void;
}) {
  const isInternal = visibility === 'internal';
  if (confirm?.chunkId === chunkId) {
    return (
      <span style={{ display: 'inline-flex', gap: 4, fontSize: 11 }}>
        <span style={{ color: '#92400e' }}>设为公开？</span>
        <button
          type="button"
          disabled={busy}
          aria-busy={busy}
          onClick={() => onFlip('public', confirm.editVersion)}
          style={{ color: '#166534' }}
        >
          {busy ? '处理中…' : '确认公开'}
        </button>
        <button type="button" onClick={() => onAskConfirm(null)}>Cancel</button>
      </span>
    );
  }
  return (
    <button
      type="button"
      disabled={busy}
      aria-busy={busy}
      onClick={() => {
        if (isInternal) {
          onAskConfirm({ chunkId, editVersion });
        } else {
          onFlip('internal', editVersion);
        }
      }}
      style={{ fontSize: 11 }}
      title={isInternal
        ? '设为公开，这条知识点才能发布到公开仓库。'
        : '改回内部，阻止发布到公开仓库。'}
    >
      {isInternal ? '→ Public' : '→ Internal'}
    </button>
  );
}

/**
 * Phase 77 — compact relative-time formatter for chunk access stats.
 * Returns "Nm ago" / "Nh ago" / "Nd ago" — keep cards visually tight.
 * Falls back to the raw ISO string for unparseable input rather than
 * throwing; this is decoration, not data.
 */
function formatRelative(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  const deltaMs = Date.now() - ts;
  if (deltaMs < 60_000) return 'just now';
  const mins = Math.floor(deltaMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function shortId(id: string, len = 12): string {
  return id.length > len ? `${id.slice(0, len)}…` : id;
}

function summarizePrompt(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…';
}

/**
 * 知识阶梯 PR-γ: 升格弹窗 — 选这个集合里的碎片 → 合并成一篇可编辑的
 * 文档 → MR 进 llm-wiki 的 domains/<域>/。合入并 pull 后内容回到团队
 * 成熟层。原碎片不自动删除（MR 可能被拒），合入后手动清理。
 */
export function PromoteModal({ roleId, roleName, onClose }: {
  roleId: string;
  roleName: string;
  onClose: () => void;
}) {
  const detail = useApi(() => helmApi.role(roleId), [roleId]);
  const repos = useApi(() => helmApi.listKnowledgeRepos('active'), []);
  const wikiRepo = (repos.data?.repos ?? []).find((r) => r.profile === 'llm-wiki');
  const domains = useApi(
    () => wikiRepo
      ? helmApi.getRepoDirs(wikiRepo.id, 'domains')
      : Promise.resolve({ dirs: [], importDirs: null }),
    [wikiRepo?.id],
  );

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [domain, setDomain] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [result, setResult] = useState<{ prUrl: string; branch: string; relPath: string } | null>(null);

  const chunks = detail.data?.chunks ?? [];

  // PR-γ2: AI 整理 — LLM merges the selected fragments into a polished
  // draft, pulling the external knowledge sources in as reference.
  const aiDraft = async (): Promise<void> => {
    if (!wikiRepo) { toast.error('没有订阅 llm-wiki 仓库'); return; }
    const fragments = chunks.filter((c) => selected.has(c.id)).map((c) => c.chunkText);
    if (fragments.length === 0) { toast.error('先勾选要整理的碎片'); return; }
    setDrafting(true);
    try {
      const r = await helmApi.promoteDraft(wikiRepo.id, {
        fragments,
        ...(domain.trim() ? { domain: domain.trim() } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
      });
      setBody(r.draft);
      toast.success(r.usedExternalContext ? 'AI 草稿已生成（含外部参考）' : 'AI 草稿已生成');
    } catch (err) {
      toast.error(`AI 整理失败: ${err instanceof ApiError ? err.message : String(err)}`);
    } finally { setDrafting(false); }
  };

  const toggle = (id: string, text: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      // Re-derive the editable body from the new selection — but only
      // while the user hasn't started hand-editing a divergent draft.
      const merged = chunks
        .filter((c) => next.has(c.id))
        .map((c) => c.chunkText.trim())
        .join('\n\n');
      setBody((prevBody) => {
        const prevMerged = chunks
          .filter((c) => prev.has(c.id))
          .map((c) => c.chunkText.trim())
          .join('\n\n');
        return prevBody === prevMerged ? merged : prevBody;
      });
      void text;
      return next;
    });
  };

  const submit = async (): Promise<void> => {
    if (!wikiRepo) { toast.error('没有订阅 llm-wiki 仓库'); return; }
    setBusy(true);
    try {
      const r = await helmApi.promoteToDomain(wikiRepo.id, { domain, title, body });
      setResult({ prUrl: r.prUrl, branch: r.branch, relPath: r.relPath });
      toast.success(r.prUrl ? `Contribute MR 已创建` : `分支已推送：${r.branch}（请手动开 MR）`);
    } catch (err) {
      toast.error(`Contribute 失败: ${err instanceof ApiError ? err.message : String(err)}`);
    } finally { setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent title={`Contribute 到 domains/ — ${roleName}`} width={720}>
        {!wikiRepo && <p className="muted">未订阅 llm-wiki 仓库，无法 Contribute。</p>}
        {result ? (
          <div>
            <p>✅ 已写入 <code>{result.relPath}</code> 并推送分支 <code>{result.branch}</code>。</p>
            {result.prUrl
              ? <p><a href={result.prUrl} target="_blank" rel="noreferrer">{result.prUrl}</a></p>
              : <p className="muted">未检测到 MR CLI，请用上面的分支手动创建 MR。</p>}
            <Button onClick={onClose}>关闭</Button>
          </div>
        ) : (
          <>
            <p className="muted" style={{ fontSize: 12 }}>
              勾选要 Contribute 的碎片 → 右侧合并稿可自由编辑 → 提交后开一个
              MR 到 domains/&lt;域&gt;/。评审合入后即成为团队成熟知识。
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div style={{ maxHeight: 320, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}>
                {chunks.length === 0 && <p className="muted">这个 topic 还没有知识点。</p>}
                {chunks.map((c) => (
                  <label key={c.id} style={{ display: 'flex', gap: 6, marginBottom: 8, fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={selected.has(c.id)}
                      onChange={() => toggle(c.id, c.chunkText)}
                      style={{ marginTop: 2 }}
                    />
                    <span style={{ whiteSpace: 'pre-wrap' }}>{c.chunkText.slice(0, 200)}{c.chunkText.length > 200 ? '…' : ''}</span>
                  </label>
                ))}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label className="helm-form-row">
                  <div className="muted">目标域（domains/ 下）</div>
                  <input
                    type="text"
                    list="promote-domains"
                    value={domain}
                    placeholder={domains.data?.dirs[0] ?? 'stability'}
                    onChange={(e) => setDomain(e.target.value)}
                  />
                  <datalist id="promote-domains">
                    {(domains.data?.dirs ?? []).map((d) => <option key={d} value={d} />)}
                  </datalist>
                </label>
                <label className="helm-form-row">
                  <div className="muted">文档标题</div>
                  <input type="text" value={title} placeholder="OG 标签接入与回退约定"
                    onChange={(e) => setTitle(e.target.value)} />
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="muted" style={{ fontSize: 12 }}>合并稿（可编辑）</span>
                  <button
                    disabled={drafting || selected.size === 0}
                    onClick={() => { void aiDraft(); }}
                    title="LLM 把勾选的碎片整理成成熟文档草稿，自动引入外部知识源做参考印证"
                    style={{ fontSize: 12 }}
                  >
                    {drafting ? 'AI 整理中…' : '✨ AI 整理'}
                  </button>
                </div>
                <textarea
                  value={body}
                  rows={10}
                  placeholder="勾选左侧碎片自动合并到这里；点 ✨AI 整理 生成润色稿；可自由编辑"
                  style={{ width: '100%', fontFamily: 'inherit', fontSize: 12 }}
                  onChange={(e) => setBody(e.target.value)}
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <Button
                variant="primary"
                disabled={busy || !wikiRepo || !domain.trim() || !title.trim() || !body.trim()}
                aria-busy={busy}
                onClick={() => { void submit(); }}
                title="把合并稿提交到 llm-wiki 的 domains/<域>/，开一个 Contribute MR 等团队评审合入"
              >
                {busy ? '开 MR 中…' : '提交 Contribute MR'}
              </Button>
              <button onClick={onClose}>取消</button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RoleDetail({ roleId, onTrained }: { roleId: string; onTrained: () => void }) {
  const detail = useApi(() => helmApi.role(roleId), [roleId]);
  const [training, setTraining] = useState(false);
  const [trainError, setTrainError] = useState<string | null>(null);
  const [trainOk, setTrainOk] = useState(false);
  const [name, setName] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  // Phase 73: kind selector for the next train batch. Applies to ALL files
  // uploaded in one click (per-file kind would need more UI than this form
  // can carry — agents driving the MCP path can set per-doc kinds).
  const [trainKind, setTrainKind] = useState<KnowledgeChunkKind>('other');
  // Phase 73: in-flight drop on a knowledge source.
  const [droppingSourceId, setDroppingSourceId] = useState<string | null>(null);
  // helm-design PR 3 — pending drop confirmation (was window.confirm).
  // Holds the source about to be dropped while ConfirmDialog is open.
  const [dropConfirm, setDropConfirm] = useState<{ sourceId: string; origin: string } | null>(null);
  // Phase 77: per-chunk pending state for the unarchive button.
  const [unarchivingChunkId, setUnarchivingChunkId] = useState<string | null>(null);
  // R-7: per-chunk pending state for the visibility toggle button.
  const [flippingVisChunkId, setFlippingVisChunkId] = useState<string | null>(null);
  // R-7: chunk pending confirmation when promoting to 'public'. Holds
  // the chunk under consideration so the inline confirm row can render.
  const [visConfirm, setVisConfirm] = useState<{ chunkId: string; editVersion: number } | null>(null);
  // Phase 78: tab selector for the role detail panel. Three tabs:
  //   'chunks'      — trained knowledge + sources + train/retrain form
  //   'candidates'  — agent-response segments awaiting Accept / Reject
  // Sources is rendered inside 'chunks' since it's directly tied to chunks.
  // 'chunks' stays the default so users land on the same view as pre-Phase 78.
  const [activeTab, setActiveTab] = useState<'chunks' | 'candidates'>('chunks');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Pre-fill form once detail loads
  if (detail.data && !name && detail.data.role.name) {
    setName(detail.data.role.name);
  }

  async function readFile(file: File): Promise<{ filename: string; content: string }> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ filename: file.name, content: String(reader.result ?? '') });
      reader.onerror = () => reject(new Error(`failed to read ${file.name}`));
      reader.readAsText(file);
    });
  }

  async function train(): Promise<void> {
    setTrainError(null);
    setTrainOk(false);
    const files = fileInputRef.current?.files;
    if (!files || files.length === 0) {
      setTrainError('Pick at least one document.');
      return;
    }
    if (!name.trim()) {
      setTrainError('Name is required.');
      return;
    }
    setTraining(true);
    try {
      const documents = await Promise.all(Array.from(files).map(async (f) => ({
        ...(await readFile(f)),
        // Phase 73: stamp every doc with the selected kind. `'other'` is the
        // default and the safe choice when the user hasn't picked a more
        // specific category.
        kind: trainKind,
      })));
      await helmApi.trainRole(roleId, {
        name: name.trim(),
        documents,
        baseSystemPrompt: systemPrompt.trim() || undefined,
      });
      setTrainOk(true);
      detail.reload();
      onTrained();
      // clear the file input
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setTrainError(msg);
    } finally {
      setTraining(false);
    }
  }

  /** Phase 77: restore a single archived chunk. Best-effort; reloads the
   * role detail on success so the chunk pops back into the live list. */
  async function unarchiveChunk(chunkId: string): Promise<void> {
    setUnarchivingChunkId(chunkId);
    try {
      await helmApi.unarchiveChunk(chunkId);
      detail.reload();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setTrainError(`Unarchive failed: ${msg}`);
    } finally {
      setUnarchivingChunkId(null);
    }
  }

  /** R-7: flip a chunk's R-0 visibility. `nextVisibility` is the
   *  target value; the caller is responsible for surfacing a confirm
   *  prompt before promoting to 'public' (the destructive direction). */
  async function flipChunkVisibility(
    chunkId: string,
    nextVisibility: 'internal' | 'public',
    expectedEditVersion: number,
  ): Promise<void> {
    setFlippingVisChunkId(chunkId);
    try {
      await helmApi.setChunkVisibility(chunkId, nextVisibility, expectedEditVersion);
      detail.reload();
      setVisConfirm(null);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setTrainError(`Visibility change failed: ${msg}`);
    } finally {
      setFlippingVisChunkId(null);
    }
  }

  // helm-design PR 3 — dropSource is now ConfirmDialog-driven. The
  // button below sets `dropConfirm`; this function runs only after the
  // user clicks the destructive button in the dialog.
  async function dropSource(sourceId: string): Promise<void> {
    setDroppingSourceId(sourceId);
    try {
      await helmApi.dropKnowledgeSource(sourceId);
      detail.reload();
      onTrained();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setTrainError(`Drop failed: ${msg}`);
    } finally {
      setDroppingSourceId(null);
      setDropConfirm(null);
    }
  }

  if (detail.loading) return <p className="muted">Loading topic…</p>;
  if (detail.error) return <p className="muted" style={{ color: 'var(--danger)' }}>{detail.error.message}</p>;
  if (!detail.data) return null;
  const { role, chunks, sources } = detail.data;

  return (
    <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
      <div className="label">System prompt</div>
      <pre style={{ marginBottom: 14 }}>{role.systemPrompt}</pre>

      {/* Phase 78 / helm-design PR 8: segmented control over Chunks
          (default, holds sources + chunks + train form) vs Candidates
          (knowledge-capture pending review). Radix Tabs gives keyboard
          arrow nav + roving-focus + tablist/tabpanel a11y wiring for
          free; we only own the segmented-pill styling. */}
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as 'chunks' | 'candidates')}
      >
        <TabsList aria-label="Topic detail sections">
          <TabsTrigger value="chunks">Chunks</TabsTrigger>
          <TabsTrigger value="candidates">Candidates</TabsTrigger>
        </TabsList>

        <TabsContent value="candidates">
          <RoleCandidates roleId={roleId} onChange={() => { detail.reload(); onTrained(); }} />
        </TabsContent>

        <TabsContent value="chunks">
      {/* Phase 73: Sources block. Each knowledge_source row corresponds to
          one raw-doc ingestion event; the Drop button cascade-deletes every
          chunk derived from that source. */}
      {sources && sources.length > 0 && (
        <>
          <div className="label">Sources ({sources.length})</div>
          <ul style={{ margin: '6px 0 14px', paddingLeft: 0, listStyle: 'none' }}>
            {sources.map((s) => (
              <li key={s.id} style={{
                marginBottom: 8,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                justifyContent: 'space-between',
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12 }}>
                    <span className="muted" style={{ fontSize: 10, marginRight: 6 }}>{s.kind}</span>
                    <code title={s.origin} style={{
                      color: 'var(--text-secondary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      display: 'inline-block',
                      maxWidth: '100%',
                    }}>{s.origin}</code>
                  </div>
                  <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                    {s.chunkCount} chunk{s.chunkCount === 1 ? '' : 's'}
                    {s.label ? ` · "${s.label}"` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={droppingSourceId === s.id}
                  aria-busy={droppingSourceId === s.id}
                  onClick={() => setDropConfirm({ sourceId: s.id, origin: s.origin })}
                  style={{ color: 'var(--danger)' }}
                  title="Drop this source — cascade-deletes its chunks"
                >
                  {droppingSourceId === s.id ? 'Dropping…' : 'Drop'}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* Phase 77: split chunks into live + archived. Live chunks render
          first (limited to 8 for the preview); archived chunks live in a
          folded `<details>` so they don't clutter the main view. Each
          archived row gets an "Unarchive" button driven by the new
          unarchive endpoint. */}
      {(() => {
        const liveChunks = chunks.filter((c) => !c.archived);
        const archivedChunks = chunks.filter((c) => c.archived);
        return (
          <>
            <div className="label">Knowledge chunks ({liveChunks.length})</div>
            {liveChunks.length === 0 ? (
              <p className="muted" style={{ marginTop: 4, marginBottom: 14 }}>
                No documents trained yet.
              </p>
            ) : (
              <ul style={{ margin: '6px 0 14px', paddingLeft: 0, listStyle: 'none' }}>
                {liveChunks.slice(0, 8).map((c) => (
                  <li key={c.id} style={{ marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <KindBadge kind={c.kind} />
                      <code style={{ color: 'var(--text-secondary)' }}>{c.sourceFile ?? '(no file)'}</code>
                      <VisibilityChip visibility={c.visibility ?? 'internal'} />
                      <VisibilityToggle
                        chunkId={c.id}
                        visibility={c.visibility ?? 'internal'}
                        editVersion={c.editVersion ?? 1}
                        busy={flippingVisChunkId === c.id}
                        confirm={visConfirm}
                        onAskConfirm={(v) => setVisConfirm(v)}
                        onFlip={(v, ev) => { void flipChunkVisibility(c.id, v, ev); }}
                      />
                    </div>
                    <div className="muted" style={{ marginTop: 2, fontSize: 12 }}>
                      {summarizePrompt(c.chunkText, 200)}
                    </div>
                    <div className="muted" style={{ marginTop: 2, fontSize: 11 }}>
                      accessed {c.accessCount} time{c.accessCount === 1 ? '' : 's'}
                      {c.lastAccessedAt
                        ? ` · last ${formatRelative(c.lastAccessedAt)}`
                        : ' · never queried'}
                    </div>
                  </li>
                ))}
                {liveChunks.length > 8 && (
                  <li className="muted" style={{ fontSize: 12 }}>
                    … {liveChunks.length - 8} more chunk{liveChunks.length - 8 === 1 ? '' : 's'}.
                  </li>
                )}
              </ul>
            )}

            {archivedChunks.length > 0 && (
              <details style={{ marginBottom: 14 }}>
                <summary style={{ cursor: 'pointer', fontSize: 12 }}>
                  Archived chunks ({archivedChunks.length}) — cold + old; default-hidden from search
                </summary>
                <ul style={{ margin: '6px 0 0', paddingLeft: 0, listStyle: 'none' }}>
                  {archivedChunks.map((c) => (
                    <li key={c.id} style={{
                      marginBottom: 8,
                      opacity: 0.7,
                      display: 'flex',
                      gap: 8,
                      alignItems: 'flex-start',
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <KindBadge kind={c.kind} />
                          <code style={{ color: 'var(--text-secondary)' }}>{c.sourceFile ?? '(no file)'}</code>
                        </div>
                        <div className="muted" style={{ marginTop: 2, fontSize: 12 }}>
                          {summarizePrompt(c.chunkText, 200)}
                        </div>
                        <div className="muted" style={{ marginTop: 2, fontSize: 11 }}>
                          accessed {c.accessCount} time{c.accessCount === 1 ? '' : 's'}
                          {c.lastAccessedAt ? ` · last ${formatRelative(c.lastAccessedAt)}` : ''}
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={unarchivingChunkId === c.id}
                        aria-busy={unarchivingChunkId === c.id}
                        onClick={() => { void unarchiveChunk(c.id); }}
                        title="Restore this chunk into the live search pool"
                      >
                        {unarchivingChunkId === c.id ? 'Restoring…' : 'Unarchive'}
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        );
      })()}

      <div className="label">Train / re-train</div>
      <p className="muted" style={{ fontSize: 11, margin: '4px 0 8px' }}>
        Re-training replaces the existing chunks for this topic. Built-in topics
        keep their default system prompt unless you override below.
      </p>
      <label className="helm-form-row">
        <div className="muted">Display name</div>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Senior iOS Engineer"
        />
      </label>
      <label className="helm-form-row">
        <div className="muted">Override system prompt (optional)</div>
        <textarea
          rows={3}
          value={systemPrompt}
          placeholder="Leave blank to keep the existing prompt"
          onChange={(e) => setSystemPrompt(e.target.value)}
          style={{ width: '100%', fontFamily: 'inherit' }}
        />
      </label>
      <label className="helm-form-row">
        <div className="muted">Kind (applies to every doc in this batch)</div>
        <Select
          value={trainKind}
          onValueChange={(v) => setTrainKind(v as KnowledgeChunkKind)}
        >
          <SelectTrigger style={{ minWidth: 160 }}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KIND_OPTIONS.map((k) => (
              <SelectItem key={k} value={k}>{k}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <label className="helm-form-row">
        <div className="muted">Documents (.md / .txt — multiple)</div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".md,.markdown,.txt,text/markdown,text/plain"
        />
      </label>

      {trainError && (
        <p className="muted" style={{ color: 'var(--danger)', margin: '8px 0 0' }}>{trainError}</p>
      )}
      {trainOk && (
        <p className="muted" style={{ color: 'var(--success)', margin: '8px 0 0' }}>
          Topic trained. New chunks visible above.
        </p>
      )}

      <div style={{ marginTop: 12 }}>
        <Button
          variant="primary"
          disabled={training}
          aria-busy={training}
          onClick={() => { void train(); }}
          title="用上方填写的内容重新训练：替换这个 topic 现有的知识点"
        >
          {training ? 'Training…' : 'Train'}
        </Button>
      </div>
        </TabsContent>
      </Tabs>

      {dropConfirm && (
        <ConfirmDialog
          open={true}
          onOpenChange={(o) => { if (!o) setDropConfirm(null); }}
          title="Drop knowledge source?"
          description={`Cascade-deletes every chunk derived from "${dropConfirm.origin}". Chunks from other sources are not affected.`}
          confirmLabel="Drop"
          onConfirm={() => dropSource(dropConfirm.sourceId)}
          busy={droppingSourceId === dropConfirm.sourceId}
        />
      )}
    </div>
  );
}

/**
 * Phase 78 — Candidates tab body for one role. Lives outside RoleDetail
 * so its state (which candidate is being edited / busy state) doesn't
 * rerender the whole detail panel on every button click.
 */
function RoleCandidates({
  roleId,
  onChange,
}: {
  roleId: string;
  onChange: () => void;
}) {
  const list = useApi(() => helmApi.listCandidates(roleId, 'pending'), [roleId]);
  const candidateIds = useMemo(
    () => (list.data?.candidates ?? []).map((c) => c.id),
    [list.data],
  );
  const { contexts, refreshing, refresh } = useCandidateContexts(candidateIds);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState<string>('');

  async function accept(id: string): Promise<void> {
    setBusyId(id); setErr(null);
    try {
      await helmApi.acceptCandidate(id);
      list.reload();
      onChange();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e as Error).message;
      setErr(`采纳失败：${msg}`);
    } finally {
      setBusyId(null);
    }
  }
  async function reject(id: string): Promise<void> {
    setBusyId(id); setErr(null);
    try {
      await helmApi.rejectCandidate(id);
      list.reload();
      onChange();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e as Error).message;
      setErr(`忽略失败：${msg}`);
    } finally {
      setBusyId(null);
    }
  }
  async function saveEdit(id: string): Promise<void> {
    if (!editingText.trim()) { setErr('Edited text cannot be empty.'); return; }
    setBusyId(id); setErr(null);
    try {
      await helmApi.editAndAcceptCandidate(id, editingText);
      setEditingId(null);
      setEditingText('');
      list.reload();
      onChange();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e as Error).message;
      setErr(`Edit+accept failed: ${msg}`);
    } finally {
      setBusyId(null);
    }
  }

  if (list.loading) return <p className="muted">Loading candidates…</p>;
  if (list.error) return <p className="muted" style={{ color: 'var(--danger)' }}>{list.error.message}</p>;
  const candidates = list.data?.candidates ?? [];
  if (candidates.length === 0) {
    return (
      <p className="muted" style={{ marginTop: 4, marginBottom: 14 }}>
        No pending candidates. New ones arrive automatically when this topic is
        bound to a chat and the agent's responses contain segments that match
        existing knowledge (entity overlap ≥ 2 OR cosine ≥ 0.6).
      </p>
    );
  }

  return (
    <>
      {err && (
        <p className="muted" style={{ color: 'var(--danger)', marginBottom: 8 }}>{err}</p>
      )}
      <ul style={{ margin: '6px 0 14px', paddingLeft: 0, listStyle: 'none' }}>
        {candidates.map((c) => {
          const isEditing = editingId === c.id;
          const isBusy = busyId === c.id;
          return (
            <li key={c.id} style={{ marginBottom: 14, padding: 10, border: '1px solid var(--border)', borderRadius: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <KindBadge kind={c.kind} />
                <span className="muted" style={{ fontSize: 11 }}>
                  entity={c.scoreEntity} · cosine={c.scoreCosine.toFixed(2)}
                </span>
                <span className="muted" style={{ fontSize: 11 }}>
                  · from chat <code title={c.hostSessionId ?? '(orphaned)'}>
                    {c.hostSessionId ? shortId(c.hostSessionId, 8) : '?'}
                  </code>
                </span>
                <span className="muted" style={{ fontSize: 11, marginLeft: 'auto' }}>
                  {c.createdAt.slice(0, 19).replace('T', ' ')}
                </span>
              </div>
              {isEditing ? (
                <textarea
                  value={editingText}
                  rows={6}
                  style={{ width: '100%', fontFamily: 'inherit', fontSize: 12 }}
                  onChange={(e) => setEditingText(e.target.value)}
                />
              ) : (
                <pre style={{ marginBottom: 6, fontSize: 12, whiteSpace: 'pre-wrap' }}>
                  {c.chunkText}
                </pre>
              )}
              <div style={{ display: 'flex', gap: 6 }}>
                {isEditing ? (
                  <>
                    <Button
                      variant="primary"
                      disabled={isBusy}
                      aria-busy={isBusy}
                      onClick={() => { void saveEdit(c.id); }}
                      title="保存你的改写，并把它作为新知识点采纳进这个 topic"
                    >
                      {isBusy ? '保存中…' : '保存并采纳'}
                    </Button>
                    <button
                      onClick={() => { setEditingId(null); setEditingText(''); }}
                      title="放弃改写，回到候选列表"
                    >取消</button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="primary"
                      disabled={isBusy}
                      aria-busy={isBusy}
                      onClick={() => { void accept(c.id); }}
                      title="采纳：把这段作为新知识点加到这个 topic（写入个人层 chat-captured）。"
                    >
                      {isBusy ? '采纳中…' : '采纳'}
                    </Button>
                    <button
                      disabled={isBusy}
                      onClick={() => { setEditingId(c.id); setEditingText(c.chunkText); }}
                      title="先改写这条候选的文本，再采纳"
                    >
                      编辑
                    </button>
                    <button
                      disabled={isBusy}
                      onClick={() => { void reject(c.id); }}
                      style={{ color: 'var(--danger)' }}
                      title="忽略——不会再为这个 topic 建议。"
                    >
                      {isBusy ? '忽略中…' : '忽略'}
                    </button>
                  </>
                )}
              </div>
              {!isEditing && (
                <ExternalContextBox
                  context={contexts[c.id]}
                  refreshing={refreshing.has(c.id)}
                  onRefresh={() => { void refresh(c.id); }}
                />
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/**
 * Compact per-role action menu. The card used to spray six buttons across
 * a wrapping row (Update via chat / Contribute / 删除 / 合并… / 卸下人格 /
 * Show) — visually noisy and language-mixed. Now only the expand toggle
 * stays inline; everything else folds into a single ⋯ overflow menu so the
 * row footprint shrinks to two small controls. Reuses the .helm-conv-overflow
 * idiom from Chats.tsx (click-outside to close).
 */
function RoleActionsMenu({
  role,
  onUpdateViaChat,
  onPromote,
  onToggleBindable,
  onDelete,
  mergeTargets,
  onMerge,
}: {
  role: RoleSummary;
  onUpdateViaChat: () => void;
  onPromote: () => void;
  onToggleBindable: () => void;
  onDelete: () => void;
  mergeTargets: { value: string; label: string }[];
  onMerge: (targetRoleId: string, targetName: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent): void {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setMergeOpen(false);
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Built-ins are seeded from src: no edit/delete/merge actions apply, so the
  // menu would be empty — don't render the trigger at all.
  if (role.isBuiltin) return null;

  const isExpert = role.bindable !== false;
  const canContribute = role.tier !== 'team';

  return (
    <div ref={wrapRef} className="helm-conv-overflow">
      <button
        type="button"
        className="helm-conv-overflow-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="更多操作"
        onClick={() => { setOpen((v) => !v); setMergeOpen(false); }}
      >
        ⋯
      </button>
      {open && (
        <div role="menu" className="helm-conv-overflow-menu">
          {isExpert && (
            <button type="button" role="menuitem"
              onClick={() => { onUpdateViaChat(); setOpen(false); }}
              title="通过对话补充知识或微调 system prompt —— 已有知识点保留">
              通过对话更新
            </button>
          )}
          {canContribute && (
            <button type="button" role="menuitem"
              onClick={() => { onPromote(); setOpen(false); }}
              title="挑选碎片合并成一篇文档，开 MR Contribute 到 llm-wiki 的 domains/<域>/">
              贡献到团队层…
            </button>
          )}
          <button type="button" role="menuitem"
            onClick={() => { onToggleBindable(); setOpen(false); }}
            title={isExpert
              ? '卸下人格：退回纯知识主题。检索不受影响，但不再可绑定、不再注入/定向捕获'
              : '配置人格：给这个主题加上 system prompt，让它可绑定到对话、开场注入知识、定向捕获'}>
            {isExpert ? '卸下人格' : '配置人格'}
          </button>
          {mergeTargets.length > 0 && (
            <button type="button" role="menuitem"
              onClick={() => setMergeOpen((v) => !v)}
              title="把这个主题及其全部知识点并入另一个主题">
              合并到… {mergeOpen ? '▾' : '▸'}
            </button>
          )}
          {mergeOpen && mergeTargets.length > 0 && (
            <div className="helm-role-merge-sublist">
              {mergeTargets.map((t) => (
                <button key={t.value} type="button" role="menuitem"
                  onClick={() => { onMerge(t.value, t.label); setOpen(false); setMergeOpen(false); }}
                  title={`并入「${t.label}」`}>
                  {t.label}
                </button>
              ))}
            </div>
          )}
          <div className="helm-conv-overflow-divider" role="separator" />
          <button type="button" role="menuitem" className="helm-conv-overflow-danger"
            onClick={() => { onDelete(); setOpen(false); }}
            title="删除这个 topic 及其全部知识点（不可恢复）">
            删除
          </button>
        </div>
      )}
    </div>
  );
}

function RoleCard({
  role,
  expanded,
  onToggle,
  onUpdateViaChat,
  onTrained,
  onToggleBindable,
  onPromote,
  onDelete,
  mergeTargets,
  onMerge,
}: {
  role: RoleSummary;
  expanded: boolean;
  onToggle: () => void;
  /** Phase 65: open the train modal in update-mode for this role. */
  onUpdateViaChat: () => void;
  onTrained: () => void;
  /** PR-δ: flip Expert / Collection. */
  onToggleBindable: () => void;
  /** PR-γ: open the promote-to-domains modal. */
  onPromote: () => void;
  /** Topics cleanup: delete this collection (confirm handled by page). */
  onDelete: () => void;
  /** Topics merge: other non-builtin topics this one can be folded into. */
  mergeTargets: { value: string; label: string }[];
  /** Topics merge: user picked a target; page opens the confirm dialog. */
  onMerge: (targetRoleId: string, targetName: string) => void;
}) {
  return (
    <Card>
      <div className="row">
        <div style={{ flex: 1 }}>
          <div className="label">
            {role.isBuiltin ? 'built-in' : role.bindable === false ? 'topic' : 'expert'}
            {' · '}<code title={role.id}>{shortId(role.id)}</code>
            {/* helm-design PR A: role version. Hidden when v1 (the
                initial state — visually noisy on every brand-new
                role) so only edited roles show the marker. */}
            {role.version > 1 && <> · v{role.version}</>}
          </div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{role.name}</div>
          <div className="muted" style={{ marginTop: 4, marginBottom: 0 }}>
            {summarizePrompt(role.systemPrompt)}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <span className="helm-status">
            <span className="dot" />
            {role.chunkCount} chunk{role.chunkCount === 1 ? '' : 's'}
          </span>
          {/* Phase 78: pending knowledge-capture candidates badge. Surfaces
              new agent-response segments that scored above the capture
              thresholds against this role — user reviews via the Candidates
              tab inside the role detail. Hidden when zero so existing
              roles don't show a useless `(0)`. */}
          {role.pendingCandidateCount > 0 && (
            <span
              className="helm-status"
              style={{ background: 'var(--accent)', color: '#fff' }}
              title={`${role.pendingCandidateCount} pending knowledge-capture candidate${role.pendingCandidateCount === 1 ? '' : 's'}`}
            >
              {role.pendingCandidateCount} new
            </span>
          )}
          {/* R-9: proposed-case count per role. Reads from the
              global notifications cache the App-level hook seeds so
              every row doesn't refetch independently. */}
          <ProposedCaseChip roleId={role.id} />
          {/* Compact actions: expand toggle stays inline (most-used);
              everything else (update / contribute / persona / merge /
              delete) folds into the ⋯ overflow menu to shrink the row. */}
          <button
            onClick={onToggle}
            title={expanded ? '收起：隐藏知识点、来源与候选' : '展开：查看这个 topic 的知识点、来源与待采纳候选'}
          >{expanded ? '收起' : '展开'}</button>
          <RoleActionsMenu
            role={role}
            onUpdateViaChat={onUpdateViaChat}
            onPromote={onPromote}
            onToggleBindable={onToggleBindable}
            onDelete={onDelete}
            mergeTargets={mergeTargets}
            onMerge={onMerge}
          />
        </div>
      </div>
      {expanded && <RoleDetail roleId={role.id} onTrained={onTrained} />}
    </Card>
  );
}

function RolesPageBase() {
  const { data, loading, error, reload } = useApi(() => helmApi.roles());
  const [expanded, setExpanded] = useState<string | null>(null);
  // Phase 65: chat modal can run in two modes:
  //   - { mode: 'create' }                 → new role (default behavior)
  //   - { mode: 'update', roleId, name }   → append knowledge to existing
  // The two modes share the modal UI but seed different greetings + steer
  // the agent toward different MCP tools (train_role vs update_role).
  const [chatTarget, setChatTarget] = useState<
    | null
    | { mode: 'create' }
    | { mode: 'update'; roleId: string; name: string }
  >(null);
  // PR-γ: promote modal target.
  const [promoteTarget, setPromoteTarget] = useState<{ roleId: string; name: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ roleId: string; name: string } | null>(null);
  // Topics merge: holds {from, to} while the confirm dialog is open.
  const [mergeTarget, setMergeTarget] = useState<
    { fromId: string; fromName: string; toId: string; toName: string } | null
  >(null);

  const doMerge = async (): Promise<void> => {
    if (!mergeTarget) return;
    try {
      await helmApi.mergeRole(mergeTarget.fromId, mergeTarget.toId);
      toast.success(`已并入 ${mergeTarget.toName}`);
      setMergeTarget(null);
      reload();
    } catch (err) {
      toast.error(`合并失败: ${err instanceof ApiError ? err.message : String(err)}`);
    }
  };

  const doDelete = async (): Promise<void> => {
    if (!deleteTarget) return;
    try {
      await helmApi.deleteRole(deleteTarget.roleId);
      toast.success(`已删除：${deleteTarget.name}`);
      setDeleteTarget(null);
      reload();
    } catch (err) {
      toast.error(`删除失败: ${err instanceof ApiError ? err.message : String(err)}`);
    }
  };

  // helm-design PR 9: load errors → toast.
  useEffect(() => {
    if (error) toast.error(`Topics: ${error.message}`, { id: 'roles-load' });
  }, [error]);

  // helm-design PR 6: stats reflect what's in the roles list. Built-in
  // roles count separately so the user sees at a glance how many of
  // their own roles they've added; pending-candidates rolls up the
  // per-role candidate badge.
  // Built-in roles (the relay-era Developer/Product/Test agents) are persona
  // scaffolding, not chat knowledge or user dev-habits — hide them from
  // Topics entirely.
  const allRoles = (data?.roles ?? []).filter((r) => !r.isBuiltin);
  // PR-δ: Experts (bindable personas) render first; pure knowledge
  // Collections (imported dirs / entity buckets) get their own section.
  const experts = allRoles.filter((r) => r.bindable !== false);
  const collections = allRoles.filter((r) => r.bindable === false);

  const toggleBindable = async (r: RoleSummary): Promise<void> => {
    try {
      await helmApi.setRoleBindable(r.id, r.bindable === false);
      toast.success(r.bindable === false ? `已配置人格：${r.name}（现为专家）` : `已卸下人格：${r.name}（退回纯主题）`);
      reload();
    } catch (err) {
      toast.error(`切换失败: ${err instanceof ApiError ? err.message : String(err)}`);
    }
  };
  const pendingCandidates = allRoles.reduce(
    (acc, r) => acc + (r.pendingCandidateCount ?? 0),
    0,
  );

  return (
    <>
      <PageHeader
        title="Topics"
        subtitle={<>知识主题——实体桶、导入主题域，以及带人格的专家主题。带 prompt 的可绑定到对话（开场注入知识 + 定向捕获）；检索对所有主题一视同仁。</>}
        stats={<>
          <StatTile label="Experts" value={experts.length} tone={experts.length > 0 ? 'live' : 'muted'} />
          <StatTile label="Topics" value={collections.length} tone={collections.length > 0 ? 'live' : 'muted'} />
          <StatTile label="Candidates" value={pendingCandidates} tone={pendingCandidates > 0 ? 'warn' : 'muted'} />
        </>}
        actions={
          <Button
            variant="primary"
            onClick={() => setChatTarget({ mode: 'create' })}
            title="打开对话式训练：用本机 CLI 聊出一个新 topic（带 prompt 即成专家），自动蒸馏知识点"
          >
            + Train a new topic via chat
          </Button>
        }
      />
      <p className="muted" style={{ marginTop: -4, marginBottom: 16, fontSize: 12 }}>
        Coach an LLM through a conversation — it asks clarifying questions,
        then distills your answers into a role.
      </p>

      <TrainViaCliPanel />


      {loading && <CardSkeletonList n={4} />}

      {data && allRoles.length === 0 && (
        <EmptyState
          title="还没有任何主题。"
          hint={<>订阅 llm-wiki（Sources）、在对话里聊出新实体，或训练一个专家主题。</>}
        />
      )}

      {data && experts.length > 0 && (
        <h3 style={{ margin: '8px 0 4px' }}>专家主题（可绑定）</h3>
      )}
      {data && experts.map((r) => (
        <RoleCard
          key={r.id}
          role={r}
          expanded={expanded === r.id}
          onToggle={() => setExpanded(expanded === r.id ? null : r.id)}
          onUpdateViaChat={() => setChatTarget({ mode: 'update', roleId: r.id, name: r.name })}
          onToggleBindable={() => { void toggleBindable(r); }}
          onPromote={() => setPromoteTarget({ roleId: r.id, name: r.name })}
          onDelete={() => setDeleteTarget({ roleId: r.id, name: r.name })}
          mergeTargets={allRoles
            .filter((o) => o.id !== r.id)
            .map((o) => ({ value: o.id, label: o.name }))}
          onMerge={(toId, toName) =>
            setMergeTarget({ fromId: r.id, fromName: r.name, toId, toName })}
          onTrained={() => reload()}
        />
      ))}

      {data && collections.length > 0 && (
        <h3 style={{ margin: '16px 0 4px' }}>主题（未配人格）</h3>
      )}
      {data && collections.map((r) => (
        <RoleCard
          key={r.id}
          role={r}
          expanded={expanded === r.id}
          onToggle={() => setExpanded(expanded === r.id ? null : r.id)}
          onUpdateViaChat={() => setChatTarget({ mode: 'update', roleId: r.id, name: r.name })}
          onToggleBindable={() => { void toggleBindable(r); }}
          onPromote={() => setPromoteTarget({ roleId: r.id, name: r.name })}
          onDelete={() => setDeleteTarget({ roleId: r.id, name: r.name })}
          mergeTargets={allRoles
            .filter((o) => o.id !== r.id)
            .map((o) => ({ value: o.id, label: o.name }))}
          onMerge={(toId, toName) =>
            setMergeTarget({ fromId: r.id, fromName: r.name, toId, toName })}
          onTrained={() => reload()}
        />
      ))}

      {deleteTarget && (
        <ConfirmDialog
          open
          onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}
          title={`删除 ${deleteTarget.name}？`}
          description="topic 及其全部知识点将被删除，不可恢复。chat-captured 里的文件不受影响。"
          confirmLabel="删除"
          onConfirm={() => { void doDelete(); }}
        />
      )}

      {mergeTarget && (
        <ConfirmDialog
          open
          onOpenChange={(o) => { if (!o) setMergeTarget(null); }}
          title={`合并主题`}
          description={`把『${mergeTarget.fromName}』并入『${mergeTarget.toName}』？本主题将被删除，知识点/候选/case 全部转移。`}
          confirmLabel="合并"
          onConfirm={() => { void doMerge(); }}
        />
      )}

      {promoteTarget && (
        <PromoteModal
          roleId={promoteTarget.roleId}
          roleName={promoteTarget.name}
          onClose={() => setPromoteTarget(null)}
        />
      )}

      {chatTarget && (
        <RoleTrainChatModal
          target={chatTarget}
          onClose={() => setChatTarget(null)}
          onSaved={() => { setChatTarget(null); reload(); }}
        />
      )}
    </>
  );
}

// ── Phase 60b: conversational role trainer (claude CLI subprocess) ─────────
// ── Phase 65:  + update mode (append knowledge to an existing role) ────────

type ChatTarget =
  | { mode: 'create' }
  | { mode: 'update'; roleId: string; name: string };

// R-19: English greeting with Chinese fallback. The trainer agent
// speaks whichever language the user opens with — but the seed
// message has to land before either side has said anything, so we
// pick English as the default and keep the Chinese form right next
// to it so future i18n wiring can swap by user locale.
const CREATE_GREETING = [
  "Hi! I'll help you define a new helm topic.",
  '',
  "I'm running inside the Claude Code CLI on your machine — file read, grep, shell, web fetch out of the box; helm wires `train_role`, `read_lark_doc`, etc. as MCP tools.",
  '',
  "Tell me what kind of expert you want to train: the domain, the projects you care about, the docs / code you want to distill. Once we've agreed on a shape, say \"save this as the XXX topic\" and I'll call `train_role` to persist it.",
  '',
  '(中文起手：你好！我会帮你定义一个新的 helm topic。直接用中文继续就行。)',
].join('\n');

function updateGreeting(roleName: string, roleId: string): string {
  return [
    `好，给现有 topic **${roleName}** (\`${roleId}\`) 增量补充知识。`,
    '',
    '我会用 helm 的 `update_role` MCP 工具 — 它**只 append、不覆盖**：原有的 chunks 不会被擦掉。也可以同时改 system prompt（如果你想纠正某些表述）。',
    '',
    '**冲突检测**：调 `update_role` 时，helm 会先把新内容和已有 chunks 跑一遍语义比对。如果有重叠（cosine ≥ 0.85），工具会返回 `status: "conflicts"`，**不会写入**。我会把每个冲突念给你听，你逐条选：',
    '- *"两条都留"*：我用 `force: true` 重新调一次 → 新旧并存；',
    '- *"用新的替换旧的"*：我先调 `delete_role_chunk` 删旧 chunk，再用 `force: true` 调 `update_role`。',
    '',
    '没有冲突时直接写入。告诉我你想加什么：新文档、规范、对话沉淀、命令清单都行。读 Lark 文档贴 URL 就行；读代码告诉我项目路径。',
  ].join('\n');
}

interface ChatMessageView {
  role: 'user' | 'assistant';
  content: string;
}

function RoleTrainChatModal({
  target,
  onClose,
  onSaved,
}: {
  target: ChatTarget;
  onClose: () => void;
  onSaved: () => void;
}) {
  const initialGreeting = target.mode === 'update'
    ? updateGreeting(target.name, target.roleId)
    : CREATE_GREETING;
  const [messages, setMessages] = useState<ChatMessageView[]>([
    { role: 'assistant', content: initialGreeting },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [stderrTail, setStderrTail] = useState<string | null>(null);
  // Phase 60b: project path becomes the spawned `claude` subprocess's cwd —
  // claude's built-in read/grep/glob/shell tools then operate on the user's
  // actual codebase. Optional; empty = no file access.
  const [projectPath, setProjectPath] = useState('');

  // Phase 60b: TODO — listen for a `role.created` SSE event and auto-refresh
  // the Roles list when the agent calls `train_role`. Until that event is
  // emitted, the user clicks ✕ to close and the parent `onSaved` reloads.
  void onSaved;

  async function send(): Promise<void> {
    const text = input.trim();
    if (!text || busy) return;
    const next: ChatMessageView[] = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setInput('');
    setBusy(true);
    setErr(null);
    try {
      const r = await helmApi.roleTrainChat(
        next,
        projectPath.trim() ? { projectPath: projectPath.trim() } : {},
      );
      setMessages([
        ...next,
        { role: 'assistant', content: r.message.content },
      ]);
      // Surface non-trivial stderr (claude warns on MCP connection issues etc).
      const tail = r.stderr?.trim() ?? '';
      setStderrTail(tail.length > 0 ? tail.slice(-400) : null);
    } catch (e) {
      // The HTTP layer (handleRoleTrainChat) interprets claude CLI failures
      // via interpretClaudeError() and returns `{ message, hint }`. We
      // prefer the interpreted message because raw `claude` stderr is
      // typically an ENOENT dump or a generic "401" line — not actionable.
      let msg: string;
      if (e instanceof ApiError) {
        const body = e.body as { message?: string } | undefined;
        msg = body?.message ?? e.message ?? `${e.status}`;
      } else {
        msg = (e as Error).message;
      }
      setErr(msg);
      // Roll back the optimistic user message so the user can retry from the input.
      setMessages(messages);
      setInput(text);
    } finally {
      setBusy(false);
    }
  }

  const title = target.mode === 'update'
    ? `Update topic: ${target.name}`
    : 'Train a new topic via chat';

  return (
    <Dialog open={true} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        width={Math.min(720, typeof window !== 'undefined' ? window.innerWidth * 0.9 : 720)}
        aria-label={title}
        style={{ maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}
      >
        <div className="row" style={{ marginBottom: 12 }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{title}</div>
            <div className="muted" style={{ fontSize: 12 }}>
              Powered by your local <code>claude</code> CLI (Phase 60b). When you&apos;re ready, say
              {' '}<em>&quot;保存这个为 XXX topic&quot;</em> — the agent calls helm&apos;s
              {' '}<code>train_role</code> MCP tool and the topic appears in the list.
            </div>
          </div>
          <button onClick={onClose} aria-label="Close">✕</button>
        </div>

        {/* Phase 60b: optional project path. Becomes the spawned claude
            subprocess's cwd, so claude's read/grep/glob/shell tools operate
            on the user's actual code. */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span className="muted" style={{ fontSize: 12, minWidth: 90 }}>Project path</span>
          <input
            type="text"
            value={projectPath}
            disabled={busy}
            onChange={(e) => setProjectPath(e.target.value)}
            placeholder="(optional) /Users/me/projects/foo — gives the agent file access"
            style={{
              flex: 1, padding: '4px 8px', fontSize: 12, fontFamily: 'inherit',
              border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
            }}
          />
        </label>

        <div
          style={{
            flex: 1, minHeight: 200, overflowY: 'auto', display: 'flex',
            flexDirection: 'column', gap: 10, padding: '8px 4px',
            border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
          }}
        >
          {messages.map((m, i) => (
            <div key={i} style={{
              alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '85%',
            }}>
              <div style={{
                padding: '8px 12px',
                borderRadius: 8,
                background: m.role === 'user' ? 'var(--accent-soft, #e6f0ff)' : 'var(--bg-pre)',
                fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap',
              }}>
                {m.content}
              </div>
            </div>
          ))}
          {busy && <div className="muted" style={{ fontSize: 12 }}>claude is thinking…</div>}
        </div>

        {err && (
          <p className="muted" style={{ color: 'var(--danger)', marginTop: 8 }}>{err}</p>
        )}
        {stderrTail && (
          <details style={{ marginTop: 8 }}>
            <summary className="muted" style={{ fontSize: 11, cursor: 'pointer' }}>
              claude stderr ({stderrTail.length} bytes)
            </summary>
            <pre style={{
              fontSize: 11, padding: 6, background: 'var(--bg-pre)',
              borderRadius: 4, maxHeight: 120, overflow: 'auto',
            }}>{stderrTail}</pre>
          </details>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <textarea
            aria-label="Your message"
            value={input}
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); }
            }}
            placeholder="Reply… (⌘/Ctrl+Enter to send)"
            rows={3}
            style={{
              flex: 1, padding: 8, fontFamily: 'inherit', fontSize: 13,
              border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', resize: 'vertical',
            }}
          />
          <Button variant="primary" disabled={busy || !input.trim()} onClick={() => void send()}>
            Send
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Phase 60a — "Train via your CLI" panel. Helm exposes a `train_role` MCP
 * tool at http://127.0.0.1:17317/mcp/sse. Once the user registers helm in
 * their CLI's MCP config, they can finish any conversation in that CLI by
 * saying "save this as a helm role" — the CLI agent calls `train_role` and
 * the role lands here. This panel surfaces the one-time setup commands so
 * the user doesn't have to memorize URLs or hand-edit JSON.
 */

// ─── Mirror panel — auto-push to remote (Phase 80 / helm-design PR B) ──

function TrainViaCliPanel() {
  const HELM_MCP_URL = 'http://127.0.0.1:17317/mcp/sse';
  const examplePrompt = '把刚才的对话沉淀成 helm 的 TCE 专家 topic';
  // Phase 63: state per target so the user can see "Set up Claude Code" and
  // "Set up Cursor" results independently.
  const [busy, setBusy] = useState<'claude' | 'cursor' | null>(null);
  const [results, setResults] = useState<Partial<Record<'claude' | 'cursor', {
    ok: boolean; message: string;
  }>>>({});

  async function setup(target: 'claude' | 'cursor'): Promise<void> {
    setBusy(target);
    try {
      const r = await helmApi.setupMcp(target);
      setResults((prev) => ({
        ...prev,
        [target]: { ok: true, message: r.message },
      }));
    } catch (err) {
      const msg = err instanceof ApiError ? `${err.status}: ${err.message}` : (err as Error).message;
      setResults((prev) => ({ ...prev, [target]: { ok: false, message: msg } }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <details
      style={{
        marginBottom: 16,
        padding: '12px 14px',
        borderRadius: 8,
        background: 'var(--bg-pre)',
        border: '1px solid var(--border)',
      }}
    >
      <summary style={{ cursor: 'pointer', fontWeight: 500 }}>
        Or train a role from your existing CLI / IDE chat (Claude Code, Cursor)
      </summary>
      <p className="muted" style={{ marginTop: 10 }}>
        Helm exposes a <code>train_role</code> tool over MCP at{' '}
        <code>{HELM_MCP_URL}</code>. After registering helm with your CLI, end
        any conversation by saying e.g.{' '}
        <em>&quot;{examplePrompt}&quot;</em> — the agent calls{' '}
        <code>train_role</code> and the topic appears below automatically.
      </p>

      <p className="muted" style={{ marginTop: 12, marginBottom: 4, fontWeight: 500 }}>
        One-time setup (click the target you use):
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button
          type="button"
          variant="primary"
          disabled={busy !== null}
          aria-busy={busy === 'claude'}
          onClick={() => { void setup('claude'); }}
        >
          {busy === 'claude' ? 'Setting up…' : 'Set up Claude Code'}
        </Button>
        <button
          type="button"
          disabled={busy !== null}
          aria-busy={busy === 'cursor'}
          onClick={() => { void setup('cursor'); }}
        >
          {busy === 'cursor' ? 'Setting up…' : 'Set up Cursor'}
        </button>
      </div>

      {(['claude', 'cursor'] as const).map((target) => {
        const r = results[target];
        if (!r) return null;
        return (
          <p
            key={target}
            style={{
              marginTop: 10, fontSize: 12,
              color: r.ok ? 'var(--success)' : 'var(--danger)',
              whiteSpace: 'pre-wrap',
            }}
          >
            <strong>{target}</strong>: {r.message}
          </p>
        );
      })}

      <p className="muted" style={{ marginTop: 12, fontSize: 12 }}>
        Claude Code uses <code>claude mcp add --scope user</code>; Cursor edits{' '}
        <code>~/.cursor/mcp.json</code>. Both are idempotent — running again is
        a no-op when already registered. <strong>Restart Claude Code / Cursor
        after the first setup</strong> so it picks the new MCP server up.
      </p>
    </details>
  );
}

// Phase 63 dropped CodeRow — the panel now uses a button-driven flow that
// hits POST /api/setup-mcp directly, so the user doesn't have to copy any
// shell commands.

/** P1 (de-redundancy): one unified Topics page — expert topics
 *  (bindable persona) and plain topics live in one list. */
export function TopicsPage() {
  return <RolesPageBase />;
}

/** Back-compat for tests/imports that still reference the old names. */
export const RolesPage = TopicsPage;
export const ExpertsPage = TopicsPage;
