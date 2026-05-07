/**
 * E2e — full cycle with bug follow-up (Phase 30 / C2).
 *
 * Drives the campaign workflow end-to-end through the HTTP API the renderer
 * uses, then asserts the workflow engine + storage layers are in the expected
 * state. Covers the path PROJECT_BLUEPRINT.md §6 calls out as the "real"
 * happy story:
 *
 *   1. Product agent (or the user via the renderer) seeds a campaign + cycle
 *      via WorkflowEngine.initWorkflow.
 *   2. Dev tasks land + complete; cycle auto-flips to "test".
 *   3. Tester finds bugs → POST /api/cycles/:id/bug-tasks → cycle goes back
 *      to "dev". (PR #19 wired this HTTP endpoint to the engine.)
 *   4. Bug-fix tasks complete → cycle returns to "test" automatically.
 *   5. Tester completes the cycle → POST /api/cycles/:id/complete → engine
 *      auto-creates the next cycle in "product" phase.
 *
 * Because the orchestrator wires the same engine instance into both the HTTP
 * endpoints and the MCP server (Phase 7), this spec doubles as proof that
 * the live engine config (docFirst.enforce flag, etc.) reads through.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootE2e, type E2eHarness } from '../_helpers/setup.js';
import { HelmConfigSchema } from '../../../src/config/schema.js';
import { listCycles, listTasks } from '../../../src/storage/repos/campaigns.js';

let harness: E2eHarness;

beforeEach(async () => {
  // docFirst.enforce defaults to true in HelmConfigSchema; turn it off so
  // this spec can drive complete_task without minting docAuditTokens (those
  // are covered separately in `tests/unit/workflow/doc-first.test.ts`).
  harness = await bootE2e({
    deps: { config: HelmConfigSchema.parse({ docFirst: { enforce: false } }) },
  });
});

afterEach(async () => { await harness.shutdown(); });

async function postJson(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${harness.app.httpPort()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

describe('cycle-complete-with-bug-followup happy', () => {
  it('dev → test → bug followup → fix → complete → next cycle auto-starts in product', async () => {
    // Step 1: seed the campaign + first cycle via the engine. The HTTP API
    // doesn't expose initWorkflow directly (that's an MCP tool), so we drive
    // it through the same WorkflowEngine instance the orchestrator uses.
    const campaign = harness.app.workflowEngine.initWorkflow('/proj', 'Auth refactor', 'rebuild login');
    const [cycle] = listCycles(harness.db, campaign.id);
    expect(cycle).toBeDefined();
    expect(cycle!.status).toBe('product');

    // Product role splits the cycle into dev tasks. Use the engine for the
    // creation path (this is the role the MCP server's create_tasks tool drives).
    const devTasks = harness.app.workflowEngine.createTasks(cycle!.id, [
      { role: 'dev', title: 'Refactor session storage' },
      { role: 'test', title: 'Cover login happy path' },
    ]);
    expect(devTasks).toHaveLength(2);
    // createTasks flips the cycle from 'product' → 'dev' automatically.
    expect(listCycles(harness.db, campaign.id)[0]!.status).toBe('dev');

    // Step 2: dev completes their task — engine auto-flips to 'test' once the
    // last dev-role task is done.
    const devTaskId = devTasks.find((t) => t.role === 'dev')!.id;
    harness.app.workflowEngine.completeTask(devTaskId, { result: 'merged in #42' });
    expect(listCycles(harness.db, campaign.id)[0]!.status).toBe('test');

    // Step 3: tester files a bug via the HTTP endpoint the renderer uses.
    const bugReply = await postJson(`/api/cycles/${cycle!.id}/bug-tasks`, {
      bugs: [{
        title: 'Logout drops the session token early',
        description: 'token cleared before redirect completes',
        expected: 'redirect, then clear',
        actual: 'cleared, then redirect — race window',
      }],
    });
    expect(bugReply.status).toBe(200);
    const { tasks: bugTasks } = bugReply.body as { tasks: Array<{ id: string; title: string }> };
    expect(bugTasks).toHaveLength(1);
    expect(bugTasks[0]!.title.startsWith('[BUG]')).toBe(true);

    // Cycle reverts to 'dev' so the dev role can pick up the bug fix.
    expect(listCycles(harness.db, campaign.id)[0]!.status).toBe('dev');
    // The original test task is still pending; the bug task is also pending.
    const allTasks = listTasks(harness.db, cycle!.id);
    expect(allTasks.some((t) => t.title === '[BUG] Logout drops the session token early')).toBe(true);

    // Step 4: dev fixes the bug → cycle auto-flips back to 'test'.
    const bugTaskId = bugTasks[0]!.id;
    harness.app.workflowEngine.completeTask(bugTaskId, { result: 'fix shipped' });
    expect(listCycles(harness.db, campaign.id)[0]!.status).toBe('test');

    // Step 5: tester completes the cycle via HTTP.
    const completeReply = await postJson(`/api/cycles/${cycle!.id}/complete`, {
      passRate: 100,
      screenshots: [{ filePath: '/tmp/login.png', description: 'login form passes' }],
    });
    expect(completeReply.status).toBe(200);

    // The engine auto-spawns the next cycle in 'product' status so the loop
    // keeps moving without a manual nudge.
    const allCycles = listCycles(harness.db, campaign.id);
    expect(allCycles).toHaveLength(2);
    const completed = allCycles.find((c) => c.cycleNum === 1)!;
    const nextCycle = allCycles.find((c) => c.cycleNum === 2)!;
    expect(completed.status).toBe('completed');
    expect(nextCycle.status).toBe('product');
    expect(nextCycle.startedAt).toBeTruthy();
  });

  it('product feedback merges into the next cycle\'s brief without restarting the engine', async () => {
    const campaign = harness.app.workflowEngine.initWorkflow('/proj', 'UX pass', 'first pass');
    const [cycle] = listCycles(harness.db, campaign.id);
    harness.app.workflowEngine.createTasks(cycle!.id, [
      { role: 'dev', title: 'd1' }, { role: 'test', title: 't1' },
    ]);
    const devTask = listTasks(harness.db, cycle!.id).find((t) => t.role === 'dev')!;
    harness.app.workflowEngine.completeTask(devTask.id, { result: 'done' });

    // Feedback from tester gets folded into the cycle's brief — the next
    // cycle's brief picks up the same field if/when product carries it forward.
    harness.app.workflowEngine.addProductFeedback(cycle!.id, 'login button alignment is off');

    const updated = listCycles(harness.db, campaign.id)[0]!;
    expect(updated.productBrief).toContain('login button alignment is off');
    expect(updated.productBrief).toContain('Test Feedback');
  });
});
