/**
 * Active Chats — every host_session that's still open.
 *
 * Phase 25: each chat row had a single-role picker dropdown.
 * Phase 36: Close + Delete buttons (soft / cascade).
 * Phase 42: dropdown → multi-select chips. Each bound role shows as a chip
 * with an inline ✕ to remove. An "+ Add role" picker beneath lets the user
 * stack more (e.g. Goofy + 容灾大盘 + Developer). The next session_start
 * concatenates every role's prompt + chunks into the injected context.
 * Phase 55: chat title is editable inline. The user-set displayName wins
 * over firstPrompt. Pencil icon flips the title to a textbox; Enter saves,
 * Escape cancels, blur saves. Empty value clears the override.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { ApiError, helmApi } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';
import { useEventStream } from '../hooks/useEventStream.js';
import { EmptyState } from '../components/EmptyState.js';
import type { ActiveChat, ChannelBinding } from '../api/types.js';

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

/**
 * Phase 55: pick the best human-readable label for a chat.
 *   1. user-set displayName (wins outright)
 *   2. first user prompt captured by Phase 32
 *   3. cwd (when no prompt yet — fresh chat)
 *   4. id prefix (last resort)
 */
function chatLabel(chat: ActiveChat): string {
  if (chat.displayName && chat.displayName.trim()) return chat.displayName;
  if (chat.firstPrompt && chat.firstPrompt.trim()) return truncate(chat.firstPrompt);
  if (chat.cwd) return chat.cwd;
  return `${chat.id.slice(0, 12)}…`;
}

