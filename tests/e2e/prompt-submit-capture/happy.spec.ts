/**
 * E2e — beforeSubmitPrompt → host_prompt_submit → first_prompt capture
 * (Phase 32).
 *
 * Drives the real Cursor hook against the bridge. On the first user message,
 * helm records the prompt as the chat's `firstPrompt` so the Active Chats UI
 * can show "fix the login redirect bug" instead of `da7bafc0-b32c-…`.
 *
 * Subsequent messages MUST NOT overwrite — the label is supposed to be a
 * stable opening-message snapshot, not a moving "last message" tracker.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootE2e, runHookViaBridge, type E2eHarness } from '../_helpers/setup.js';
import { getHostSession, upsertHostSession } from '../../../src/storage/repos/host-sessions.js';

let harness: E2eHarness;

beforeEach(async () => {
  harness = await bootE2e({
    seed: (db) => {
      const now = new Date().toISOString();
      upsertHostSession(db, {
        id: 'sess_p', host: 'cursor', cwd: '/Users/me/projects/foo',
        status: 'active', firstSeenAt: now, lastSeenAt: now,
      });
    },
  });
});

afterEach(async () => { await harness.shutdown(); });

describe('prompt-submit-capture happy', () => {
  it('first beforeSubmitPrompt records prompt as firstPrompt; hook returns continue=true', async () => {
    const r = await runHookViaBridge(harness, {
      event: 'beforeSubmitPrompt',
      payload: {
        session_id: 'sess_p',
        prompt: 'fix the login redirect bug',
        workspace_roots: ['/Users/me/projects/foo'],
      },
    }) as { continue?: boolean };

    expect(r.continue).toBe(true);
    expect(getHostSession(harness.db, 'sess_p')?.firstPrompt).toBe('fix the login redirect bug');
  });

  it('second beforeSubmitPrompt does NOT overwrite firstPrompt', async () => {
    await runHookViaBridge(harness, {
      event: 'beforeSubmitPrompt',
      payload: { session_id: 'sess_p', prompt: 'first message' },
    });
    await runHookViaBridge(harness, {
      event: 'beforeSubmitPrompt',
      payload: { session_id: 'sess_p', prompt: 'second message' },
    });
    await runHookViaBridge(harness, {
      event: 'beforeSubmitPrompt',
      payload: { session_id: 'sess_p', prompt: 'third message' },
    });
    expect(getHostSession(harness.db, 'sess_p')?.firstPrompt).toBe('first message');
  });

  it('whitespace-only prompt is treated as empty — no firstPrompt written', async () => {
    await runHookViaBridge(harness, {
      event: 'beforeSubmitPrompt',
      payload: { session_id: 'sess_p', prompt: '   \n  \t' },
    });
    expect(getHostSession(harness.db, 'sess_p')?.firstPrompt).toBeUndefined();
  });

  it('Phase 32 cwd: workspace_roots array on sessionStart is recognised', async () => {
    // Brand-new session (no row pre-seeded) — the sessionStart hook must
    // create the row with cwd taken from workspace_roots[0].
    await runHookViaBridge(harness, {
      event: 'sessionStart',
      payload: {
        session_id: 'sess_new',
        workspace_roots: ['/Users/me/projects/from-array'],
        composer_mode: 'agent',
      },
    });
    const row = getHostSession(harness.db, 'sess_new');
    expect(row?.cwd).toBe('/Users/me/projects/from-array');
    expect(row?.composerMode).toBe('agent');
  });

  it('firstPrompt survives the next sessionStart hook bumping last_seen_at', async () => {
    // Capture a prompt.
    await runHookViaBridge(harness, {
      event: 'beforeSubmitPrompt',
      payload: { session_id: 'sess_p', prompt: 'opening message' },
    });
    expect(getHostSession(harness.db, 'sess_p')?.firstPrompt).toBe('opening message');

    // Next sessionStart hook fires (e.g. Cursor reloaded the chat). The
    // upsert path must NOT clear first_prompt.
    await runHookViaBridge(harness, {
      event: 'sessionStart',
      payload: {
        session_id: 'sess_p',
        workspace_roots: ['/Users/me/projects/foo'],
      },
    });
    expect(getHostSession(harness.db, 'sess_p')?.firstPrompt).toBe('opening message');
  });
});
