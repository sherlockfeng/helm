/**
 * E2e — requireApproval Lark-only gate (Phase 46a).
 *
 * Behavior contract: helm intercepts every Cursor tool call by default, but
 * if the user hasn't bound this chat to any remote channel (Lark thread / etc.),
 * there's nothing to ask — auto-allow without creating a pending row that
 * nobody will decide on. Cursor's own permission UI is still in front, so
 * this just suppresses helm's additional layer for the unbound case.
 *
 * Why an e2e: the unit suite covers the predicate in isolation. This spec
 * proves the orchestrator wires it correctly — listBindingsForSession()
 * filtered by `channel='lark'`. A regression that, e.g., forgot the channel
 * filter would silently let GitHub-bound chats through unnoticed.
 *
 *   1. Unbound chat fires a hook → permission=allow, no pending row
 *   2. Bind chat to Lark → next hook creates a pending and waits for decision
 *   3. Unbinding (delete the binding) → next hook auto-allows again
 *   4. Policy deny rules still apply universally — gate doesn't bypass them
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bootE2e, runHookViaBridge, seedLarkBinding, type E2eHarness,
} from '../_helpers/setup.js';
import { upsertHostSession } from '../../../src/storage/repos/host-sessions.js';
import {
  deleteChannelBinding,
  listBindingsForSession,
  insertChannelBinding,
} from '../../../src/storage/repos/channel-bindings.js';

let harness: E2eHarness;

beforeEach(async () => {
  harness = await bootE2e({
    seed: (db) => {
      const now = new Date().toISOString();
      upsertHostSession(db, {
        id: 'sess_gate', host: 'cursor', cwd: '/proj',
        status: 'active', firstSeenAt: now, lastSeenAt: now,
      });
    },
  });
});

afterEach(async () => { await harness.shutdown(); });

describe('lark-gate happy', () => {
  it('unbound chat → hook auto-allows without creating a pending row', async () => {
    let pendingCreatedCount = 0;
    harness.app.approval.onPendingCreated(() => { pendingCreatedCount += 1; });

    const r = await runHookViaBridge(harness, {
      event: 'beforeShellExecution',
      payload: { session_id: 'sess_gate', command: 'rm -rf /tmp/whatever' },
    }) as { permission: string; agent_message?: string };

    expect(r.permission).toBe('allow');
    expect(pendingCreatedCount).toBe(0);
    // No row in the DB either — pending requests would persist there.
    const dbRows = harness.db.prepare(
      `SELECT count(*) AS n FROM approval_requests WHERE host_session_id = ?`,
    ).get('sess_gate') as { n: number };
    expect(dbRows.n).toBe(0);
  });

  it('after binding to Lark, the same command goes through the pending path', async () => {
    seedLarkBinding(harness.db, 'sess_gate');

    // Auto-deny so the hook completes promptly.
    harness.app.approval.onPendingCreated((req) => {
      queueMicrotask(() => {
        void harness.app.channel.pushApprovalDecision({
          approvalId: req.id, decision: 'deny',
        });
      });
    });

    const r = await runHookViaBridge(harness, {
      event: 'beforeShellExecution',
      payload: { session_id: 'sess_gate', command: 'rm -rf /tmp/x' },
    }) as { permission: string };
    expect(r.permission).toBe('deny');
  });

  it('removing the Lark binding flips the gate back to auto-allow', async () => {
    seedLarkBinding(harness.db, 'sess_gate');
    expect(listBindingsForSession(harness.db, 'sess_gate')).toHaveLength(1);

    deleteChannelBinding(harness.db, 'b_sess_gate');
    expect(listBindingsForSession(harness.db, 'sess_gate')).toHaveLength(0);

    let pendingCreatedCount = 0;
    harness.app.approval.onPendingCreated(() => { pendingCreatedCount += 1; });

    const r = await runHookViaBridge(harness, {
      event: 'beforeShellExecution',
      payload: { session_id: 'sess_gate', command: 'echo unbound-again' },
    }) as { permission: string };
    expect(r.permission).toBe('allow');
    expect(pendingCreatedCount).toBe(0);
  });

  it('non-Lark binding (other channel kind) does NOT count as bound — stays auto-allow', async () => {
    // Hypothetical future channel — gate only treats `lark` as activating.
    insertChannelBinding(harness.db, {
      id: 'b_other',
      channel: 'github' as 'lark', // forced cast: schema accepts strings
      hostSessionId: 'sess_gate',
      externalChat: 'gh',
      externalThread: 'pr',
      externalRoot: 'comment_1',
      waitEnabled: false,
      createdAt: new Date().toISOString(),
    });

    let pendingCreatedCount = 0;
    harness.app.approval.onPendingCreated(() => { pendingCreatedCount += 1; });

    const r = await runHookViaBridge(harness, {
      event: 'beforeShellExecution',
      payload: { session_id: 'sess_gate', command: 'ls /tmp' },
    }) as { permission: string };
    expect(r.permission).toBe('allow');
    expect(pendingCreatedCount).toBe(0);
  });

  it('explicit deny rule trumps the gate — unbound chat with a matching deny rule still denies', async () => {
    // Deny rules are a security mechanism; the gate must not bypass them.
    harness.app.policy.add({ tool: 'Shell', commandPrefix: 'rm', decision: 'deny' });

    const r = await runHookViaBridge(harness, {
      event: 'beforeShellExecution',
      payload: { session_id: 'sess_gate', command: 'rm -rf /etc' },
    }) as { permission: string; agent_message?: string };
    expect(r.permission).toBe('deny');
  });
});