export function ChatsPage() {
  const { data, loading, error, reload } = useApi(() => helmApi.activeChats());
  const { data: rolesData } = useApi(() => helmApi.roles());
  // Phase 62: pull bindings so we can show Lark status per chat. Refreshes
  // on the same SSE events the Bindings page listens for.
  const { data: bindingsData, reload: reloadBindings } = useApi(() => helmApi.bindings());
  useEventStream(() => { reload(); reloadBindings(); }, {
    types: ['session.started', 'session.closed', 'binding.created', 'binding.removed'],
  });
  const [savingId, setSavingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  // Phase 62: which chat (if any) currently has the Mirror-to-Lark modal open.
  const [bindModalFor, setBindModalFor] = useState<string | null>(null);
  // Phase 55: which row's title is currently being edited. Only one at a
  // time so escape-from-edit doesn't accidentally cancel another row.
  const [editingId, setEditingId] = useState<string | null>(null);

  async function saveLabel(hostSessionId: string, raw: string): Promise<void> {
    setSavingId(hostSessionId);
    setRowError(null);
    try {
      // Empty / whitespace-only → null clears the override; backend trims and
      // caps so we don't have to.
      const cleaned = raw.trim();
      await helmApi.setChatLabel(hostSessionId, cleaned.length === 0 ? null : cleaned);
      reload();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setRowError({ id: hostSessionId, message: msg });
    } finally {
      setSavingId(null);
      setEditingId(null);
    }
  }

  async function addRole(hostSessionId: string, roleId: string): Promise<void> {
    setSavingId(hostSessionId);
    setRowError(null);
    try {
      await helmApi.addChatRole(hostSessionId, roleId);
      reload();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setRowError({ id: hostSessionId, message: msg });
    } finally {
      setSavingId(null);
    }
  }

  async function removeRole(hostSessionId: string, roleId: string): Promise<void> {
    setSavingId(hostSessionId);
    setRowError(null);
    try {
      await helmApi.removeChatRole(hostSessionId, roleId);
      reload();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setRowError({ id: hostSessionId, message: msg });
    } finally {
      setSavingId(null);
    }
  }

  async function closeChat(hostSessionId: string, cascade: boolean): Promise<void> {
    const verb = cascade ? 'permanently delete this chat' : 'close this chat';
    const detail = cascade
      ? 'The session row, its bindings, and any queued Lark messages will be removed.'
      : "It'll disappear from this list but the row + bindings stay for history.";
    if (!window.confirm(`${verb}?\n\n${detail}`)) return;
    setSavingId(hostSessionId);
    setRowError(null);
    try {
      await helmApi.closeChat(hostSessionId, { cascade });
      reload();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setRowError({ id: hostSessionId, message: msg });
    } finally {
      setSavingId(null);
    }
  }

  const roles = rolesData?.roles ?? [];

  return (
    <>
      <h2>Active Chats</h2>
      <p className="muted">
        Cursor sessions Helm is currently observing. Bind a role to a chat and
        Helm injects that role's system prompt + knowledge on the next
        session_start.
      </p>

      {loading && <p className="muted">Loading…</p>}
      {error && <p className="muted" style={{ color: 'var(--danger)' }}>Failed to load: {error.message}</p>}

      {data && data.chats.length === 0 && (
        <EmptyState
          title="No active Cursor chats."
          hint="Start one and Helm will pick it up automatically."
        />
      )}

      {data && data.chats.map((chat) => (
        <article key={chat.id} className="helm-card">
          <div className="row">
            <div>
              <div className="label">{chat.host}</div>
              {/* Phase 55: editable title. displayName > firstPrompt > cwd > id.
                  Click the pencil to edit; Enter saves, Escape cancels, blur saves
                  (saves empty → clears the override). */}
              <ChatTitle
                chat={chat}
                editing={editingId === chat.id}
                saving={savingId === chat.id}
                onStartEdit={() => setEditingId(chat.id)}
                onCancelEdit={() => setEditingId(null)}
                onSave={(raw) => saveLabel(chat.id, raw)}
              />
              <div className="label" style={{ marginTop: 6 }}>
                {chat.cwd ? <>{chat.cwd} • </> : null}
                session <code title={chat.id}>{shortId(chat.id)}</code>
              </div>
            </div>
            <span className="helm-status ok">
              <span className="dot" />
              last seen {formatRelative(chat.lastSeenAt)}
            </span>
          </div>

          {/* Phase 42: every bound role renders as a chip with inline ✕.
              "+ Add role" dropdown lists only roles NOT yet attached. */}
          <div style={{ marginTop: 12 }}>
            <div className="muted" style={{ marginBottom: 6 }}>Roles</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              {chat.roleIds.length === 0 && (
                <span className="muted" style={{ fontSize: 12 }}>(none — no auto-inject)</span>
              )}
              {chat.roleIds.map((rid) => {
                const role = roles.find((r) => r.id === rid);
                const display = role
                  ? `${role.name}${role.isBuiltin ? ' (built-in)' : ''}`
                  : `${rid} (unknown)`;
                return (
                  <span
                    key={rid}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      padding: '2px 8px', borderRadius: 12,
                      background: 'var(--surface-2, #eef)',
                      fontSize: 12, fontWeight: 500,
                    }}
                  >
                    {display}
                    <button
                      type="button"
                      aria-label={`Remove role ${role?.name ?? rid} from chat ${chat.id}`}
                      disabled={savingId === chat.id}
                      onClick={() => { void removeRole(chat.id, rid); }}
                      style={{
                        all: 'unset', cursor: 'pointer', fontSize: 14,
                        opacity: savingId === chat.id ? 0.4 : 0.7, lineHeight: 1,
                      }}
                    >
                      ✕
                    </button>
                  </span>
                );
              })}
              {(() => {
                const addable = roles.filter((r) => !chat.roleIds.includes(r.id));
                if (addable.length === 0) return null;
                return (
                  <select
                    aria-label={`Add role to chat ${chat.id}`}
                    value=""
                    disabled={savingId === chat.id}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v) void addRole(chat.id, v);
                    }}
                    style={{ fontSize: 12, padding: '2px 4px' }}
                  >
                    <option value="">+ Add role…</option>
                    {addable.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}{r.isBuiltin ? ' (built-in)' : ''}
                      </option>
                    ))}
                  </select>
                );
              })()}
              {savingId === chat.id && <span className="muted" style={{ fontSize: 11 }}>saving…</span>}
            </div>
          </div>
          {rowError && rowError.id === chat.id && (
            <p className="muted" style={{ color: 'var(--danger)', fontSize: 12, marginTop: 6 }}>
              {rowError.message}
            </p>
          )}

          {/* Phase 62: Lark binding status + initiate button. Bindings live in
              channel_bindings; we filter client-side rather than adding the
              join to /api/active-chats's response shape. */}
          <ChatLarkSection
            chat={chat}
            bindings={(bindingsData?.bindings ?? [])
              .filter((b) => b.hostSessionId === chat.id && b.channel === 'lark')}
            onMirror={() => setBindModalFor(chat.id)}
          />

          {/* Phase 36: chat lifecycle controls. Close is soft (history kept);
              Delete cascades to channel_bindings + queued messages. Both
              prompt for confirmation via window.confirm. */}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button
              type="button"
              disabled={savingId === chat.id}
              onClick={() => { void closeChat(chat.id, false); }}
              aria-label={`Close chat ${chat.id}`}
            >
              Close
            </button>
            <button
              type="button"
              className="danger-outline"
              disabled={savingId === chat.id}
              onClick={() => { void closeChat(chat.id, true); }}
              aria-label={`Delete chat ${chat.id} and all bindings`}
            >
              Delete
            </button>
          </div>
        </article>
      ))}

      {bindModalFor && (
        <MirrorToLarkModal
          hostSessionId={bindModalFor}
          chatLabel={(() => {
            const c = data?.chats.find((x) => x.id === bindModalFor);
            return c ? chatLabel(c) : bindModalFor;
          })()}
          onClose={() => setBindModalFor(null)}
          onBound={() => {
            setBindModalFor(null);
            reload();
            reloadBindings();
          }}
        />
      )}
    </>
  );
}

