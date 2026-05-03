/**
 * HostAdapter abstraction — see PROJECT_BLUEPRINT.md §10.
 *
 * A HostAdapter is the layer that knows how to talk to a specific chat host
 * (Cursor today, Claude Code later). It owns:
 *   - hook installation / removal
 *   - normalizing the host's raw hook payload into a uniform HostEvent
 *   - formatting the host's expected response back from a HostDecision
 *
 * The bridge protocol layer (src/bridge/protocol.ts) defines the wire format
 * between the hook subprocess and the long-running Helm app. The mapping
 * between HostEvent and bridge messages lives per-host (see cursor/bridge-mapper.ts).
 */

export type HostEventKind =
  | 'session_start'
  | 'prompt_submit'
  | 'agent_response'
  | 'tool_use_pre'
  | 'tool_use_post'
  | 'progress'
  | 'stop';

export type HostId = 'cursor' | 'claude-code';

export interface HostEventBase {
  host: HostId;
  hostSessionId: string;
  cwd?: string;
  /** Original hook payload, kept for debugging / event log persistence. */
  raw: unknown;
}

export interface HostSessionStartEvent extends HostEventBase {
  kind: 'session_start';
  composerMode?: string;
}

export interface HostPromptSubmitEvent extends HostEventBase {
  kind: 'prompt_submit';
  prompt: string;
}

export interface HostAgentResponseEvent extends HostEventBase {
  kind: 'agent_response';
  text: string;
}

export interface HostToolUsePreEvent extends HostEventBase {
  kind: 'tool_use_pre';
  /** Cursor-side hook event name (beforeShellExecution / beforeMcpExecution / preToolUse). */
  hookEventName: string;
  tool: string;
  command: string;
  payload: Record<string, unknown>;
  permissionMode?: string;
}

export interface HostToolUsePostEvent extends HostEventBase {
  kind: 'tool_use_post';
  tool: string;
  command: string;
  phase: 'completed' | 'failed';
  exitCode?: number;
  durationMs?: number;
}

export interface HostProgressEvent extends HostEventBase {
  kind: 'progress';
  tool: string;
  detail?: string;
}

export interface HostStopEvent extends HostEventBase {
  kind: 'stop';
  loopCount?: number;
  status?: string;
}

export type HostEvent =
  | HostSessionStartEvent
  | HostPromptSubmitEvent
  | HostAgentResponseEvent
  | HostToolUsePreEvent
  | HostToolUsePostEvent
  | HostProgressEvent
  | HostStopEvent;

// ── Decisions (returned from app, formatted back into host-specific output) ─

export type HostDecision =
  | { kind: 'session_start'; additionalContext?: string }
  | { kind: 'prompt_submit'; continue: boolean; userMessage?: string }
  | { kind: 'agent_response'; ok: boolean; suppressed?: boolean }
  | { kind: 'tool_use_pre'; permission: 'allow' | 'deny' | 'ask'; reason?: string }
  | { kind: 'tool_use_post'; ok: boolean }
  | { kind: 'progress'; ok: boolean; sent?: boolean }
  | { kind: 'stop'; followupMessage?: string };

// ── Adapter interface ─────────────────────────────────────────────────────

export interface HostAdapter {
  readonly hostId: HostId;
  install(options?: HostInstallOptions): Promise<HostInstallResult>;
  uninstall(options?: HostInstallOptions): Promise<HostInstallResult>;
  /** Convert a raw hook payload into a typed HostEvent. */
  normalize(rawEvent: unknown, hookEventName?: string): HostEvent;
  /** Format the response back into whatever JSON shape the host expects. */
  formatResponse(event: HostEvent, decision: HostDecision): Record<string, unknown>;
}

export interface HostInstallOptions {
  /** Override default hooks-config path (e.g. for tests). */
  hooksPath?: string;
  /** Restrict to specific hook events. Defaults to the adapter's full set. */
  events?: string[];
  /** Per-hook timeout in seconds (default 86400 = 24h). */
  timeoutSeconds?: number;
}

export interface HostInstallResult {
  hooksPath: string;
  events: string[];
}
