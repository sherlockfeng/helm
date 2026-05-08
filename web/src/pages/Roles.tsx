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

import { useRef, useState } from 'react';
import { ApiError, helmApi } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';
import { EmptyState } from '../components/EmptyState.js';
import type { RoleSummary } from '../api/types.js';

function shortId(id: string, len = 12): string {
  return id.length > len ? `${id.slice(0, len)}…` : id;
}

function summarizePrompt(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…';
}

function RoleDetail({ roleId, onTrained }: { roleId: string; onTrained: () => void }) {
  const detail = useApi(() => helmApi.role(roleId), [roleId]);
  const [training, setTraining] = useState(false);
  const [trainError, setTrainError] = useState<string | null>(null);
  const [trainOk, setTrainOk] = useState(false);
  const [name, setName] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
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
      const documents = await Promise.all(Array.from(files).map(readFile));
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

  if (detail.loading) return <p className="muted">Loading role…</p>;
  if (detail.error) return <p className="muted" style={{ color: 'var(--danger)' }}>{detail.error.message}</p>;
  if (!detail.data) return null;
  const { role, chunks } = detail.data;

  return (
    <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
      <div className="label">System prompt</div>
      <pre style={{ marginBottom: 14 }}>{role.systemPrompt}</pre>

      <div className="label">Knowledge chunks ({chunks.length})</div>
      {chunks.length === 0 ? (
        <p className="muted" style={{ marginTop: 4, marginBottom: 14 }}>
          No documents trained yet.
        </p>
      ) : (
        <ul style={{ margin: '6px 0 14px', paddingLeft: 0, listStyle: 'none' }}>
          {chunks.slice(0, 8).map((c) => (
            <li key={c.id} style={{ marginBottom: 8 }}>
              <code style={{ color: 'var(--text-secondary)' }}>{c.sourceFile ?? '(no file)'}</code>
              <div className="muted" style={{ marginTop: 2, fontSize: 12 }}>
                {summarizePrompt(c.chunkText, 200)}
              </div>
            </li>
          ))}
          {chunks.length > 8 && (
            <li className="muted" style={{ fontSize: 12 }}>
              … {chunks.length - 8} more chunk{chunks.length - 8 === 1 ? '' : 's'}.
            </li>
          )}
        </ul>
      )}

      <div className="label">Train / re-train</div>
      <p className="muted" style={{ fontSize: 11, margin: '4px 0 8px' }}>
        Re-training replaces the existing chunks for this role. Built-in roles
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
          Role trained. New chunks visible above.
        </p>
      )}

      <div style={{ marginTop: 12 }}>
        <button
          className="primary"
          disabled={training}
          aria-busy={training}
          onClick={() => { void train(); }}
        >
          {training ? 'Training…' : 'Train'}
        </button>
      </div>
    </div>
  );
}

function RoleCard({
  role,
  expanded,
  onToggle,
  onTrained,
}: {
  role: RoleSummary;
  expanded: boolean;
  onToggle: () => void;
  onTrained: () => void;
}) {
  return (
    <article className="helm-card">
      <div className="row">
        <div style={{ flex: 1 }}>
          <div className="label">
            {role.isBuiltin ? 'built-in' : 'custom'} · <code title={role.id}>{shortId(role.id)}</code>
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
          <button onClick={onToggle}>{expanded ? 'Hide' : 'Show'}</button>
        </div>
      </div>
      {expanded && <RoleDetail roleId={role.id} onTrained={onTrained} />}
    </article>
  );
}

