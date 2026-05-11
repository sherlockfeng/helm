/**
 * EngineRouter + adapter contracts (Phase 68).
 *
 * Three LLM-driven features in helm — summarizer, Harness reviewer,
 * role-trainer modal — used to bind directly to either CursorLlmClient
 * or ClaudeCodeAgent. Phase 68 routes them through a single
 * `EngineRouter` so the user can pick a global default in Settings.
 *
 * The router holds adapter instances keyed by engine id and re-reads
 * `liveConfig.engine.default` on every `.current()` call (no caching) so
 * a Settings save takes effect immediately for the next request.
 *
 * Adapters expose three capabilities — `summarize`, `review`,
 * `runConversation`. Each feature picks the one it needs:
 *   - summarizer / Harness reviewer    → summarize OR review (single-turn
 *     structured output)
 *   - Roles "Train via chat" modal     → runConversation (multi-turn +
 *     MCP tool calls)
 *
 * When the active adapter can't do the requested capability (e.g. cursor
 * adapter's conversational-tools fallback isn't ready), it throws a
 * `EngineCapabilityUnsupportedError` with an actionable message that the
 * UI surfaces directly.
 */

import type { LlmClient } from '../summarizer/campaign.js';

export type EngineId = 'cursor' | 'claude';

/** Single-turn review payload — produced by `assembleReviewerPayload()`. */
export interface ReviewInput {
  /** The fully-assembled prompt (Intent + Structure + diff + conventions). */
  userPayload: string;
  /** Reviewer system prompt (no Decisions / Stage Log — info isolation). */
  systemPrompt: string;
  /** Working directory the subprocess should run in (typically the project root). */
  cwd: string;
  /** Optional helm MCP SSE URL — adapters that support tool calls can wire it in. */
  helmMcpUrl?: string;
  /** Hard timeout for the subprocess; default ~5 min. */
  timeoutMs?: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface RunConversationInput {
  messages: readonly ChatMessage[];
  systemPrompt?: string;
  /** Working directory for the spawned subprocess. */
  cwd?: string;
  /** helm MCP SSE URL so the agent can call `train_role` / `harness_*` etc. */
  helmMcpUrl?: string;
}

export interface RunConversationResult {
  /** Latest assistant turn. */
  text: string;
  /** Whatever stderr the subprocess wrote — surfaced to the debug panel. */
  stderr: string;
  /** Stable id for the agent session, where the engine has one. */
  sessionId: string;
}

/**
 * The capability-specific contract each engine adapter has to satisfy.
 *
 * Adapters DON'T need to support all three. Implementations that can't
 * fulfil a capability throw `EngineCapabilityUnsupportedError` synchronously
 * (or reject immediately) so the orchestrator can fall back gracefully OR
 * (in MVP's hard-fail mode, per fork #2) surface an actionable error.
 */
export interface EngineAdapter {
  readonly id: EngineId;

  /** Single-turn text generation — fits `LlmClient` (summarizer). */
  readonly summarize: LlmClient;

  /**
   * Single-turn structured output for the Harness reviewer. Output is the
   * raw text claude/cursor produced — caller decides how to parse.
   */
  review(input: ReviewInput): Promise<string>;

  /**
   * Multi-turn conversational session. The adapter spawns a subprocess (or
   * holds a session) capable of calling helm's MCP tools mid-conversation,
   * then returns the latest assistant text + stderr.
   */
  runConversation(input: RunConversationInput): Promise<RunConversationResult>;
}

export class EngineCapabilityUnsupportedError extends Error {
  constructor(
    public readonly engineId: EngineId,
    public readonly capability: 'summarize' | 'review' | 'runConversation',
    message: string,
  ) {
    super(message);
    this.name = 'EngineCapabilityUnsupportedError';
  }
}

/** Engine health for the Settings page status row. */
export interface EngineHealth {
  engine: EngineId;
  ready: boolean;
  /** Free-form one-liner about state (version, "missing", "needs login"). */
  detail: string;
  /** When `ready === false`, the next user action that fixes it. */
  hint?: string;
}
