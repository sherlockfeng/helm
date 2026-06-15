/**
 * Unit tests for the engine-backed CompletionClient (Run-now fallback).
 *
 *   - complete() returns the fake LlmClient's text verbatim
 *   - systemPrompt + userPrompt are concatenated with a blank line
 *   - no systemPrompt → just the userPrompt
 *   - model + maxTokens (default 1024) are threaded to generate()
 *   - the getter is read on each call (picks up the current engine)
 */

import { describe, expect, it } from 'vitest';
import { makeEngineCompletionClient } from '../../../src/verification/engine-llm-client.js';
import type { LlmClient } from '../../../src/summarizer/campaign.js';
import type { ResolvedProvider } from '../../../src/verification/provider-config.js';

const DUMMY_PROVIDER: ResolvedProvider = {
  id: 'engine',
  model: {
    id: 'auto', api: 'engine', provider: 'engine', baseUrl: 'n/a',
    contextWindow: 0, maxTokens: 1024,
  },
  apiKey: 'n/a',
};

function fakeLlm(
  onCall: (prompt: string, opts: { model: string; maxTokens: number }) => void,
  reply = 'fake answer',
): LlmClient {
  return {
    async generate(prompt, opts) {
      onCall(prompt, opts);
      return reply;
    },
  };
}

describe('makeEngineCompletionClient', () => {
  it('returns the LlmClient text and concatenates system + user prompts', async () => {
    let seenPrompt = '';
    let seenOpts: { model: string; maxTokens: number } | undefined;
    const client = makeEngineCompletionClient(
      () => fakeLlm((p, o) => { seenPrompt = p; seenOpts = o; }, 'hello world'),
      'claude-x',
    );

    const out = await client.complete({
      provider: DUMMY_PROVIDER,
      systemPrompt: 'SYS',
      userPrompt: 'USER',
      maxOutputTokens: 256,
    });

    expect(out.text).toBe('hello world');
    expect(seenPrompt).toBe('SYS\n\nUSER');
    expect(seenOpts).toEqual({ model: 'claude-x', maxTokens: 256 });
  });

  it('uses just the user prompt when no system prompt is given', async () => {
    let seenPrompt = '';
    const client = makeEngineCompletionClient(
      () => fakeLlm((p) => { seenPrompt = p; }),
      'auto',
    );

    await client.complete({ provider: DUMMY_PROVIDER, userPrompt: 'only user' });

    expect(seenPrompt).toBe('only user');
  });

  it('defaults maxTokens to 1024 when maxOutputTokens is absent', async () => {
    let seenMax = -1;
    const client = makeEngineCompletionClient(
      () => fakeLlm((_p, o) => { seenMax = o.maxTokens; }),
      'auto',
    );

    await client.complete({ provider: DUMMY_PROVIDER, userPrompt: 'q' });

    expect(seenMax).toBe(1024);
  });

  it('reads the getter on each call so a swapped engine takes effect', async () => {
    let current: LlmClient = fakeLlm(() => {}, 'first');
    const client = makeEngineCompletionClient(() => current, 'auto');

    const a = await client.complete({ provider: DUMMY_PROVIDER, userPrompt: 'q' });
    expect(a.text).toBe('first');

    current = fakeLlm(() => {}, 'second');
    const b = await client.complete({ provider: DUMMY_PROVIDER, userPrompt: 'q' });
    expect(b.text).toBe('second');
  });
});
