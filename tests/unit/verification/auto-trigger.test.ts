/**
 * Unit tests for the auto-trigger orchestration (PR 6.2).
 *
 *   - enqueueAffectedRuns calls the injected runner once per affected
 *     case and aggregates alert ids
 *   - per-trigger cap defers extras into the `deferred` set
 *   - runner errors land in `result.errors` keyed by caseId; sibling
 *     runners still execute
 *   - empty affected list short-circuits before any runner call
 *   - caseAlignmentDeltas computes the (latest - baseline) delta
 *     ignoring reproduce runs
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import {
  insertCase,
  insertRun,
  listRunsForCase,
} from '../../../src/storage/repos/benchmark.js';
import { upsertRole } from '../../../src/storage/repos/roles.js';
import {
  caseAlignmentDeltas,
  enqueueAffectedRuns,
  type RunnerFn,
} from '../../../src/verification/auto-trigger.js';
import type { BenchmarkRun } from '../../../src/storage/types.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedRoleAndPoint(db: BetterSqlite3.Database, roleId: string, pointId: string): void {
  upsertRole(db, {
    id: roleId, name: `R-${roleId}`, systemPrompt: 'sp',
    isBuiltin: false, createdAt: new Date().toISOString(),
  });
  db.prepare(`
    INSERT OR IGNORE INTO knowledge_chunks (id, role_id, chunk_text, kind, created_at)
    VALUES (?, ?, 'body', 'spec', ?)
  `).run(pointId, roleId, new Date().toISOString());
}

function makeRunInserter(
  db: BetterSqlite3.Database,
  alignmentByCase: Record<string, number>,
): RunnerFn {
  return async (caseId): Promise<BenchmarkRun | null> => {
    const alignmentPct = alignmentByCase[caseId] ?? 50;
    const id = `run-${caseId}-${Date.now()}-${Math.random()}`;
    insertRun(db, {
      id, caseId, runAt: Date.now(),
      answerProviderId: 'p', judgeProviderId: 'p',
      recallPct: 100, alignmentPct,
      answerText: 'a', judgeVerdictText: 'v', judgeVerdictJson: '{}',
      durationMs: 1, knowledgeStateSha: id, isReproducible: true,
    });
    return listRunsForCase(db, caseId, 1)[0] ?? null;
  };
}

describe('enqueueAffectedRuns', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => {
    db = openDb();
    seedRoleAndPoint(db, 'r-1', 'p-1');
  });
  afterEach(() => { db.close(); });

  it('runs every affected case and aggregates produced alertIds', async () => {
    insertCase(db, {
      id: 'c-1', name: 'A', question: 'q', expectedTruth: 't',
      goldenPointIds: ['p-1'],
    });
    insertCase(db, {
      id: 'c-2', name: 'B', question: 'q', expectedTruth: 't',
      goldenPointIds: ['p-1'],
    });
    // Seed baseline runs so the next run can register as a regression.
    insertRun(db, {
      id: 'r-c1-prev', caseId: 'c-1', runAt: 1,
      answerProviderId: 'p', judgeProviderId: 'p',
      recallPct: 100, alignmentPct: 90,
      answerText: 'a', judgeVerdictText: 'v', judgeVerdictJson: '{}',
      durationMs: 1, knowledgeStateSha: 'sha', isReproducible: true,
    });
    insertRun(db, {
      id: 'r-c2-prev', caseId: 'c-2', runAt: 1,
      answerProviderId: 'p', judgeProviderId: 'p',
      recallPct: 100, alignmentPct: 90,
      answerText: 'a', judgeVerdictText: 'v', judgeVerdictJson: '{}',
      durationMs: 1, knowledgeStateSha: 'sha', isReproducible: true,
    });

    const runner = makeRunInserter(db, { 'c-1': 70, 'c-2': 88 });
    const result = await enqueueAffectedRuns(db, {
      pointIds: ['p-1'],
      triggeringEventKind: 'candidate_accept',
      triggeringEventRefId: 'cand-x',
      runner,
    });
    expect(result.rerun.sort()).toEqual(['c-1', 'c-2']);
    // 90 → 70 crosses the default -5 threshold → one alert for c-1.
    // 90 → 88 is comfortably above the threshold → no alert for c-2.
    expect(result.alertIds).toHaveLength(1);
  });

  it('caps reruns per trigger and surfaces the rest as deferred', async () => {
    for (let i = 0; i < 7; i++) {
      insertCase(db, {
        id: `c-${i}`, name: `C${i}`, question: 'q', expectedTruth: 't',
        goldenPointIds: ['p-1'],
      });
    }
    const runner = makeRunInserter(db, {});
    const result = await enqueueAffectedRuns(db, {
      pointIds: ['p-1'],
      triggeringEventKind: 'candidate_accept',
      triggeringEventRefId: 'x',
      runner,
      maxRunsPerTrigger: 3,
    });
    expect(result.rerun).toHaveLength(3);
    expect(result.deferred).toHaveLength(4);
    expect(new Set([...result.rerun, ...result.deferred]).size).toBe(7);
  });

  it('a runner that throws is captured per-case; siblings still run', async () => {
    insertCase(db, {
      id: 'c-ok',   name: 'ok',   question: 'q', expectedTruth: 't',
      goldenPointIds: ['p-1'],
    });
    insertCase(db, {
      id: 'c-fail', name: 'fail', question: 'q', expectedTruth: 't',
      goldenPointIds: ['p-1'],
    });
    const successInserter = makeRunInserter(db, { 'c-ok': 80 });
    const runner: RunnerFn = async (caseId) => {
      if (caseId === 'c-fail') throw new Error('runner kaput');
      return successInserter(caseId);
    };
    const result = await enqueueAffectedRuns(db, {
      pointIds: ['p-1'],
      triggeringEventKind: 'manual', triggeringEventRefId: 'op',
      runner,
    });
    expect(result.rerun).toEqual(['c-ok']);
    expect(result.errors['c-fail']).toBe('runner kaput');
  });

  it('empty affected set short-circuits without invoking the runner', async () => {
    const runner = vi.fn(makeRunInserter(db, {}));
    const result = await enqueueAffectedRuns(db, {
      pointIds: ['nothing-matches-this'],
      triggeringEventKind: 'manual', triggeringEventRefId: 'op',
      runner,
    });
    expect(result.rerun).toEqual([]);
    expect(runner).not.toHaveBeenCalled();
  });
});

describe('caseAlignmentDeltas', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => {
    db = openDb();
    seedRoleAndPoint(db, 'r-1', 'p-1');
    insertCase(db, {
      id: 'c-d', name: 'D', question: 'q', expectedTruth: 't',
      goldenPointIds: ['p-1'],
    });
  });
  afterEach(() => { db.close(); });

  it('computes latest - baseline and skips reproduce runs', () => {
    insertRun(db, {
      id: 'r-1', caseId: 'c-d', runAt: 100,
      answerProviderId: 'p', judgeProviderId: 'p',
      recallPct: 100, alignmentPct: 90,
      answerText: 'a', judgeVerdictText: 'v', judgeVerdictJson: '{}',
      durationMs: 1, knowledgeStateSha: 'a', isReproducible: true,
    });
    insertRun(db, {
      id: 'r-2', caseId: 'c-d', runAt: 200,
      answerProviderId: 'p', judgeProviderId: 'p',
      recallPct: 100, alignmentPct: 40,
      answerText: 'a', judgeVerdictText: 'v', judgeVerdictJson: '{}',
      durationMs: 1, knowledgeStateSha: 'b', isReproducible: true,
      reproducedFromRunId: 'r-1',
    });
    insertRun(db, {
      id: 'r-3', caseId: 'c-d', runAt: 300,
      answerProviderId: 'p', judgeProviderId: 'p',
      recallPct: 100, alignmentPct: 78,
      answerText: 'a', judgeVerdictText: 'v', judgeVerdictJson: '{}',
      durationMs: 1, knowledgeStateSha: 'c', isReproducible: true,
    });
    // Real runs: r-1=90, r-3=78. delta = 78 - 90 = -12.
    const out = caseAlignmentDeltas(db, ['c-d']);
    expect(out[0]!.latest).toBe(78);
    expect(out[0]!.baseline).toBe(90);
    expect(out[0]!.delta).toBe(-12);
  });

  it('returns just `latest` when only one real run exists', () => {
    insertRun(db, {
      id: 'r-only', caseId: 'c-d', runAt: 100,
      answerProviderId: 'p', judgeProviderId: 'p',
      recallPct: 100, alignmentPct: 65,
      answerText: 'a', judgeVerdictText: 'v', judgeVerdictJson: '{}',
      durationMs: 1, knowledgeStateSha: 'a', isReproducible: true,
    });
    const out = caseAlignmentDeltas(db, ['c-d']);
    expect(out[0]!.latest).toBe(65);
    expect(out[0]!.baseline).toBeUndefined();
    expect(out[0]!.delta).toBeUndefined();
  });
});
