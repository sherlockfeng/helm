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
import { setHostSessionRole, upsertHostSession } from '../../../src/storage/repos/host-sessions.js';
import { insertChunk, upsertRole } from '../../../src/storage/repos/roles.js';

let harness: E2eHarness;

beforeEach(async () => {
  harness = await bootE2e();
});

afterEach(async () => { await harness.shutdown(); });

describe('session-start-injection happy', () => {
  it('returns just the Helm tool guide when chat is unbound (Phase 71)', async () => {
    // Phase 71: sessionStart ALWAYS injects the Helm tool guide so the
    // Cursor agent knows helm is a desktop app + MCP namespace, even when
    // no roles / no Harness task / no knowledge providers contributed.
    // Pre-Phase-71 this test asserted `additional_context` was undefined —
    // now it carries just the guide.
    const r = await runHookViaBridge(harness, {
      event: 'sessionStart',
      payload: { session_id: 'sess_a', cwd: '/proj' },
    }) as { additional_context?: string };
    expect(r.additional_context).toBeDefined();
    expect(r.additional_context).toContain('helm is a desktop GUI');
    expect(r.additional_context).toContain('list_roles');
    expect(r.additional_context).toContain('harness_create_task');
  });

  it('Phase 71: records lastInjectedGuideVersion on the host_session row', async () => {
    await runHookViaBridge(harness, {
      event: 'sessionStart',
      payload: { session_id: 'sess_guide_marker', cwd: '/proj' },
    });
    const row = harness.db.prepare(
      `SELECT last_injected_guide_version FROM host_sessions WHERE id = ?`,
    ).get('sess_guide_marker') as { last_injected_guide_version: number };
    expect(row.last_injected_guide_version).toBe(1);
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

  it('Phase 25: chat ↔ role binding auto-injects role prompt + chunks at sessionStart', async () => {
    // Seed a role with one knowledge chunk.
    upsertRole(harness.db, {
      id: 'role-pm',
      name: 'Product Manager',
      systemPrompt: 'You are a meticulous PM. Always restate the goal first.',
      isBuiltin: true,
      createdAt: new Date().toISOString(),
    });
    insertChunk(harness.db, {
      id: 'chunk-1',
      roleId: 'role-pm',
      sourceFile: 'pm-handbook.md',
      chunkText: 'Always validate the customer pain before shipping.',
      kind: 'other',
      createdAt: new Date().toISOString(),
    });
    // Pre-create the host_session row and bind the role; mimics the user
    // picking the role in the Chats UI before the next sessionStart.
    const now = new Date().toISOString();
    upsertHostSession(harness.db, {
      id: 'sess_role',
      host: 'cursor',
      cwd: '/proj',
      status: 'active',
      firstSeenAt: now,
      lastSeenAt: now,
    });
    setHostSessionRole(harness.db, 'sess_role', 'role-pm');

    const r = await runHookViaBridge(harness, {
      event: 'sessionStart',
      payload: { session_id: 'sess_role', cwd: '/proj' },
    }) as { additional_context?: string };

    expect(r.additional_context).toBeDefined();
    expect(r.additional_context).toContain('## Local Roles');
    expect(r.additional_context).toContain('# Role: Product Manager');
    expect(r.additional_context).toContain('You are a meticulous PM');
    expect(r.additional_context).toContain('Always validate the customer pain');

    // The session_start hook fired again with new lastSeenAt — binding survives.
    const refreshed = harness.db.prepare(
      `SELECT role_id FROM host_sessions WHERE id = ?`,
    ).get('sess_role') as { role_id: string };
    expect(refreshed.role_id).toBe('role-pm');
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
