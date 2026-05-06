/**
 * AnthropicLlmClient — real implementation of the summarizer's LlmClient
 * interface, backed by the official `@anthropic-ai/sdk`.
 *
 * The summarizer (src/summarizer/campaign.ts) was written with `LlmClient`
 * as a deps interface so tests can supply a fake. This module is the
 * production wiring. It's deliberately small — concentrates the SDK shape
 * coupling in one file so a future swap (different model provider, mocked
 * client per environment) doesn't ripple through the codebase.
 *
 * Resolution order for the API key:
 *   1. constructor option `apiKey`
 *   2. `ANTHROPIC_API_KEY` env var
 *   3. throw — `summarize_campaign` should fail loudly when no key is
 *      available rather than silently fall back to a stub.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { LlmClient } from './campaign.js';

export interface AnthropicLlmClientOptions {
  /** Bearer key. When undefined, falls back to ANTHROPIC_API_KEY env var. */
  apiKey?: string;
  /** Override SDK base URL (test seam; ANTHROPIC_BASE_URL env wins by default). */
  baseURL?: string;
  /** Pre-built Anthropic instance for tests. When set, apiKey/baseURL are ignored. */
  client?: Anthropic;
}

export function resolveAnthropicApiKey(options: AnthropicLlmClientOptions = {}, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (options.apiKey && options.apiKey.trim()) return options.apiKey.trim();
  const fromEnv = env['ANTHROPIC_API_KEY'];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return undefined;
}

export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;

  constructor(options: AnthropicLlmClientOptions = {}) {
    if (options.client) {
      this.client = options.client;
      return;
    }
    const apiKey = resolveAnthropicApiKey(options);
    if (!apiKey) {
      throw new Error(
        'AnthropicLlmClient requires an API key — pass options.apiKey, '
        + 'set ANTHROPIC_API_KEY in env, or fill helm config.anthropic.apiKey.',
      );
    }
    this.client = new Anthropic({
      apiKey,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
  }

  async generate(prompt: string, options: { model: string; maxTokens: number }): Promise<string> {
    const response = await this.client.messages.create({
      model: options.model,
      max_tokens: options.maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });

    // Concatenate every text block in the response (some models emit multiple).
    // Tool-use blocks (no `text` field) are dropped — the summarizer asks for
    // a single JSON answer and never grants tools.
    const text = response.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');

    if (!text) {
      throw new Error(
        `Anthropic returned no text content (stop_reason=${response.stop_reason}); `
        + `${response.content.length} content block(s)`,
      );
    }
    return text;
  }
}

/**
 * Try to build an AnthropicLlmClient; return null when no key is available.
 * Useful for orchestrator wiring where summarize is opt-in: the HTTP
 * endpoint returns 501 when this is null, and the user fills the key in
 * Settings.
 */
export function tryCreateAnthropicLlmClient(options: AnthropicLlmClientOptions = {}): AnthropicLlmClient | null {
  if (resolveAnthropicApiKey(options) === undefined && !options.client) return null;
  return new AnthropicLlmClient(options);
}
