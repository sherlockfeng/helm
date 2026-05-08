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
    const create = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
    const client = new AnthropicChatClient({
      apiKey: 'sk', model: 'default-model',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: { messages: { create } } as any,
    });
    await client.chat([{ role: 'user', content: 'q' }], { model: 'override-model' });
    expect(create.mock.calls[0]?.[0].model).toBe('override-model');
  });
});

describe('AnthropicChatClient — tool-use loop (Phase 58)', () => {
  function makeTool(name: string, run: (input: unknown) => Promise<{ content: string }>) {
    return {
      name,
      description: `${name} description`,
      inputSchema: {
        type: 'object' as const,
        properties: { x: { type: 'string' } },
        required: ['x'],
      },
      run,
    };
  }

  it('happy: LLM emits tool_use → tool runs → result fed back → LLM emits final text', async () => {
    const toolRun = vi.fn().mockResolvedValue({ content: 'doc body markdown' });
    const tool = makeTool('read_lark_doc', toolRun);

    const create = vi.fn()
      // First call: LLM decides to use the tool.
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'reading the doc...' },
          { type: 'tool_use', id: 'tu_1', name: 'read_lark_doc', input: { x: 'https://x.com' } },
        ],
      })
      // Second call: LLM has the tool_result, finishes with text.
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'based on the doc, ...' }],
      });

    const client = new AnthropicChatClient({
      apiKey: 'sk',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: { messages: { create } } as any,
    });
    const r = await client.chat(
      [{ role: 'user', content: 'read https://x.com' }],
      { tools: [tool] },
    );

    expect(r.content).toBe('based on the doc, ...');
    expect(toolRun).toHaveBeenCalledWith({ x: 'https://x.com' });
    // toolCalls surfaced for the renderer.
    expect(r.toolCalls).toEqual([
      expect.objectContaining({ name: 'read_lark_doc', input: { x: 'https://x.com' }, resultPreview: 'doc body markdown' }),
    ]);
    // Tool definitions were forwarded on the first call.
    expect(create.mock.calls[0]?.[0].tools).toEqual([
      expect.objectContaining({ name: 'read_lark_doc', input_schema: tool.inputSchema }),
    ]);
    // Second call carried the tool_use turn + tool_result so the LLM has context.
    const secondMessages = create.mock.calls[1]?.[0].messages as unknown[];
    expect(secondMessages).toHaveLength(3); // user, assistant(tool_use), user(tool_result)
  });

  it('attack: tool throws → captured as tool_result.is_error=true; LLM still gets a final answer', async () => {
    const tool = makeTool('flaky', async () => { throw new Error('rate limited'); });
    const create = vi.fn()
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'flaky', input: { x: 'a' } }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'tool failed; here is what I have anyway.' }],
      });
    const client = new AnthropicChatClient({
      apiKey: 'sk',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: { messages: { create } } as any,
    });
    const r = await client.chat([{ role: 'user', content: 'go' }], { tools: [tool] });
    expect(r.content).toContain('tool failed');
    expect(r.toolCalls?.[0]).toMatchObject({ name: 'flaky', error: true, resultPreview: 'rate limited' });
    // tool_result block in the second messages call carries is_error: true.
    const secondMessages = create.mock.calls[1]?.[0].messages as Array<{ content: unknown }>;
    const lastBlock = (secondMessages[secondMessages.length - 1]!.content as Array<{ is_error?: boolean }>)[0];
    expect(lastBlock.is_error).toBe(true);
  });

  it('attack: LLM calls an unregistered tool → reported back as error; LLM continues', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'ghost_tool', input: {} }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'sorry, that tool isn\'t available.' }],
      });
    const client = new AnthropicChatClient({
      apiKey: 'sk',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: { messages: { create } } as any,
    });
    const r = await client.chat([{ role: 'user', content: 'q' }], { tools: [] });
    expect(r.content).toContain('isn\'t available');
    expect(r.toolCalls?.[0]).toMatchObject({ name: 'ghost_tool', error: true });
  });

  it('attack: tool-use ping-pong exceeds maxIterations → throws with diagnostic', async () => {
    const tool = makeTool('loop', async () => ({ content: 'more' }));
    // Always returns tool_use; never finishes.
    const create = vi.fn().mockResolvedValue({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu_x', name: 'loop', input: { x: 'a' } }],
    });
    const client = new AnthropicChatClient({
      apiKey: 'sk',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: { messages: { create } } as any,
    });
    await expect(
      client.chat([{ role: 'user', content: 'go' }], { tools: [tool], maxToolIterations: 3 }),
    ).rejects.toThrow(/exceeded 3 iterations/);
  });

  it('no tools passed → backwards compatible (single create call, no tools field)', async () => {
    const create = vi.fn().mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'plain text reply' }],
    });
    const client = new AnthropicChatClient({
      apiKey: 'sk',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: { messages: { create } } as any,
    });
    const r = await client.chat([{ role: 'user', content: 'q' }]);
    expect(r.content).toBe('plain text reply');
    expect(r.toolCalls).toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0].tools).toBeUndefined();
  });
});

