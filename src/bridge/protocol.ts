/**
 * Bridge wire protocol.
 *
 * Wire format: line-delimited JSON over Unix domain socket. Each connection is
 * one request → one response → close. Detailed table in PROJECT_BLUEPRINT.md §8.1.
 *
 * Naming: messages use `host_*` (from the host adapter, e.g. Cursor hooks) and
 * `channel_*` (from a remote channel adapter, e.g. Lark). No backward-compat with
 * agent2lark-cursor's `cursor_*` / `lark_*` types.
 */

export const BRIDGE_MESSAGE_TYPES = [
  'host_session_start',
  'host_prompt_submit',
  'host_agent_response',
  'host_progress',
  'host_stop',
  'host_approval_request',
  'host_chat_rename',
  'channel_inbound_message',
  'channel_approval_decision',
  'channel_create_binding',
  'channel_unbind',
  'channel_disable_wait',
] as const;

export type BridgeMessageType = (typeof BRIDGE_MESSAGE_TYPES)[number];

const MESSAGE_TYPE_SET: ReadonlySet<string> = new Set(BRIDGE_MESSAGE_TYPES);

export function isBridgeMessageType(t: unknown): t is BridgeMessageType {
  return typeof t === 'string' && MESSAGE_TYPE_SET.has(t);
}

// ── Generic envelope ───────────────────────────────────────────────────────

export interface BridgeRequest {
  type: BridgeMessageType;
  [key: string]: unknown;
}

export type BridgeResponse = Record<string, unknown>;

export interface BridgeErrorResponse {
  error: 'unknown_type' | 'parse_error' | 'no_handler' | 'handler_error';
  message?: string;
}

// ── Concrete request / response shapes (host_*) ────────────────────────────

export interface HostSessionStartRequest extends BridgeRequest {
  type: 'host_session_start';
  host_session_id: string;
  /** Agent identity — 'cursor' | 'claude-code' | 'codex'. Older Cursor
   *  hooks omit this; the server defaults to 'cursor' for back-compat. */
  host?: string;
  cwd?: string;
  composer_mode?: string;
}
export interface HostSessionStartResponse extends BridgeResponse {
  additional_context?: string;
}

export interface HostPromptSubmitRequest extends BridgeRequest {
  type: 'host_prompt_submit';
  host_session_id: string;
  /** Agent identity — see HostSessionStartRequest.host for the contract. */
  host?: string;
  prompt: string;
  cwd?: string;
}
export interface HostPromptSubmitResponse extends BridgeResponse {
  continue: boolean;
  user_message?: string;
}

export interface HostAgentResponseRequest extends BridgeRequest {
  type: 'host_agent_response';
  host_session_id: string;
  response_text: string;
}
export interface HostAgentResponseResponse extends BridgeResponse {
  ok: boolean;
  suppressed?: boolean;
}

export interface HostProgressRequest extends BridgeRequest {
  type: 'host_progress';
  host_session_id: string;
  tool: string;
  detail?: string;
}
export interface HostProgressResponse extends BridgeResponse {
  ok: boolean;
  sent?: boolean;
}

export interface HostStopRequest extends BridgeRequest {
  type: 'host_stop';
  host_session_id: string;
}
export interface HostStopResponse extends BridgeResponse {
  followup_message?: string;
}

export interface HostApprovalRequestRequest extends BridgeRequest {
  type: 'host_approval_request';
  host_session_id: string;
  tool: string;
  command?: string;
  payload?: Record<string, unknown>;
}
export interface HostApprovalRequestResponse extends BridgeResponse {
  decision: 'allow' | 'deny' | 'ask';
  reason?: string;
}

// ── Concrete request / response shapes (channel_*) ─────────────────────────

export interface ChannelInboundMessageRequest extends BridgeRequest {
  type: 'channel_inbound_message';
  channel: string;
  external_chat: string;
  external_thread: string;
  external_id?: string;
  text: string;
}
export interface ChannelInboundMessageResponse extends BridgeResponse {
  ok: boolean;
  routed?: boolean;
}

