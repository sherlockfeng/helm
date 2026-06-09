/**
 * ClaudeCodeHostAdapter (PR 7-codex).
 *
 * Claude Code's bridge to helm is the existing MCP server: every tool
 * call lands in helm's MCP handler and carries the host_session_id +
 * agent identity, so we already have everything needed to record a
 * session lifecycle. This adapter formalises that observation as a
 * HostAdapter — install/uninstall write helm's MCP config into
 * `~/.claude.json` so the Claude Code CLI discovers helm without
 * manual configuration.
 *
 * normalize / formatResponse operate on the MCP protocol's
 * notifications/* surface in JSON-RPC. Most of these events are
 * "session opened" / "session closed" / "tool invoked" — they don't
 * mirror Cursor's hook shapes directly, so we project them onto the
 * neutral HostEvent kinds the orchestrator understands.
 */

import type {
  HostAdapter,
  HostDecision,
  HostEvent,
  HostInstallOptions,
  HostInstallResult,
} from '../types.js';
import { installClaudeCodeHooks, uninstallClaudeCodeHooks } from './installer.js';
import { normalizeClaudePayload } from './normalize.js';

export interface ClaudeCodeHostAdapterOptions {
  /** Override the Claude Code config file path (default ~/.claude.json). */
  configPath?: string;
  /** URL helm's MCP server is listening on. */
  mcpUrl?: string;
}

export class ClaudeCodeHostAdapter implements HostAdapter {
  readonly hostId = 'claude-code' as const;
  private readonly configPath?: string;
  private readonly mcpUrl?: string;

  constructor(opts: ClaudeCodeHostAdapterOptions = {}) {
    if (opts.configPath) this.configPath = opts.configPath;
    if (opts.mcpUrl) this.mcpUrl = opts.mcpUrl;
  }

  async install(options: HostInstallOptions = {}): Promise<HostInstallResult> {
    const opts: HostInstallOptions = { ...options };
    if (this.configPath && !opts.hooksPath) opts.hooksPath = this.configPath;
    return Promise.resolve(installClaudeCodeHooks(opts));
  }

  async uninstall(options: HostInstallOptions = {}): Promise<HostInstallResult> {
    const opts: HostInstallOptions = { ...options };
    if (this.configPath && !opts.hooksPath) opts.hooksPath = this.configPath;
    return Promise.resolve(uninstallClaudeCodeHooks(opts));
  }

  normalize(rawEvent: unknown, hookEventName?: string): HostEvent {
    const raw = (rawEvent && typeof rawEvent === 'object' && !Array.isArray(rawEvent))
      ? (rawEvent as Record<string, unknown>)
      : {};
    return normalizeClaudePayload(raw, hookEventName);
  }

  formatResponse(event: HostEvent, decision: HostDecision): Record<string, unknown> {
    if (decision.kind !== event.kind) return {};
    switch (decision.kind) {
      case 'session_start':
        return decision.additionalContext
          ? { context: decision.additionalContext }
          : {};
      case 'prompt_submit':
        return {
          continue: decision.continue,
          ...(decision.userMessage ? { user_message: decision.userMessage } : {}),
        };
      case 'stop':
        return decision.followupMessage ? { followup: decision.followupMessage } : {};
      default:
        return {};
    }
  }

  /** Expose for the renderer's setup card. */
  mcpEndpoint(): string | undefined {
    return this.mcpUrl;
  }
}
