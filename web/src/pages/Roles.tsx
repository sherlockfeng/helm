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
import type { KnowledgeChunkKind, RoleSummary } from '../api/types.js';

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
  // Phase 73: kind selector for the next train batch. Applies to ALL files
  // uploaded in one click (per-file kind would need more UI than this form
  // can carry — agents driving the MCP path can set per-doc kinds).
  const [trainKind, setTrainKind] = useState<KnowledgeChunkKind>('other');
  // Phase 73: in-flight drop on a knowledge source.
  const [droppingSourceId, setDroppingSourceId] = useState<string | null>(null);
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

  async function dropSource(sourceId: string, origin: string): Promise<void> {
    if (!window.confirm(
      `Drop knowledge source "${origin}"?\n\n`
      + 'This cascade-deletes every chunk derived from this source. '
      + 'Chunks from other sources are not affected.',
    )) return;
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
    }
  }

  if (detail.loading) return <p className="muted">Loading role…</p>;
  if (detail.error) return <p className="muted" style={{ color: 'var(--danger)' }}>{detail.error.message}</p>;
  if (!detail.data) return null;
  const { role, chunks, sources } = detail.data;

  return (
    <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
      <div className="label">System prompt</div>
      <pre style={{ marginBottom: 14 }}>{role.systemPrompt}</pre>

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
                  onClick={() => { void dropSource(s.id, s.origin); }}
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

      <div className="label">Knowledge chunks ({chunks.length})</div>
      {chunks.length === 0 ? (
        <p className="muted" style={{ marginTop: 4, marginBottom: 14 }}>
          No documents trained yet.
        </p>
      ) : (
        <ul style={{ margin: '6px 0 14px', paddingLeft: 0, listStyle: 'none' }}>
          {chunks.slice(0, 8).map((c) => (
            <li key={c.id} style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <KindBadge kind={c.kind} />
                <code style={{ color: 'var(--text-secondary)' }}>{c.sourceFile ?? '(no file)'}</code>
              </div>
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
        <div className="muted">Kind (applies to every doc in this batch)</div>
        <select
          value={trainKind}
          onChange={(e) => setTrainKind(e.target.value as KnowledgeChunkKind)}
          style={{ minWidth: 160 }}
        >
          {KIND_OPTIONS.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
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
  onUpdateViaChat,
  onTrained,
}: {
  role: RoleSummary;
  expanded: boolean;
  onToggle: () => void;
  /** Phase 65: open the train modal in update-mode for this role. */
  onUpdateViaChat: () => void;
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
          {/* Phase 65: per-role "Update via chat" — opens the train modal
              in update mode, telling the agent to call update_role (not
              train_role) so existing chunks survive. Hidden on built-ins
              because their prompts/chunks are seeded from src — overwriting
              would make them drift from code. */}
          {!role.isBuiltin && (
            <button
              onClick={onUpdateViaChat}
              title="Append knowledge or refine the system prompt — existing chunks stay."
            >
              Update via chat
            </button>
          )}
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

  return (
    <>
      <h2>Roles</h2>
      <p className="muted">
        Built-in agent personas (product / developer / qa) plus any roles you train
        with project-specific docs. <code>query_knowledge</code> and the
        sessionStart context provider read from the same chunks.
      </p>

      <div style={{ marginBottom: 16 }}>
        <button className="primary" onClick={() => setChatTarget({ mode: 'create' })}>
          + Train a new role via chat
        </button>
        <span className="muted" style={{ marginLeft: 12, fontSize: 12 }}>
          Coach an LLM through a conversation — it asks clarifying questions,
          then distills your answers into a role.
        </span>
      </div>

      <TrainViaCliPanel />


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
          onUpdateViaChat={() => setChatTarget({ mode: 'update', roleId: r.id, name: r.name })}
          onTrained={() => reload()}
        />
      ))}

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

const CREATE_GREETING = [
  '你好！我会帮你定义一个新的 helm role。',
  '',
  '我跑在你机器上的 Claude Code CLI 里 — 默认带文件读取、grep、shell、web fetch；helm 还接了 `train_role`、`read_lark_doc` 等 MCP 工具。',
  '',
  '先告诉我：你想训练什么样的专家？领域、关心的项目、想沉淀的文档/代码都可以一起说。当你确认方案后，直接说"保存这个为 XXX role"，我就调 `train_role` 存下来。',
].join('\n');

function updateGreeting(roleName: string, roleId: string): string {
  return [
    `好，给现有 role **${roleName}** (\`${roleId}\`) 增量补充知识。`,
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
    ? `Update role: ${target.name}`
    : 'Train a new role via chat';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
        // The page-content rule `.helm-main > * { max-width: ... }` was
        // clamping this fixed-positioned overlay to the body container
        // width because the modal renders inside the Roles fragment (which
        // is a direct child of .helm-main). Explicit override keeps the
        // overlay viewport-sized so the white card actually centers.
        maxWidth: 'none',
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
            <div style={{ fontWeight: 600, fontSize: 14 }}>{title}</div>
            <div className="muted" style={{ fontSize: 12 }}>
              Powered by your local <code>claude</code> CLI (Phase 60b). When you&apos;re ready, say
              {' '}<em>&quot;保存这个为 XXX role&quot;</em> — the agent calls helm&apos;s
              {' '}<code>train_role</code> MCP tool and the role appears in the list.
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
          <button className="primary" disabled={busy || !input.trim()} onClick={() => void send()}>
            Send
          </button>
        </div>
      </div>
    </div>
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
function TrainViaCliPanel() {
  const HELM_MCP_URL = 'http://127.0.0.1:17317/mcp/sse';
  const examplePrompt = '把刚才的对话沉淀成 helm 的 TCE 专家 role';
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
        <code>train_role</code> and the role appears below automatically.
      </p>

      <p className="muted" style={{ marginTop: 12, marginBottom: 4, fontWeight: 500 }}>
        One-time setup (click the target you use):
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="primary"
          disabled={busy !== null}
          aria-busy={busy === 'claude'}
          onClick={() => { void setup('claude'); }}
        >
          {busy === 'claude' ? 'Setting up…' : 'Set up Claude Code'}
        </button>
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
