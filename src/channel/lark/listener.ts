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
  onError?: (err: Error, where: 'spawn' | 'parse' | 'process_exit') => void;
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

  const eventType = String(obj['event_type'] ?? obj['type'] ?? '');
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
  const message = (obj['message'] && typeof obj['message'] === 'object'
    ? obj['message'] as Record<string, unknown>
    : obj);
  const messageId = asString(message['message_id'] ?? message['messageId']);
  const chatId = asString(message['chat_id'] ?? message['chatId']);
  const text = asString(
    message['text']
    ?? (typeof message['content'] === 'string' ? message['content'] : ''),
  );
  if (!messageId || !chatId) return null;
  const threadId = asString(message['thread_id'] ?? message['threadId']) || undefined;
  const senderId = asString(message['sender_id'] ?? message['senderId']) || undefined;
  const mentions = (message['mentions'] && Array.isArray(message['mentions']))
    ? (message['mentions'] as unknown[])
    : [];
  const mentioned = mentions.length > 0 || /@/.test(text);

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
      // lark-cli writes diagnostics to stderr — log a warning but don't tear
      // down the listener. Empty stderr is normal.
      if (line.trim()) onError(new Error(`stderr: ${line}`), 'process_exit');
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