export function RolesPage() {
  const { data, loading, error, reload } = useApi(() => helmApi.roles());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);

  return (
    <>
      <h2>Roles</h2>
      <p className="muted">
        Built-in agent personas (product / developer / qa) plus any roles you train
        with project-specific docs. <code>query_knowledge</code> and the
        sessionStart context provider read from the same chunks.
      </p>

      <div style={{ marginBottom: 16 }}>
        <button className="primary" onClick={() => setChatOpen(true)}>
          + Train a new role via chat
        </button>
        <span className="muted" style={{ marginLeft: 12, fontSize: 12 }}>
          Coach an LLM through a conversation — it asks clarifying questions,
          then distills your answers into a role.
        </span>
      </div>

      {loading && <p className="muted">Loading…</p>}
      {error && <p className="muted" style={{ color: 'var(--danger)' }}>{error.message}</p>}

      {data && data.roles.length === 0 && (
        <EmptyState
          title="No roles yet."
          hint={<>Built-in roles seed automatically — if you see this, the database may not be initialized.</>}
        />
      )}

      {data && data.roles.map((r) => (
        <RoleCard
          key={r.id}
          role={r}
          expanded={expanded === r.id}
          onToggle={() => setExpanded(expanded === r.id ? null : r.id)}
          onTrained={() => reload()}
        />
      ))}

      {chatOpen && (
        <RoleTrainChatModal
          onClose={() => setChatOpen(false)}
          onSaved={() => { setChatOpen(false); reload(); }}
        />
      )}
    </>
  );
}

// ── Phase 57: conversational role trainer ─────────────────────────────────

const SEED_GREETING = '你好！我会帮你定义一个新的 helm role。先告诉我：你想要训练什么样的专家？比如领域、用途、关心的代码库或业务场景都可以。';

function RoleTrainChatModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([
    { role: 'assistant', content: SEED_GREETING },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [committed, setCommitted] = useState(false);

  async function send(): Promise<void> {
    const text = input.trim();
    if (!text || busy) return;
    const next = [...messages, { role: 'user' as const, content: text }];
    setMessages(next);
    setInput('');
    setBusy(true);
    setErr(null);
    try {
      const r = await helmApi.roleTrainChat(next);
      setMessages([...next, r.message]);
      setProvider(`${r.provider} · ${r.model}`);
    } catch (e) {
      const msg = e instanceof ApiError ? `${e.status}: ${e.message}` : (e as Error).message;
      setErr(msg);
      // Roll back the optimistic user message so the user can retry from the input.
      setMessages(messages);
      setInput(text);
    } finally {
      setBusy(false);
    }
  }

  async function commit(): Promise<void> {
    if (busy || messages.length < 3) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await helmApi.roleTrainChatCommit(messages);
      setCommitted(true);
      setMessages([...messages, {
        role: 'assistant',
        content: `✓ Saved as **${r.spec.name}**. You can close this dialog now — the role will appear in the list.`,
      }]);
      // Briefly delay so the success message is readable, then close.
      setTimeout(() => onSaved(), 1500);
    } catch (e) {
      const msg = e instanceof ApiError ? `${e.status}: ${e.message}` : (e as Error).message;
      setErr(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Train a new role via chat"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        className="helm-card"
        style={{ width: 'min(720px, 90vw)', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row" style={{ marginBottom: 12 }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>Train a new role via chat</div>
            <div className="muted" style={{ fontSize: 12 }}>
              {provider ? `Using ${provider}` : 'Configure anthropic.apiKey or sign into Cursor in Settings.'}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close">✕</button>
        </div>

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
              maxWidth: '80%',
              padding: '8px 12px',
              borderRadius: 8,
              background: m.role === 'user' ? 'var(--accent-soft, #e6f0ff)' : 'var(--bg-pre)',
              fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap',
            }}>
              {m.content}
            </div>
          ))}
          {busy && <div className="muted" style={{ fontSize: 12 }}>thinking…</div>}
        </div>

        {err && (
          <p className="muted" style={{ color: 'var(--danger)', marginTop: 8 }}>{err}</p>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <textarea
            aria-label="Your message"
            value={input}
            disabled={busy || committed}
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <button className="primary" disabled={busy || committed || !input.trim()} onClick={() => void send()}>
              Send
            </button>
            <button
              className="primary"
              disabled={busy || committed || messages.length < 3}
              onClick={() => void commit()}
              title="Distill the conversation into a role and save"
            >
              Save role
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
