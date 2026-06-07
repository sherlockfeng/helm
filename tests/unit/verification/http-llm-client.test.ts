/**
 * Unit tests for the HTTP-backed CompletionClient (PR 5b.1).
 *
 *   - Sends a POST with the OpenAI chat-completions shape
 *   - Threads model.id + Authorization Bearer + system+user messages
 *   - Respects max_tokens clamp from the provider model
 *   - Returns text + estimated cost from usage when model.cost is set
 *   - 4xx/5xx → HttpLlmError stage='http' with the status
 *   - Non-JSON response → HttpLlmError stage='parse'
 *   - Empty choices → HttpLlmError stage='response'
 *   - Timeout → HttpLlmError stage='timeout'
 */

import { describe, expect, it } from 'vitest';
import { HttpLlmClient, HttpLlmError } from '../../../src/verification/http-llm-client.js';
import type { ResolvedProvider } from '../../../src/verification/provider-config.js';

function makeProvider(overrides: Partial<ResolvedProvider['model']> = {}): ResolvedProvider {
  return {
    id: 'fake',
    apiKey: 'sk-test',
    model: {
      id: 'gpt-4o-mini',
      api: 'openai-completions',
      provider: 'openai',
      baseUrl: 'https://api.example.com/v1',
      contextWindow: 128000,
      maxTokens: 2048,
      cost: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 },
      ...overrides,
    },
  };
}

interface Captured {
  url: string;
  init: RequestInit;
}

function makeFetch(
  result: { ok: boolean; status?: number; body: unknown },
  captured: Captured[],
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    captured.push({ url: String(url), init: init ?? {} });
    const status = result.status ?? (result.ok ? 200 : 500);
    return new Response(
      typeof result.body === 'string' ? result.body : JSON.stringify(result.body),
      { status, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
}

describe('HttpLlmClient.complete', () => {
  it('posts with chat-completions shape + Authorization Bearer', async () => {
    const captured: Captured[] = [];
    const client = new HttpLlmClient({
      fetchFn: makeFetch({
        ok: true,
        body: { choices: [{ message: { content: 'answer text' } }] },
      }, captured),
    });
    await client.complete({
      provider: makeProvider(),
      systemPrompt: 'You are a judge.',
      userPrompt: 'Evaluate this.',
    });
    expect(captured).toHaveLength(1);
    const c = captured[0]!;
    expect(c.url).toBe('https://api.example.com/v1/chat/completions');
    const headers = c.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer sk-test');
    const body = JSON.parse(c.init.body as string) as Record<string, unknown>;
    expect(body['model']).toBe('gpt-4o-mini');
    expect(body['messages']).toEqual([
      { role: 'system', content: 'You are a judge.' },
      { role: 'user', content: 'Evaluate this.' },
    ]);
  });

  it('omits the system message when no systemPrompt is provided', async () => {
    const captured: Captured[] = [];
    const client = new HttpLlmClient({
      fetchFn: makeFetch({
        ok: true,
        body: { choices: [{ message: { content: 'x' } }] },
      }, captured),
    });
    await client.complete({ provider: makeProvider(), userPrompt: 'q' });
    const body = JSON.parse(captured[0]!.init.body as string) as { messages: unknown[] };
    expect(body.messages).toEqual([{ role: 'user', content: 'q' }]);
  });

  it('clamps max_tokens to the model.maxTokens upper bound', async () => {
    const captured: Captured[] = [];
    const client = new HttpLlmClient({
      fetchFn: makeFetch({
        ok: true,
        body: { choices: [{ message: { content: 'x' } }] },
      }, captured),
    });
    await client.complete({
      provider: makeProvider({ maxTokens: 1024 }),
      userPrompt: 'q',
      maxOutputTokens: 99999, // way over the cap
    });
    const body = JSON.parse(captured[0]!.init.body as string) as { max_tokens: number };
    expect(body.max_tokens).toBe(1024);
  });

  it('estimates cost from usage tokens when model.cost is filled in', async () => {
    const client = new HttpLlmClient({
      fetchFn: makeFetch({
        ok: true,
        body: {
          choices: [{ message: { content: 'x' } }],
          usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
        },
      }, []),
    });
    const out = await client.complete({ provider: makeProvider(), userPrompt: 'q' });
    // model.cost.input=0.15, output=0.6 per 1M tokens → 1×0.15 + 1×0.6 = 0.75
    expect(out.costUsd).toBeCloseTo(0.75, 5);
  });

  it('returns costUsd undefined when model.cost is absent', async () => {
    const client = new HttpLlmClient({
      fetchFn: makeFetch({
        ok: true,
        body: {
          choices: [{ message: { content: 'x' } }],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        },
      }, []),
    });
    const out = await client.complete({
      provider: makeProvider({ cost: undefined }),
      userPrompt: 'q',
    });
    expect(out.costUsd).toBeUndefined();
  });

  it('4xx response → HttpLlmError stage=http', async () => {
    const client = new HttpLlmClient({
      fetchFn: makeFetch(
        { ok: false, status: 429, body: 'rate limited' },
        [],
      ),
    });
    try {
      await client.complete({ provider: makeProvider(), userPrompt: 'q' });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpLlmError);
      const e = err as HttpLlmError;
      expect(e.stage).toBe('http');
      expect(e.status).toBe(429);
      expect(e.message).toMatch(/HTTP 429/);
    }
  });

  it('non-JSON body → HttpLlmError stage=parse', async () => {
    const client = new HttpLlmClient({
      fetchFn: makeFetch({ ok: true, body: 'not json at all{{' }, []),
    });
    try {
      await client.complete({ provider: makeProvider(), userPrompt: 'q' });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpLlmError);
      expect((err as HttpLlmError).stage).toBe('parse');
    }
  });

  it('empty choices → HttpLlmError stage=response', async () => {
    const client = new HttpLlmClient({
      fetchFn: makeFetch({ ok: true, body: { choices: [] } }, []),
    });
    try {
      await client.complete({ provider: makeProvider(), userPrompt: 'q' });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpLlmError);
      expect((err as HttpLlmError).stage).toBe('response');
    }
  });

  it('appended /chat/completions when baseUrl already ends with it', async () => {
    const captured: Captured[] = [];
    const client = new HttpLlmClient({
      fetchFn: makeFetch(
        { ok: true, body: { choices: [{ message: { content: 'x' } }] } },
        captured,
      ),
    });
    await client.complete({
      provider: makeProvider({ baseUrl: 'https://api.example.com/v1/chat/completions' }),
      userPrompt: 'q',
    });
    expect(captured[0]!.url).toBe('https://api.example.com/v1/chat/completions');
  });
});