/**
 * Phase 55: editable chat title. Click-to-edit pencil icon when not editing;
 * Enter / blur saves; Escape cancels. The textbox seeds with the current
 * displayName (NOT the firstPrompt fallback) so the user is editing the
 * actual override, not retyping their prompt.
 */
function ChatTitle({
  chat,
  editing,
  saving,
  onStartEdit,
  onCancelEdit,
  onSave,
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

  // When the row enters edit mode, seed the draft with the current override
  // and select-all so the user can immediately type a replacement.
  useEffect(() => {
    if (editing) {
      setDraft(chat.displayName ?? '');
      // Defer focus to next frame so the input is in the DOM.
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
        style={{
          fontWeight: 600, fontSize: 14, padding: '2px 6px',
          border: '1px solid var(--border)', borderRadius: 4,
          width: 'min(440px, 100%)', fontFamily: 'inherit',
        }}
      />
    );
  }

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span
        style={{ fontWeight: 600, fontSize: 14, color: chat.displayName ? undefined : 'var(--text-secondary)' }}
        title={tooltip}
      >
        {label || '(awaiting first message)'}
      </span>
      <button
        type="button"
        onClick={onStartEdit}
        aria-label={`Rename chat ${chat.id}`}
        title="Rename"
        style={{
          all: 'unset', cursor: 'pointer', fontSize: 12,
          opacity: 0.5, padding: '0 4px',
        }}
      >
        ✎
      </button>
    </div>
  );
}

/**
 * Phase 62: per-chat Lark binding section. Three states:
 *   - bound:   show a chip "Lark · oc_...#om_... (label)" with an Unbind button
 *   - unbound: show "Lark: not bound" + a "Mirror to Lark" button
 *   - multiple: rare but possible — render each chip
 *
 * Hidden when no Lark bindings exist AND helm doesn't have Lark wired,
 * because there's nothing actionable. We detect that lazily — when the
 * Initiate endpoint 501s, the modal surfaces the friendly error.
 */
function ChatLarkSection({
  chat,
  bindings,
  onMirror,
}: {
  chat: ActiveChat;
  bindings: ChannelBinding[];
  onMirror: () => void;
}) {
  return (
    <div style={{ marginTop: 12 }}>
      <div className="muted" style={{ marginBottom: 6, fontSize: 12 }}>Lark</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {bindings.length === 0 && (
          <span className="muted" style={{ fontSize: 12 }}>not bound</span>
        )}
        {bindings.map((b) => {
          const labelChip = b.label ? `${b.label} · ` : '';
          const threadFrag = b.externalThread ? `…/${b.externalThread.slice(-6)}` : '';
          return (
            <span
              key={b.id}
              title={`bindingId: ${b.id}\nexternalChat: ${b.externalChat ?? '(none)'}\nexternalThread: ${b.externalThread ?? '(none)'}`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '2px 8px', borderRadius: 12,
                background: 'rgba(52,199,89,0.12)',
                color: 'var(--text)',
                fontSize: 12, fontWeight: 500,
              }}
            >
              ✓ {labelChip}{b.externalChat?.slice(0, 12) ?? ''}{threadFrag}
            </span>
          );
        })}
        <button
          type="button"
          onClick={onMirror}
          style={{ fontSize: 12 }}
          aria-label={`Mirror chat ${chat.id} to a Lark thread`}
        >
          + Mirror to Lark
        </button>
      </div>
    </div>
  );
}

/**
 * Phase 62: modal that mints a pending bind code + waits for Lark-side
 * consumption. Flow:
 *   1. open → call /api/bindings/initiate → display code + instruction
 *   2. user copies the line, pastes into a Lark thread
 *   3. lark-wiring listener consumes → emits binding.created
 *   4. SSE listener here matches by hostSessionId → calls onBound (modal closes)
 *
 * Implementation note: we DON'T close on every binding.created — only when
 * the new binding's hostSessionId matches ours. Otherwise opening this
 * modal during a sibling's bind would hide it prematurely.
 */
