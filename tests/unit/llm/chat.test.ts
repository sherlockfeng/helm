/**
 * Unit tests for the LLM chat abstraction (Phase 57).
 *
 * Both backends are stubbed at construct-time so the tests don't reach
 * Anthropic's API or spawn a real Cursor agent. We exercise:
 *   - factory routing (anthropic key wins; falls back to Cursor; throws on
 *     no provider)
 *   - Anthropic chat translates messages → API correctly + concatenates
 *     text blocks
 *   - Cursor chat serializes the transcript + unwraps RunResult.result
 *   - both surface a clean error when the backend rejects
 */

import { describe, expect, it, vi } from 'vitest';
import {
  AnthropicChatClient,
  CursorChatClient,
  createLlmChatClient,
} from '../../../src/llm/chat.js';
import { HelmConfigSchema } from '../../../src/config/schema.js';

describe('AnthropicChatClient', () => {
  it('forwards messages + system + maxTokens to Anthropic.messages.create', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'hi back' }],
    });
    const client = new AnthropicChatClient({
      apiKey: 'sk-test',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: { messages: { create } } as any,
    });
    const r = await client.chat([{ role: 'user', content: 'hi' }], {
      system: 'be brief',
      maxTokens: 100,
    });
    expect(r.content).toBe('hi back');
    expect(r.provider).toBe('anthropic');
    const args = create.mock.calls[0]?.[0];
    expect(args.system).toBe('be brief');
    expect(args.max_tokens).toBe(100);
    expect(args.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('concatenates multiple text blocks; ignores tool_use / image blocks', async () => {
    const client = new AnthropicChatClient({
      apiKey: 'sk-test',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: { messages: { create: async () => ({
        content: [
          { type: 'text', text: 'part one. ' },
          { type: 'tool_use', id: 'x', name: 'y', input: {} },
          { type: 'text', text: 'part two.' },
        ],
      }) } } as any,
    });
    const r = await client.chat([{ role: 'user', content: 'q' }]);
    expect(r.content).toBe('part one. part two.');
  });

  it('attack: missing apiKey throws on construct (fail loud, don\'t make an API call)', () => {
    expect(() => new AnthropicChatClient({ apiKey: '' })).toThrow(/apiKey/);
    expect(() => new AnthropicChatClient({ apiKey: '   ' })).toThrow(/apiKey/);
  });

  it('respects per-call model override', async () => {
    const create = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const client = new AnthropicChatClient({
      apiKey: 'sk', model: 'default-model',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: { messages: { create } } as any,
    });
    await client.chat([{ role: 'user', content: 'q' }], { model: 'override-model' });
    expect(create.mock.calls[0]?.[0].model).toBe('override-model');
  });
});

describe('CursorChatClient', () => {
  it('serializes the conversation as a transcript and surfaces RunResult.result', async () => {
    const promptFn = vi.fn().mockResolvedValue({
      id: 'r1', status: 'finished', result: 'cursor reply',
    });
    const client = new CursorChatClient({
      mode: 'local',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      promptFn: promptFn as any,
    });
    const r = await client.chat(
      [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'how are you?' },
      ],
      { system: 'be polite' },
    );
    expect(r.content).toBe('cursor reply');
    expect(r.provider).toBe('cursor');
    const transcript = promptFn.mock.calls[0]?.[0] as string;
    expect(transcript).toContain('System:\nbe polite');
    expect(transcript).toContain('User:\nhello');
    expect(transcript).toContain('Assistant:\nhi');
    expect(transcript).toContain('User:\nhow are you?');
    // Trailing "Assistant:\n" cue so the LLM continues as the assistant.
    expect(transcript.trim().endsWith('Assistant:')).toBe(true);
  });

  it('attack: agent did not finish → throws with the status code visible', async () => {
    const client = new CursorChatClient({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      promptFn: (async () => ({ id: 'r', status: 'errored', result: 'rate limited' })) as any,
    });
    await expect(client.chat([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow(/status=errored.*rate limited/);
  });
});

describe('createLlmChatClient factory', () => {
  function cfg(overrides: Record<string, unknown>) {
    return HelmConfigSchema.parse(overrides);
  }

  it('anthropic.apiKey set → AnthropicChatClient (explicit user choice wins)', () => {
    const client = createLlmChatClient({
      config: cfg({ anthropic: { apiKey: 'sk-test' } }),
    });
    expect(client.provider).toBe('anthropic');
  });

  it('no anthropic key + cursor local mode → CursorChatClient (zero-config path)', () => {
    const client = createLlmChatClient({
      config: cfg({ cursor: { mode: 'local' } }),
    });
    expect(client.provider).toBe('cursor');
  });

  it('no anthropic + cursor cloud + cursor key → CursorChatClient', () => {
    const client = createLlmChatClient({
      config: cfg({ cursor: { mode: 'cloud', apiKey: 'curs-test' } }),
    });
    expect(client.provider).toBe('cursor');
  });

  it('attack: cursor cloud without a key + no anthropic + no env → throws', () => {
    const orig = process.env['CURSOR_API_KEY'];
    delete process.env['CURSOR_API_KEY'];
    try {
      expect(() => createLlmChatClient({
        config: cfg({ cursor: { mode: 'cloud' } }),
      })).toThrow(/anthropic\.apiKey|Cursor app/);
    } finally {
      if (orig !== undefined) process.env['CURSOR_API_KEY'] = orig;
    }
  });

  it('test override: factory dep replaces the auto-pick', () => {
    const stub = {
      provider: 'anthropic' as const,
      model: 'stub',
      chat: async () => ({ content: 'x', provider: 'anthropic' as const, model: 'stub' }),
    };
    const r = createLlmChatClient({
      config: cfg({}),
      factory: () => stub,
    });
    expect(r).toBe(stub);
  });

  it('honors anthropic model override from config', () => {
    const client = createLlmChatClient({
      config: cfg({ anthropic: { apiKey: 'sk', model: 'claude-haiku-4' } }),
    });
    expect(client.model).toBe('claude-haiku-4');
  });
});
