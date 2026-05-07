/**
 * E2e attacks for knowledge-aggregator-cap.
 *
 * Verifies the aggregator stays bounded under hostile providers — single
 * provider exceeding cap, providers throwing, and the cap not creeping when
 * registry ordering shifts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootE2e, runHookViaBridge, type E2eHarness } from '../_helpers/setup.js';
import { SESSION_CONTEXT_MAX_BYTES } from '../../../src/constants.js';
import type { KnowledgeProvider } from '../../../src/knowledge/types.js';

let harness: E2eHarness;

beforeEach(async () => { harness = await bootE2e(); });
afterEach(async () => { await harness.shutdown(); });

function makeProvider(id: string, displayName: string, body: string | (() => Promise<string | null>)): KnowledgeProvider {
  return {
    id,
    displayName,
    canHandle: () => true,
    getSessionContext: typeof body === 'string' ? (async () => body) : body,
    search: async () => [],
    healthcheck: async () => ({ ok: true }),
  };
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

describe('knowledge-aggregator-cap attacks', () => {
  it('attack: single provider returning > cap is dropped — response empty, not truncated mid-record', async () => {
    const huge = 'X'.repeat(SESSION_CONTEXT_MAX_BYTES + 1024);
    harness.app.knowledge.register(makeProvider('p-huge', 'Huge', huge));

    const r = await runHookViaBridge(harness, {
      event: 'sessionStart',
      payload: { session_id: 'sess_huge', cwd: '/proj' },
    }) as Record<string, unknown>;

    // Aggregator never half-includes a provider's body — either it fits
    // whole, or it's skipped. The response is therefore either omitted
    // entirely or includes only providers that fit; never a chopped block.
    if (r['additional_context'] !== undefined) {
      expect(r['additional_context']).not.toContain('## Huge');
      expect(byteLength(r['additional_context'] as string)).toBeLessThanOrEqual(SESSION_CONTEXT_MAX_BYTES);
    }
  });

  it('attack: provider throws → other providers still render, no crash', async () => {
    harness.app.knowledge.register(makeProvider(
      'p-throws', 'Throws',
      async () => { throw new Error('upstream went sideways'); },
    ));
    harness.app.knowledge.register(makeProvider('p-ok', 'OK', 'survived'));

    const r = await runHookViaBridge(harness, {
      event: 'sessionStart',
      payload: { session_id: 'sess_err', cwd: '/proj' },
    }) as { additional_context?: string };

    expect(r.additional_context).toBeDefined();
    expect(r.additional_context).toContain('## OK');
    expect(r.additional_context).toContain('survived');
    expect(r.additional_context).not.toContain('## Throws');
  });

  it('attack: cap is honoured when oversize provider registers first — aggregator skips it, then fits the next', async () => {
    // Register order: oversize first, fitter second. Aggregator must skip
    // the oversize one and still emit the fitter one's block.
    const oversize = 'O'.repeat(SESSION_CONTEXT_MAX_BYTES + 4096);
    const fitting = 'F'.repeat(2 * 1024);
    harness.app.knowledge.register(makeProvider('p-oversize', 'Oversize', oversize));
    harness.app.knowledge.register(makeProvider('p-fits', 'Fits Later', fitting));

    const r = await runHookViaBridge(harness, {
      event: 'sessionStart',
      payload: { session_id: 'sess_swap', cwd: '/proj' },
    }) as { additional_context?: string };

    expect(r.additional_context).toBeDefined();
    expect(r.additional_context).not.toContain('## Oversize');
    expect(r.additional_context).toContain('## Fits Later');
    expect(byteLength(r.additional_context!)).toBeLessThanOrEqual(SESSION_CONTEXT_MAX_BYTES);
  });

  it('attack: provider returning null is a no-op (treated as "no context to inject")', async () => {
    harness.app.knowledge.register(makeProvider('p-null', 'Nullish', async () => null));
    harness.app.knowledge.register(makeProvider('p-real', 'Real', 'real-context'));

    const r = await runHookViaBridge(harness, {
      event: 'sessionStart',
      payload: { session_id: 'sess_null', cwd: '/proj' },
    }) as { additional_context?: string };

    expect(r.additional_context).toContain('## Real');
    expect(r.additional_context).not.toContain('## Nullish');
  });
});
