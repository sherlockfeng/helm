/**
 * E2e attacks for cycle-complete-with-bug-followup.
 *
 * Verify the HTTP endpoints don't crash on bad input, and that the workflow
 * engine refuses transitions that would corrupt the state machine (e.g.
 * complete a cycle that's still in dev).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootE2e, type E2eHarness } from '../_helpers/setup.js';
import { HelmConfigSchema } from '../../../src/config/schema.js';
import { listCycles, listTasks } from '../../../src/storage/repos/campaigns.js';

let harness: E2eHarness;

beforeEach(async () => {
  harness = await bootE2e({
    deps: { config: HelmConfigSchema.parse({ docFirst: { enforce: false } }) },
  });
});

afterEach(async () => { await harness.shutdown(); });

async function postJson(path: string, body: unknown, opts?: { rawBody?: string }): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${harness.app.httpPort()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: opts?.rawBody ?? JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

describe('cycle-complete-with-bug-followup attacks', () => {
  it('attack: complete a cycle still in dev → 400, no auto-spawned next cycle', async () => {
    const campaign = harness.app.workflowEngine.initWorkflow('/proj', 'C', 'b');
    const [cycle] = listCycles(harness.db, campaign.id);
    harness.app.workflowEngine.createTasks(cycle!.id, [{ role: 'dev', title: 'd1' }]);
    // Cycle is in 'dev' — completeCycle must refuse.
    const r = await postJson(`/api/cycles/${cycle!.id}/complete`, { passRate: 100 });
    expect(r.status).toBe(400);
    expect(listCycles(harness.db, campaign.id)).toHaveLength(1);
  });

  it('attack: bug-tasks against an unknown cycle → 404', async () => {
    const r = await postJson('/api/cycles/ghost-cycle/bug-tasks', {
      bugs: [{ title: 'x' }],
    });
    expect(r.status).toBe(404);
  });

  it('attack: bug-tasks with empty bugs[] → 400, nothing inserted', async () => {
    const campaign = harness.app.workflowEngine.initWorkflow('/proj', 'C', 'b');
    const [cycle] = listCycles(harness.db, campaign.id);
    const r = await postJson(`/api/cycles/${cycle!.id}/bug-tasks`, { bugs: [] });
    expect(r.status).toBe(400);
    expect(listTasks(harness.db, cycle!.id)).toHaveLength(0);
  });

  it('attack: bug-tasks malformed JSON → 400, atomic rejection', async () => {
    const campaign = harness.app.workflowEngine.initWorkflow('/proj', 'C', 'b');
    const [cycle] = listCycles(harness.db, campaign.id);
    const r = await postJson(`/api/cycles/${cycle!.id}/bug-tasks`, {}, { rawBody: '{not json' });
    expect(r.status).toBe(400);
    expect(listTasks(harness.db, cycle!.id)).toHaveLength(0);
  });
});
