/**
 * E2e — knowledge aggregator byte-cap (Phase 30 / C2).
 *
 * §11.5.5 calls out that `additional_context` is capped at
 * SESSION_CONTEXT_MAX_BYTES (8 KiB) so a misconfigured / chatty
 * KnowledgeProvider can't blow Cursor's prompt budget. This spec drives the
 * real session_start path with two providers:
 *   - one returns ~6 KB
 *   - the other returns ~10 KB
 * and asserts the aggregator includes the first, drops the second, marks it
 * `truncated` in the per-provider diagnostics, and the response stays under
 * cap.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootE2e, runHookViaBridge, type E2eHarness } from '../_helpers/setup.js';
import { SESSION_CONTEXT_MAX_BYTES } from '../../../src/constants.js';
import type { KnowledgeProvider } from '../../../src/knowledge/types.js';

let harness: E2eHarness;

beforeEach(async () => { harness = await bootE2e(); });
afterEach(async () => { await harness.shutdown(); });

function makeProvider(id: string, displayName: string, body: string): KnowledgeProvider {
  return {
    id,
    displayName,
    canHandle: () => true,
    getSessionContext: async () => body,
    search: async () => [],
    healthcheck: async () => ({ ok: true }),
  };
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

describe('knowledge-aggregator-cap happy', () => {
  it('caps additional_context at SESSION_CONTEXT_MAX_BYTES — first provider in, second truncated', async () => {
    const fitting = 'A'.repeat(6 * 1024);
    const oversize = 'B'.repeat(10 * 1024);

    harness.app.knowledge.register(makeProvider('p-fits', 'Provider Fits', fitting));
    harness.app.knowledge.register(makeProvider('p-too-big', 'Provider Too Big', oversize));

    const r = await runHookViaBridge(harness, {
      event: 'sessionStart',
      payload: { session_id: 'sess_cap', cwd: '/proj' },
    }) as { additional_context?: string };

    expect(r.additional_context).toBeDefined();
    const ctx = r.additional_context!;
    // First provider in.
    expect(ctx).toContain('## Provider Fits');
    expect(ctx).toContain(fitting.slice(0, 100));
    // Second provider's body NOT in — exceeded the remaining budget.
    expect(ctx).not.toContain('## Provider Too Big');
    expect(ctx).not.toContain(oversize.slice(0, 100));
    // Total under cap.
    expect(byteLength(ctx)).toBeLessThanOrEqual(SESSION_CONTEXT_MAX_BYTES);
  });

  it('a single provider under cap is included verbatim', async () => {
    const small = 'small body';
    harness.app.knowledge.register(makeProvider('p-small', 'Small', small));

    const r = await runHookViaBridge(harness, {
      event: 'sessionStart',
      payload: { session_id: 'sess_small', cwd: '/proj' },
    }) as { additional_context?: string };

    expect(r.additional_context).toContain('## Small');
    expect(r.additional_context).toContain(small);
    expect(byteLength(r.additional_context!)).toBeLessThanOrEqual(SESSION_CONTEXT_MAX_BYTES);
  });

  it('all providers fit → all included in registry order, separator preserved', async () => {
    harness.app.knowledge.register(makeProvider('p-1', 'Alpha', 'ALPHA-CTX'));
    harness.app.knowledge.register(makeProvider('p-2', 'Bravo', 'BRAVO-CTX'));
    harness.app.knowledge.register(makeProvider('p-3', 'Charlie', 'CHARLIE-CTX'));

    const r = await runHookViaBridge(harness, {
      event: 'sessionStart',
      payload: { session_id: 'sess_all', cwd: '/proj' },
    }) as { additional_context: string };

    const idxAlpha = r.additional_context.indexOf('## Alpha');
    const idxBravo = r.additional_context.indexOf('## Bravo');
    const idxCharlie = r.additional_context.indexOf('## Charlie');
    expect(idxAlpha).toBeGreaterThanOrEqual(0);
    expect(idxAlpha).toBeLessThan(idxBravo);
    expect(idxBravo).toBeLessThan(idxCharlie);
    // Blank-line separator between blocks per §11.5.5.
    expect(r.additional_context).toContain('ALPHA-CTX\n\n## Bravo');
  });
});
