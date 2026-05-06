/**
 * AnthropicLlmClient tests. We pass a fake `client` so the real Anthropic
 * SDK never makes a network call — keeps the test hermetic and fast.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  AnthropicLlmClient,
  resolveAnthropicApiKey,
  tryCreateAnthropicLlmClient,
} from '../../../src/summarizer/anthropic-client.js';
import type Anthropic from '@anthropic-ai/sdk';

interface FakeMessage {
  type: 'text' | 'tool_use';
  text?: string;
}

function fakeClient(content: FakeMessage[], stop_reason: string = 'end_turn'): Anthropic {
  const create = vi.fn().mockResolvedValue({
    content,
    stop_reason,
  });
  return {
    messages: { create } as unknown as Anthropic['messages'],
  } as unknown as Anthropic;
}

describe('resolveAnthropicApiKey', () => {
  it('options.apiKey wins', () => {
    expect(resolveAnthropicApiKey({ apiKey: 'opt-key' }, { ANTHROPIC_API_KEY: 'env-key' }))
      .toBe('opt-key');
  });

  it('falls back to ANTHROPIC_API_KEY env when option missing', () => {
    expect(resolveAnthropicApiKey({}, { ANTHROPIC_API_KEY: 'env-key' })).toBe('env-key');
  });

  it('attack: whitespace-only values are ignored', () => {
    expect(resolveAnthropicApiKey({ apiKey: '   ' }, { ANTHROPIC_API_KEY: '   ' }))
      .toBeUndefined();
  });

  it('returns undefined when neither set', () => {
    expect(resolveAnthropicApiKey({}, {})).toBeUndefined();
  });
});

describe('AnthropicLlmClient', () => {
  it('throws on construction when no key + no client supplied', () => {
    expect(() => new AnthropicLlmClient({}))
      .toThrow(/API key/);
  });

  it('uses an injected client when provided', async () => {
    const client = fakeClient([{ type: 'text', text: 'hello' }]);
    const llm = new AnthropicLlmClient({ client });
    const out = await llm.generate('say hi', { model: 'claude-x', maxTokens: 100 });
    expect(out).toBe('hello');
  });

  it('forwards model + max_tokens + prompt to messages.create', async () => {
    const client = fakeClient([{ type: 'text', text: 'ok' }]);
    const create = client.messages.create as unknown as ReturnType<typeof vi.fn>;
    const llm = new AnthropicLlmClient({ client });
    await llm.generate('summarize this', { model: 'claude-x', maxTokens: 1234 });
    expect(create).toHaveBeenCalledOnce();
    const args = create.mock.calls[0]![0] as {
      model: string; max_tokens: number; messages: Array<{ role: string; content: string }>;
    };
    expect(args.model).toBe('claude-x');
    expect(args.max_tokens).toBe(1234);
    expect(args.messages[0]?.content).toBe('summarize this');
  });

  it('concatenates multiple text blocks into one string', async () => {
    const client = fakeClient([
      { type: 'text', text: 'part one ' },
      { type: 'text', text: 'part two' },
    ]);
    const llm = new AnthropicLlmClient({ client });
    expect(await llm.generate('p', { model: 'm', maxTokens: 1 })).toBe('part one part two');
  });

  it('skips tool_use blocks', async () => {
    const client = fakeClient([
      { type: 'text', text: 'hello' },
      { type: 'tool_use' },
      { type: 'text', text: ' world' },
    ]);
    const llm = new AnthropicLlmClient({ client });
    expect(await llm.generate('p', { model: 'm', maxTokens: 1 })).toBe('hello world');
  });

  it('attack: response with no text content throws with stop_reason in message', async () => {
    const client = fakeClient([{ type: 'tool_use' }], 'tool_use');
    const llm = new AnthropicLlmClient({ client });
    await expect(llm.generate('p', { model: 'm', maxTokens: 1 }))
      .rejects.toThrow(/stop_reason=tool_use/);
  });

  it('attack: SDK error propagates', async () => {
    const client = {
      messages: {
        create: vi.fn().mockRejectedValue(new Error('rate limit')),
      } as unknown as Anthropic['messages'],
    } as unknown as Anthropic;
    const llm = new AnthropicLlmClient({ client });
    await expect(llm.generate('p', { model: 'm', maxTokens: 1 }))
      .rejects.toThrow(/rate limit/);
  });
});

describe('tryCreateAnthropicLlmClient', () => {
  it('returns null when no key + no client', () => {
    const original = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      expect(tryCreateAnthropicLlmClient({})).toBeNull();
    } finally {
      if (original !== undefined) process.env['ANTHROPIC_API_KEY'] = original;
    }
  });

  it('returns a client when injected client is provided', () => {
    const client = fakeClient([{ type: 'text', text: 'x' }]);
    const result = tryCreateAnthropicLlmClient({ client });
    expect(result).toBeInstanceOf(AnthropicLlmClient);
  });
});
