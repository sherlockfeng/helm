/**
 * Active Chats — Conversations rail + Knowledge IN/OUT detail pane.
 *
 * Repositioned (this PR) from "session control panel" to "knowledge flow
 * view per chat". The detail pane answers two questions for each chat:
 *
 *   - Knowledge IN  — what roles auto-inject context here, and which
 *                     chunks were retrieved for the latest turn.
 *   - Knowledge OUT — what passages from this conversation the system
 *                     flagged as worth promoting to permanent knowledge,
 *                     with promote / dismiss right on the row.
 *
 * Mirror-to-Lark, the Lark stat tile, the metric strip, the Close button,
 * the inspector sidebar, and the bordered sub-cards from the previous
 * design are all gone. Delete moves into the header overflow menu.
 *
 * Backed by /api/conversations/:id/detail (src/api/conversation-detail.ts).
 * The rail still uses /api/active-chats so it stays cheap; the heavier
 * detail aggregate is fetched only for the currently-selected row.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { ApiError, helmApi } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';
import { useEventStream } from '../hooks/useEventStream.js';
import { EmptyState } from '../components/EmptyState.js';
import { toast } from 'sonner';
import { Combobox } from '../components/Combobox.js';
import { ConfirmDialog } from '../components/Dialog.js';
import { CardSkeletonList } from '../components/Skeleton.js';
import Markdown from 'react-markdown';
import type {
  ActiveChat,
  ChatKnowledgePoint,
  ConversationDetailCandidate,
  ConversationDetailKnowledgeInPlay,
  ConversationDetailTurn,
} from '../api/types.js';

function formatRelative(iso: string): string {
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function shortId(id: string, len = 12): string {
  return id.length > len ? `${id.slice(0, len)}…` : id;
}

function truncate(s: string, max = 80): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

function chatLabel(chat: ActiveChat): string {
  if (chat.displayName && chat.displayName.trim()) return chat.displayName;
  if (chat.firstPrompt && chat.firstPrompt.trim()) return truncate(chat.firstPrompt);
  if (chat.cwd) return chat.cwd;
  return `${chat.id.slice(0, 12)}…`;
}

/**
 * Map agent_kind / host string to a stable class fragment. Drives the
 * source chip color (cursor / claude-code / codex / unknown).
 */
function sourceKey(chat: { host?: string; agentKind?: string }): string {
  const raw = (chat.agentKind || chat.host || '').toLowerCase();
  if (raw.includes('claude')) return 'claude-code';
  if (raw.includes('codex')) return 'codex';
  if (raw.includes('cursor')) return 'cursor';
  return 'unknown';
}

function sourceLabel(key: string): string {
  if (key === 'claude-code') return 'CLAUDE';
  if (key === 'cursor') return 'CURSOR';
  if (key === 'codex') return 'CODEX';
  return key.toUpperCase();
}

const CHAT_FILTERS: { value: 'active' | 'all' | 'closed'; label: string; hint: string }[] = [
  { value: 'active', label: 'Active', hint: '正在进行的会话' },
  { value: 'all', label: '全部', hint: '进行中 + 已结束' },
  { value: 'closed', label: '已结束', hint: '历史会话（含扫描导入的）' },
];

