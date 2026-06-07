/**
 * CodexHostAdapter (PR 7-codex).
 *
 * OpenAI Codex CLI doesn't yet have a documented hook protocol like
 * Cursor; PR S (the spike) decides whether we ride a future stable
 * hook surface OR keep parsing stdout. This adapter ships the
 * minimum viable shape so renderer-side IA + agent_kind discriminator
 * have a real implementation behind them; the production wiring is
 * left as a thin shim the spike PR will fill in.
 */

import type {
  HostAdapter,
  HostDecision,
  HostEvent,
  HostInstallOptions,
  HostInstallResult,
} from '../types.js';

export interface CodexHostAdapterOptions {
  hooksPath?: string;
}

export class CodexHostAdapter implements HostAdapter {
  readonly hostId = 'codex' as const;
  private readonly hooksPath?: string;

  constructor(opts: CodexHostAdapterOptions = {}) {
    if (opts.hooksPath) this.hooksPath = opts.hooksPath;
  }

  async install(options: HostInstallOptions = {}): Promise<HostInstallResult> {
    const hooksPath = this.hooksPath ?? options.hooksPath
      ?? `${process.env['HOME'] ?? ''}/.codex/hooks/helm.json`;
    return Promise.resolve({ hooksPath, events: ['session_start', 'prompt_submit', 'agent_response', 'stop'] });
  }

  async uninstall(options: HostInstallOptions = {}): Promise<HostInstallResult> {
    const hooksPath = this.hooksPath ?? options.hooksPath
      ?? `${process.env['HOME'] ?? ''}/.codex/hooks/helm.json`;
    return Promise.resolve({ hooksPath, events: [] });
  }

  normalize(rawEvent: unknown, hookEventName?: string): HostEvent {
    const raw = (rawEvent ?? {}) as Record<string, unknown>;
    const hostSessionId = String(
      raw['session_id'] ?? raw['hostSessionId'] ?? raw['session'] ?? 'unknown',
    );
    const cwd = typeof raw['cwd'] === 'string' ? raw['cwd'] : undefined;
    const base = { host: this.hostId, hostSessionId, raw, ...(cwd ? { cwd } : {}) } as const;
    const kind = (hookEventName ?? raw['kind'] ?? raw['type'] ?? 'session_start') as string;
    switch (kind) {
      case 'session_start':
        return { ...base, kind: 'session_start' };
      case 'prompt_submit':
      case 'prompt':
        return { ...base, kind: 'prompt_submit', prompt: String(raw['prompt'] ?? raw['body'] ?? '') };
      case 'agent_response':
      case 'response':
        return { ...base, kind: 'agent_response', text: String(raw['text'] ?? raw['body'] ?? '') };
      case 'stop':
        return { ...base, kind: 'stop' };
      default:
        return { ...base, kind: 'session_start' };
    }
  }

  formatResponse(event: HostEvent, decision: HostDecision): Record<string, unknown> {
    if (decision.kind !== event.kind) return {};
    switch (decision.kind) {
      case 'session_start':
        return decision.additionalContext
          ? { additional_context: decision.additionalContext }
          : {};
      case 'prompt_submit':
        return {
          continue: decision.continue,
          ...(decision.userMessage ? { user_message: decision.userMessage } : {}),
        };
      case 'stop':
        return decision.followupMessage ? { followup_message: decision.followupMessage } : {};
      default:
        return {};
    }
  }
}
