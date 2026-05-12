/**
 * E2e — Helm tool guide injection (Phase 71).
 *
 * Two paths, both verified end-to-end through the bridge:
 *   - sessionStart   → guide rides into `additional_context`
 *   - prompt-submit  → guide rides as a prefix block on `user_message`
 *                      when the chat's `last_injected_guide_version` is
 *                      stale (catches chats that pre-existed helm /
 *                      missed sessionStart).
 *
 * The marker `last_injected_guide_version` on host_sessions tracks per-
 * chat state; mismatch with the constant `HELM_TOOL_GUIDE_VERSION` is
 * what triggers injection. After injection the version is bumped so
 * subsequent prompts in the same chat skip the path.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootE2e, runHookViaBridge, type E2eHarness } from '../_helpers/setup.js';
import { setLastInjectedGuideVersion, upsertHostSession } from '../../../src/storage/repos/host-sessions.js';

let harness: E2eHarness;

beforeEach(async () => { harness = await bootE2e(); });
afterEach(async () => { await harness.shutdown(); });

describe('helm-tool-guide injection (Phase 71)', () => {
  it('sessionStart writes the guide into additional_context', async () => {
    const r = await runHookViaBridge(harness, {
      event: 'sessionStart',
      payload: { session_id: 'sess_g1', cwd: '/proj' },
    }) as { additional_context?: string };

    expect(r.additional_context).toBeDefined();
    expect(r.additional_context).toContain('helm is a desktop GUI');
    expect(r.additional_context).toContain('list_roles');
    expect(r.additional_context).toContain('harness_create_task');
    expect(r.additional_context).toContain('bind_to_remote_channel');
  });

  it('sessionStart bumps last_injected_guide_version to the current constant', async () => {
    await runHookViaBridge(harness, {
      event: 'sessionStart',
      payload: { session_id: 'sess_g2', cwd: '/proj' },
    });
    const row = harness.db.prepare(
      `SELECT last_injected_guide_version FROM host_sessions WHERE id = ?`,
    ).get('sess_g2') as { last_injected_guide_version: number };
    expect(row.last_injected_guide_version).toBe(1);
  });

  it('prompt-submit injects the guide as <helm:tool-guide> prefix when version is stale', async () => {
    // Pre-existing chat (sessionStart never fired) → version is null.
    // The autoUpsertSession path in host_prompt_submit will create the row
    // for us; we don't pre-seed.
    const r = await runHookViaBridge(harness, {
      event: 'beforeSubmitPrompt',
      payload: { session_id: 'sess_g3', prompt: 'first message', workspace_roots: ['/proj'] },
    }) as { continue: boolean; user_message?: string };

    expect(r.continue).toBe(true);
    expect(r.user_message).toContain('<helm:tool-guide>');
    expect(r.user_message).toContain('helm is a desktop GUI');
    expect(r.user_message).toContain('</helm:tool-guide>');
    expect(r.user_message).toMatch(/<\/helm:tool-guide>[\s\S]*first message/);
  });

  it('prompt-submit DOES NOT re-inject when the version is already current', async () => {
    // Set the version up-front to simulate a chat that already received
    // the guide (either via sessionStart or a prior prompt-submit).
    const now = new Date().toISOString();
    upsertHostSession(harness.db, {
      id: 'sess_g4', host: 'cursor', cwd: '/proj',
      status: 'active', firstSeenAt: now, lastSeenAt: now,
    });
    setLastInjectedGuideVersion(harness.db, 'sess_g4', 1);

    const r = await runHookViaBridge(harness, {
      event: 'beforeSubmitPrompt',
      payload: { session_id: 'sess_g4', prompt: 'msg', workspace_roots: ['/proj'] },
    }) as { user_message?: string };

    expect(r.user_message).toBeUndefined();
  });

  it('a sessionStart-injected chat does NOT see the guide again on its first prompt-submit', async () => {
    // Phase 71: ensures the two paths don't double-inject. sessionStart
    // marks the version; the subsequent prompt-submit's stale check sees
    // an exact match and skips.
    await runHookViaBridge(harness, {
      event: 'sessionStart',
      payload: { session_id: 'sess_g5', cwd: '/proj' },
    });

    const r = await runHookViaBridge(harness, {
      event: 'beforeSubmitPrompt',
      payload: { session_id: 'sess_g5', prompt: 'first prompt', workspace_roots: ['/proj'] },
    }) as { user_message?: string };

    // No prefix — sessionStart already shipped the guide.
    expect(r.user_message).toBeUndefined();
  });

  it('manually clearing the version forces a re-injection on the next prompt (covers "guide text bumped" upgrade path)', async () => {
    // Simulate a release where we bumped HELM_TOOL_GUIDE_VERSION: helm
    // resets the column to null (or it just lags), and the next prompt
    // gets the freshened text. Cleanest way to test the trigger without
    // mocking the constant.
    await runHookViaBridge(harness, {
      event: 'sessionStart',
      payload: { session_id: 'sess_g6', cwd: '/proj' },
    });
    setLastInjectedGuideVersion(harness.db, 'sess_g6', null);

    const r = await runHookViaBridge(harness, {
      event: 'beforeSubmitPrompt',
      payload: { session_id: 'sess_g6', prompt: 'after bump', workspace_roots: ['/proj'] },
    }) as { user_message?: string };

    expect(r.user_message).toContain('<helm:tool-guide>');
  });
});