export function ChatsPage() {
  const [filter, setFilter] = useState<'active' | 'all' | 'closed'>('active');
  const { data, loading, error, reload } = useApi(() => helmApi.activeChats(filter), [filter]);
  const { data: rolesData } = useApi(() => helmApi.roles());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    if (error) toast.error(`Chats: ${error.message}`, { id: 'chats-load' });
  }, [error]);

  async function scanHistory(): Promise<void> {
    setScanning(true);
    try {
      const { results } = await helmApi.scanHistory('all');
      const imported = results.reduce((n, r) => n + r.imported, 0);
      const skipped = results.reduce((n, r) => n + r.skipped, 0);
      if (imported === 0) {
        toast.message(`没有新历史会话（已跳过 ${skipped} 个已导入的）。`);
      } else {
        const per = results.filter((r) => r.imported > 0)
          .map((r) => `${r.host} ${r.imported}`).join(' · ');
        toast.success(`导入 ${imported} 个历史会话（${per}）；跳过 ${skipped} 个。`);
      }
      reload();
    } catch (err) {
      toast.error(`扫描失败：${err instanceof ApiError ? err.message : String(err)}`);
    } finally { setScanning(false); }
  }

  useEventStream(() => { reload(); }, {
    types: ['session.started', 'session.closed'],
  });

  // Seed selection on first load + when the selected chat disappears.
  useEffect(() => {
    const chats = data?.chats ?? [];
    if (chats.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    const stillExists = selectedId !== null && chats.some((c) => c.id === selectedId);
    if (!stillExists) setSelectedId(chats[0]!.id);
  }, [data, selectedId]);

  const chats = data?.chats ?? [];
  const roles = rolesData?.roles ?? [];
  const selectedChat = selectedId ? chats.find((c) => c.id === selectedId) : undefined;

  return (
    <>
      {/* No PageHeader — the sidebar nav item "Conversations" already labels
          this surface, and the giant h1 was burning vertical space without
          earning it. The detail pane's own header IS the page's hierarchy. */}

      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
        <div className="helm-conv-filter" role="tablist" aria-label="Chat filter"
          style={{ display: 'flex', gap: 4 }}>
          {CHAT_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              role="tab"
              aria-selected={filter === f.value}
              className={`helm-seg${filter === f.value ? ' is-active' : ''}`}
              onClick={() => { setSelectedId(null); setFilter(f.value); }}
              title={f.hint}
            >
              {f.label}
            </button>
          ))}
        </div>
        {filter !== 'active' && (
          <button
            type="button"
            className="helm-seg"
            style={{ marginLeft: 'auto' }}
            disabled={scanning}
            onClick={() => { void scanHistory(); }}
            title="一次性扫描 Claude Code / Cursor / Codex 的本机记录，把装 helm 之前的历史会话导入进来（已导入的会跳过）"
          >
            {scanning ? '扫描中…' : '↧ 扫描导入历史'}
          </button>
        )}
      </div>

      {loading && <CardSkeletonList n={3} />}

      {data && chats.length === 0 && (
        <EmptyState
          title={filter === 'active' ? 'No active chats.' : '没有历史会话。'}
          hint={filter === 'active'
            ? 'Start one in Cursor / Claude Code / Codex and Helm will pick it up.'
            : '装 helm 之前的对话可以在「已结束」里点「扫描导入历史」一次性导入。'}
        />
      )}

      {data && typeof data.total === 'number' && data.total > chats.length && (
        <p className="muted" style={{ fontSize: 11, margin: '0 0 8px' }}>
          显示最近 {chats.length} / 共 {data.total} 条历史会话
        </p>
      )}

      {data && chats.length > 0 && (
        <div className="helm-rail-layout">
          <aside className="helm-rail" aria-label="Chats list">
            {chats.map((chat) => (
              <ChatRailRow
                key={chat.id}
                chat={chat}
                roles={roles}
                selected={selectedId === chat.id}
                onClick={() => setSelectedId(chat.id)}
              />
            ))}
          </aside>

          <section className="helm-rail-content">
            {/* Guard: when the filter swaps the whole list, selectedId can
                briefly point at a chat from the previous filter that isn't in
                the new list. find() → undefined; rendering the pane with an
                undefined chat white-screens the app. Render only once the
                selected chat actually exists in the current list (the
                seed-selection effect fixes selectedId right after). */}
            {selectedChat && (
              <ConversationDetailPane
                key={selectedChat.id}
                chat={selectedChat}
                roles={roles}
                onMutated={() => reload()}
              />
            )}
          </section>
        </div>
      )}
    </>
  );
}

// ── Rail row ─────────────────────────────────────────────────────────────

function ChatRailRow({
  chat, roles, selected, onClick,
}: {
  chat: ActiveChat;
  roles: { id: string; name: string }[];
  selected: boolean;
  onClick: () => void;
}): ReactElement {
  const queued = chat.queuedMessageCount ?? 0;
  const turns = chat.turnCount ?? 0;
  const pending = chat.pendingCandidateCount ?? 0;
  const key = sourceKey(chat);
  // First bound role's display name — multi-role chats are rare; if it
  // matters we can show "+N" later. For now first-wins keeps the row tight.
  const firstRole = chat.roleIds.length > 0
    ? (roles.find((r) => r.id === chat.roleIds[0])?.name ?? chat.roleIds[0]!)
    : null;
  const totalRoles = chat.roleIds.length;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`helm-rail-row${selected ? ' selected' : ''}`}
      aria-current={selected ? 'page' : undefined}
      title={chat.cwd ?? chat.id}
    >
      <div className="helm-rail-row-title">
        <span className={`helm-conv-source-chip helm-conv-source-${key}`}>
          {sourceLabel(key)}
        </span>
        <span className="helm-rail-row-label">{chatLabel(chat)}</span>
        {chat.status === 'closed' && (
          <span className="muted" style={{ fontSize: 10, marginLeft: 'auto' }} title="已结束的历史会话">已结束</span>
        )}
      </div>
      <div className="helm-rail-row-meta">
        <span className="helm-rail-row-role">
          {firstRole
            ? <>{firstRole}{totalRoles > 1 ? ` +${totalRoles - 1}` : ''}</>
            : <span className="muted">no topic</span>}
        </span>
        {turns > 0 && (
          <>
            <span className="helm-rail-row-sep">·</span>
            <span>{turns} turn{turns === 1 ? '' : 's'}</span>
          </>
        )}
        <span className="helm-rail-row-sep">·</span>
        <span>{formatRelative(chat.lastSeenAt)}</span>
        {pending > 0 && (
          <span className="helm-rail-row-badge helm-rail-row-badge-cand" title={`${pending} pending knowledge candidate${pending === 1 ? '' : 's'}`}>
            ⚠ {pending}
          </span>
        )}
        {queued > 0 && (
          <span className="helm-rail-row-badge helm-rail-row-badge-queued" title={`${queued} queued message${queued === 1 ? '' : 's'}`}>
            📨 {queued}
          </span>
        )}
      </div>
    </button>
  );
}

