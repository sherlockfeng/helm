import { useState, type ReactElement } from 'react';
import { ApiError, helmApi } from '../api/client.js';
import { Button } from './Button.js';

/**
 * One-time MCP setup so the user can train helm topics from their OWN CLI /
 * IDE chat (Claude Code, Cursor): registers helm's `train_role` MCP tool with
 * the chosen agent. Lives in Settings (moved off the Topics page — it's MCP
 * registration, not a chat; topic-creation-via-chat now lives in the global
 * assistant).
 */
export function TrainViaCliPanel(): ReactElement {
  const HELM_MCP_URL = 'http://127.0.0.1:17317/mcp/sse';
  const examplePrompt = '把刚才的对话沉淀成 helm 的 TCE 专家 topic';
  const [busy, setBusy] = useState<'claude' | 'cursor' | null>(null);
  const [results, setResults] = useState<Partial<Record<'claude' | 'cursor', {
    ok: boolean; message: string;
  }>>>({});

  async function setup(target: 'claude' | 'cursor'): Promise<void> {
    setBusy(target);
    try {
      const r = await helmApi.setupMcp(target);
      setResults((prev) => ({ ...prev, [target]: { ok: true, message: r.message } }));
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
        从你自己的 CLI / IDE 聊天里训练 topic（Claude Code、Cursor）
      </summary>
      <p className="muted" style={{ marginTop: 10 }}>
        Helm exposes a <code>train_role</code> tool over MCP at{' '}
        <code>{HELM_MCP_URL}</code>. After registering helm with your CLI, end
        any conversation by saying e.g.{' '}
        <em>&quot;{examplePrompt}&quot;</em> — the agent calls{' '}
        <code>train_role</code> and the topic appears in Knowledge › Topics.
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
