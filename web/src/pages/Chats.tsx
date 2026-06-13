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

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useCandidateContexts } from '../hooks/useCandidateContexts.js';
import { ApiError, helmApi } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';
import { useEventStream } from '../hooks/useEventStream.js';
import { EmptyState } from '../components/EmptyState.js';
import { toast } from 'sonner';
import { Combobox } from '../components/Combobox.js';
import { ConfirmDialog, Dialog, DialogContent } from '../components/Dialog.js';
import { Button } from '../components/Button.js';
import { CardSkeletonList } from '../components/Skeleton.js';
import Markdown from 'react-markdown';
import type {
  ActiveChat,
  ConversationDetailCandidate,
  ConversationDetailKnowledgeInPlay,
  ConversationDetailTurn,
  RoleSuggestion,
  UnknownEntity,
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

export function ChatsPage() {
  const { data, loading, error, reload } = useApi(() => helmApi.activeChats());
  const { data: rolesData } = useApi(() => helmApi.roles());
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (error) toast.error(`Active chats: ${error.message}`, { id: 'chats-load' });
  }, [error]);

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

  return (
    <>
      {/* No PageHeader — the sidebar nav item "Conversations" already labels
          this surface, and the giant h1 was burning vertical space without
          earning it. The detail pane's own header IS the page's hierarchy. */}

      {loading && <CardSkeletonList n={3} />}

      {data && chats.length === 0 && (
        <EmptyState
          title="No active chats."
          hint="Start one in Cursor / Claude Code / Codex and Helm will pick it up."
        />
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
            {selectedId && (
              <ConversationDetailPane
                key={selectedId}
                chat={chats.find((c) => c.id === selectedId)!}
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
  const candidates = data?.candidates ?? [];
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

      {/* Discovery layers sit ABOVE the timeline — they're the actionable
          knowledge-flow signals this page exists for, and the timeline
          (with its auto-expanded latest turn) is tall enough to push
          anything below it out of the first viewport. Buried-below-fold
          was exactly how the user missed them. */}
      <UnknownEntitiesSection
        unknownEntities={data?.unknownEntities ?? []}
        turns={data?.turns ?? []}
        hostSessionId={chat.id}
        onSpawned={() => reload()}
      />
      <RoleSuggestionsSection
        suggestions={data?.roleSuggestions ?? []}
        hostSessionId={chat.id}
        onAddRole={(rid) => { void addRole(rid); }}
        onExtracted={() => reload()}
        savingRole={savingRole}
      />

      {/* Knowledge OUT — directly after discovery so suggestion → extract
          → candidates reads as one continuous flow. */}
      <KnowledgeOutSection
        candidates={candidates}
        onDecided={() => reload()}
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
  const addable = roles.filter((r) => !chat.roleIds.includes(r.id) && r.bindable !== false);
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

// ── Unknown entities (Path B — spawn role from chat) ────────────────────

/**
 * Where in this chat does an entity appear? Pure client-side scan over
 * the already-fetched turns — no extra round-trip. Returns up to
 * `cap` snippets with ±60 chars of context around the first occurrence
 * per message.
 */
function findEntityMentions(
  turns: readonly ConversationDetailTurn[],
  entity: string,
  cap = 4,
): Array<{ turnIndex: number; who: 'you' | 'AI'; snippet: string }> {
  const needle = entity.toLowerCase();
  const out: Array<{ turnIndex: number; who: 'you' | 'AI'; snippet: string }> = [];
  for (const t of turns) {
    const sources: Array<['you' | 'AI', string]> = [['you', t.userPrompt.text]];
    if (t.assistantResponse) sources.push(['AI', t.assistantResponse.text]);
    for (const [who, text] of sources) {
      const idx = text.toLowerCase().indexOf(needle);
      if (idx === -1) continue;
      const start = Math.max(0, idx - 60);
      const end = Math.min(text.length, idx + needle.length + 60);
      out.push({
        turnIndex: t.index,
        who,
        snippet: `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`,
      });
      if (out.length >= cap) return out;
    }
  }
  return out;
}

function UnknownEntitiesSection({
  unknownEntities,
  turns,
  hostSessionId,
  onSpawned,
}: {
  unknownEntities: UnknownEntity[];
  turns: ConversationDetailTurn[];
  hostSessionId: string;
  onSpawned: () => void;
}): ReactElement | null {
  const [showModal, setShowModal] = useState(false);
  // Which entity's provenance is expanded; null = none.
  const [inspecting, setInspecting] = useState<string | null>(null);
  if (unknownEntities.length === 0) return null;
  const mentions = inspecting ? findEntityMentions(turns, inspecting) : [];
  return (
    <>
      <div className="helm-conv-section">
        <div className="helm-conv-section-header">
          <span className="helm-conv-section-label">helm 不认识的内容</span>
          <span className="helm-conv-section-meta">
            {unknownEntities.length} unknown {unknownEntities.length === 1 ? 'entity' : 'entities'}
          </span>
        </div>
        <p className="helm-conv-empty" style={{ marginBottom: 8 }}>
          这条 chat 反复提到 helm 还没有 topic 覆盖的内容。要不要建一个 topic 来沉淀？
        </p>
        <div className="helm-conv-unknown-chips">
          {unknownEntities.map((e) => (
            <button
              key={e.entity}
              type="button"
              className={`helm-conv-unknown-chip is-amber${inspecting === e.entity ? ' is-selected' : ''}`}
              title="点击查看它在对话里出现的位置"
              aria-expanded={inspecting === e.entity}
              onClick={() => setInspecting((cur) => (cur === e.entity ? null : e.entity))}
            >
              {e.entity} <span className="helm-conv-unknown-chip-count">×{e.mentions}</span>
            </button>
          ))}
        </div>
        {inspecting && (
          <div className="helm-conv-mentions">
            {mentions.length === 0 ? (
              <div className="helm-conv-mention-row muted">
                出现在更早的 turn 里（timeline 截断了）
              </div>
            ) : (
              mentions.map((m, i) => (
                <div key={i} className="helm-conv-mention-row">
                  <span className="helm-conv-mention-loc">Turn {m.turnIndex} · {m.who}</span>
                  <span className="helm-conv-mention-snippet">{m.snippet}</span>
                </div>
              ))
            )}
          </div>
        )}
        <div style={{ marginTop: 10 }}>
          <button
            type="button"
            className="helm-conv-link-button"
            onClick={() => setShowModal(true)}
            title="用这些未识别实体作种子，新建一个 topic 来沉淀这条对话反复提到的内容"
          >
            + 新建 topic…
          </button>
        </div>
      </div>
      {showModal && (
        <SpawnRoleModal
          hostSessionId={hostSessionId}
          unknownEntities={unknownEntities}
          onClose={() => setShowModal(false)}
          onSpawned={(roleName, total) => {
            setShowModal(false);
            toast.success(`Topic "${roleName}" 已创建 · 自动提取了 ${total} 个候选`);
            onSpawned();
          }}
        />
      )}
    </>
  );
}

function SpawnRoleModal({
  hostSessionId,
  unknownEntities,
  onClose,
  onSpawned,
}: {
  hostSessionId: string;
  unknownEntities: UnknownEntity[];
  onClose: () => void;
  onSpawned: (roleName: string, totalCandidates: number) => void;
}): ReactElement {
  // Default selection: top 5 entities. User can uncheck.
  const initial = useMemo(
    () => new Set(unknownEntities.slice(0, 5).map((e) => e.entity)),
    [unknownEntities],
  );
  const [selected, setSelected] = useState<Set<string>>(initial);
  const [roleName, setRoleName] = useState(
    unknownEntities[0] ? `${unknownEntities[0].entity} 专家` : '新建 topic',
  );
  const [submitting, setSubmitting] = useState(false);

  function toggle(entity: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(entity)) next.delete(entity);
      else next.add(entity);
      return next;
    });
  }

  async function submit(): Promise<void> {
    if (selected.size === 0 || !roleName.trim()) return;
    setSubmitting(true);
    try {
      const r = await helmApi.spawnRoleFromChat(hostSessionId, {
        entities: Array.from(selected),
        roleName: roleName.trim(),
      });
      onSpawned(r.roleName, r.updateCount + r.newCount);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      toast.error(`新建 topic 失败: ${msg}`);
    } finally { setSubmitting(false); }
  }

  return (
    <Dialog open={true} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        width={Math.min(560, typeof window !== 'undefined' ? window.innerWidth * 0.9 : 560)}
        aria-label="Create topic from chat"
      >
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>从这条 chat 新建 topic</div>
          <div className="muted" style={{ fontSize: 12 }}>
            helm 会用 chat 里提到选中实体的段落作为 topic 的种子知识，自动训练 + 提取候选。
          </div>
        </div>

        <label style={{ display: 'block', marginBottom: 12 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Topic name</div>
          <input
            type="text"
            value={roleName}
            onChange={(e) => setRoleName(e.target.value.slice(0, 60))}
            placeholder="OG 专家"
            style={{
              width: '100%', padding: '6px 10px', fontSize: 13,
              border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
            }}
          />
        </label>

        <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
          种子实体（chat 里提到这些词的段落会被收进 topic）
        </div>
        <div className="helm-conv-unknown-chips" style={{ marginBottom: 12 }}>
          {unknownEntities.map((e) => {
            const on = selected.has(e.entity);
            return (
              <button
                key={e.entity}
                type="button"
                onClick={() => toggle(e.entity)}
                className={`helm-conv-unknown-chip${on ? ' is-selected' : ''}`}
                aria-pressed={on}
              >
                {on ? '✓ ' : ''}{e.entity}
                <span className="helm-conv-unknown-chip-count">×{e.mentions}</span>
              </button>
            );
          })}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <Button
            variant="primary"
            disabled={submitting || selected.size === 0 || !roleName.trim()}
            onClick={() => { void submit(); }}
            title="新建这个 topic，并立刻从当前对话提取相关知识候选"
          >
            {submitting ? '创建中…' : `创建 topic + 提取`}
          </Button>
          <button type="button" onClick={onClose} disabled={submitting} title="关闭，不创建">取消</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Role suggestions (KNOWLEDGE OUT — discovery layer) ────────────────────

function RoleSuggestionsSection({
  suggestions,
  hostSessionId,
  onAddRole,
  onExtracted,
  savingRole,
}: {
  suggestions: RoleSuggestion[];
  hostSessionId: string;
  onAddRole: (roleId: string) => void;
  onExtracted: () => void;
  savingRole: boolean;
}): ReactElement | null {
  // Only show unbound roles — bound ones are already in KNOWLEDGE IN.
  const unbound = suggestions.filter((s) => !s.isBound);
  if (unbound.length === 0) return null;

  return (
    <div className="helm-conv-section">
      <div className="helm-conv-section-header">
        <span className="helm-conv-section-label">这条对话涉及</span>
        <span className="helm-conv-section-meta">
          {unbound.length} {unbound.length === 1 ? 'topic' : 'topics'} matched
        </span>
      </div>
      <ul className="helm-conv-suggestions">
        {unbound.map((s) => (
          <RoleSuggestionRow
            key={s.roleId}
            suggestion={s}
            hostSessionId={hostSessionId}
            savingRole={savingRole}
            onAddRole={onAddRole}
            onExtracted={onExtracted}
          />
        ))}
      </ul>
    </div>
  );
}

function RoleSuggestionRow({
  suggestion,
  hostSessionId,
  savingRole,
  onAddRole,
  onExtracted,
}: {
  suggestion: RoleSuggestion;
  hostSessionId: string;
  savingRole: boolean;
  onAddRole: (roleId: string) => void;
  onExtracted: () => void;
}): ReactElement {
  const [extracting, setExtracting] = useState(false);

  async function extract(): Promise<void> {
    setExtracting(true);
    try {
      const r = await helmApi.extractForRole(hostSessionId, suggestion.roleId);
      const total = r.updateCount + r.newCount;
      if (total === 0) {
        toast.message(`${suggestion.roleName}：没有提取到新知识。`);
      } else {
        toast.success(
          `已为 ${suggestion.roleName} 提取 ${total} 个候选`
          + `（${r.updateCount} 更新 · ${r.newCount} 新）`,
        );
      }
      onExtracted();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      toast.error(`提取失败：${msg}`);
    } finally { setExtracting(false); }
  }

  return (
    <li className="helm-conv-suggestion">
      <div className="helm-conv-suggestion-head">
        <span className="helm-conv-suggestion-role">{suggestion.roleName}</span>
        <span className="helm-conv-suggestion-meta">
          {suggestion.hitEntities.length} {suggestion.hitEntities.length === 1 ? 'entity' : 'entities'}
          {' · '}
          {suggestion.totalHits} {suggestion.totalHits === 1 ? 'mention' : 'mentions'}
        </span>
        <button
          type="button"
          className="helm-conv-link-button"
          disabled={extracting || savingRole}
          onClick={() => { void extract(); }}
          title="一次性：扫这条对话里匹配该 topic 的内容，跑 LLM 审一遍，产出知识候选（见下方「提取的知识」）。不改变绑定关系。"
        >
          {extracting ? '提取中…' : '↗ 提取'}
        </button>
        <button
          type="button"
          className="helm-conv-link-button"
          disabled={savingRole || extracting}
          onClick={() => onAddRole(suggestion.roleId)}
          title="持续：把这条对话绑定到该 topic，之后的新内容自动捕获到这里"
        >
          + 绑定
        </button>
      </div>
      <div className="helm-conv-suggestion-entities">
        {suggestion.hitEntities.slice(0, 6).map((e) => (
          <span key={e} className="helm-conv-entity-chip">{e}</span>
        ))}
        {suggestion.hitEntities.length > 6 && (
          <span className="helm-conv-entity-more">
            +{suggestion.hitEntities.length - 6}
          </span>
        )}
      </div>
    </li>
  );
}

function KnowledgeOutSection({
  candidates,
  onDecided,
}: {
  candidates: ConversationDetailCandidate[];
  onDecided: () => void;
}): ReactElement | null {
  const candidateIds = useMemo(() => candidates.map((c) => c.id), [candidates]);
  const { contexts } = useCandidateContexts(candidateIds);
  // PR-B: split by whether the candidate refines an existing chunk
  // (UPDATE) or proposes new knowledge (NEW). Different visual
  // affordances — updates carry a reference to the chunk they replace.
  const updates = candidates.filter((c) => c.targetChunkId);
  const news = candidates.filter((c) => !c.targetChunkId);

  // No candidates → no section. The extract affordance already lives on
  // the suggestion rows above; an empty section with a how-to sentence
  // was pure noise ("浪费空间" per user feedback).
  if (candidates.length === 0) return null;

  return (
    <div className="helm-conv-section">
      <div className="helm-conv-section-header">
        <span
          className="helm-conv-section-label"
          title="从这条对话里提取出来的知识候选 — 采纳后进入 topic 的知识库"
        >
          提取的知识
        </span>
        <span className="helm-conv-section-meta">
          {updates.length > 0 && `${updates.length} update${updates.length === 1 ? '' : 's'}`}
          {updates.length > 0 && news.length > 0 && ' · '}
          {news.length > 0 && `${news.length} new`}
        </span>
      </div>

      {updates.length > 0 && (
        <div className="helm-conv-out-group">
          <div className="helm-conv-out-group-label">🔄 建议更新</div>
          <ul className="helm-conv-candidates">
            {updates.map((c) => (
              <CandidateRow key={c.id} candidate={c} onDecided={onDecided}
                externalContext={contexts[c.id]} />
            ))}
          </ul>
        </div>
      )}

      {news.length > 0 && (
        <div className="helm-conv-out-group">
          <div className="helm-conv-out-group-label">💡 新知识</div>
          <ul className="helm-conv-candidates">
            {news.map((c) => (
              <CandidateRow key={c.id} candidate={c} onDecided={onDecided}
                externalContext={contexts[c.id]} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CandidateRow({
  candidate,
  onDecided,
  externalContext,
}: {
  candidate: ConversationDetailCandidate;
  onDecided: () => void;
  externalContext?: import('../api/types.js').CandidateExternalContext;
}): ReactElement {
  const [busy, setBusy] = useState<'promote' | 'dismiss' | null>(null);

  async function promote(): Promise<void> {
    setBusy('promote');
    try {
      await helmApi.acceptCandidate(candidate.id);
      toast.success('已采纳到知识库。');
      onDecided();
    } catch (err) {
      toast.error(`采纳失败：${err instanceof ApiError ? err.message : (err as Error).message}`);
    } finally { setBusy(null); }
  }

  async function dismiss(): Promise<void> {
    setBusy('dismiss');
    try {
      await helmApi.rejectCandidate(candidate.id);
      toast.success('已忽略。');
      onDecided();
    } catch (err) {
      toast.error(`忽略失败：${err instanceof ApiError ? err.message : (err as Error).message}`);
    } finally { setBusy(null); }
  }

  // Show the LLM-classified gist as the headline when present; fall back
  // to the raw chunkText (the original behavior) when classification
  // hasn't run yet or failed. The full text is always available behind
  // an expand toggle so the user can see what's actually being promoted.
  const [expanded, setExpanded] = useState(false);
  const headline = candidate.gist?.trim() || candidate.chunkText;
  const showFold = Boolean(candidate.gist?.trim()) && candidate.chunkText.trim() !== headline.trim();
  const kind = candidate.kind ?? 'other';

  return (
    <li className={`helm-conv-candidate-row helm-conv-kind-${kind}`}>
      <div className="helm-conv-candidate-accent" />
      <div className="helm-conv-candidate-body">
        <div className="helm-conv-candidate-head">
          <span
            className={`helm-conv-kind-chip helm-conv-kind-chip-${kind}`}
            title={`kind: ${kind}`}
          >
            {KIND_EMOJI[kind]} {kind}
          </span>
          <span className="helm-conv-candidate-headline">{headline}</span>
        </div>
        {expanded && showFold && (
          <div className="helm-conv-candidate-excerpt-full">{candidate.chunkText}</div>
        )}
        {externalContext && (
          <details style={{ marginTop: 4 }}>
            <summary style={{ cursor: 'pointer', fontSize: 11, color: '#6d28d9' }}>
              组织已有相关（{externalContext.providers.join(' · ')}）
            </summary>
            <pre style={{
              margin: '4px 0 0', fontSize: 11, whiteSpace: 'pre-wrap',
              maxHeight: 160, overflow: 'auto',
            }}>{externalContext.body}</pre>
          </details>
        )}
        <div className="helm-conv-candidate-foot">
          <span className="muted">
            from this chat · {formatRelative(candidate.createdAt)}
            {showFold && (
              <>
                {' '}·{' '}
                <button
                  type="button"
                  className="helm-conv-link-button"
                  onClick={() => setExpanded((v) => !v)}
                >
                  {expanded ? 'hide original' : 'show original'}
                </button>
              </>
            )}
          </span>
          <div className="helm-conv-candidate-actions">
            <button
              type="button"
              className="helm-conv-link-button"
              disabled={busy !== null}
              onClick={() => { void promote(); }}
              title="采纳到这个 topic 的知识库（写入个人层 chat-captured）"
            >
              ↑ 采纳
            </button>
            <button
              type="button"
              className="helm-conv-link-button helm-conv-link-danger"
              disabled={busy !== null}
              onClick={() => { void dismiss(); }}
              title="忽略这条候选"
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
