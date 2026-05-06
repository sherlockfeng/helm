/**
 * CursorLlmClient tests. We pass `promptFn` so the real Cursor SDK never
 * spawns an agent — keeps the test hermetic and fast.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  CursorLlmClient,
  resolveCursorApiKey,
  createCursorLlmClient,
} from '../../../src/summarizer/cursor-client.js';

interface FakeRunResult {
  status: string;
  result?: string;
}

function fakePrompt(result: FakeRunResult): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    id: 'run_test',
    ...result,
  });
}

describe('resolveCursorApiKey', () => {
  it('options.apiKey wins over env', () => {
    expect(resolveCursorApiKey({ apiKey: 'opt' }, { CURSOR_API_KEY: 'env' })).toBe('opt');
  });

  it('falls back to CURSOR_API_KEY env', () => {
    expect(resolveCursorApiKey({}, { CURSOR_API_KEY: 'env' })).toBe('env');
  });

  it('attack: whitespace-only ignored', () => {
    expect(resolveCursorApiKey({ apiKey: '   ' }, { CURSOR_API_KEY: '   ' }))
      .toBeUndefined();
  });

  it('returns undefined when neither set', () => {
    expect(resolveCursorApiKey({}, {})).toBeUndefined();
  });
});

describe('CursorLlmClient construction', () => {
  it('local mode does not require an API key', () => {
    expect(() => new CursorLlmClient({ mode: 'local' })).not.toThrow();
  });

  it('local mode is the default', () => {
    expect(() => new CursorLlmClient({})).not.toThrow();
  });

  it('attack: cloud mode without key throws', () => {
    const original = process.env['CURSOR_API_KEY'];
    delete process.env['CURSOR_API_KEY'];
    try {
      expect(() => new CursorLlmClient({ mode: 'cloud' }))
        .toThrow(/cloud mode requires an API key/);
    } finally {
      if (original !== undefined) process.env['CURSOR_API_KEY'] = original;
    }
  });

  it('cloud mode accepts options.apiKey', () => {
    expect(() => new CursorLlmClient({ mode: 'cloud', apiKey: 'sk-cur-x' })).not.toThrow();
  });

  it('cloud mode accepts CURSOR_API_KEY env', () => {
    const original = process.env['CURSOR_API_KEY'];
    process.env['CURSOR_API_KEY'] = 'env-key';
    try {
      expect(() => new CursorLlmClient({ mode: 'cloud' })).not.toThrow();
    } finally {
      if (original !== undefined) process.env['CURSOR_API_KEY'] = original;
      else delete process.env['CURSOR_API_KEY'];
    }
  });
});

describe('CursorLlmClient.generate', () => {
  it('returns the agent result on success', async () => {
    const promptFn = fakePrompt({ status: 'finished', result: 'the answer' });
    const llm = new CursorLlmClient({ promptFn: promptFn as never });
    const out = await llm.generate('say hi', { model: 'm', maxTokens: 100 });
    expect(out).toBe('the answer');
  });

  it('forwards the prompt to Agent.prompt', async () => {
    const promptFn = fakePrompt({ status: 'finished', result: 'ok' });
    const llm = new CursorLlmClient({ promptFn: promptFn as never });
    await llm.generate('summarize this', { model: 'm', maxTokens: 100 });
    expect(promptFn).toHaveBeenCalledOnce();
    expect(promptFn.mock.calls[0]![0]).toBe('summarize this');
  });

  it('configures local mode with cwd', async () => {
    const promptFn = fakePrompt({ status: 'finished', result: 'ok' });
    const llm = new CursorLlmClient({
      mode: 'local',
      cwd: '/tmp/proj',
      promptFn: promptFn as never,
    });
    await llm.generate('p', { model: 'm', maxTokens: 1 });
    const opts = promptFn.mock.calls[0]![1] as { local?: { cwd: string } };
    expect(opts.local?.cwd).toBe('/tmp/proj');
  });

  it('configures cloud mode with apiKey', async () => {
    const promptFn = fakePrompt({ status: 'finished', result: 'ok' });
    const llm = new CursorLlmClient({
      mode: 'cloud',
      apiKey: 'sk-cur-test',
      promptFn: promptFn as never,
    });
    await llm.generate('p', { model: 'm', maxTokens: 1 });
    const opts = promptFn.mock.calls[0]![1] as { apiKey?: string; local?: unknown };
    expect(opts.apiKey).toBe('sk-cur-test');
    expect(opts.local).toBeUndefined();
  });

  it('uses configured modelId', async () => {
    const promptFn = fakePrompt({ status: 'finished', result: 'ok' });
    const llm = new CursorLlmClient({ modelId: 'gpt-5', promptFn: promptFn as never });
    await llm.generate('p', { model: 'caller-ignored', maxTokens: 1 });
    const opts = promptFn.mock.calls[0]![1] as { model: { id: string } };
    expect(opts.model.id).toBe('gpt-5');
  });

  it("default model id is 'auto'", async () => {
    const promptFn = fakePrompt({ status: 'finished', result: 'ok' });
    const llm = new CursorLlmClient({ promptFn: promptFn as never });
    await llm.generate('p', { model: 'm', maxTokens: 1 });
    const opts = promptFn.mock.calls[0]![1] as { model: { id: string } };
    expect(opts.model.id).toBe('auto');
  });

  it('attack: non-finished status throws with status in message', async () => {
    const promptFn = fakePrompt({ status: 'cancelled', result: 'partial' });
    const llm = new CursorLlmClient({ promptFn: promptFn as never });
    await expect(llm.generate('p', { model: 'm', maxTokens: 1 }))
      .rejects.toThrow(/status=cancelled/);
  });

  it('attack: empty result throws', async () => {
    const promptFn = fakePrompt({ status: 'finished', result: undefined });
    const llm = new CursorLlmClient({ promptFn: promptFn as never });
    await expect(llm.generate('p', { model: 'm', maxTokens: 1 }))
      .rejects.toThrow(/empty result/);
  });

  it('attack: SDK error propagates', async () => {
    const promptFn = vi.fn().mockRejectedValue(new Error('cursor not authenticated'));
    const llm = new CursorLlmClient({ promptFn: promptFn as never });
    await expect(llm.generate('p', { model: 'm', maxTokens: 1 }))
      .rejects.toThrow(/not authenticated/);
  });

  it('attack: "error" status throws', async () => {
    const promptFn = fakePrompt({ status: 'error', result: 'rate limit' });
    const llm = new CursorLlmClient({ promptFn: promptFn as never });
    await expect(llm.generate('p', { model: 'm', maxTokens: 1 }))
      .rejects.toThrow(/status=error/);
  });
});

describe('createCursorLlmClient', () => {
  it('always returns a client (local mode is keyless)', () => {
    expect(createCursorLlmClient()).toBeInstanceOf(CursorLlmClient);
  });
});
