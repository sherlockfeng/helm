/**
 * Lark event listener — owns the long-running `lark-cli event +subscribe`
 * subprocess, parses each NDJSON line into a typed event, and re-spawns
 * with exponential backoff (capped 30s) when the process dies.
 *
 * Per PROJECT_BLUEPRINT.md §11.2:
 *   start():  spawn `lark-cli event +subscribe --event-types
 *             im.message.receive_v1,card.action.trigger --compact --quiet --as bot`
 *   stop():   kill the subprocess, drop reconnection
 *
 * Listener errors are isolated per-handler so a buggy subscriber can't take
 * the rest down. The listener itself never throws — surface errors via
 * onError handlers.
 */

import type { LarkCliRunner, LarkCliSpawnHandle } from './cli-runner.js';

/** Raw shape of `im.message.receive_v1` after the lark-cli `--compact` projection. */
export interface LarkInboundMessage {
  kind: 'message';
  /** Lark message id (om_*). */
  messageId: string;
  /** Chat id (oc_* / on_*). */
  chatId: string;
  /** Optional Lark thread / root message id (om_* of the parent). */
  threadId?: string;
  /** Plain text content (lark-cli flattens the v1 json content payload to text). */
  text: string;
  /** Whether the message @mentioned the bot. */
  mentioned: boolean;
  senderId?: string;
  receivedAt: string;
  /** Original JSON line for debugging / unhandled fields. */
  raw: unknown;
}

/** Raw shape of `card.action.trigger` events (interactive card buttons). */
export interface LarkCardAction {
  kind: 'card_action';
  /** Card token / interaction value. */
  token: string;
  chatId?: string;
  messageId?: string;
  /** action.value after JSON parse. */
  value?: Record<string, unknown>;
  raw: unknown;
}

export type LarkListenerEvent = LarkInboundMessage | LarkCardAction;

export interface LarkListenerOptions {
  cli: LarkCliRunner;
  /** Override the args passed to `lark-cli`. Defaults to the §11.2 set. */
  args?: readonly string[];
  /** Initial backoff before first reconnect attempt. Default 250ms. */
  initialBackoffMs?: number;
  /** Cap on backoff. Default 30s. */
  maxBackoffMs?: number;
  /** Surface errors / lifecycle to the caller (logger glue). */
  onError?: (err: Error, where: 'spawn' | 'parse' | 'process_exit' | 'stderr') => void;
  /** Notify on successful (re)connect — useful for status indicators. */
  onConnected?: () => void;
}

const DEFAULT_ARGS: readonly string[] = [
  'event', '+subscribe',
  '--event-types', 'im.message.receive_v1,card.action.trigger',
  '--compact', '--quiet', '--as', 'bot',
];

export interface LarkListener {
  start(): void;
  stop(): Promise<void>;
  onEvent(handler: (event: LarkListenerEvent) => void): () => void;
  isRunning(): boolean;
  /** Test hook: number of subprocess respawn attempts seen. */
  spawnCount(): number;
}

/**
 * Coerce arbitrary parsed JSON into a typed event. Returns null when the
 * line is something other than the two known event types — defensive
 * because lark-cli adds new event_types over time and we'd rather skip
 * silently than crash the listener.
 */
