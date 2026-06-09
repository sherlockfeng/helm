/**
 * Claude Code hook payload → typed HostEvent.
 *
 * Schema reference (claude code docs):
 *   UserPromptSubmit  { session_id, transcript_path, cwd, hook_event_name, prompt }
 *   Stop              { session_id, transcript_path, cwd, hook_event_name, stop_hook_active }
 *
 * For Stop we don't get the assistant's message directly — the hook entry
 * tails the JSONL transcript at `transcript_path` to recover it before
 * emitting host_agent_response. The normalize function here just produces
 * the base events; transcript-tailing is a separate concern in hook-entry.ts.
 */

import type {
  HostAgentResponseEvent,
  HostEvent,
  HostPromptSubmitEvent,
  HostSessionStartEvent,
  HostStopEvent,
} from '../types.js';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * True if this hook event name is one helm subscribes to (vs. one a
 * concurrent tool wrote into settings.json).
 */
export function isClaudeHookEvent(name: string): boolean {
  return name === 'UserPromptSubmit' || name === 'Stop' || name === 'SessionStart';
}

export function normalizeClaudePayload(
  raw: Record<string, unknown>,
  explicitEvent?: string,
): HostEvent {
  const eventName = explicitEvent || str(raw['hook_event_name']) || 'SessionStart';
  const hostSessionId = str(raw['session_id']) || 'unknown';
  const cwd = str(raw['cwd']);
  const base = {
    host: 'claude-code' as const,
    hostSessionId,
    raw,
    ...(cwd ? { cwd } : {}),
  };

  switch (eventName) {
    case 'UserPromptSubmit': {
      const ev: HostPromptSubmitEvent = {
        ...base,
        kind: 'prompt_submit',
        prompt: str(raw['prompt']),
      };
      return ev;
    }
    case 'Stop': {
      const ev: HostStopEvent = {
        ...base,
        kind: 'stop',
      };
      return ev;
    }
    case 'SessionStart':
    default: {
      const ev: HostSessionStartEvent = { ...base, kind: 'session_start' };
      return ev;
    }
  }
}

/**
 * Build a synthetic agent_response event from text the hook entry recovered
 * by tailing the transcript file. Kept separate from normalizeClaudePayload
 * because the response isn't in the hook payload itself.
 */
export function buildAgentResponseFromTranscript(
  raw: Record<string, unknown>,
  text: string,
): HostAgentResponseEvent {
  return {
    host: 'claude-code',
    hostSessionId: str(raw['session_id']) || 'unknown',
    raw,
    ...(str(raw['cwd']) ? { cwd: str(raw['cwd']) } : {}),
    kind: 'agent_response',
    text,
  };
}
