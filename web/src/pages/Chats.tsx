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
            : <span className="muted">no role</span>}
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
  roles: { id: string; name: string; isBuiltin?: boolean }[];
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

  async function addRole(roleId: string): Promise<void> {
    setSavingRole(true);
    try {
      await helmApi.addChatRole(chat.id, roleId);
      onMutated();
      reload();
    } catch (err) {
      toast.error(`Add role: ${err instanceof ApiError ? err.message : (err as Error).message}`);
    } finally { setSavingRole(false); }
  }

  async function removeRole(roleId: string): Promise<void> {
    setSavingRole(true);
    try {
      await helmApi.removeChatRole(chat.id, roleId);
      onMutated();
      reload();
    } catch (err) {
      toast.error(`Remove role: ${err instanceof ApiError ? err.message : (err as Error).message}`);
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

      {/* Timeline — turn-by-turn conversation content */}
      <TimelineSection turns={data?.turns ?? []} loading={loading && !data} />

      {/* Knowledge OUT */}
      <KnowledgeOutSection
        candidates={candidates}
        loading={loading && !data}
        onDecided={() => reload()}
      />

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
  roles: { id: string; name: string; isBuiltin?: boolean }[];
  latest: ConversationDetailKnowledgeInPlay | undefined;
  savingRole: boolean;
  onAddRole: (roleId: string) => void;
  onRemoveRole: (roleId: string) => void;
}): ReactElement {
  const boundRoles = chat.roleIds.map((rid) => ({
    id: rid,
    role: roles.find((r) => r.id === rid),
  }));
  const addable = roles.filter((r) => !chat.roleIds.includes(r.id));
  // Show up to 3 retrieved chunks; the rest fold under "show N more".
  const allPoints = latest?.points ?? [];
  const [expanded, setExpanded] = useState(false);
  const visiblePoints = expanded ? allPoints : allPoints.slice(0, 3);
  const overflow = allPoints.length - visiblePoints.length;

  return (
    <div className="helm-conv-section">
      <div className="helm-conv-section-header">
        <span className="helm-conv-section-label">Knowledge in</span>
        {addable.length > 0 && (
          <Combobox
            value=""
            placeholder="+ role"
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

      {boundRoles.length === 0 && allPoints.length === 0 ? (
        <p className="helm-conv-empty">No role bound — agent runs on base prompt only.</p>
      ) : (
        <>
          {boundRoles.length > 0 && (
            <div className="helm-conv-role-chips">
              {boundRoles.map(({ id, role }) => (
                <span key={id} className="helm-conv-role-chip">
                  {role ? role.name : `${id} (unknown)`}
                  <button
                    type="button"
                    aria-label={`Remove role ${role?.name ?? id}`}
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

function KnowledgeOutSection({
  candidates,
  loading,
  onDecided,
}: {
  candidates: ConversationDetailCandidate[];
  loading: boolean;
  onDecided: () => void;
}): ReactElement {
  return (
    <div className="helm-conv-section">
      <div className="helm-conv-section-header">
        <span className="helm-conv-section-label">Knowledge out</span>
        <span className="helm-conv-section-meta">
          {candidates.length === 0
            ? (loading ? 'loading…' : '0 candidates')
            : `${candidates.length} ${candidates.length === 1 ? 'candidate' : 'candidates'}`}
        </span>
      </div>

      {candidates.length === 0 && !loading && (
        <p className="helm-conv-empty">
          <span className="helm-conv-pulse-dot" aria-hidden /> Watching for promotable passages…
        </p>
      )}

      {candidates.length > 0 && (
        <ul className="helm-conv-candidates">
          {candidates.map((c) => (
            <CandidateRow key={c.id} candidate={c} onDecided={onDecided} />
          ))}
        </ul>
      )}
    </div>
  );
}

function CandidateRow({
  candidate,
  onDecided,
}: {
  candidate: ConversationDetailCandidate;
  onDecided: () => void;
}): ReactElement {
  const [busy, setBusy] = useState<'promote' | 'dismiss' | null>(null);

  async function promote(): Promise<void> {
    setBusy('promote');
    try {
      await helmApi.acceptCandidate(candidate.id);
      toast.success('Promoted to knowledge.');
      onDecided();
    } catch (err) {
      toast.error(`Promote: ${err instanceof ApiError ? err.message : (err as Error).message}`);
    } finally { setBusy(null); }
  }

  async function dismiss(): Promise<void> {
    setBusy('dismiss');
    try {
      await helmApi.rejectCandidate(candidate.id);
      toast.success('Dismissed.');
      onDecided();
    } catch (err) {
      toast.error(`Dismiss: ${err instanceof ApiError ? err.message : (err as Error).message}`);
    } finally { setBusy(null); }
  }

  return (
    <li className="helm-conv-candidate-row">
      <div className="helm-conv-candidate-accent" />
      <div className="helm-conv-candidate-body">
        <div className="helm-conv-candidate-excerpt">{candidate.chunkText}</div>
        <div className="helm-conv-candidate-foot">
          <span className="muted">
            from this chat · {formatRelative(candidate.createdAt)}
          </span>
          <div className="helm-conv-candidate-actions">
            <button
              type="button"
              className="helm-conv-link-button"
              disabled={busy !== null}
              onClick={() => { void promote(); }}
              title="Promote to knowledge (P)"
            >
              ↑ Promote
            </button>
            <button
              type="button"
              className="helm-conv-link-button helm-conv-link-danger"
              disabled={busy !== null}
              onClick={() => { void dismiss(); }}
              title="Dismiss (D)"
            >
              ✕ Dismiss
            </button>
          </div>
        </div>
      </div>
    </li>
  );
}

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
            <Markdown>{turn.userPrompt.text || '_(empty prompt)_'}</Markdown>
          </div>
          {turn.assistantResponse && (
            <div className="helm-conv-turn-msg helm-conv-turn-msg-ai">
              <span className="helm-conv-turn-who helm-conv-turn-who-ai">AI</span>
              <Markdown>{turn.assistantResponse.text || '_(empty response)_'}</Markdown>
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
  onDelete,
}: {
  onRename: () => void;
  onCopyId: () => void;
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
          <button type="button" role="menuitem" onClick={() => { onRename(); setOpen(false); }}>
            Rename…
          </button>
          <button type="button" role="menuitem" onClick={() => { onCopyId(); setOpen(false); }}>
            Copy session id
          </button>
          <div className="helm-conv-overflow-divider" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="helm-conv-overflow-danger"
            onClick={() => { onDelete(); setOpen(false); }}
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
