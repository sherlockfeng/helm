/**
 * CursorAgentSpawner — wraps `@cursor/sdk` `Agent.create()` (+ optional
 * `agent.send()`) so callers can launch a fresh Cursor agent against a project
 * directory and walk away with an `agentId` they can address later. Phase 26
 * (PROJECT_BLUEPRINT.md §25.3 C3) replaces the Phase 0 stub at
 * `src/spawner/index.ts` that callers like `start_relay_chat_session` couldn't
 * actually use to launch a real chat.
 *
 * Modes mirror the Phase 24 summarizer client so the user's single Cursor
 * config block (`HelmConfig.cursor`) drives both:
 *   - local (default): zero-config when the user has Cursor app installed +
 *     signed in; agent is bound to `cwd` (the project the spawned agent edits).
 *   - cloud: requires CURSOR_API_KEY (env or config). For headless / CI boxes.
 *
 * The `agentFactory` / `sendFn` test seams let unit tests assert behavior
 * without spawning a real Cursor process.
 */

import { Agent } from '@cursor/sdk';
import type { SDKAgent } from '@cursor/sdk';
import { resolveCursorApiKey, type CursorClientMode } from '../summarizer/cursor-client.js';

export interface CursorAgentSpawnerOptions {
  /** 'local' (default) or 'cloud'. */
  mode?: CursorClientMode;
  /** Bearer key for cloud mode. Falls back to CURSOR_API_KEY env. */
  apiKey?: string;
  /** Default model id passed to Agent.create when caller doesn't override. */
  modelId?: string;
  /**
   * Test seam: substitute `Agent.create`. The returned object only needs the
   * subset of `SDKAgent` we use (agentId + send + close).
   */
  agentFactory?: typeof Agent.create;
}

export interface SpawnInput {
  /** Working directory the spawned agent operates in. Required for local mode. */
  projectPath: string;
  /**
   * Initial prompt. When set, the spawner immediately calls `agent.send()` so
   * the chat starts working without an extra round-trip from the caller.
   * Omit to leave the agent idle (caller will message it later via the SDK).
   */
  prompt?: string;
  /** Optional friendly name surfaced in `Agent.list()`. */
  name?: string;
  /** Override the default model for this spawn. */
  modelId?: string;
}

export interface SpawnResult {
  agentId: string;
  /** Echoed so callers can confirm the model the agent was created with. */
  modelId: string;
  /** Echoed to make logging / UI rendering trivial. */
  projectPath: string;
  /** When `prompt` was provided, this is the run id of the initial send. */
  initialRunId?: string;
}

const DEFAULT_MODEL_ID = 'auto';

export class CursorAgentSpawner {
  private readonly options: CursorAgentSpawnerOptions;
  private readonly mode: CursorClientMode;
  private readonly modelId: string;

  constructor(options: CursorAgentSpawnerOptions = {}) {
    this.options = options;
    this.mode = options.mode ?? 'local';
    this.modelId = options.modelId ?? DEFAULT_MODEL_ID;

    if (this.mode === 'cloud' && !resolveCursorApiKey({ apiKey: options.apiKey })) {
      throw new Error(
        'CursorAgentSpawner cloud mode requires an API key — pass options.apiKey '
        + 'or set CURSOR_API_KEY in env.',
      );
    }
  }

  async spawn(input: SpawnInput): Promise<SpawnResult> {
    if (!input.projectPath || !input.projectPath.trim()) {
      throw new Error('projectPath is required');
    }
    const modelId = input.modelId ?? this.modelId;
    const factory = this.options.agentFactory ?? Agent.create;

    const agentOptions: Parameters<typeof Agent.create>[0] = {
      model: { id: modelId },
      ...(input.name ? { name: input.name } : {}),
    };

    if (this.mode === 'local') {
      agentOptions.local = { cwd: input.projectPath };
    } else {
      const apiKey = resolveCursorApiKey({ apiKey: this.options.apiKey });
      // Constructor already guarantees this is set in cloud mode; the explicit
      // re-check protects against options.apiKey being mutated post-construction.
      if (!apiKey) {
        throw new Error('CursorAgentSpawner cloud mode requires an API key');
      }
      agentOptions.apiKey = apiKey;
    }

    const agent: SDKAgent = await factory(agentOptions);

    let initialRunId: string | undefined;
    if (input.prompt && input.prompt.trim()) {
      const run = await agent.send(input.prompt);
      initialRunId = run.id;
    }

    return {
      agentId: agent.agentId,
      modelId,
      projectPath: input.projectPath,
      ...(initialRunId ? { initialRunId } : {}),
    };
  }
}

/**
 * Always returns a CursorAgentSpawner — local mode requires no key. Cloud
 * mode without a key throws synchronously, which the caller (mcp/run.ts /
 * orchestrator) catches to log a warning + skip wiring the
 * `start_relay_chat_session` tool. A spawn at runtime that fails because
 * Cursor isn't installed bubbles up as a tool error so the user can fix it.
 */
export function createCursorAgentSpawner(
  options: CursorAgentSpawnerOptions = {},
): CursorAgentSpawner {
  return new CursorAgentSpawner(options);
}