function classifyEvent(parsed: unknown): LarkListenerEvent | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  // Phase 41a: Lark schema-2.0 puts event_type under `header.event_type`,
  // not at the top level. Old (test-shape) events keep it flat. Try both.
  const header = (obj['header'] && typeof obj['header'] === 'object'
    ? obj['header'] as Record<string, unknown>
    : undefined);
  const eventType = String(
    obj['event_type']
    ?? obj['type']
    ?? header?.['event_type']
    ?? '',
  );
  if (eventType === 'im.message.receive_v1' || eventType === 'message') {
    return parseInboundMessage(obj);
  }
  if (eventType === 'card.action.trigger' || eventType === 'card_action') {
    return parseCardAction(obj);
  }
  return null;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function parseInboundMessage(obj: Record<string, unknown>): LarkInboundMessage | null {
  // Phase 41a: Lark schema-2.0 wraps the message under `obj.event.message`,
  // not `obj.message`. The previous parser missed this layer entirely, so
  // Phase 38's stripMentions never received the mentions array — and the
  // queued/injected text retained the `@_user_1 ...` prefix. We unwrap
  // defensively: try `obj.event` then fall back to `obj` so older /
  // hand-shaped events (used by tests) still parse.
  const eventBody = (obj['event'] && typeof obj['event'] === 'object' && !Array.isArray(obj['event']))
    ? obj['event'] as Record<string, unknown>
    : obj;
  const message = (eventBody['message'] && typeof eventBody['message'] === 'object' && !Array.isArray(eventBody['message']))
    ? eventBody['message'] as Record<string, unknown>
    : eventBody;
  const messageId = asString(message['message_id'] ?? message['messageId']);
  const chatId = asString(message['chat_id'] ?? message['chatId']);

  // Phase 41a: Lark stores the visible text inside `content` as a JSON
  // string, e.g. `"content":"{\"text\":\"@_user_1  hi\"}"`. The old parser
  // passed the raw blob through unparsed, leaving JSON quoting in queue
  // entries. Try structured paths first; only fall back to the raw
  // `content` blob when neither `text` nor `content.text` resolves.
  let rawText = asString(message['text']);
  if (!rawText && typeof message['content'] === 'string') {
    const contentStr = message['content'] as string;
    try {
      const parsed = JSON.parse(contentStr) as { text?: unknown };
      if (parsed && typeof parsed.text === 'string') rawText = parsed.text;
    } catch { /* not JSON */ }
    if (!rawText) rawText = contentStr;
  }

  if (!messageId || !chatId) return null;
  const threadId = asString(message['thread_id'] ?? message['threadId']) || undefined;
  // Phase 41a: schema-2.0 sender path is `event.sender.sender_id.open_id`.
  // Older shapes flatten — try both.
  const senderObj = (eventBody['sender'] && typeof eventBody['sender'] === 'object')
    ? eventBody['sender'] as Record<string, unknown>
    : undefined;
  const senderIdObj = senderObj && typeof senderObj['sender_id'] === 'object'
    ? senderObj['sender_id'] as Record<string, unknown>
    : undefined;
  const senderId = asString(message['sender_id'] ?? message['senderId'])
    || asString(senderIdObj?.['open_id'] ?? senderIdObj?.['openId'])
    || undefined;
  const mentions = (message['mentions'] && Array.isArray(message['mentions']))
    ? (message['mentions'] as unknown[])
    : [];
  const mentioned = mentions.length > 0 || /@/.test(rawText);

  // Phase 38: strip mention spans from the visible text. Lark renders
  // multi-word display names like "chat with cursor" as a single mention
  // bubble, but the text payload contains "@chat with cursor" as plain
  // characters — so a naive "@\S+" strip leaves "with cursor" behind, which
  // contaminates the bind label and any text we might inject back into Cursor.
  // We strip in priority order:
  //   1. Each mention.name from the `mentions` array (most reliable)
  //   2. Each mention.key (placeholder form like @_user_1)
  //   3. Generic `@\S+` as last resort
  const text = stripMentions(rawText, mentions);

  return {
    kind: 'message',
    messageId,
    chatId,
    threadId,
    text,
    mentioned,
    senderId,
    receivedAt: new Date().toISOString(),
    raw: obj,
  };
}

function stripMentions(text: string, mentions: readonly unknown[]): string {
  let out = text;
  for (const m of mentions) {
    if (!m || typeof m !== 'object') continue;
    const mention = m as Record<string, unknown>;
    const name = asString(mention['name']);
    const key = asString(mention['key']);
    if (name) {
      // Match `@<name>` with optional surrounding whitespace; case-insensitive
      // so "@Chat" / "@chat" / "@CHAT" all collapse.
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(`@${escaped}\\b`, 'gi'), '');
    }
    if (key) {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(escaped, 'g'), '');
    }
  }
  // Collapse the whitespace left behind by removing the mention spans.
  return out.replace(/\s{2,}/g, ' ').trim();
}

