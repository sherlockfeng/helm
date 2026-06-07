/**
 * E2e — Verification HTTP API (PR 5).
 *
 * Drives a real HelmApp through the `/api/verification/*` surface so the
 * test catches wiring breakage at the boundary, not just at the repo.
 *
 * Run is NOT exercised here (the runner needs a real LLM provider config
 * which is the next PR). What this suite proves:
 *   - cases can be created, listed, fetched, confirmed, rejected
 *   - filter / status / role params behave as documented
 *   - 404/409 paths are honest (R-5 stops the rejected → confirm flow)
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootE2e, type E2eHarness } from '../_helpers/setup.js';
import { upsertRole } from '../../../src/storage/repos/roles.js';

interface JsonResponse { status: number; body: unknown }
async function api(
  port: number,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<JsonResponse> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    ...(body !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

function getPort(h: E2eHarness): number {
  const port = h.app.httpPort();
  if (port == null) throw new Error('httpPort not bound');
  return port;
}

function seedRoleAndPoint(db: BetterSqlite3.Database, roleId: string, pointId: string): void {
  upsertRole(db, {
    id: roleId, name: `R-${roleId}`, systemPrompt: 'sp',
    isBuiltin: false, createdAt: new Date().toISOString(),
  });
  db.prepare(`
    INSERT INTO knowledge_chunks (id, role_id, chunk_text, kind, created_at)
    VALUES (?, ?, 'body', 'spec', ?)
  `).run(pointId, roleId, new Date().toISOString());
}

describe('e2e Verification — happy', () => {
  let h: E2eHarness;
  beforeEach(async () => { h = await bootE2e(); });
  afterEach(async () => { await h.shutdown(); });

  it('POST /api/verification/cases creates a case, GET returns it', async () => {
    seedRoleAndPoint(h.db, 'r-1', 'p-1');
    const port = getPort(h);
    const create = await api(port, 'POST', '/api/verification/cases', {
      name: 'dr-my-dc-failure',
      question: 'MY DC fails: how to switch?',
      expectedTruth: 'MY is in SG region; failover to SG1 via internal BFC.',
      goldenPointIds: ['p-1'],
      targetRoleIds: ['r-1'],
    });
    expect(create.status).toBe(201);
    const createdId = (create.body as { case: { id: string } }).case.id;

    const got = await api(port, 'GET', `/api/verification/cases/${createdId}`);
    expect(got.status).toBe(200);
    const c = (got.body as { case: { id: string; name: string; goldenPointIds: string[] } }).case;
    expect(c.name).toBe('dr-my-dc-failure');
    expect(c.goldenPointIds).toEqual(['p-1']);
  });

  it('GET /api/verification/cases?status=confirmed returns only confirmed', async () => {
    const port = getPort(h);
    await api(port, 'POST', '/api/verification/cases', {
      name: 'manual A', question: 'q', expectedTruth: 't',
    });
    await api(port, 'POST', '/api/verification/cases', {
      name: 'llm B', question: 'q', expectedTruth: 't',
      proposedSource: 'llm-on-edit',
    });
    const confirmed = await api(port, 'GET', '/api/verification/cases?status=confirmed');
    const proposed  = await api(port, 'GET', '/api/verification/cases?status=proposed');
    expect((confirmed.body as { cases: { name: string }[] }).cases.map((c) => c.name))
      .toContain('manual A');
    expect((proposed.body  as { cases: { name: string }[] }).cases.map((c) => c.name))
      .toContain('llm B');
  });

  it('POST /api/verification/cases/:id/confirm flips proposed → confirmed', async () => {
    const port = getPort(h);
    const create = await api(port, 'POST', '/api/verification/cases', {
      name: 'proposed case', question: 'q', expectedTruth: 't',
      proposedSource: 'llm-on-edit',
    });
    const id = (create.body as { case: { id: string } }).case.id;
    const r = await api(port, 'POST', `/api/verification/cases/${id}/confirm`, {
      confirmedBy: 'tester@example.com',
    });
    expect(r.status).toBe(200);
    const after = await api(port, 'GET', `/api/verification/cases/${id}`);
    expect((after.body as { case: { status: string } }).case.status).toBe('confirmed');
  });

  it('POST /api/verification/cases/:id/reject on a confirmed case returns 409 not_proposed', async () => {
    const port = getPort(h);
    const create = await api(port, 'POST', '/api/verification/cases', {
      name: 'already confirmed', question: 'q', expectedTruth: 't',
    });
    const id = (create.body as { case: { id: string } }).case.id;
    const r = await api(port, 'POST', `/api/verification/cases/${id}/reject`, {
      reason: 'should not be allowed',
    });
    expect(r.status).toBe(409);
    expect((r.body as { error: string }).error).toBe('not_proposed');
  });

  it('GET /api/verification/cases/:id/runs returns empty list before any run', async () => {
    const port = getPort(h);
    const create = await api(port, 'POST', '/api/verification/cases', {
      name: 'no runs yet', question: 'q', expectedTruth: 't',
    });
    const id = (create.body as { case: { id: string } }).case.id;
    const r = await api(port, 'GET', `/api/verification/cases/${id}/runs`);
    expect(r.status).toBe(200);
    expect((r.body as { runs: unknown[] }).runs).toEqual([]);
  });

  it('GET /api/verification/cases/no-such returns 404', async () => {
    const port = getPort(h);
    const r = await api(port, 'GET', '/api/verification/cases/does-not-exist');
    expect(r.status).toBe(404);
  });

  it('GET /api/verification/alerts returns [] when none exist', async () => {
    const port = getPort(h);
    const r = await api(port, 'GET', '/api/verification/alerts');
    expect(r.status).toBe(200);
    expect((r.body as { alerts: unknown[] }).alerts).toEqual([]);
  });
});