// ── Detail pane (single surface, hairline sections) ─────────────────────

function ConversationDetailPane({
  chat,
  roles,
  onMutated,
}: {
  chat: ActiveChat;
  roles: { id: string; name: string; isBuiltin?: boolean; bindable?: boolean }[];
  onMutated: () => void;
}): ReactElement {
  const { data, loading, reload } = useApi(
    () => helmApi.conversationDetail(chat.id),
    [chat.id],
  );

  // Refresh detail on session lifecycle changes. (Knowledge candidate +
  // retrieval-log events aren't on the SSE bus yet — promote/dismiss
  // reloads via onDecided, and the rest is fetched on selection change.)
  useEventStream(() => { reload(); }, {
    types: ['session.started', 'session.closed'],
  });

  const [savingRole, setSavingRole] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [savingTitle, setSavingTitle] = useState(false);

  // v34: per-chat capture mute — helm-dev chats about helm itself were
  // producing meta-noise buckets.
  async function toggleCapture(): Promise<void> {
    const next = data?.session.captureDisabled === true; // disabled → enable
    try {
      await helmApi.setChatCapture(chat.id, next);
      toast.success(next ? '已恢复此对话的知识捕获' : '已暂停此对话的知识捕获');
      reload();
    } catch (err) {
      toast.error(`切换失败: ${err instanceof ApiError ? err.message : (err as Error).message}`);
    }
  }

  async function addRole(roleId: string): Promise<void> {
    setSavingRole(true);
    try {
      await helmApi.addChatRole(chat.id, roleId);
      onMutated();
      reload();
    } catch (err) {
      toast.error(`绑定 topic: ${err instanceof ApiError ? err.message : (err as Error).message}`);
    } finally { setSavingRole(false); }
  }

  async function removeRole(roleId: string): Promise<void> {
    setSavingRole(true);
    try {
      await helmApi.removeChatRole(chat.id, roleId);
      onMutated();
      reload();
    } catch (err) {
      toast.error(`移除 topic: ${err instanceof ApiError ? err.message : (err as Error).message}`);
    } finally { setSavingRole(false); }
  }

  async function saveLabel(raw: string): Promise<void> {
    setSavingTitle(true);
    try {
      const cleaned = raw.trim();
      await helmApi.setChatLabel(chat.id, cleaned.length === 0 ? null : cleaned);
      onMutated();
    } catch (err) {
      toast.error(`Rename: ${err instanceof ApiError ? err.message : (err as Error).message}`);
    } finally {
      setSavingTitle(false);
      setEditingTitle(false);
    }
  }

  async function deleteChat(): Promise<void> {
    try {
      await helmApi.closeChat(chat.id, { cascade: true });
      onMutated();
      setDeleteConfirm(false);
    } catch (err) {
      toast.error(`Delete: ${err instanceof ApiError ? err.message : (err as Error).message}`);
    }
  }

  async function copySessionId(): Promise<void> {
    try {
      await navigator.clipboard.writeText(chat.id);
      toast.success('Session ID copied');
    } catch {
      toast.error('Copy failed');
    }
  }

  const key = sourceKey(chat);
  // The latest retrieval (highest turn / most recent ts) is the one whose
  // chunks the developer most likely wants to see; deeper history is
  // pageable in a follow-up. getRetrievalsForSession orders ts DESC.
  const latestRetrieval: ConversationDetailKnowledgeInPlay | undefined = data?.knowledgeInPlay[0];

  return (
    <div className="helm-conv-detail">
      {/* Header: source chip + title + overflow */}
      <div className="helm-conv-header">
        <span className={`helm-conv-source-chip helm-conv-source-${key}`}>
          {sourceLabel(key)}
        </span>
        <ChatTitle
          chat={chat}
          editing={editingTitle}
          saving={savingTitle}
          onStartEdit={() => setEditingTitle(true)}
          onCancelEdit={() => setEditingTitle(false)}
          onSave={(raw) => saveLabel(raw)}
        />
        <OverflowMenu
          onRename={() => setEditingTitle(true)}
          onCopyId={() => { void copySessionId(); }}
          captureDisabled={data?.session.captureDisabled === true}
          onToggleCapture={() => { void toggleCapture(); }}
          onDelete={() => setDeleteConfirm(true)}
        />
      </div>

      {/* Single metadata line — session id + cwd + recency, all mono+tertiary.
          Eliminates the previous double-row (session above, cwd below) noise. */}
      <div className="helm-conv-meta-strip">
        <span className="helm-conv-meta">session {shortId(chat.id, 18)}</span>
        {chat.cwd && <><span className="helm-conv-meta-sep">·</span>
          <span className="helm-conv-meta">{chat.cwd}</span></>}
        <span className="helm-conv-meta-sep">·</span>
        <span className="helm-conv-meta">{formatRelative(chat.lastSeenAt)}</span>
      </div>

      {/* TL;DR — LLM-generated "what is this chat / where did it end up".
          Rendered only when the summary is actually available; we don't
          show a loading shimmer because the value comes from a Stop
          hook handler that may not fire until the next turn ends. */}
      {data?.session.summary && (
        <div className="helm-conv-section helm-conv-tldr-section">
          <div className="helm-conv-section-header">
            <span className="helm-conv-section-label">TL;DR</span>
            {data.session.summaryGeneratedAt && (
              <span className="helm-conv-section-meta">
                {formatRelative(data.session.summaryGeneratedAt)}
              </span>
            )}
          </div>
          <div className="helm-conv-tldr-body">
            {data.session.summary.split('\n').map((line, i) => (
              <div key={i} className="helm-conv-tldr-line">{line}</div>
            ))}
          </div>
        </div>
      )}

      {/* Prompt preview block */}
      {chat.firstPrompt && (
        <div className="helm-conv-section helm-conv-prompt-section">
          <PromptPreview text={chat.firstPrompt} />
        </div>
      )}

      {/* Knowledge IN */}
      <KnowledgeInSection
        chat={chat}
        roles={roles}
        latest={latestRetrieval}
        savingRole={savingRole}
        onAddRole={(rid) => { void addRole(rid); }}
        onRemoveRole={(rid) => { void removeRole(rid); }}
      />

      {/* Knowledge OUT — one unified section: LLM-extracted knowledge points,
          each routed to an existing or new topic. Replaces the old
          deterministic entity-token walls (unknownEntities / roleSuggestions)
          and the raw candidate list — those were dumb keyword matching; this
          is a semantic pass. Sits above the timeline so it's not buried. */}
      <KnowledgePointsSection
        hostSessionId={chat.id}
        points={data?.knowledgePoints ?? []}
        roles={roles}
        onMutated={() => reload()}
      />

      {/* Timeline — turn-by-turn conversation content. Sits last among
          the content sections: it's reference material you scroll into,
          not a signal that competes with the knowledge-flow blocks. */}
      <TimelineSection turns={data?.turns ?? []} loading={loading && !data} />

      {/* Ambient footer */}
      <div className="helm-conv-footer">
        Last seen {formatRelative(chat.lastSeenAt)}
        {(chat.queuedMessageCount ?? 0) > 0 && (
          <> · <span style={{ color: 'var(--accent)' }}>{chat.queuedMessageCount} queued</span></>
        )}
      </div>

      <ConfirmDialog
        open={deleteConfirm}
        onOpenChange={(o) => { if (!o) setDeleteConfirm(false); }}
        title="Permanently delete this chat?"
        description="The session row, its bindings, and any queued messages will be removed. Knowledge captured from it stays."
        confirmLabel="Delete"
        tone="danger"
        onConfirm={() => { void deleteChat(); }}
      />
    </div>
  );
}

