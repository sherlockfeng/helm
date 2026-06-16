import { useState, type ReactElement } from 'react';
import { useAgentChat } from '../hooks/useAgentChat.js';
import { ChatPanel } from './ChatPanel.js';

/**
 * Global in-app assistant: a floating circular button pinned bottom-right on
 * every page that opens a chat panel. The agent answers usage questions and
 * (via helm's MCP tools, with propose-then-confirm) helps organize knowledge.
 * Mounted once at the App root, sibling to the Toaster.
 */
export function AssistantWidget(): ReactElement {
  const [open, setOpen] = useState(false);
  const { messages, busy, error, send, reset } = useAgentChat();

  return (
    <>
      {open && (
        <div className="helm-assistant-panel" role="dialog" aria-label="helm 助手">
          <div className="helm-assistant-head">
            <span className="helm-assistant-title">helm 助手</span>
            <div className="helm-assistant-head-actions">
              <button type="button" onClick={reset} title="清空对话">清空</button>
              <button type="button" onClick={() => setOpen(false)} aria-label="关闭" title="关闭">✕</button>
            </div>
          </div>
          <ChatPanel messages={messages} busy={busy} error={error} onSend={send} />
        </div>
      )}
      <button
        type="button"
        className="helm-assistant-fab"
        aria-label={open ? '关闭 helm 助手' : '打开 helm 助手'}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? '✕' : '💬'}
      </button>
    </>
  );
}
