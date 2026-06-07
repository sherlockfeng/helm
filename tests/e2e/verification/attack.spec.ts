/**
 * E2e — Verification attack variants (PR 5).
 *
 * Per AGENTS.md §1: ≥3 attacks for the new surface.
 *
 *   1. POST /api/verification/cases without required fields → 400
 *   2. Provider config validation failures (missing apiKey path) —
 *      the loader throws ProviderConfigError, the runner is mockable
 *      so the renderer never panics
 *   3. Malformed JSON judge text — verdict parser does NOT throw,
 *      yields a 0-score permissive verdict
 *   4. Case referencing a deleted point still works (golden FK is
 *      intentionally absent — same design point as PR 2)
 *   5. confirm/reject on a missing case returns 404-like
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { bootE2e, type E2eHarness } from '../_helpers/setup.js';
import { upsertRole } from '../../../src/storage/repos/roles.js';
import {
  ProviderConfigError,
  validateConfig,
} from '../../../src/verification/provider-config.js';
import { parseJudgeVerdict } from '../../../src/verification/runner.js';

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

describe('e2e Verification — attacks', () => {
  let h: E2eHarness;
  beforeEach(async () => { h = await bootE2e(); });
  afterEach(async () => { await h.shutdown(); });

  it('1. POST /api/verification/cases missing required fields returns 400', async () => {
    const port = getPort(h);
    const r = await api(port, 'POST', '/api/verification/cases', { question: 'q' });
    expect(r.status).toBe(400);
  });

  it('2. provider config error class surfaces a precise reason', () => {
    expect(() => validateConfig({})).toThrow(ProviderConfigError);
    try { validateConfig({}); }
    catch (err) {
      expect((err as Error).message).toMatch(/providers/);
    }
  });

  it('3. malformed judge JSON does NOT throw; verdict parser returns a permissive fallback', () => {
    const v = parseJudgeVerdict('the model said yes but I cannot tell why');
    expect(v.score).toBe(0);
    expect(v.summary.length).toBeGreaterThan(0);
  });

  it('4. case keeps its golden pointer even after the point row is deleted', async () => {
    seedRoleAndPoint(h.db, 'r-1', 'p-vaporware');
    const port = getPort(h);
    const create = await api(port, 'POST', '/api/verification/cases', {
      name: 'orphan golden', question: 'q', expectedTruth: 't',
      goldenPointIds: ['p-vaporware'],
    });
    const id = (create.body as { case: { id: string } }).case.id;
    // Delete the knowledge chunk; the golden id survives in the case
    // table because benchmark_case_golden.point_id is NOT a FK (PR 5.1).
    h.db.prepare(`DELETE FROM knowledge_chunks WHERE id = 'p-vaporware'`).run();
    const after = await api(port, 'GET', `/api/verification/cases/${id}`);
    expect(after.status).toBe(200);
    expect((after.body as { case: { goldenPointIds: string[] } }).case.goldenPointIds)
      .toEqual(['p-vaporware']);
  });

  it('5. confirm/reject on a missing case returns 409 not_proposed (no row to flip)', async () => {
    const port = getPort(h);
    const r = await api(port, 'POST', '/api/verification/cases/does-not-exist/confirm');
    expect(r.status).toBe(409);
  });
});
