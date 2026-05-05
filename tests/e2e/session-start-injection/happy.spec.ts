/**
 * E2e — sessionStart with KnowledgeProvider injection.
 *
 * Drives the real Cursor sessionStart hook through bridge → orchestrator →
 * aggregateSessionContext → all registered KnowledgeProviders. Verifies the
 * orchestrator merges provider output, prefixes each block with the provider's
 * displayName, and writes it to the host's `additional_context` response field.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootE2e, runHookViaBridge, type E2eHarness } from '../_helpers/setup.js';

let harness: E2eHarness;

beforeEach(async () => {
  harness = await bootE2e();
});

afterEach(async () => { await harness.shutdown(); });

describe('session-start-injection happy', () => {
  it('returns empty when only LocalRolesProvider is registered (no resolver wired)', async () => {
    const r = await runHookViaBridge(harness, {
      event: 'sessionStart',
      payload: { session_id: 'sess_a', cwd: '/proj' },
    }) as Record<string, unknown>;
    // LocalRolesProvider's getSessionContext returns null without a roleResolver,
    // so the response carries no additional_context.
    expect(r['additional_context']).toBeUndefined();
  });

  it('aggregates a fake provider into the response markdown', async () => {
    harness.app.knowledge.register({
      id: 'fake-1',
      displayName: 'Fake Provider',
      canHandle: () => true,
      getSessionContext: async () => 'this is the fake context',
      search: async () => [],
      healthcheck: async () => ({ ok: true }),
    });

    const r = await runHookViaBridge(harness, {
      event: 'sessionStart',
      payload: { session_id: 'sess_b', cwd: '/proj' },
    }) as { additional_context?: string };

    expect(r.additional_context).toContain('## Fake Provider');
    expect(r.additional_context).toContain('this is the fake context');
  });

  it('preserves registry order across multiple providers and uses blank-line separator', async () => {
    harness.app.knowledge.register({
      id: 'p-alpha', displayName: 'Alpha',
      canHandle: () => true,
      getSessionContext: async () => 'ALPHA-CTX',
      search: async () => [],
      healthcheck: async () => ({ ok: true }),
    });
    harness.app.knowledge.register({
      id: 'p-beta', displayName: 'Beta',
      canHandle: () => true,
      getSessionContext: async () => 'BETA-CTX',
      search: async () => [],
      healthcheck: async () => ({ ok: true }),
    });

    const r = await runHookViaBridge(harness, {
      event: 'sessionStart',
      payload: { session_id: 'sess_c', cwd: '/proj' },
    }) as { additional_context: string };

    const ctx = r.additional_context;
    expect(ctx.indexOf('## Alpha')).toBeLessThan(ctx.indexOf('## Beta'));
    expect(ctx).toContain('ALPHA-CTX\n\n## Beta');
  });

  it('upserts a host_session row keyed by sessionId + cwd', async () => {
    await runHookViaBridge(harness, {
      event: 'sessionStart',
      payload: { session_id: 'sess_d', cwd: '/some/proj', composer_mode: 'agent' },
    });

    const row = harness.db.prepare(
      `SELECT id, cwd, composer_mode FROM host_sessions WHERE id = ?`,
    ).get('sess_d') as { id: string; cwd: string; composer_mode: string } | undefined;

    expect(row).toMatchObject({ id: 'sess_d', cwd: '/some/proj', composer_mode: 'agent' });
  });

  it('emits session.started SSE event after the hook completes', async () => {
    const seen: string[] = [];
    harness.app.events.on((e) => {
      if (e.type === 'session.started') seen.push(e.session.id);
    });

    await runHookViaBridge(harness, {
      event: 'sessionStart',
      payload: { session_id: 'sess_e', cwd: '/proj' },
    });

    expect(seen).toEqual(['sess_e']);
  });
});
