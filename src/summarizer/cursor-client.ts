/**
 * CursorLlmClient — implements the summarizer's LlmClient using `@cursor/sdk`'s
 * `Agent.prompt()` API. Replaces the Phase 22 AnthropicLlmClient so summarize
 * reuses whatever model the user has already authenticated in Cursor — no
 * separate API key needed.
 *
 * Two modes:
 *   - local (default): runs the agent locally; uses the Cursor app's
 *     authentication on this machine. Zero config when the user has Cursor
 *     installed + signed in.
 *   - cloud: requires CURSOR_API_KEY env var or constructor `apiKey`. Useful
 *     for CI / headless boxes that don't have Cursor installed.
 *
 * `LlmClient.generate({ model, maxTokens })` ignores `maxTokens` — Cursor's
 * agent platform owns max-tokens at the model-config layer rather than per
 * request. The summarizer's prompt is small enough that this is moot.
 */

import { Agent } from '@cursor/sdk';
import type { LlmClient } from './campaign.js';

export type CursorClientMode = 'local' | 'cloud';

export interface CursorLlmClientOptions {
  /** Override model id. Default 'auto' (Cursor picks). */
  modelId?: string;
  /** Bearer key for cloud mode. Falls back to CURSOR_API_KEY env. */
  apiKey?: string;
  /**
   * 'local' (default) or 'cloud'. Local agents reuse the user's Cursor
   * app auth; cloud agents need an API key.
   */
  mode?: CursorClientMode;
  /** Working directory for local agents; defaults to process.cwd(). */
  cwd?: string;
  /**
   * Test seam: inject a fake `Agent.prompt`-compatible function so unit
   * tests don't spawn a real Cursor agent.
   */
  promptFn?: typeof Agent.prompt;
}

export function resolveCursorApiKey(options: CursorLlmClientOptions = {}, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (options.apiKey && options.apiKey.trim()) return options.apiKey.trim();
  const fromEnv = env['CURSOR_API_KEY'];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return undefined;
}

const DEFAULT_MODEL_ID = 'auto';

export class CursorLlmClient implements LlmClient {
  private readonly options: CursorLlmClientOptions;
  private readonly mode: CursorClientMode;
  private readonly modelId: string;

  constructor(options: CursorLlmClientOptions = {}) {
    this.options = options;
    this.mode = options.mode ?? 'local';
    this.modelId = options.modelId ?? DEFAULT_MODEL_ID;

    if (this.mode === 'cloud' && !resolveCursorApiKey(options)) {
      throw new Error(
        'CursorLlmClient cloud mode requires an API key — pass options.apiKey '
        + 'or set CURSOR_API_KEY in env.',
      );
    }
  }

  async generate(prompt: string, callerOptions: { model: string; maxTokens: number }): Promise<string> {
    // The summarizer passes a model id in callerOptions.model. We override
    // with our configured Cursor model id (the summarizer's default
    // 'claude-sonnet-4-6' isn't a Cursor model id). Caller's value would
    // matter if the orchestrator wired Cursor-specific model ids into
    // SummarizerDeps.model, which we don't yet — config.cursor.model
    // already lands here via the orchestrator factory.
    void callerOptions;

    const promptFn = this.options.promptFn ?? Agent.prompt;
    const agentOptions: Parameters<typeof Agent.prompt>[1] = {
      model: { id: this.modelId },
    };

    if (this.mode === 'local') {
      agentOptions.local = { cwd: this.options.cwd ?? process.cwd() };
    } else {
      const apiKey = resolveCursorApiKey(this.options);
      if (apiKey) agentOptions.apiKey = apiKey;
    }

    const result = await promptFn(prompt, agentOptions);

    if (result.status !== 'finished') {
      throw new Error(
        `Cursor agent did not finish (status=${result.status})`
        + (result.result ? `: ${result.result.slice(0, 200)}` : ''),
      );
    }
    if (!result.result) {
      throw new Error(`Cursor agent returned empty result (status=${result.status})`);
    }
    return result.result;
  }
}

/**
 * Always returns a CursorLlmClient — local mode requires no key. The
 * orchestrator gets a non-null result, then `generate()` calls fail at
 * runtime if Cursor isn't installed / authenticated. That's actionable
 * (user re-installs / signs in to Cursor) rather than a silent 501.
 *
 * For the cloud path: when caller asks for cloud and no key is available,
 * the constructor throws "API key required", which the orchestrator's
 * factory catches and surfaces via 501.
 */
export function createCursorLlmClient(options: CursorLlmClientOptions = {}): CursorLlmClient {
  return new CursorLlmClient(options);
}
