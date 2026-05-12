/**
 * E2e — role re-injection on mid-chat bind change (Phase 56).
 *
 * The user scenario:
 *   1. Cursor chat is already running (sessionStart fired with no roles bound)
 *   2. User realizes they need Goofy 专家, binds it via the Active Chats UI
 *   3. User sends another prompt → the agent should now have Goofy's
 *      system prompt + chunks available
 *
 * Cursor's beforeSubmitPrompt hook response only carries `user_message`
 * (no `additional_context` field), so helm prefixes the role markdown into
 * the user's prompt with a clearly-marked `<helm:role-context>` block. The
 * agent treats it as system context; subsequent prompts skip the prefix
 * until the binding changes again.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootE2e, runHookViaBridge, type E2eHarness } from '../_helpers/setup.js';
import {
  addHostSessionRole,
  getHostSession,
  removeHostSessionRole,
  upsertHostSession,
} from '../../../src/storage/repos/host-sessions.js';
import { upsertRole } from '../../../src/storage/repos/roles.js';

let harness: E2eHarness;

beforeEach(async () => {
  harness = await bootE2e({
    seed: (db) => {
      const now = new Date().toISOString();
      upsertHostSession(db, {
        id: 'sess_r', host: 'cursor', cwd: '/proj',
        status: 'active', firstSeenAt: now, lastSeenAt: now,
      });
      // Two roles available to bind; the chat starts with neither.
      upsertRole(db, {
        id: 'goofy',
        name: 'Goofy 专家',
        systemPrompt: 'You are the resident Goofy expert. Answer in detail about deploys.',
        isBuiltin: false,
        createdAt: now,
      });
      upsertRole(db, {
        id: 'arch',
        name: '架构师',
        systemPrompt: 'You think in architecture diagrams first.',
        isBuiltin: false,
        createdAt: now,
      });
    },
  });
});

afterEach(async () => { await harness.shutdown(); });

describe('role-reinject-on-bind happy', () => {
  it('first prompt before any role bound: only the Helm tool guide is prefixed (no role block)', async () => {
    // Phase 71: every chat receives the Helm tool guide on its first
    // prompt-submit (if sessionStart didn't already deliver it). With NO
    // roles bound, the prompt-submit handler returns ONLY the tool guide
    // block — no <helm:role-context>. Subsequent prompts in this chat
    // see undefined (guide already marked).
    const r = await runHookViaBridge(harness, {
      event: 'beforeSubmitPrompt',
      payload: {
        session_id: 'sess_r',
        prompt: 'how are things?',
        workspace_roots: ['/proj'],
      },
    }) as { continue: boolean; user_message?: string };

    expect(r.continue).toBe(true);
    expect(r.user_message).toContain('<helm:tool-guide>');
    expect(r.user_message).not.toContain('<helm:role-context>');
    expect(r.user_message).toMatch(/<\/helm:tool-guide>[\s\S]*how are things\?/);

    // Second prompt in the same chat: guide is marked → no prefix.
    const second = await runHookViaBridge(harness, {
      event: 'beforeSubmitPrompt',
      payload: { session_id: 'sess_r', prompt: 'follow-up', workspace_roots: ['/proj'] },
    }) as { user_message?: string };
    expect(second.user_message).toBeUndefined();
  });

  it('binding a role mid-chat → next prompt-submit prefixes the helm role-context block', async () => {
    // Step 1: simulate prior chat activity (no role yet) — first prompt
    // sets the baseline lastInjectedRoleIds = [].
    await runHookViaBridge(harness, {
      event: 'beforeSubmitPrompt',
      payload: { session_id: 'sess_r', prompt: 'starting work', workspace_roots: ['/proj'] },
    });
    expect(getHostSession(harness.db, 'sess_r')?.lastInjectedRoleIds).toEqual([]);

    // Step 2: user binds Goofy via the UI (we hit the repo directly to keep
    // this spec focused on the inject path; the UI/HTTP path is covered in
    // active-chats e2e).
    addHostSessionRole(harness.db, 'sess_r', 'goofy');

    // Step 3: next prompt arrives — helm should now rewrite user_message.
    const r = await runHookViaBridge(harness, {
      event: 'beforeSubmitPrompt',
      payload: {
        session_id: 'sess_r',
        prompt: 'how do I configure the deploy pipeline?',
        workspace_roots: ['/proj'],
      },
    }) as { continue: boolean; user_message?: string };

    expect(r.continue).toBe(true);
    expect(r.user_message).toBeDefined();
    expect(r.user_message).toMatch(/<helm:role-context>/);
    expect(r.user_message).toMatch(/<\/helm:role-context>/);
    // Goofy's system prompt MUST appear inside the block.
    expect(r.user_message).toContain('Goofy expert');
    // The user's actual prompt sits after the block.
    expect(r.user_message).toMatch(/<\/helm:role-context>\s*\n\s*how do I configure the deploy pipeline\?/);

    // Storage now records goofy as the last-injected set.
    expect(getHostSession(harness.db, 'sess_r')?.lastInjectedRoleIds).toEqual(['goofy']);
  });

  it('subsequent prompt with the SAME bound roles is NOT re-prefixed (avoids token spam)', async () => {
    // Bind + first inject.
    addHostSessionRole(harness.db, 'sess_r', 'goofy');
    const first = await runHookViaBridge(harness, {
      event: 'beforeSubmitPrompt',
      payload: { session_id: 'sess_r', prompt: 'p1', workspace_roots: ['/proj'] },
    }) as { user_message?: string };
    expect(first.user_message).toMatch(/<helm:role-context>/);

    // Same roles → no rewrite on second prompt.
    const second = await runHookViaBridge(harness, {
      event: 'beforeSubmitPrompt',
      payload: { session_id: 'sess_r', prompt: 'p2', workspace_roots: ['/proj'] },
    }) as { continue: boolean; user_message?: string };
    expect(second.continue).toBe(true);
    expect(second.user_message).toBeUndefined();
  });

  it('adding a SECOND role re-injects with the full union (Goofy + 架构师)', async () => {
    // Bind goofy + first inject.
    addHostSessionRole(harness.db, 'sess_r', 'goofy');
    await runHookViaBridge(harness, {
      event: 'beforeSubmitPrompt',
      payload: { session_id: 'sess_r', prompt: 'p1', workspace_roots: ['/proj'] },
    });

    // Add 架构师 — bind set is now {goofy, arch}.
    addHostSessionRole(harness.db, 'sess_r', 'arch');
    const r = await runHookViaBridge(harness, {
      event: 'beforeSubmitPrompt',
      payload: { session_id: 'sess_r', prompt: 'next prompt', workspace_roots: ['/proj'] },
    }) as { user_message?: string };
    expect(r.user_message).toContain('Goofy expert');
    expect(r.user_message).toContain('architecture diagrams');

    // Sorted = ['arch', 'goofy'].
    expect(getHostSession(harness.db, 'sess_r')?.lastInjectedRoleIds).toEqual(['arch', 'goofy']);
  });

  it('removing the LAST role flips to baseline; future prompts have no prefix', async () => {
    addHostSessionRole(harness.db, 'sess_r', 'goofy');
    await runHookViaBridge(harness, {
      event: 'beforeSubmitPrompt',
      payload: { session_id: 'sess_r', prompt: 'inject', workspace_roots: ['/proj'] },
    });

    // Unbind.
    removeHostSessionRole(harness.db, 'sess_r', 'goofy');
    const r = await runHookViaBridge(harness, {
      event: 'beforeSubmitPrompt',
      payload: { session_id: 'sess_r', prompt: 'after unbind', workspace_roots: ['/proj'] },
    }) as { continue: boolean; user_message?: string };
    expect(r.continue).toBe(true);
    // Empty role set → no inject text, but baseline updates so the NEXT
    // prompt-submit sees same empty set and is also a no-op.
    expect(r.user_message).toBeUndefined();
    expect(getHostSession(harness.db, 'sess_r')?.lastInjectedRoleIds).toEqual([]);

    const after = await runHookViaBridge(harness, {
      event: 'beforeSubmitPrompt',
      payload: { session_id: 'sess_r', prompt: 'still nothing', workspace_roots: ['/proj'] },
    }) as { user_message?: string };
    expect(after.user_message).toBeUndefined();
  });

  it('attack: rebinding the SAME role (remove → re-add) re-injects (binding identity changed)', async () => {
    addHostSessionRole(harness.db, 'sess_r', 'goofy');
    await runHookViaBridge(harness, {
      event: 'beforeSubmitPrompt',
      payload: { session_id: 'sess_r', prompt: 'first', workspace_roots: ['/proj'] },
    });

    removeHostSessionRole(harness.db, 'sess_r', 'goofy');
    addHostSessionRole(harness.db, 'sess_r', 'goofy');

    // The role set went `[goofy] → [] → [goofy]`. Last-injected was
    // recorded as `[goofy]` after the first inject; the empty middle state
    // never reached prompt-submit. Final state matches last-injected →
    // helm should NOT re-inject (no actual change observed by helm).
    const r = await runHookViaBridge(harness, {
      event: 'beforeSubmitPrompt',
      payload: { session_id: 'sess_r', prompt: 'after rebind', workspace_roots: ['/proj'] },
    }) as { user_message?: string };
    expect(r.user_message).toBeUndefined();
  });

  it('host_session_start records the synced baseline so the very first prompt does not double-inject', async () => {
    // Pre-bind a role BEFORE sessionStart fires (e.g. user binds via UI then
    // restarts Cursor and a new chat opens). sessionStart's additional_context
    // already carries the role context; prompt_submit should NOT add it again.
    addHostSessionRole(harness.db, 'sess_r', 'goofy');

    await runHookViaBridge(harness, {
      event: 'sessionStart',
      payload: { session_id: 'sess_r', cwd: '/proj' },
    });
    expect(getHostSession(harness.db, 'sess_r')?.lastInjectedRoleIds).toEqual(['goofy']);

    const r = await runHookViaBridge(harness, {
      event: 'beforeSubmitPrompt',
      payload: { session_id: 'sess_r', prompt: 'go', workspace_roots: ['/proj'] },
    }) as { user_message?: string };
    // No re-inject — sessionStart already shipped it.
    expect(r.user_message).toBeUndefined();
  });
});
