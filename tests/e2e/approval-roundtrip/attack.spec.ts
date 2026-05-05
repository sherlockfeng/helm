/**
 * E2e attack — failure modes of the approval round-trip.
 *
 * Per AGENTS.md §3, every user flow has at least 3 attack variants. This
 * suite exercises:
 *   - bridge unreachable → fallback to ask
 *   - approval timeout → ask
 *   - concurrent approvals don't cross-contaminate
 *   - malformed hook payload doesn't throw
 *   - bridge returns garbage / empty → ask fallback (covered by hook-entry
 *     unit tests; this suite focuses on multi-component integration)
 *   - settling twice (race between local UI and Lark) — second is a no-op
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootE2e, runHookViaBridge, type E2eHarness } from '../_helpers/setup.js';
import { upsertHostSession } from '../../../src/storage/repos/host-sessions.js';
import { Readable, Writable } from 'node:stream';
import { runHook } from '../../../src/host/cursor/hook-entry.js';
import { join } from 'node:path';

let harness: E2eHarness;

beforeEach(async () => {
  harness = await bootE2e({
    deps: { approvalTimeoutMs: 80 }, // dial down so timeout test is fast
    seed: (db) => {
      const now = new Date().toISOString();
      upsertHostSession(db, {
        id: 'sess_e2e', host: 'cursor', cwd: '/proj',
        status: 'active', firstSeenAt: now, lastSeenAt: now,
      });
    },
  });
});

afterEach(async () => { await harness.shutdown(); });

describe('approval-roundtrip attack', () => {
  it('bridge socket missing → hook returns permission=ask', async () => {
    // Stop the bridge so the socket vanishes; runHook should see the missing
    // socket and emit the conservative fallback.
    await harness.app.bridge.stop();

    const stdin = Readable.from([Buffer.from(JSON.stringify({
      session_id: 'sess_e2e', command: 'rm -rf /tmp',
    }), 'utf8')]);

    class Mem extends Writable {
      bufs: Buffer[] = [];
      override _write(c: Buffer, _e: string, cb: (e?: Error | null) => void): void { this.bufs.push(c); cb(); }
      out(): unknown { return JSON.parse(Buffer.concat(this.bufs).toString('utf8').trim()); }
    }
    const stdout = new Mem();

    await runHook({
      argv: ['--event', 'beforeShellExecution'],
      stdin, stdout,
      socketPath: harness.socketPath,
    });
    const r = stdout.out() as { permission: string; user_message: string };
    expect(r.permission).toBe('ask');
    expect(String(r.user_message).toLowerCase()).toContain('not running');
  });

  it('bridge points at a stale path → fallback ask, no throw', async () => {
    const stalePath = join(harness.tmpDir, 'does-not-exist.sock');
    // Payload must declare a risky tool so the hook actually contacts the
    // bridge (low-risk tools short-circuit to allow without consulting it).
    const stdin = Readable.from([Buffer.from(JSON.stringify({
      session_id: 'sess_e2e', tool_name: 'Write',
      tool_input: { path: '/proj/x.ts' },
    }), 'utf8')]);
    class Mem extends Writable {
      bufs: Buffer[] = [];
      override _write(c: Buffer, _e: string, cb: (e?: Error | null) => void): void { this.bufs.push(c); cb(); }
      out(): unknown { return JSON.parse(Buffer.concat(this.bufs).toString('utf8').trim()); }
    }
    const stdout = new Mem();
    await runHook({
      argv: ['--event', 'preToolUse'],
      stdin, stdout,
      socketPath: stalePath,
    });
    const r = stdout.out() as { permission?: string };
    expect(r.permission).toBe('ask');
  });

  it('approval times out → hook returns permission=ask', async () => {
    // No one settles → registry timeout fires (configured to 80ms in beforeEach).
    // The hook waits longer than that via host_approval_request budget.
    const response = await runHookViaBridge(harness, {
      event: 'beforeShellExecution',
      payload: { session_id: 'sess_e2e', command: 'sleep 1' },
      // hint the bridge client's per-message timeout is generous so it doesn't
      // race with the registry timeout
      envOverrides: { HELM_BRIDGE_TIMEOUT_MS: '10000' },
    }) as { permission: string };

    expect(response.permission).toBe('ask');
  });

  it('two concurrent approvals settle independently', async () => {
    // Allow the first, deny the second by inspecting the command in the request.
    harness.app.approval.onPendingCreated((req) => {
      queueMicrotask(() => {
        const decision: 'allow' | 'deny' = req.command === 'cmd_a' ? 'allow' : 'deny';
        void harness.app.channel.pushApprovalDecision({
          approvalId: req.id, decision,
        });
      });
    });

    const [r1, r2] = await Promise.all([
      runHookViaBridge(harness, {
        event: 'beforeShellExecution',
        payload: { session_id: 'sess_e2e', command: 'cmd_a' },
      }),
      runHookViaBridge(harness, {
        event: 'beforeShellExecution',
        payload: { session_id: 'sess_e2e', command: 'cmd_b' },
      }),
    ]) as Array<{ permission: string }>;

    expect(r1.permission).toBe('allow');
    expect(r2.permission).toBe('deny');
  });

  it('settle race (local UI and Lark both decide) → first wins, hook sees one decision', async () => {
    // Two listeners fight to settle; ApprovalRegistry.settle is idempotent so
    // only the first call returns true and triggers the bridge response.
    harness.app.approval.onPendingCreated((req) => {
      // Local-UI says allow
      queueMicrotask(() => {
        void harness.app.channel.pushApprovalDecision({
          approvalId: req.id, decision: 'allow',
        });
      });
      // "Lark" tries to deny right after — the second settle is a no-op.
      queueMicrotask(() => {
        harness.app.approval.settle(req.id, {
          permission: 'deny', decidedBy: 'lark',
        });
      });
    });

    const r = await runHookViaBridge(harness, {
      event: 'beforeShellExecution',
      payload: { session_id: 'sess_e2e', command: 'echo race' },
    }) as { permission: string };

    // Whichever queueMicrotask fires first wins; both are valid outcomes
    // because they're both legitimate "user decided" sources. The point is
    // that we never see e.g. an undefined/garbage permission.
    expect(['allow', 'deny']).toContain(r.permission);
  });

  it('malformed stdin payload does not crash the hook', async () => {
    const stdin = Readable.from([Buffer.from('not-json-at-all', 'utf8')]);
    class Mem extends Writable {
      bufs: Buffer[] = [];
      override _write(c: Buffer, _e: string, cb: (e?: Error | null) => void): void { this.bufs.push(c); cb(); }
      out(): string { return Buffer.concat(this.bufs).toString('utf8'); }
    }
    const stdout = new Mem();
    await runHook({
      argv: [],
      stdin, stdout,
      socketPath: harness.socketPath,
    });
    // Should produce *some* JSON, never throw.
    const text = stdout.out().trim();
    expect(text.length).toBeGreaterThan(0);
    expect(() => JSON.parse(text)).not.toThrow();
  });
});
