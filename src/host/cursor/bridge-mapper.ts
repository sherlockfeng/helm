/**
 * Maps between HostEvent (host-agnostic) and BridgeRequest/BridgeResponse
 * (wire format). Kept separate from CursorHostAdapter so the adapter stays
 * focused on hook installation + payload normalization, and the mapping
 * logic is unit-testable without touching the bridge.
 */

import type {
  AnyBridgeRequest,
  BridgeResponse,
  BridgeErrorResponse,
  HostApprovalRequestResponse,
  HostPromptSubmitResponse,
  HostSessionStartResponse,
  HostStopResponse,
} from '../../bridge/protocol.js';
import type { HostDecision, HostEvent } from '../types.js';

/**
 * Translate a HostEvent into the wire-format request the bridge expects.
 * Returns `null` for kinds we don't currently route over the bridge (e.g. an
 * unknown event the caller should silently no-op).
 */
export function eventToBridgeRequest(event: HostEvent): AnyBridgeRequest | null {
  switch (event.kind) {
    case 'session_start':
      return {
        type: 'host_session_start',
        host_session_id: event.hostSessionId,
        cwd: event.cwd,
        composer_mode: event.composerMode,
      };
    case 'prompt_submit':
      return {
        type: 'host_prompt_submit',
        host_session_id: event.hostSessionId,
        prompt: event.prompt,
        cwd: event.cwd,
      };
    case 'agent_response':
      return {
        type: 'host_agent_response',
        host_session_id: event.hostSessionId,
        response_text: event.text,
      };
    case 'progress':
      return {
        type: 'host_progress',
        host_session_id: event.hostSessionId,
        tool: event.tool,
        detail: event.detail,
      };
    case 'tool_use_post':
      return {
        type: 'host_progress',
        host_session_id: event.hostSessionId,
        tool: event.tool,
        detail: `${event.phase}${event.exitCode !== undefined ? ` (exit ${event.exitCode})` : ''}`,
      };
    case 'stop':
      return {
        type: 'host_stop',
        host_session_id: event.hostSessionId,
      };
    case 'tool_use_pre':
      return {
        type: 'host_approval_request',
        host_session_id: event.hostSessionId,
        tool: event.tool,
        command: event.command,
        payload: event.payload,
      };
  }
}

function isErrorResponse(res: BridgeResponse | BridgeErrorResponse): res is BridgeErrorResponse {
  return typeof (res as BridgeErrorResponse).error === 'string';
}

/**
 * Convert a bridge response into a typed HostDecision matching the event's
 * kind. Errors fall back to a conservative decision (continue/ask/ok=false).
 */
export function bridgeResponseToDecision(
  event: HostEvent,
  response: BridgeResponse | BridgeErrorResponse,
): HostDecision {
  if (isErrorResponse(response)) {
    return fallbackDecision(event);
  }

  switch (event.kind) {
    case 'session_start': {
      const r = response as HostSessionStartResponse;
      return { kind: 'session_start', additionalContext: r.additional_context };
    }
    case 'prompt_submit': {
      const r = response as HostPromptSubmitResponse;
      return {
        kind: 'prompt_submit',
        continue: r.continue !== false,
        userMessage: r.user_message,
      };
    }
    case 'agent_response':
      return {
        kind: 'agent_response',
        ok: Boolean((response as { ok?: boolean }).ok ?? true),
        suppressed: (response as { suppressed?: boolean }).suppressed,
      };
    case 'tool_use_post':
      return { kind: 'tool_use_post', ok: Boolean((response as { ok?: boolean }).ok ?? true) };
    case 'progress':
      return {
        kind: 'progress',
        ok: Boolean((response as { ok?: boolean }).ok ?? true),
        sent: (response as { sent?: boolean }).sent,
      };
    case 'stop': {
      const r = response as HostStopResponse;
      return { kind: 'stop', followupMessage: r.followup_message };
    }
    case 'tool_use_pre': {
      const r = response as HostApprovalRequestResponse;
      const permission = r.decision === 'allow' || r.decision === 'deny' ? r.decision : 'ask';
      return { kind: 'tool_use_pre', permission, reason: r.reason };
    }
  }
}

/**
 * The conservative default when the bridge is unreachable, returns garbage,
 * or errors out. Mirrors agent2lark-cursor's relayFallback / localAsk.
 */
export function fallbackDecision(event: HostEvent, reason?: string): HostDecision {
  switch (event.kind) {
    case 'session_start':
      return { kind: 'session_start' };
    case 'prompt_submit':
      return { kind: 'prompt_submit', continue: true };
    case 'agent_response':
      return { kind: 'agent_response', ok: true };
    case 'tool_use_post':
      return { kind: 'tool_use_post', ok: true };
    case 'progress':
      return { kind: 'progress', ok: true };
    case 'stop':
      return { kind: 'stop' };
    case 'tool_use_pre':
      return {
        kind: 'tool_use_pre',
        permission: 'ask',
        reason: reason ?? 'Helm bridge unreachable; please review locally.',
      };
  }
}
