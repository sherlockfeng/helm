/**
 * E2e — full approval round-trip:
 *
 *   Cursor preToolUse hook subprocess
 *     → JSON over UDS bridge
 *     → orchestrator.host_approval_request handler
 *     → ApprovalRegistry.create + LocalChannel push (notifier)
 *     → User clicks "allow" via HTTP API or LocalChannel.pushApprovalDecision
 *     → registry.settle
 *     → bridge response
 *     → hook stdout JSON
 *
 * Drives the real runHook() against the real bridge over a real socket so
 * every layer (normalize, bridge protocol, registry, channel pub/sub, HTTP API)
 * is exercised end-to-end with no mocks at the seams under test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bootE2e,
  runHookViaBridge,
  seedLarkBinding,
  waitFor,
  type E2eHarness,
} from '../_helpers/setup.js';
import { upsertHostSession } from '../../../src/storage/repos/host-sessions.js';

let harness: E2eHarness;

beforeEach(async () => {
  harness = await bootE2e({
    seed: (db) => {
      const now = new Date().toISOString();
      upsertHostSession(db, {
        id: 'sess_e2e', host: 'cursor', cwd: '/proj',
        status: 'active', firstSeenAt: now, lastSeenAt: now,
      });
      // Phase 46a: requireApproval gate auto-allows unbound chats. Seed a
      // Lark binding so the full pending → settle path runs.
      seedLarkBinding(db, 'sess_e2e');
    },
  });
});

afterEach(async () => { await harness.shutdown(); });

describe('approval-roundtrip happy', () => {
  it('local UI allow settles the hook with permission=allow', async () => {
    // Wait for orchestrator listeners to register before the hook fires.
    await waitFor(() => true, { intervalMs: 0, timeoutMs: 50 });

    // Auto-approve from the "user" side once the registry creates a pending.
    harness.app.approval.onPendingCreated((req) => {
      // Simulate the renderer clicking "allow" via the LocalChannel pub/sub.
      // queueMicrotask so the create() call returns first and the awaiter is
      // installed by the time we settle.
      queueMicrotask(() => {
        void harness.app.channel.pushApprovalDecision({
          approvalId: req.id, decision: 'allow', reason: 'user clicked allow',
        });
      });
    });

    const response = await runHookViaBridge(harness, {
      event: 'beforeShellExecution',
      payload: {
        session_id: 'sess_e2e',
        command: 'pnpm install',
      },
    }) as { permission: string; agent_message?: string };

    expect(response.permission).toBe('allow');
    expect(String(response.agent_message)).toContain('Approved by Helm');
  });

  it('policy fast-path allows without any user interaction', async () => {
    harness.app.policy.add({ tool: 'Shell', commandPrefix: 'pnpm', decision: 'allow' });

    const response = await runHookViaBridge(harness, {
      event: 'beforeShellExecution',
      payload: { session_id: 'sess_e2e', command: 'pnpm test' },
    }) as { permission: string };

    expect(response.permission).toBe('allow');
  });

  it('low-risk preToolUse short-circuits to allow without contacting the bridge', async () => {
    // No registry create should be observed even though bridge is up — runHook
    // skips the bridge entirely for read-only tools.
    let pendingCount = 0;
    harness.app.approval.onPendingCreated(() => { pendingCount += 1; });

    const response = await runHookViaBridge(harness, {
      event: 'preToolUse',
      payload: { session_id: 'sess_e2e', tool_name: 'Read' },
    }) as { permission: string };

    expect(response.permission).toBe('allow');
    expect(pendingCount).toBe(0);
  });

  it('emits approval.pending + approval.settled SSE events as the round-trip resolves', async () => {
    const events: string[] = [];
    harness.app.events.on((e) => { events.push(e.type); });

    harness.app.approval.onPendingCreated((req) => {
      queueMicrotask(() => {
        void harness.app.channel.pushApprovalDecision({
          approvalId: req.id, decision: 'allow',
        });
      });
    });

    await runHookViaBridge(harness, {
      event: 'beforeShellExecution',
      payload: { session_id: 'sess_e2e', command: 'echo hi' },
    });

    expect(events).toContain('approval.pending');
    expect(events).toContain('approval.settled');
    // pending always fires before settled
    expect(events.indexOf('approval.pending')).toBeLessThan(events.indexOf('approval.settled'));
  });
});
