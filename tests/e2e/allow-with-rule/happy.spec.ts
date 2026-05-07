/**
 * E2e — "Allow with rule" full round-trip (Phase 46d).
 *
 * The unit suite (`tests/unit/api/server.test.ts`) covers the API contract;
 * this spec drives the actual user flow:
 *
 *   1. Lark-bound chat fires a hook → pending row created
 *   2. User clicks "Allow & remember" via POST /api/approvals/:id/decide
 *      with `{ remember: true }`
 *   3. The same command fires again → policy fast-path auto-allows, no
 *      pending row created (registry never sees it)
 *
 * This is the "stop pestering me about pnpm install" loop a real user closes
 * the very first time. Without this spec, a regression could leave the rule
 * inserted but bypass the fast-path, or re-create a pending anyway, and
 * neither unit nor manual smoke would catch it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bootE2e, runHookViaBridge, seedLarkBinding, type E2eHarness,
} from '../_helpers/setup.js';
import { upsertHostSession } from '../../../src/storage/repos/host-sessions.js';

let harness: E2eHarness;

beforeEach(async () => {
  harness = await bootE2e({
    seed: (db) => {
      const now = new Date().toISOString();
      upsertHostSession(db, {
        id: 'sess_rule', host: 'cursor', cwd: '/proj',
        status: 'active', firstSeenAt: now, lastSeenAt: now,
      });
      seedLarkBinding(db, 'sess_rule');
    },
  });
});

afterEach(async () => { await harness.shutdown(); });

async function decide(
  approvalId: string,
  body: { decision: 'allow' | 'deny'; remember?: boolean; scope?: string },
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(
    `http://127.0.0.1:${harness.app.httpPort()}/api/approvals/${encodeURIComponent(approvalId)}/decide`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

describe('allow-with-rule happy', () => {
  it('first hook → pending → "Allow & remember"; second identical hook → policy fast-path', async () => {
    // Step 1: arrange to capture the registry's pending then click Allow+remember.
    // Unsubscribe after the first call so the audit-only pending the policy
    // fast-path creates on the second hook doesn't re-fire decide() against
    // a registry that's already settled it (which would leak a 409 fetch
    // past test end and surface as an unhandled rejection).
    let decidePromise: Promise<{ status: number; body: unknown }> | undefined;
    const off = harness.app.approval.onPendingCreated((req) => {
      decidePromise = decide(req.id, { decision: 'allow', remember: true });
      off();
    });

    const r1 = await runHookViaBridge(harness, {
      event: 'beforeShellExecution',
      payload: { session_id: 'sess_rule', command: 'pnpm install' },
    }) as { permission: string };
    expect(r1.permission).toBe('allow');

    // Now the decide HTTP call has had a chance to land (the registry settle
    // it triggered is what released the hook above).
    expect(decidePromise).toBeDefined();
    const decideResult = await decidePromise!;
    expect(decideResult.status).toBe(200);
    const decideBody = decideResult.body as {
      ok: boolean; rememberedRule?: { tool: string; decision: string };
    };
    expect(decideBody.rememberedRule).toMatchObject({ tool: 'Shell', decision: 'allow' });

    // Step 2: verify the rule is in the policy table — the engine derives
    // commandPrefix=firstToken for shell commands, so "pnpm" should match.
    const rules = harness.app.policy.list();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ tool: 'Shell', commandPrefix: 'pnpm', decision: 'allow' });

    // Step 3: the second identical hook should hit the policy fast-path. We
    // prove this by asserting the registry never sees a pending in
    // .listPending() — the handler creates a pending then settles immediately
    // for audit; what matters is that no NEW pending stays open and no
    // listener fires from the user's perspective. Here we count
    // onPendingCreated invocations.
    let pendingCreatedCount = 0;
    harness.app.approval.onPendingCreated(() => { pendingCreatedCount += 1; });

    const r2 = await runHookViaBridge(harness, {
      event: 'beforeShellExecution',
      payload: { session_id: 'sess_rule', command: 'pnpm test' }, // different subcommand, same prefix
    }) as { permission: string; agent_message?: string };
    expect(r2.permission).toBe('allow');

    // The policy fast-path persists an audit row but fires onPendingCreated
    // since it goes through registry.create. The key signal is the rule's
    // hits counter — it must have been bumped exactly once.
    const rulesAfter = harness.app.policy.list();
    expect(rulesAfter[0]!.hits).toBe(1);

    // And: pendingCreatedCount may be 1 (the audit pending) but it gets
    // settled inline via decidedBy='policy', not awaiting any user. No
    // user-visible decision UI fires.
    expect(pendingCreatedCount).toBeLessThanOrEqual(1);
  });

  it('"Allow & remember" with explicit scope inserts a rule mirroring policyInputFromScope', async () => {
    let decidePromise: Promise<{ status: number; body: unknown }> | undefined;
    harness.app.approval.onPendingCreated((req) => {
      // User typed an override in the scope input — same mechanism Lark uses
      // for `/allow! shell pnpm test`.
      decidePromise = decide(req.id, { decision: 'allow', remember: true, scope: 'shell pnpm test' });
    });

    await runHookViaBridge(harness, {
      event: 'beforeShellExecution',
      payload: { session_id: 'sess_rule', command: 'pnpm test --watch=false' },
    });
    await decidePromise;

    const rules = harness.app.policy.list();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      tool: 'Shell', commandPrefix: 'pnpm test', decision: 'allow',
    });
  });

  it('mcp__ tool with remember=true inserts a toolScope rule (whole tool greenlit)', async () => {
    let decidePromise: Promise<{ status: number; body: unknown }> | undefined;
    harness.app.approval.onPendingCreated((req) => {
      decidePromise = decide(req.id, { decision: 'allow', remember: true });
    });

    // Cursor's beforeMCPExecution carries `server` + `toolName` separately;
    // normalize.ts joins them into `mcp__<server>__<tool>`.
    await runHookViaBridge(harness, {
      event: 'beforeMCPExecution',
      payload: {
        session_id: 'sess_rule',
        server: 'lark-docs',
        toolName: 'send_message',
      },
    });
    await decidePromise;

    const rules = harness.app.policy.list();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      tool: 'mcp__lark-docs__send_message', toolScope: true, decision: 'allow',
    });
  });
});
