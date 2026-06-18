import { useRef, useState, type ReactElement } from 'react';
import Markdown from 'react-markdown';
import type { ChatMsg } from '../hooks/useAgentChat.js';

/**
 * Presentational chat surface: a scrolling message list + a textarea input.
 * No data fetching — the caller owns the conversation (messages/busy/error)
 * and the send handler. Reusable by the in-app assistant and (later) the
 * role-train modal.
 */
export function ChatPanel({
  messages, busy, error, onSend,
}: {
  messages: ChatMsg[];
  busy: boolean;
  error: string | null;
  onSend: (text: string) => void;
}): ReactElement {
  const [input, setInput] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  function submit(): void {
    const t = input.trim();
    if (!t || busy) return;
    onSend(t);
    setInput('');
    // Scroll to bottom after the message renders.
    requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    });
  }

  // The last assistant message is "thinking" only while busy AND still empty
  // (no tokens streamed yet).
  const last = messages[messages.length - 1];
  const showThinking = busy && last?.role === 'assistant' && last.content === '';

  return (
    <div className="helm-chat">
      <div className="helm-chat-messages" ref={listRef}>
        {messages.map((m, i) => (
          <div key={i} className={`helm-chat-msg helm-chat-msg-${m.role}`}>
            {/* Assistant replies are markdown (bold / code / lists) — render them.
                User turns stay literal so their text isn't reinterpreted. */}
            {m.role === 'assistant'
              ? (m.content
                ? <div className="helm-chat-md"><Markdown>{m.content}</Markdown></div>
                : (showThinking && i === messages.length - 1 ? '思考中…' : ''))
              : m.content}
          </div>
        ))}
        {error && <div className="helm-chat-error">⚠️ {error}</div>}
      </div>
      <div className="helm-chat-input">
        <textarea
          value={input}
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
          }}
          placeholder="问我用法，或让我整理知识…（⌘/Ctrl+Enter 发送）"
          rows={2}
        />
        <button type="button" onClick={submit} disabled={busy || !input.trim()}>
          {busy ? '…' : '发送'}
        </button>
      </div>
    </div>
  );
}
