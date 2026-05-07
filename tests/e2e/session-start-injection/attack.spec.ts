/**
 * E2e attacks — sessionStart context injection failure modes.
 *
 * The aggregator must isolate provider failures so a single broken
 * KnowledgeProvider can't kill the chat or block the rest from contributing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootE2e, runHookViaBridge, type E2eHarness } from '../_helpers/setup.js';

let harness: E2eHarness;

beforeEach(async () => {
  harness = await bootE2e();
});

afterEach(async () => { await harness.shutdown(); });

describe('session-start-injection attack', () => {
  it('a throwing provider does not block other providers', async () => {
    harness.app.knowledge.register({
      id: 'boom', displayName: 'Boom',
      canHandle: () => true,
      getSessionContext: async () => { throw new Error('endpoint dead'); },
      search: async () => [],
      healthcheck: async () => ({ ok: true }),
    });
    harness.app.knowledge.register({
      id: 'survivor', displayName: 'Survivor',
      canHandle: () => true,
      getSessionContext: async () => 'still here',
      search: async () => [],
      healthcheck: async () => ({ ok: true }),
    });

    const r = await runHookViaBridge(harness, {
      event: 'sessionStart',
      payload: { session_id: 'sess_a', cwd: '/proj' },
    }) as { additional_context?: string };

    expect(r.additional_context).toContain('## Survivor');
    expect(r.additional_context).toContain('still here');
    expect(r.additional_context).not.toContain('## Boom');
  });

  it('a hanging provider is timed out and the rest of the response is delivered', async () => {
    harness.app.knowledge.register({
      id: 'slow', displayName: 'Slow',
      canHandle: () => true,
      getSessionContext: () => new Promise(() => { /* never */ }),
      search: async () => [],
      healthcheck: async () => ({ ok: true }),
    });
    harness.app.knowledge.register({
      id: 'fast', displayName: 'Fast',
      canHandle: () => true,
      getSessionContext: async () => 'quick',
      search: async () => [],
      healthcheck: async () => ({ ok: true }),
    });

    const start = Date.now();
    const r = await runHookViaBridge(harness, {
      event: 'sessionStart',
      payload: { session_id: 'sess_b', cwd: '/proj' },
    }) as { additional_context?: string };

    expect(r.additional_context).toContain('Fast');
    expect(r.additional_context).not.toContain('Slow');
    // Phase 53: e2e harness sets `knowledgeGetContextMs: 200` so the
    // aggregator times out the hanging provider in ~200ms instead of the
    // 5s production default. Generous bound to absorb CI jitter while
    // still failing if the timeout regresses to the old 5s.
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('canHandle false → provider skipped, no markdown contributed', async () => {
    harness.app.knowledge.register({
      id: 'skipper', displayName: 'Skipper',
      canHandle: () => false,
      getSessionContext: async () => 'should never see this',
      search: async () => [],
      healthcheck: async () => ({ ok: true }),
    });
    harness.app.knowledge.register({
      id: 'p-handle', displayName: 'Handler',
      canHandle: () => true,
      getSessionContext: async () => 'real',
      search: async () => [],
      healthcheck: async () => ({ ok: true }),
    });

    const r = await runHookViaBridge(harness, {
      event: 'sessionStart',
      payload: { session_id: 'sess_c', cwd: '/proj' },
    }) as { additional_context?: string };

    expect(r.additional_context).not.toContain('## Skipper');
    expect(r.additional_context).toContain('## Handler');
  });

  it('sessionStart without cwd skips the aggregator entirely (returns empty)', async () => {
    // Add a provider that would otherwise emit context
    harness.app.knowledge.register({
      id: 'noisy', displayName: 'Noisy',
      canHandle: () => true,
      getSessionContext: async () => 'should not appear',
      search: async () => [],
      healthcheck: async () => ({ ok: true }),
    });

    const r = await runHookViaBridge(harness, {
      event: 'sessionStart',
      payload: { session_id: 'sess_d' /* no cwd */ },
    }) as Record<string, unknown>;

    expect(r['additional_context']).toBeUndefined();
  });
});