describe('CursorChatClient — Phase 59 Agent.create + stream', () => {
  /**
   * Build a fake `Agent.create`-compatible factory whose `agent.send().stream()`
   * yields the supplied SDKMessage events. `wait()` returns finished+result.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function fakeAgentFactory(events: any[], finalResult = 'cursor reply'): any {
    const captured: { createOptions?: unknown; sentPrompt?: string } = {};
    const factory = vi.fn().mockImplementation(async (opts: unknown) => {
      captured.createOptions = opts;
      return {
        send: vi.fn().mockImplementation(async (prompt: string) => {
          captured.sentPrompt = prompt;
          return {
            stream: () => (async function* () { for (const e of events) yield e; })(),
            wait: async () => ({ id: 'r1', status: 'finished', result: finalResult }),
          };
        }),
        [Symbol.asyncDispose]: async () => undefined,
      };
    });
    return Object.assign(factory, { __captured: captured });
  }

  it('streams assistant text deltas and aggregates them as final content', async () => {
    const factory = fakeAgentFactory([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hello ' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'world' }] } },
    ]);
    const client = new CursorChatClient({
      mode: 'local',
      agentFactory: factory,
    });
    const r = await client.chat(
      [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'how are you?' },
      ],
      { system: 'be polite' },
    );
    expect(r.content).toBe('hello world');
    expect(r.provider).toBe('cursor');
    // Transcript is built from messages + system; verify format.
    expect(factory.__captured.sentPrompt).toContain('System:\nbe polite');
    expect(factory.__captured.sentPrompt).toContain('User:\nhello');
    expect(factory.__captured.sentPrompt).toContain('Assistant:\nhi');
    expect(factory.__captured.sentPrompt!.trim().endsWith('Assistant:')).toBe(true);
  });

  it('passes cwd to Agent.create local options for file access', async () => {
    const factory = fakeAgentFactory([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
    ]);
    const client = new CursorChatClient({
      mode: 'local',
      cwd: '/Users/me/projects/foo',
      agentFactory: factory,
    });
    await client.chat([{ role: 'user', content: 'q' }]);
    const opts = factory.__captured.createOptions as { local?: { cwd?: string } };
    expect(opts.local?.cwd).toBe('/Users/me/projects/foo');
  });

  it('passes helm MCP SSE URL into agent.mcpServers when supplied', async () => {
    const factory = fakeAgentFactory([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
    ]);
    const client = new CursorChatClient({
      mode: 'local',
      helmMcpUrl: 'http://127.0.0.1:17317/mcp/sse',
      agentFactory: factory,
    });
    await client.chat([{ role: 'user', content: 'q' }]);
    const opts = factory.__captured.createOptions as {
      mcpServers?: Record<string, { type?: string; url?: string }>;
    };
    expect(opts.mcpServers?.helm).toEqual({ type: 'sse', url: 'http://127.0.0.1:17317/mcp/sse' });
  });

  it('captures tool_use blocks and matching tool_call completed events into toolCalls[]', async () => {
    const factory = fakeAgentFactory([
      // Agent decides to call read_lark_doc.
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'reading docs… ' },
            { type: 'tool_use', id: 'tu_1', name: 'read_lark_doc', input: { url_or_token: 'https://x.com/wiki/abc' } },
          ],
        },
      },
      // Tool completes with a result.
      {
        type: 'tool_call',
        call_id: 'tu_1',
        name: 'read_lark_doc',
        args: { url_or_token: 'https://x.com/wiki/abc' },
        status: 'completed',
        result: '# heading\nbody',
      },
      // Agent's final reply after seeing the doc.
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'based on the doc, ...' }] },
      },
    ]);
    const client = new CursorChatClient({ mode: 'local', agentFactory: factory });
    const r = await client.chat([{ role: 'user', content: 'read https://x.com/wiki/abc' }]);
    expect(r.content).toBe('reading docs… based on the doc, ...');
    expect(r.toolCalls).toEqual([
      expect.objectContaining({
        name: 'read_lark_doc',
        input: { url_or_token: 'https://x.com/wiki/abc' },
        resultPreview: '# heading\nbody',
      }),
    ]);
  });

  it('flags tool_call with status=failed as error in toolCalls[]', async () => {
    const factory = fakeAgentFactory([
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tu_1', name: 'flaky', input: { x: 'a' } }],
        },
      },
      {
        type: 'tool_call', call_id: 'tu_1', name: 'flaky',
        args: { x: 'a' }, status: 'failed', result: 'rate limited',
      },
    ]);
    const client = new CursorChatClient({ mode: 'local', agentFactory: factory });
    const r = await client.chat([{ role: 'user', content: 'go' }]);
    expect(r.toolCalls?.[0]).toMatchObject({ name: 'flaky', error: true, resultPreview: 'rate limited' });
  });

  it('attack: run.wait() returns non-finished status → throws diagnostic', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const factory = vi.fn().mockResolvedValue({
      send: async () => ({
        stream: async function* () { /* no events */ },
        wait: async () => ({ id: 'r', status: 'errored', result: 'agent crashed' }),
      }),
      [Symbol.asyncDispose]: async () => undefined,
    });
    const client = new CursorChatClient({
      mode: 'local',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agentFactory: factory as any,
    });
    await expect(client.chat([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow(/status=errored.*agent crashed/);
  });

  it('disposes the agent (Symbol.asyncDispose) even when the run throws mid-stream', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const factory = vi.fn().mockResolvedValue({
      send: async () => ({
        stream: async function* () { throw new Error('stream boom'); },
        wait: async () => ({ status: 'finished', result: '' }),
      }),
      [Symbol.asyncDispose]: dispose,
    });
    const client = new CursorChatClient({
      mode: 'local',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agentFactory: factory as any,
    });
    await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/stream boom/);
    expect(dispose).toHaveBeenCalled();
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
