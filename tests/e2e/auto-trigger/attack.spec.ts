/**
 * E2e — auto-trigger attack surface (R-15).
 *
 * The happy-path spec covers single-candidate flows; this file adds
 * the adversarial cases that the per-case lock + cap mechanics in
 * `enqueueAffectedRuns` exist to defend against. Real HelmApp with an
 * injected fake runner so we exercise the actual orchestration glue
 * end-to-end, not just the unit-level Promise chain.
 */

import { createHash } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootE2e, type E2eHarness } from '../_helpers/setup.js';
import { insertCase, insertRun, listRunsForCase } from '../../../src/storage/repos/benchmark.js';
import { insertCandidateIfNew } from '../../../src/storage/repos/knowledge-candidates.js';
import { upsertRole } from '../../../src/storage/repos/roles.js';
import { _resetCaseLocksForTests } from '../../../src/verification/auto-trigger.js';
import type { BenchmarkRun } from '../../../src/storage/types.js';

interface JsonResponse { status: number; body: unknown }
async function api(
  port: number, method: 'GET' | 'POST', path: string, body?: unknown,
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

function seedRoleAndChunk(db: BetterSqlite3.Database, roleId: string, chunkId: string): void {
  upsertRole(db, {
    id: roleId, name: `R-${roleId}`, systemPrompt: 'sp',
    isBuiltin: false, createdAt: new Date().toISOString(),
  });
  db.prepare(`
    INSERT INTO knowledge_chunks (id, role_id, chunk_text, kind, created_at)
    VALUES (?, ?, 'body', 'spec', ?)
  `).run(chunkId, roleId, new Date().toISOString());
}

describe('e2e auto-trigger — attacks (R-15)', () => {
  let h: E2eHarness;
  let inFlight = 0;
  let maxInFlight = 0;

  beforeEach(async () => {
    _resetCaseLocksForTests();
    inFlight = 0;
    maxInFlight = 0;
    h = await bootE2e({
      deps: {
        verificationRunner: async (caseId: string): Promise<BenchmarkRun | null> => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          try {
            // Hold long enough that two concurrent triggers definitely
            // overlap if the lock is broken.
            await new Promise((r) => setTimeout(r, 25));
            const id = `attack-run-${caseId}-${Date.now()}-${Math.random()}`;
            const run: BenchmarkRun = {
              id, caseId, runAt: Date.now(),
              answerProviderId: 'fake', judgeProviderId: 'fake',
              recallPct: 100, alignmentPct: 80,
              answerText: 'a', judgeVerdictText: 'v', judgeVerdictJson: '{}',
              durationMs: 1, knowledgeStateSha: id, isReproducible: true,
            };
            insertRun(h.db, run);
            return run;
          } finally { inFlight -= 1; }
        },
      },
    });
  });
  afterEach(async () => {
    await h.shutdown();
    _resetCaseLocksForTests();
  });

  it('two concurrent accepts against the same role never overlap inside the runner', async () => {
    seedRoleAndChunk(h.db, 'r-lock', 'p-lock');
    insertCase(h.db, {
      id: 'case-lock', name: 'L', question: 'q', expectedTruth: 't',
      goldenPointIds: ['p-lock'], targetRoleIds: ['r-lock'],
    });
    const port = getPort(h);

    // Two distinct candidates, both targeting the same role → both
    // trigger the same affected case. With the per-case lock, the
    // runner sees them strictly serial.
    const seed = (i: number): void => {
      const body = `body ${i}`;
      insertCandidateIfNew(h.db, {
        id: `cand-${i}`, roleId: 'r-lock', chunkText: body,
        sourceSegmentIndex: 0, kind: 'other',
        scoreEntity: 3, scoreCosine: 0.7,
        textHash: createHash('sha256').update(body).digest('hex'),
        status: 'pending', provenance: 'chat_capture',
        createdAt: new Date().toISOString(),
      });
    };
    seed(1); seed(2);

    const [a, b] = await Promise.all([
      api(port, 'POST', '/api/knowledge-candidates/cand-1/accept'),
      api(port, 'POST', '/api/knowledge-candidates/cand-2/accept'),
    ]);
    // At least one accept must succeed; the other may legitimately
    // 409 on a candidate-table UNIQUE constraint. The load-bearing
    // assertion below is maxInFlight === 1.
    expect([200, 409]).toContain(a.status);
    expect([200, 409]).toContain(b.status);
    expect([a.status, b.status]).toContain(200);

    // Auto-trigger fires in the background; poll until at least one
    // run lands. The lock is what we're really proving.
    const deadline = Date.now() + 4000;
    while (listRunsForCase(h.db, 'case-lock', 5).length < 1 && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 25));
    }
    expect(listRunsForCase(h.db, 'case-lock', 5).length).toBeGreaterThanOrEqual(1);
    expect(maxInFlight).toBe(1);
  }, 15_000);

  it('a runner that throws on one case does not poison other cases', async () => {
    // Build two cases targeting the same role. The runner will be
    // wrapped to throw for the first case only.
    seedRoleAndChunk(h.db, 'r-mix', 'p-mix');
    insertCase(h.db, {
      id: 'case-good', name: 'good', question: 'q', expectedTruth: 't',
      goldenPointIds: ['p-mix'], targetRoleIds: ['r-mix'],
    });
    insertCase(h.db, {
      id: 'case-bad', name: 'bad', question: 'q', expectedTruth: 't',
      goldenPointIds: ['p-mix'], targetRoleIds: ['r-mix'],
    });
    // Rewire the runner to throw on case-bad.
    await h.shutdown();
    _resetCaseLocksForTests();
    h = await bootE2e({
      deps: {
        verificationRunner: async (caseId: string): Promise<BenchmarkRun | null> => {
          if (caseId === 'case-bad') throw new Error('runner kaput');
          const id = `mix-${caseId}-${Date.now()}`;
          const run: BenchmarkRun = {
            id, caseId, runAt: Date.now(),
            answerProviderId: 'fake', judgeProviderId: 'fake',
            recallPct: 100, alignmentPct: 80,
            answerText: 'a', judgeVerdictText: 'v', judgeVerdictJson: '{}',
            durationMs: 1, knowledgeStateSha: id, isReproducible: true,
          };
          insertRun(h.db, run);
          return run;
        },
      },
    });
    // Re-seed after the shutdown wiped the DB.
    seedRoleAndChunk(h.db, 'r-mix', 'p-mix');
    insertCase(h.db, {
      id: 'case-good', name: 'good', question: 'q', expectedTruth: 't',
      goldenPointIds: ['p-mix'], targetRoleIds: ['r-mix'],
    });
    insertCase(h.db, {
      id: 'case-bad', name: 'bad', question: 'q', expectedTruth: 't',
      goldenPointIds: ['p-mix'], targetRoleIds: ['r-mix'],
    });

    const port = getPort(h);
    const body = 'mixed';
    insertCandidateIfNew(h.db, {
      id: 'cand-mix', roleId: 'r-mix', chunkText: body,
      sourceSegmentIndex: 0, kind: 'other',
      scoreEntity: 3, scoreCosine: 0.7,
      textHash: createHash('sha256').update(body).digest('hex'),
      status: 'pending', provenance: 'chat_capture',
      createdAt: new Date().toISOString(),
    });
    await api(port, 'POST', '/api/knowledge-candidates/cand-mix/accept');

    // case-good's run must still land despite case-bad's runner throw.
    const deadline = Date.now() + 4000;
    while (listRunsForCase(h.db, 'case-good', 1).length === 0 && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 25));
    }
    expect(listRunsForCase(h.db, 'case-good', 1).length).toBe(1);
    expect(listRunsForCase(h.db, 'case-bad',  1).length).toBe(0);
  }, 15_000);
});