// ── Sections ──────────────────────────────────────────────────────────────

function KnowledgeInSection({
  chat,
  roles,
  latest,
  savingRole,
  onAddRole,
  onRemoveRole,
}: {
  chat: ActiveChat;
  roles: { id: string; name: string; isBuiltin?: boolean; bindable?: boolean }[];
  latest: ConversationDetailKnowledgeInPlay | undefined;
  savingRole: boolean;
  onAddRole: (roleId: string) => void;
  onRemoveRole: (roleId: string) => void;
}): ReactElement {
  const boundRoles = chat.roleIds.map((rid) => ({
    id: rid,
    role: roles.find((r) => r.id === rid),
  }));
  // PR-δ: only Experts are bindable — Collections (imported dirs,
  // entity buckets) stay out of the persona dropdown; retrieval still
  // covers their knowledge.
  const addable = roles.filter((r) => !chat.roleIds.includes(r.id) && r.bindable !== false && !r.isBuiltin);
  // Show up to 3 retrieved chunks; the rest fold under "show N more".
  const allPoints = latest?.points ?? [];
  const [expanded, setExpanded] = useState(false);
  const visiblePoints = expanded ? allPoints : allPoints.slice(0, 3);
  const overflow = allPoints.length - visiblePoints.length;

  const isEmpty = boundRoles.length === 0 && allPoints.length === 0;

  return (
    <div className={`helm-conv-section${isEmpty ? ' helm-conv-section-compact' : ''}`}>
      <div className="helm-conv-section-header">
        <span
          className="helm-conv-section-label"
          title="绑定的 topic 会在会话开始时把它的知识注入给 agent"
        >
          注入的知识
        </span>
        {/* Empty state lives inline in the header — a one-line section
            instead of header + explanatory paragraph. The user called
            the old two-line version "很难理解，而且浪费空间". */}
        {isEmpty && (
          <span className="helm-conv-section-meta">未绑定 topic</span>
        )}
        {addable.length > 0 && (
          <Combobox
            value=""
            placeholder="+ topic"
            disabled={savingRole}
            triggerClassName="helm-conv-add-role"
            items={addable.map((r) => ({
              value: r.id,
              label: r.name,
              description: r.isBuiltin ? 'built-in' : undefined,
            }))}
            onValueChange={(v) => { if (v) onAddRole(v); }}
          />
        )}
      </div>

      {!isEmpty && (
        <>
          {boundRoles.length > 0 && (
            <div className="helm-conv-role-chips">
              {boundRoles.map(({ id, role }) => (
                <span key={id} className="helm-conv-role-chip">
                  {role ? role.name : `${id} (unknown)`}
                  <button
                    type="button"
                    aria-label={`Remove topic ${role?.name ?? id}`}
                    disabled={savingRole}
                    onClick={() => onRemoveRole(id)}
                    className="helm-conv-role-chip-x"
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}

          {visiblePoints.length > 0 && (
            <ul className="helm-conv-chunks">
              {visiblePoints.map((p) => (
                <li key={p.pointId} className="helm-conv-chunk-row">
                  <span className="helm-conv-chunk-arrow">→</span>
                  <span className="helm-conv-chunk-title" title={p.title ?? p.pointId}>
                    {p.title ?? p.sourceFile ?? shortId(p.pointId, 24)}
                  </span>
                  <span className="helm-conv-chunk-source">
                    {p.roleName ?? p.sourceFile ?? ''}
                  </span>
                  <span className="helm-conv-chunk-score" title="Fusion score">
                    {p.fusionScore.toFixed(2)}
                  </span>
                </li>
              ))}
              {overflow > 0 && (
                <li>
                  <button
                    type="button"
                    onClick={() => setExpanded(true)}
                    className="helm-conv-link-button"
                  >
                    show {overflow} more
                  </button>
                </li>
              )}
            </ul>
          )}

          {boundRoles.length > 0 && allPoints.length === 0 && (
            <p className="helm-conv-empty">Roles bound — no retrievals captured yet for this turn.</p>
          )}
        </>
      )}
    </div>
  );
}

// ── v35: LLM knowledge points (the unified "可沉淀的知识" section) ──────────

function KnowledgePointsSection({
  hostSessionId, points, roles, onMutated,
}: {
  hostSessionId: string;
  points: ChatKnowledgePoint[];
  roles: { id: string; name: string }[];
  onMutated: () => void;
}): ReactElement {
  const [extracting, setExtracting] = useState(false);

  async function extract(): Promise<void> {
    setExtracting(true);
    try {
      const r = await helmApi.extractKnowledge(hostSessionId);
      if (r.inserted === 0) toast.message('没提取到新的知识点。');
      else toast.success(`提取了 ${r.inserted} 个知识点`);
      onMutated();
    } catch (err) {
      toast.error(`提取失败：${err instanceof ApiError ? err.message : String(err)}`);
    } finally { setExtracting(false); }
  }

  return (
    <div className="helm-conv-section">
      <div className="helm-conv-section-header">
        <span
          className="helm-conv-section-label"
          title="LLM 读这条对话，提出可沉淀为 topic 的知识点。攒够新内容会自动提取，也可手动强制。"
        >
          可沉淀的知识
        </span>
        <button
          type="button"
          className="helm-conv-link-button"
          disabled={extracting}
          onClick={() => { void extract(); }}
          title="用 LLM 立刻读这条对话，提取可沉淀为 topic 的知识点（不必等自动触发）"
        >
          {extracting ? '提取中…' : '✨ 提取知识点'}
        </button>
      </div>
      {points.length === 0 ? (
        <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>
          还没有知识点。攒够新的对话内容会自动提取，或点「✨ 提取知识点」手动跑一次。
        </p>
      ) : (
        <ul className="helm-conv-candidates">
          {points.map((p) => (
            <KnowledgePointRow key={p.id} point={p} roles={roles} onDecided={onMutated} />
          ))}
        </ul>
      )}
    </div>
  );
}

function KnowledgePointRow({
  point, roles, onDecided,
}: {
  point: ChatKnowledgePoint;
  roles: { id: string; name: string }[];
  onDecided: () => void;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const isNew = !point.suggestedRoleId;
  const suggestedName = point.suggestedRoleId
    ? (roles.find((r) => r.id === point.suggestedRoleId)?.name ?? point.suggestedRoleId)
    : (point.suggestedTopicName ?? '新 topic');

  async function accept(target: { targetRoleId?: string; newTopicName?: string }): Promise<void> {
    setBusy(true);
    try {
      const r = await helmApi.acceptKnowledgePoint(point.id, target);
      const name = roles.find((x) => x.id === r.roleId)?.name ?? r.roleId;
      toast.success(`已采纳到 ${name}`);
      onDecided();
    } catch (err) {
      toast.error(`采纳失败：${err instanceof ApiError ? err.message : String(err)}`);
    } finally { setBusy(false); }
  }

  async function dismiss(): Promise<void> {
    setBusy(true);
    try {
      await helmApi.dismissKnowledgePoint(point.id);
      toast.success('已忽略。');
      onDecided();
    } catch (err) {
      toast.error(`忽略失败：${err instanceof ApiError ? err.message : String(err)}`);
    } finally { setBusy(false); }
  }

  return (
    <li className={`helm-conv-candidate-row helm-conv-kind-${point.kind}`}>
      <div className="helm-conv-candidate-accent" />
      <div className="helm-conv-candidate-body">
        <div className="helm-conv-candidate-head">
          <span className={`helm-conv-kind-chip helm-conv-kind-chip-${point.kind}`} title={`kind: ${point.kind}`}>
            {KIND_EMOJI[point.kind]} {point.kind}
          </span>
          <span className="helm-conv-candidate-headline">{point.title}</span>
        </div>
        {expanded && <div className="helm-conv-candidate-excerpt-full">{point.body}</div>}
        <div className="helm-conv-candidate-foot">
          <span className="muted">
            建议归入 {isNew ? <>新 topic「{suggestedName}」</> : <strong>{suggestedName}</strong>}
            {' · '}
            <button type="button" className="helm-conv-link-button" onClick={() => setExpanded((v) => !v)}>
              {expanded ? '收起' : '展开'}
            </button>
          </span>
          <div className="helm-conv-candidate-actions">
            <button
              type="button"
              className="helm-conv-link-button"
              disabled={busy}
              onClick={() => {
                void accept(point.suggestedRoleId
                  ? { targetRoleId: point.suggestedRoleId }
                  : { newTopicName: point.suggestedTopicName ?? point.title });
              }}
              title={isNew ? `采纳并新建 topic「${suggestedName}」` : `采纳到 ${suggestedName}`}
            >
              ↑ {isNew ? '采纳·新建' : '采纳'}
            </button>
            <Combobox
              value=""
              placeholder="改去…"
              triggerClassName="helm-conv-add-role"
              items={roles.map((r) => ({ value: r.id, label: r.name }))}
              onValueChange={(rid) => { if (rid) void accept({ targetRoleId: rid }); }}
            />
            <button
              type="button"
              className="helm-conv-link-button helm-conv-link-danger"
              disabled={busy}
              onClick={() => { void dismiss(); }}
              title="忽略这个知识点"
            >
              ✕ 忽略
            </button>
          </div>
        </div>
      </div>
    </li>
  );
}

const KIND_EMOJI: Record<NonNullable<ConversationDetailCandidate['kind']>, string> = {
  spec: '📘',
  example: '💡',
  warning: '⚠️',
  runbook: '🛠',
  glossary: '📖',
  decision: '🎯',
  open_question: '❓',
  workaround: '🩹',
  other: '📝',
};

// ── Timeline section ──────────────────────────────────────────────────────

const INITIAL_VISIBLE_TURNS = 5;

function TimelineSection({
  turns,
  loading,
}: {
  turns: ConversationDetailTurn[];
  loading: boolean;
}): ReactElement {
  const [showAll, setShowAll] = useState(false);
  // Newest first — matches the rail's "what just happened" mental model.
  const sorted = [...turns].sort((a, b) => b.index - a.index);
  const visible = showAll ? sorted : sorted.slice(0, INITIAL_VISIBLE_TURNS);
  const hidden = sorted.length - visible.length;

  return (
    <div className="helm-conv-section">
      <div className="helm-conv-section-header">
        <span className="helm-conv-section-label">Timeline</span>
        <span className="helm-conv-section-meta">
          {turns.length === 0
            ? (loading ? 'loading…' : 'no turns yet')
            : `${turns.length} turn${turns.length === 1 ? '' : 's'}`}
        </span>
      </div>

      {turns.length === 0 && !loading && (
        <p className="helm-conv-empty">
          No prompts captured yet — the chat shows up here as soon as the first
          hook fires.
        </p>
      )}

      {visible.length > 0 && (
        <ol className="helm-conv-turns">
          {visible.map((turn, i) => (
            <TimelineTurnCard
              key={turn.index}
              turn={turn}
              // Auto-expand the most recent turn — that's the one a developer
              // glancing at a live chat actually wants to see in full.
              defaultExpanded={i === 0}
            />
          ))}
        </ol>
      )}

      {hidden > 0 && !showAll && (
        <button
          type="button"
          className="helm-conv-link-button"
          onClick={() => setShowAll(true)}
        >
          show {hidden} older turn{hidden === 1 ? '' : 's'}
        </button>
      )}
    </div>
  );
}

function TimelineTurnCard({
  turn,
  defaultExpanded,
}: {
  turn: ConversationDetailTurn;
  defaultExpanded: boolean;
}): ReactElement {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const toolCount = turn.toolEvents.filter((e) => e.kind === 'tool_use').length;
  const userOneLine = firstLine(turn.userPrompt.text) || '(empty prompt)';
  const assistantOneLine = turn.assistantResponse
    ? firstLine(turn.assistantResponse.text) || '(empty response)'
    : null;

  return (
    <li className={`helm-conv-turn${expanded ? ' expanded' : ''}`}>
      <button
        type="button"
        className="helm-conv-turn-header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="helm-conv-turn-caret" aria-hidden>{expanded ? '▼' : '▶'}</span>
        <span className="helm-conv-turn-index">Turn {turn.index}</span>
        <span className="helm-conv-turn-time muted">
          {formatRelative(turn.userPrompt.createdAt)}
        </span>
        {toolCount > 0 && (
          <span className="helm-conv-turn-tools" title={`${toolCount} tool call${toolCount === 1 ? '' : 's'}`}>
            {toolCount} tool{toolCount === 1 ? '' : 's'}
          </span>
        )}
        {!turn.assistantResponse && (
          <span className="helm-conv-turn-inflight">in-flight</span>
        )}
      </button>

      {!expanded && (
        <div className="helm-conv-turn-preview">
          <div className="helm-conv-turn-line">
            <span className="helm-conv-turn-who helm-conv-turn-who-user">you</span>
            <span className="helm-conv-turn-text">{userOneLine}</span>
          </div>
          {assistantOneLine && (
            <div className="helm-conv-turn-line">
              <span className="helm-conv-turn-who helm-conv-turn-who-ai">AI</span>
              <span className="helm-conv-turn-text">{assistantOneLine}</span>
            </div>
          )}
        </div>
      )}

      {expanded && (
        <div className="helm-conv-turn-body">
          <div className="helm-conv-turn-msg helm-conv-turn-msg-user">
            <span className="helm-conv-turn-who helm-conv-turn-who-user">you</span>
            {/* react-markdown emits multiple top-level <p> children; without a
                wrapping div they each become flex items and split the row
                into N narrow columns. Wrap once to keep markdown a single
                flex child that stacks naturally. */}
            <div className="helm-conv-turn-md">
              <Markdown>{turn.userPrompt.text || '_(empty prompt)_'}</Markdown>
            </div>
          </div>
          {turn.assistantResponse && (
            <div className="helm-conv-turn-msg helm-conv-turn-msg-ai">
              <span className="helm-conv-turn-who helm-conv-turn-who-ai">AI</span>
              <div className="helm-conv-turn-md">
                <Markdown>{turn.assistantResponse.text || '_(empty response)_'}</Markdown>
              </div>
            </div>
          )}
          {turn.toolEvents.length > 0 && (
            <div className="helm-conv-turn-tools-list">
              <div className="helm-conv-turn-tools-label">tool events</div>
              <ul>
                {turn.toolEvents.map((e, i) => (
                  <li key={i}>
                    <span className="helm-conv-turn-tool-kind">{e.kind}</span>
                    <code>{summarizePayload(e.payload)}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function firstLine(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const nl = trimmed.indexOf('\n');
  const line = nl === -1 ? trimmed : trimmed.slice(0, nl);
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

function summarizePayload(p: Record<string, unknown>): string {
  // Concise one-liner for the tool-events list — caller wraps in <code>.
  const cmd = p['command'] ?? p['cmd'];
  const tool = p['tool'];
  if (tool && cmd) return `${String(tool)}: ${String(cmd).slice(0, 100)}`;
  if (cmd) return String(cmd).slice(0, 120);
  if (tool) return String(tool);
  return JSON.stringify(p).slice(0, 120);
}

// ── Small UI pieces ───────────────────────────────────────────────────────

function PromptPreview({ text }: { text: string }): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > 240;
  return (
    <div>
      <div className={`helm-conv-prompt${expanded || !isLong ? ' expanded' : ''}`}>{text}</div>
      {isLong && (
        <button
          type="button"
          className="helm-conv-link-button"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'show less' : 'show more'}
        </button>
      )}
    </div>
  );
}

function OverflowMenu({
  onRename,
  onCopyId,
  captureDisabled,
  onToggleCapture,
  onDelete,
}: {
  onRename: () => void;
  onCopyId: () => void;
  captureDisabled: boolean;
  onToggleCapture: () => void;
  onDelete: () => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent): void {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div ref={wrapRef} className="helm-conv-overflow">
      <button
        type="button"
        className="helm-conv-overflow-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        onClick={() => setOpen((v) => !v)}
      >
        ⋯
      </button>
      {open && (
        <div role="menu" className="helm-conv-overflow-menu">
          <button type="button" role="menuitem" onClick={() => { onRename(); setOpen(false); }}
            title="给这条对话改一个好认的标题">
            Rename…
          </button>
          <button type="button" role="menuitem" onClick={() => { onCopyId(); setOpen(false); }}
            title="复制这条对话的 session id（排查 / 关联日志用）">
            Copy session id
          </button>
          <button type="button" role="menuitem" onClick={() => { onToggleCapture(); setOpen(false); }}
            title={captureDisabled
              ? '恢复后，这条对话的新内容会重新被提取为知识候选'
              : '暂停后，这条对话不再自动提取知识候选（适合调试 / 闲聊）'}>
            {captureDisabled ? '🔔 恢复知识捕获' : '🔕 暂停知识捕获'}
          </button>
          <div className="helm-conv-overflow-divider" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="helm-conv-overflow-danger"
            onClick={() => { onDelete(); setOpen(false); }}
            title="从 helm 删除这条对话记录（不影响已采纳的知识）"
          >
            Delete chat
          </button>
        </div>
      )}
    </div>
  );
}

function ChatTitle({
  chat, editing, saving, onStartEdit, onCancelEdit, onSave,
}: {
  chat: ActiveChat;
  editing: boolean;
  saving: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSave: (raw: string) => void;
}): ReactElement {
  const label = chatLabel(chat);
  const tooltip = chat.firstPrompt ?? chat.cwd ?? chat.id;
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(chat.displayName ?? '');

  useEffect(() => {
    if (editing) {
      setDraft(chat.displayName ?? '');
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing, chat.displayName]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={draft}
        disabled={saving}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); onSave(draft); }
          else if (e.key === 'Escape') { e.preventDefault(); onCancelEdit(); }
        }}
        onBlur={() => onSave(draft)}
        placeholder={chat.firstPrompt ? truncate(chat.firstPrompt, 40) : 'Chat title'}
        aria-label={`Rename chat ${chat.id}`}
        maxLength={120}
        className="helm-conv-title-input"
      />
    );
  }

  return (
    <h2
      className="helm-conv-title"
      title={tooltip}
      onDoubleClick={onStartEdit}
    >
      {label || '(awaiting first message)'}
    </h2>
  );
}