function parseCardAction(obj: Record<string, unknown>): LarkCardAction | null {
  const action = (obj['action'] && typeof obj['action'] === 'object'
    ? obj['action'] as Record<string, unknown>
    : obj);
  const token = asString(action['token'] ?? obj['token']);
  if (!token) return null;
  const chatId = asString(action['chat_id'] ?? obj['chat_id']) || undefined;
  const messageId = asString(action['message_id'] ?? obj['message_id']) || undefined;
  const valueField = action['value'];
  let value: Record<string, unknown> | undefined;
  if (valueField && typeof valueField === 'object' && !Array.isArray(valueField)) {
    value = valueField as Record<string, unknown>;
  } else if (typeof valueField === 'string' && valueField.trim()) {
    try {
      const parsed = JSON.parse(valueField);
      if (parsed && typeof parsed === 'object') value = parsed as Record<string, unknown>;
    } catch { /* leave value undefined */ }
  }
  return { kind: 'card_action', token, chatId, messageId, value, raw: obj };
}

export function createLarkListener(options: LarkListenerOptions): LarkListener {
  const cli = options.cli;
  const args = options.args ?? DEFAULT_ARGS;
  const initialBackoff = options.initialBackoffMs ?? 250;
  const maxBackoff = options.maxBackoffMs ?? 30_000;
  const onError = options.onError ?? (() => {});
  const onConnected = options.onConnected ?? (() => {});

  const handlers = new Set<(event: LarkListenerEvent) => void>();
  let started = false;
  let stopped = false;
  let current: LarkCliSpawnHandle | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let backoff = initialBackoff;
  let spawns = 0;

  const fanOut = (event: LarkListenerEvent): void => {
    for (const h of [...handlers]) {
      try { h(event); } catch { /* per-handler isolation */ }
    }
  };

  const onLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); }
    catch (err) {
      onError(err as Error, 'parse');
      return;
    }
    const event = classifyEvent(parsed);
    if (event) fanOut(event);
  };

  const scheduleReconnect = (): void => {
    if (stopped) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => spawnOnce(), backoff);
    reconnectTimer.unref?.();
    backoff = Math.min(backoff * 2, maxBackoff);
  };

  const spawnOnce = (): void => {
    if (stopped) return;
    spawns += 1;
    const handle = cli.spawn(args);
    current = handle;
    onConnected();
    backoff = initialBackoff;

    handle.onStdoutLine(onLine);
    handle.onStderrLine((line) => {
      // Phase 37: lark-cli writes diagnostics to stderr (proxy warnings,
      // version notices, etc.). Previously labelled `process_exit` which made
      // it look like the subprocess died — wrong category, very noisy.
      // Now reported under its own `stderr` channel so the orchestrator can
      // route at the right level (warn for actual problems, debug for the
      // proxy/version chatter).
      if (line.trim()) onError(new Error(line), 'stderr');
    });
    handle.onError((err) => onError(err, 'spawn'));

    void handle.exited.then((res) => {
      current = undefined;
      if (stopped) return;
      onError(new Error(`lark-cli exited (code=${res.exitCode ?? 'null'} signal=${res.signal ?? 'null'})`), 'process_exit');
      scheduleReconnect();
    });
  };

  return {
    start(): void {
      if (started) return;
      started = true;
      stopped = false;
      spawnOnce();
    },
    async stop(): Promise<void> {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      if (current) {
        const handle = current;
        current = undefined;
        handle.kill('SIGTERM');
        // Best-effort wait for clean exit, but don't hang forever.
        await Promise.race([
          handle.exited,
          new Promise((r) => setTimeout(r, 1_000).unref()),
        ]);
      }
      handlers.clear();
      started = false;
    },
    onEvent(handler): () => void {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    isRunning(): boolean { return started && !stopped; },
    spawnCount(): number { return spawns; },
  };
}
