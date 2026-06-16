/**
 * Streaming chat hook for the in-app assistant.
 *
 * Talks to `POST /api/agent-chat`, which streams the assistant's reply back as
 * `text/plain` (the CLI bridge forwards `claude` token deltas). We read the
 * response body incrementally and grow the last assistant message so the UI
 * renders token-by-token, like ChatGPT / Claude Code.
 *
 * Deliberately dependency-free (no Vercel AI SDK): the backend contract is a
 * plain text stream + `{messages:[{role,content}]}` body, so a small reader
 * loop is all that's needed — and it sidesteps ai@6's React-19 peer pinning.
 * If we later want the SDK, the endpoint contract is unchanged.
 */
import { useCallback, useRef, useState } from 'react';
import { apiUrl } from '../api/base-url.js';

export interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

const GREETING: ChatMsg = {
  role: 'assistant',
  content:
    '我是 helm 助手。可以问我这个 app 怎么用，或让我帮你整理知识 —— 比如「doc-lsp-expert 里有哪些重叠的知识点」「把这条 chat 的知识沉淀到某个 topic」。涉及修改会先跟你确认再动手。',
};

export interface UseAgentChat {
  messages: ChatMsg[];
  busy: boolean;
  error: string | null;
  send: (text: string) => Promise<void>;
  reset: () => void;
}

export function useAgentChat(): UseAgentChat {
  const [messages, setMessages] = useState<ChatMsg[]>([GREETING]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guard against overlapping sends.
  const inFlight = useRef(false);

  const send = useCallback(async (text: string): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed || inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setBusy(true);

    const userMsg: ChatMsg = { role: 'user', content: trimmed };
    // History sent to the backend = everything so far + this user turn. The
    // empty assistant placeholder we add for streaming is NOT sent (it would
    // fail the non-empty-content validation).
    const history = [...messages, userMsg];
    setMessages((prev) => [...prev, userMsg, { role: 'assistant', content: '' }]);

    try {
      const res = await fetch(apiUrl('/api/agent-chat'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: history.map((m) => ({ role: m.role, content: m.content })) }),
      });
      if (!res.ok || !res.body) {
        const raw = await res.text();
        let msg = raw;
        try { msg = (JSON.parse(raw) as { message?: string }).message ?? raw; } catch { /* not JSON */ }
        throw new Error(msg || `请求失败 (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = { role: 'assistant', content: acc };
          return next;
        });
      }
      // Flush any trailing bytes.
      acc += decoder.decode();
      if (acc) {
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = { role: 'assistant', content: acc };
          return next;
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Drop the empty assistant placeholder (keep the user's message).
      setMessages((prev) =>
        prev.length > 0 && prev[prev.length - 1]!.role === 'assistant' && prev[prev.length - 1]!.content === ''
          ? prev.slice(0, -1)
          : prev,
      );
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }, [messages]);

  const reset = useCallback((): void => {
    setMessages([GREETING]);
    setError(null);
  }, []);

  return { messages, busy, error, send, reset };
}
