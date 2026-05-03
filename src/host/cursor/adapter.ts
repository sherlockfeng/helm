/**
 * CursorHostAdapter — the HostAdapter implementation for Cursor IDE.
 * See PROJECT_BLUEPRINT.md §10.
 */

import type { HostAdapter, HostDecision, HostEvent, HostInstallOptions, HostInstallResult } from '../types.js';
import { normalizeCursorEvent } from './normalize.js';
import { installCursorHooks, uninstallCursorHooks } from './installer.js';

export interface CursorHostAdapterOptions {
  /** Override the absolute path to the helm-hook bin script. Used by tests + dev installs. */
  hookBinPath?: string;
}

export class CursorHostAdapter implements HostAdapter {
  readonly hostId = 'cursor' as const;
  private readonly hookBinPath?: string;

  constructor(options: CursorHostAdapterOptions = {}) {
    this.hookBinPath = options.hookBinPath;
  }

  async install(options: HostInstallOptions = {}): Promise<HostInstallResult> {
    return installCursorHooks(options, this.hookBinPath);
  }

  async uninstall(options: HostInstallOptions = {}): Promise<HostInstallResult> {
    return uninstallCursorHooks(options);
  }

  normalize(rawEvent: unknown, hookEventName?: string): HostEvent {
    return normalizeCursorEvent(rawEvent, hookEventName).event;
  }

  formatResponse(event: HostEvent, decision: HostDecision): Record<string, unknown> {
    if (decision.kind !== event.kind) {
      // Defensive: caller paired a decision with a mismatched event. Treat as fallback.
      return {};
    }

    switch (decision.kind) {
      case 'session_start':
        return decision.additionalContext ? { additional_context: decision.additionalContext } : {};

      case 'prompt_submit':
        return {
          continue: decision.continue,
          ...(decision.userMessage ? { user_message: decision.userMessage } : {}),
        };

      case 'agent_response':
      case 'tool_use_post':
      case 'progress':
        // Cursor doesn't consume a response payload for these events; an empty
        // object satisfies its hook contract.
        return {};

      case 'stop':
        return decision.followupMessage ? { followup_message: decision.followupMessage } : {};

      case 'tool_use_pre': {
        if (decision.permission === 'allow') {
          return {
            permission: 'allow',
            agent_message: decision.reason
              ? `Approved by Helm (${decision.reason}).`
              : 'Approved by Helm.',
          };
        }
        if (decision.permission === 'deny') {
          const msg = decision.reason ? `Denied by Helm (${decision.reason}).` : 'Denied by Helm.';
          return { permission: 'deny', user_message: msg, agent_message: msg };
        }
        return {
          permission: 'ask',
          user_message: decision.reason ?? 'Please review this Cursor action locally.',
          agent_message: decision.reason ?? 'Helm fell back to Cursor local approval.',
        };
      }
    }
  }
}