export interface ChannelApprovalDecisionRequest extends BridgeRequest {
  type: 'channel_approval_decision';
  channel: string;
  approval_id: string;
  decision: 'allow' | 'deny';
  reason?: string;
}
export interface ChannelApprovalDecisionResponse extends BridgeResponse {
  ok: boolean;
}

export interface ChannelCreateBindingRequest extends BridgeRequest {
  type: 'channel_create_binding';
  channel: string;
  external_chat?: string;
  external_thread?: string;
  external_root?: string;
}
export interface ChannelCreateBindingResponse extends BridgeResponse {
  ok: boolean;
  code: string;
}

export interface ChannelUnbindRequest extends BridgeRequest {
  type: 'channel_unbind';
  channel: string;
  binding_id?: string;
  external_chat?: string;
  external_thread?: string;
}
export interface ChannelUnbindResponse extends BridgeResponse {
  ok: boolean;
  removed: number;
}

export interface ChannelDisableWaitRequest extends BridgeRequest {
  type: 'channel_disable_wait';
  channel: string;
  binding_id: string;
}
export interface ChannelDisableWaitResponse extends BridgeResponse {
  ok: boolean;
}

/**
 * Push a host-side chat label change into helm. Currently emitted by the
 * Claude Code hook entry when the transcript's `customTitle` shifts (claude
 * auto-summarises a name, or the user renames via the TUI). Server writes
 * the value to `host_sessions.display_name`. Empty / unchanged values are
 * no-ops on the server side.
 */
export interface HostChatRenameRequest extends BridgeRequest {
  type: 'host_chat_rename';
  host_session_id: string;
  title: string;
}
export interface HostChatRenameResponse extends BridgeResponse {
  ok: boolean;
}

// ── Discriminated unions ───────────────────────────────────────────────────

export type AnyBridgeRequest =
  | HostSessionStartRequest
  | HostPromptSubmitRequest
  | HostAgentResponseRequest
  | HostProgressRequest
  | HostStopRequest
  | HostApprovalRequestRequest
  | HostChatRenameRequest
  | ChannelInboundMessageRequest
  | ChannelApprovalDecisionRequest
  | ChannelCreateBindingRequest
  | ChannelUnbindRequest
  | ChannelDisableWaitRequest;

export type RequestForType<T extends BridgeMessageType> = Extract<AnyBridgeRequest, { type: T }>;

export interface ResponseTypeMap {
  host_session_start: HostSessionStartResponse;
  host_prompt_submit: HostPromptSubmitResponse;
  host_agent_response: HostAgentResponseResponse;
  host_progress: HostProgressResponse;
  host_stop: HostStopResponse;
  host_approval_request: HostApprovalRequestResponse;
  host_chat_rename: HostChatRenameResponse;
  channel_inbound_message: ChannelInboundMessageResponse;
  channel_approval_decision: ChannelApprovalDecisionResponse;
  channel_create_binding: ChannelCreateBindingResponse;
  channel_unbind: ChannelUnbindResponse;
  channel_disable_wait: ChannelDisableWaitResponse;
}

export type ResponseForType<T extends BridgeMessageType> = ResponseTypeMap[T];

// ── Wire encode / decode ───────────────────────────────────────────────────

export function encodeMessage(msg: BridgeRequest | BridgeResponse | BridgeErrorResponse): string {
  return JSON.stringify(msg) + '\n';
}

export interface DecodedMessage {
  ok: boolean;
  message?: BridgeRequest;
  error?: BridgeErrorResponse;
}

export function decodeRequest(line: string): DecodedMessage {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: { error: 'parse_error', message: 'empty line' } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return { ok: false, error: { error: 'parse_error', message: (err as Error).message } };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: { error: 'parse_error', message: 'message must be a JSON object' } };
  }
  const obj = parsed as Record<string, unknown>;
  if (!isBridgeMessageType(obj['type'])) {
    return {
      ok: false,
      error: { error: 'unknown_type', message: `type=${String(obj['type'])} is not a known bridge message` },
    };
  }
  return { ok: true, message: obj as BridgeRequest };
}