function MirrorToLarkModal({
  hostSessionId,
  chatLabel,
  onClose,
  onBound,
}: {
  hostSessionId: string;
  chatLabel: string;
  onClose: () => void;
  onBound: () => void;
}) {
  const [code, setCode] = useState<string | null>(null);
  const [instruction, setInstruction] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [labelDraft, setLabelDraft] = useState('');
  const [step, setStep] = useState<'compose' | 'waiting'>('compose');

  async function initiate(): Promise<void> {
    setErr(null);
    try {
      const r = await helmApi.initiateLarkBind(labelDraft.trim() || undefined);
      setCode(r.code);
      setInstruction(r.instruction);
      setExpiresAt(r.expiresAt);
      setStep('waiting');
    } catch (e) {
      const msg = e instanceof ApiError
        ? (e.status === 501
          ? 'Lark is not configured in this Helm. Open Settings → Lark to enable it.'
          : `${e.status}: ${e.message}`)
        : (e as Error).message;
      setErr(msg);
    }
  }

  // Listen for the consumed bind. The renderer's general SSE feed
  // already fires binding.created across the app; we filter here.
  useEventStream((e) => {
    if (e.type !== 'binding.created') return;
    if (e.binding.channel !== 'lark') return;
    if (e.binding.hostSessionId !== hostSessionId) return;
    onBound();
  }, { types: ['binding.created'] });

  // Cancel the unused code on dismiss so it doesn't sit until TTL.
  function cancel(): void {
    if (code) {
      void helmApi.cancelPendingBind(code).catch(() => {/* best-effort */});
    }
    onClose();
  }

  function copyToClipboard(value: string): void {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  const expiryHint = expiresAt
    ? `Expires ${new Date(expiresAt).toLocaleTimeString()}.`
    : '';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Mirror chat to Lark"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
      }}
      onClick={cancel}
    >
      <div
        className="helm-card"
        style={{ width: 'min(560px, 90vw)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row" style={{ marginBottom: 12 }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>Mirror to Lark</div>
            <div className="muted" style={{ fontSize: 12 }}>
              Pair Cursor chat <strong>{chatLabel}</strong> with a Lark thread
            </div>
          </div>
          <button onClick={cancel} aria-label="Close">✕</button>
        </div>

        {step === 'compose' && (
          <>
            <p className="muted" style={{ fontSize: 12 }}>
              Helm will mint a one-time code. Paste it into the Lark thread you want to
              mirror as <code>@bot bind &lt;code&gt;</code>. Once Lark side consumes it,
              the binding lands here automatically.
            </p>
            <label style={{ display: 'block', marginTop: 12 }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                Optional label (shows in Bindings + on the bind-ack message)
              </div>
              <input
                type="text"
                value={labelDraft}
                onChange={(e) => setLabelDraft(e.target.value.slice(0, 60))}
                placeholder="tce-deploy-thread"
                style={{
                  width: '100%', padding: '6px 10px', fontSize: 13,
                  border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                }}
              />
            </label>
            {err && (
              <p style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }}>{err}</p>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button className="primary" onClick={() => void initiate()}>
                Generate code
              </button>
              <button onClick={cancel}>Cancel</button>
            </div>
          </>
        )}

        {step === 'waiting' && code && instruction && (
          <>
            <p style={{ fontSize: 13, marginTop: 0 }}>
              Paste this in the target Lark thread:
            </p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'stretch', marginBottom: 8 }}>
              <code
                style={{
                  flex: 1, padding: '8px 12px',
                  background: 'var(--bg-pre)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 13, whiteSpace: 'pre',
                }}
              >
                @bot bind {code}
              </code>
              <button
                type="button"
                onClick={() => copyToClipboard(`@bot bind ${code}`)}
                style={{ minWidth: 80 }}
              >
                {copied ? '✓ Copied' : 'Copy'}
              </button>
            </div>
            <p className="muted" style={{ fontSize: 11, marginBottom: 8 }}>{instruction}</p>
            {expiryHint && (
              <p className="muted" style={{ fontSize: 11, marginBottom: 0 }}>{expiryHint}</p>
            )}

            <div
              style={{
                marginTop: 16, padding: 10,
                background: 'rgba(0,122,255,0.08)',
                borderRadius: 'var(--radius-sm)',
                fontSize: 12, lineHeight: 1.5,
              }}
            >
              ⏳ Waiting for Lark to consume the code… The modal will close
              automatically once the bind lands. You can leave this open.
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button onClick={cancel}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
