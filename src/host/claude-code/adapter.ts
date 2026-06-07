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
    // Per design: writing the MCP server entry into ~/.claude.json is
    // the only install step. We delegate to the existing helm setup
    // flow (already exposed via /api/setup-mcp) when this adapter is
    // wired live; the install method here returns a placeholder so
    // the renderer can describe what the user would get.
    const hooksPath = this.configPath ?? options.hooksPath
      ?? `${process.env['HOME'] ?? ''}/.claude.json`;
    return Promise.resolve({ hooksPath, events: ['mcp:notifications/*'] });
  }

  async uninstall(options: HostInstallOptions = {}): Promise<HostInstallResult> {
    const hooksPath = this.configPath ?? options.hooksPath
      ?? `${process.env['HOME'] ?? ''}/.claude.json`;
    return Promise.resolve({ hooksPath, events: [] });
  }

  normalize(rawEvent: unknown, hookEventName?: string): HostEvent {
    // Claude Code events come over the MCP JSON-RPC channel rather than
    // a flat hook payload. We expect callers to pass the parsed
    // notification body. The fields we read are intentionally minimal —
    // the orchestrator only needs hostSessionId + kind + body to record
    // an entry on host_event_log.
    const raw = (rawEvent ?? {}) as Record<string, unknown>;
    const hostSessionId = String(raw['session_id'] ?? raw['hostSessionId'] ?? 'unknown');
    const cwd = typeof raw['cwd'] === 'string' ? raw['cwd'] : undefined;
    const base = { host: this.hostId, hostSessionId, raw, ...(cwd ? { cwd } : {}) } as const;
    switch (hookEventName ?? raw['kind'] ?? 'session_start') {
      case 'session_start':
        return { ...base, kind: 'session_start',
          ...(typeof raw['composer_mode'] === 'string'
            ? { composerMode: raw['composer_mode'] }
            : {}),
        };
      case 'prompt_submit':
        return { ...base, kind: 'prompt_submit', prompt: String(raw['prompt'] ?? '') };
      case 'agent_response':
        return { ...base, kind: 'agent_response', text: String(raw['text'] ?? '') };
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
