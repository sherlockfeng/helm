/**
 * E2e — auto-trigger after candidate accept (PR 6).
 *
 * Wires a real HelmApp with an injected fake VerificationRunner so the
 * accept path can fire without needing a real LLM provider. Proves:
 *
 *   - When a candidate is accepted, the runner is invoked once per
 *     affected case (matched via the role binding)
 *   - The runner's prior + new runs combine into a regression_alert
 *     when the score drops past threshold
 *   - The HTTP response for the accept itself is NOT blocked on the
 *     runner — it returns success immediately and the trigger runs
 *     in the background; we poll for the side-effects
 *   - GET /api/verification/counts surfaces the open alert count
 *     after the trigger fires
 */

import { createHash } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootE2e, type E2eHarness } from '../_helpers/setup.js';
import {
  insertCase,
  insertRun,
} from '../../../src/storage/repos/benchmark.js';
import { insertCandidateIfNew } from '../../../src/storage/repos/knowledge-candidates.js';
import { upsertRole } from '../../../src/storage/repos/roles.js';
import type { BenchmarkRun } from '../../../src/storage/types.js';

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

describe('e2e auto-trigger — happy', () => {
  let h: E2eHarness;
  /** caseIds the fake runner has been asked to execute. */
  const triggered: string[] = [];
  /** alignment score the fake runner records for each new run. */
  const fakeAlignmentByCase: Record<string, number> = {};

  beforeEach(async () => {
    triggered.length = 0;
    for (const k of Object.keys(fakeAlignmentByCase)) delete fakeAlignmentByCase[k];
    h = await bootE2e({
      deps: {
        verificationRunner: async (caseId: string): Promise<BenchmarkRun | null> => {
          triggered.push(caseId);
          const alignmentPct = fakeAlignmentByCase[caseId] ?? 50;
          const id = `fake-run-${caseId}-${Date.now()}-${Math.random()}`;
          insertRun(h.db, {
            id, caseId, runAt: Date.now(),
            answerProviderId: 'fake', judgeProviderId: 'fake',
            recallPct: 100, alignmentPct,
            answerText: 'a', judgeVerdictText: 'v', judgeVerdictJson: '{}',
            durationMs: 1, knowledgeStateSha: id, isReproducible: true,
          });
          return {
            id, caseId, runAt: Date.now(),
            answerProviderId: 'fake', judgeProviderId: 'fake',
            recallPct: 100, alignmentPct,
            answerText: 'a', judgeVerdictText: 'v', judgeVerdictJson: '{}',
            durationMs: 1, knowledgeStateSha: id, isReproducible: true,
          };
        },
      },
    });
  });
  afterEach(async () => { await h.shutdown(); });

  it('candidate accept triggers runs for cases bound to the same role', async () => {
    seedRoleAndChunk(h.db, 'r-tcc', 'p-tcc');
    insertCase(h.db, {
      id: 'case-tcc-1', name: 'TCC case', question: 'q', expectedTruth: 't',
      goldenPointIds: ['p-tcc'], targetRoleIds: ['r-tcc'],
    });
    const port = getPort(h);

    const body = 'rollback steps: pause, wait, resume';
    const hash = createHash('sha256').update(body).digest('hex');
    insertCandidateIfNew(h.db, {
      id: 'cand-1', roleId: 'r-tcc', chunkText: body,
      sourceSegmentIndex: 0, kind: 'runbook',
      scoreEntity: 4, scoreCosine: 0.8, textHash: hash,
      status: 'pending', provenance: 'chat_capture',
      createdAt: new Date().toISOString(),
    });

    const r = await api(port, 'POST', '/api/knowledge-candidates/cand-1/accept');
    expect(r.status).toBe(200);

    // The accept response is not blocked on the trigger. Poll briefly
    // (a few ms is plenty in CI under the in-process runner).
    const deadline = Date.now() + 2000;
    while (triggered.length === 0 && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 25));
    }
    expect(triggered).toEqual(['case-tcc-1']);
  });

  it('a triggered run that scores worse opens a regression alert; counts endpoint reflects it', async () => {
    seedRoleAndChunk(h.db, 'r-reg', 'p-reg');
    insertCase(h.db, {
      id: 'case-reg', name: 'reg', question: 'q', expectedTruth: 't',
      goldenPointIds: ['p-reg'], targetRoleIds: ['r-reg'],
    });
    // Baseline run scored 92.
    insertRun(h.db, {
      id: 'baseline', caseId: 'case-reg', runAt: 1,
      answerProviderId: 'fake', judgeProviderId: 'fake',
      recallPct: 100, alignmentPct: 92,
      answerText: 'a', judgeVerdictText: 'v', judgeVerdictJson: '{}',
      durationMs: 1, knowledgeStateSha: 'baseline', isReproducible: true,
    });
    // Make the auto-triggered run score badly so the regression detector fires.
    fakeAlignmentByCase['case-reg'] = 60;

    const port = getPort(h);
    const body = 'updated knowledge that contradicts the baseline';
    const hash = createHash('sha256').update(body).digest('hex');
    insertCandidateIfNew(h.db, {
      id: 'cand-r', roleId: 'r-reg', chunkText: body,
      sourceSegmentIndex: 0, kind: 'other',
      scoreEntity: 3, scoreCosine: 0.7, textHash: hash,
      status: 'pending', provenance: 'chat_capture',
      createdAt: new Date().toISOString(),
    });
    await api(port, 'POST', '/api/knowledge-candidates/cand-r/accept');

    const deadline = Date.now() + 2000;
    while (triggered.length === 0 && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 25));
    }
    // Allow the alert insert to land.
    await new Promise((res) => setTimeout(res, 50));

    const counts = await api(port, 'GET', '/api/verification/counts');
    expect(counts.status).toBe(200);
    expect((counts.body as { openAlerts: number }).openAlerts).toBe(1);
    const alerts = await api(port, 'GET', '/api/verification/alerts');
    const a = (alerts.body as { alerts: { delta: number; triggeringEventKind: string }[] }).alerts[0]!;
    expect(a.delta).toBeCloseTo(60 - 92);
    expect(a.triggeringEventKind).toBe('candidate_accept');
  });

  it('without a runner injected (default deps), accept still works and no trigger fires', async () => {
    await h.shutdown();
    h = await bootE2e(); // no verificationRunner this time
    seedRoleAndChunk(h.db, 'r-norunner', 'p-norunner');
    insertCase(h.db, {
      id: 'case-nr', name: 'nr', question: 'q', expectedTruth: 't',
      goldenPointIds: ['p-norunner'], targetRoleIds: ['r-norunner'],
    });
    const port = getPort(h);
    const body = 'a perfectly fine candidate';
    const hash = createHash('sha256').update(body).digest('hex');
    insertCandidateIfNew(h.db, {
      id: 'cand-nr', roleId: 'r-norunner', chunkText: body,
      sourceSegmentIndex: 0, kind: 'other',
      scoreEntity: 3, scoreCosine: 0.7, textHash: hash,
      status: 'pending', provenance: 'chat_capture',
      createdAt: new Date().toISOString(),
    });
    const r = await api(port, 'POST', '/api/knowledge-candidates/cand-nr/accept');
    expect(r.status).toBe(200);
    // Without the runner the trigger is a no-op: zero runs landed
    // for the case beyond what we manually seed (which is none here).
    const runs = h.db.prepare(`SELECT COUNT(*) AS n FROM benchmark_run WHERE case_id = 'case-nr'`)
      .get() as { n: number };
    expect(runs.n).toBe(0);
  });
});
