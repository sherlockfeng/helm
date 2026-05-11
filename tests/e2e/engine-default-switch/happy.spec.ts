/**
 * E2e — switching default engine routes downstream features to the new
 * adapter (Phase 68).
 *
 * Strategy: stand up the MCP server with `runReviewOverride` capturing
 * which engine's review() got called. We can't actually spawn claude /
 * cursor-agent in CI, so this drives the EngineRouter contract end-to-end
 * via the public API.
 *
 * We assert: (a) router resolves the current default's adapter, (b)
 * switching default flips which adapter is hit next call.
 */

import { describe, expect, it } from 'vitest';
import { EngineRouter } from '../../../src/engine/router.js';
import type { EngineAdapter, EngineId } from '../../../src/engine/types.js';

function makeStubAdapter(id: EngineId, captureLog: string[]): EngineAdapter {
  return {
    id,
    summarize: { generate: async () => `${id}: hello` },
    review: async () => {
      captureLog.push(`review:${id}`);
      return `${id}: review-ok`;
    },
    runConversation: async () => {
      captureLog.push(`conv:${id}`);
      return { text: `${id}: conv-ok`, stderr: '', sessionId: `${id}-sid` };
    },
  };
}

describe('default engine switch (Phase 68)', () => {
  it('switching default at runtime flips which adapter runs the next request', async () => {
    let activeDefault: EngineId = 'claude';
    const captureLog: string[] = [];
    const router = new EngineRouter({
      adapters: {
        claude: makeStubAdapter('claude', captureLog),
        cursor: makeStubAdapter('cursor', captureLog),
      },
      defaultGetter: () => activeDefault,
    });

    // 1. Default is claude — review hits claude.
    await router.current().review({
      userPayload: 'p', systemPrompt: 's', cwd: '/tmp',
    });
    expect(captureLog).toEqual(['review:claude']);

    // 2. User flips Settings; next call hits cursor.
    activeDefault = 'cursor';
    await router.current().review({
      userPayload: 'p', systemPrompt: 's', cwd: '/tmp',
    });
    expect(captureLog).toEqual(['review:claude', 'review:cursor']);

    // 3. Flip back; runConversation now goes to claude.
    activeDefault = 'claude';
    await router.current().runConversation({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(captureLog).toEqual(['review:claude', 'review:cursor', 'conv:claude']);
  });

  it('summarize / review / runConversation all dispatch through the SAME adapter for a given default', async () => {
    const captureLog: string[] = [];
    const router = new EngineRouter({
      adapters: {
        claude: makeStubAdapter('claude', captureLog),
        cursor: makeStubAdapter('cursor', captureLog),
      },
      defaultGetter: () => 'cursor',
    });

    const a = router.current();
    const b = router.current();
    const c = router.current();
    expect(a.id).toBe('cursor');
    expect(b.id).toBe('cursor');
    expect(c.id).toBe('cursor');

    await a.summarize.generate('x', { model: 'auto', maxTokens: 10 });
    await b.review({ userPayload: 'p', systemPrompt: 's', cwd: '/tmp' });
    await c.runConversation({ messages: [{ role: 'user', content: 'hi' }] });
    expect(captureLog).toEqual(['review:cursor', 'conv:cursor']);
    // summarize doesn't push into captureLog (the stub adapter doesn't
    // capture it because it's the trivial path), but the .id checks above
    // already prove all three dispatched through the cursor adapter.
  });
});
