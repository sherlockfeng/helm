/**
 * AnthropicLlmClient — wraps the Anthropic SDK to satisfy the minimal LlmClient
 * contract used by the summarizer (and future LLM-driven engines).
 *
 * Kept separate from the summarizer so:
 *   1. Tests substitute a fake LlmClient without touching the SDK
 *   2. Other LLM providers can ship their own implementation later
 */

import Anthropic from '@anthropic-ai/sdk';
import type { LlmClient } from '../summarizer/campaign.js';

export interface AnthropicClientOptions {
  apiKey: string;
}

export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;

  constructor(options: AnthropicClientOptions) {
    this.client = new Anthropic({ apiKey: options.apiKey });
  }

  async generate(prompt: string, options: { model: string; maxTokens: number }): Promise<string> {
    const response = await this.client.messages.create({
      model: options.model,
      max_tokens: options.maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });

    return response.content
      .filter((b): b is { type: 'text'; text: string; citations?: unknown } => b.type === 'text')
      .map((b) => b.text)
      .join('');
  }
}
