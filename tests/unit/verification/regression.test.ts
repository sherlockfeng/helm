/**
 * Unit tests for the regression detection (PR 6.1).
 *
 * Covered:
 *   - selectAffectedCases by goldenPointId, by targetRoleId, both
 *   - proposed cases never appear (R-5)
 *   - empty input no-ops
 *   - detectRegression compares against most recent non-reproduce run
 *   - threshold is honored (>threshold = no alert, ≤threshold = alert)
 *   - reproduce runs never trigger an alert
 *   - cases without prior runs never trigger
 *   - configurable threshold override
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import {
  insertCase,
  insertRun,
  listAlerts,
  listRunsForCase,
} from '../../../src/storage/repos/benchmark.js';
import { upsertRole } from '../../../src/storage/repos/roles.js';
import {
  detectRegression,
  REGRESSION_DELTA_THRESHOLD,
  selectAffectedCases,
} from '../../../src/verification/regression.js';

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

function insertRunForCase(
  db: BetterSqlite3.Database,
  caseId: string,
  id: string,
  alignmentPct: number,
  opts: { reproducedFromRunId?: string; runAt?: number } = {},
): void {
  insertRun(db, {
    id, caseId, runAt: opts.runAt ?? Date.now(),
    answerProviderId: 'p', judgeProviderId: 'p',
    recallPct: 100, alignmentPct,
    answerText: 'a', judgeVerdictText: 'v', judgeVerdictJson: '{}',
    durationMs: 1, knowledgeStateSha: id, isReproducible: true,
    ...(opts.reproducedFromRunId ? { reproducedFromRunId: opts.reproducedFromRunId } : {}),
  });
}

describe('selectAffectedCases', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => {
    db = openDb();
    seedRoleAndPoint(db, 'r-1', 'p-1');
    seedRoleAndPoint(db, 'r-2', 'p-2');
  });
  afterEach(() => { db.close(); });

  it('matches by goldenPointId', () => {
    insertCase(db, {
      id: 'c-a', name: 'A', question: 'q', expectedTruth: 't',
      goldenPointIds: ['p-1'],
    });
    insertCase(db, {
      id: 'c-b', name: 'B', question: 'q', expectedTruth: 't',
      goldenPointIds: ['p-2'],
    });
    const out = selectAffectedCases(db, { pointIds: ['p-1'] });
    expect(out.map((c) => c.id)).toEqual(['c-a']);
  });

  it('matches by targetRoleId', () => {
    insertCase(db, {
      id: 'c-r1', name: 'R1', question: 'q', expectedTruth: 't',
      targetRoleIds: ['r-1'],
    });
    insertCase(db, {
      id: 'c-r2', name: 'R2', question: 'q', expectedTruth: 't',
      targetRoleIds: ['r-2'],
    });
    const out = selectAffectedCases(db, { roleIds: ['r-1'] });
    expect(out.map((c) => c.id)).toEqual(['c-r1']);
  });

  it('dedupes when a single case matches via BOTH point and role', () => {
    insertCase(db, {
      id: 'c-both', name: 'B', question: 'q', expectedTruth: 't',
      goldenPointIds: ['p-1'], targetRoleIds: ['r-1'],
    });
    const out = selectAffectedCases(db, { pointIds: ['p-1'], roleIds: ['r-1'] });
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('c-both');
  });

  it('excludes proposed cases (R-5)', () => {
    insertCase(db, {
      id: 'c-prop', name: 'P', question: 'q', expectedTruth: 't',
      goldenPointIds: ['p-1'], proposedSource: 'llm-on-edit',
    });
    const out = selectAffectedCases(db, { pointIds: ['p-1'] });
    expect(out).toEqual([]);
  });

  it('empty input returns []', () => {
    insertCase(db, { id: 'c-x', name: 'X', question: 'q', expectedTruth: 't' });
    expect(selectAffectedCases(db, {})).toEqual([]);
    expect(selectAffectedCases(db, { pointIds: [] })).toEqual([]);
  });
});

describe('detectRegression', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => {
    db = openDb();
    seedRoleAndPoint(db, 'r-1', 'p-1');
    insertCase(db, {
      id: 'c-1', name: 'n', question: 'q', expectedTruth: 't',
      goldenPointIds: ['p-1'],
    });
  });
  afterEach(() => { db.close(); });

  it('inserts an alert when delta crosses the default threshold', () => {
    insertRunForCase(db, 'c-1', 'r-prev', 90, { runAt: 100 });
    insertRunForCase(db, 'c-1', 'r-now',  72, { runAt: 200 });
    const currentRun = listRunsForCase(db, 'c-1', 1)[0]!;
    const out = detectRegression(db, {
      currentRun,
      triggeringEventKind: 'candidate_accept',
      triggeringEventRefId: 'cand-x',
    });
    expect(out).not.toBeNull();
    expect(listAlerts(db)).toHaveLength(1);
    expect(listAlerts(db)[0]!.delta).toBeCloseTo(-18);
  });

  it('does NOT alert when the drop is below threshold magnitude', () => {
    insertRunForCase(db, 'c-1', 'r-prev', 90, { runAt: 100 });
    insertRunForCase(db, 'c-1', 'r-now',  88, { runAt: 200 });
    const currentRun = listRunsForCase(db, 'c-1', 1)[0]!;
    expect(detectRegression(db, {
      currentRun,
      triggeringEventKind: 'manual', triggeringEventRefId: 'op',
    })).toBeNull();
    expect(listAlerts(db)).toEqual([]);
  });

  it('reproduce runs never trigger an alert even with massive drops', () => {
    insertRunForCase(db, 'c-1', 'r-prev', 90, { runAt: 100 });
    insertRunForCase(db, 'c-1', 'r-repro', 10, {
      runAt: 200, reproducedFromRunId: 'r-prev',
    });
    const currentRun = listRunsForCase(db, 'c-1', 1)[0]!;
    expect(detectRegression(db, {
      currentRun,
      triggeringEventKind: 'manual', triggeringEventRefId: 'op',
    })).toBeNull();
  });

  it('reproduce runs are skipped when scanning for the baseline', () => {
    // Inserting: real(prev=90) → reproduce(40) → real(now=80). The
    // detector should compare real(now)=80 against real(prev)=90 and
    // see only a -10 delta — comfortably above threshold.
    insertRunForCase(db, 'c-1', 'r-prev', 90, { runAt: 100 });
    insertRunForCase(db, 'c-1', 'r-rep',  40, {
      runAt: 200, reproducedFromRunId: 'r-prev',
    });
    insertRunForCase(db, 'c-1', 'r-now',  80, { runAt: 300 });
    const currentRun = listRunsForCase(db, 'c-1', 1)[0]!;
    expect(detectRegression(db, {
      currentRun,
      triggeringEventKind: 'manual', triggeringEventRefId: 'op',
    })).toBeNull();
  });

  it('first run of a case has no baseline → null', () => {
    insertRunForCase(db, 'c-1', 'r-first', 50, { runAt: 100 });
    const currentRun = listRunsForCase(db, 'c-1', 1)[0]!;
    expect(detectRegression(db, {
      currentRun,
      triggeringEventKind: 'manual', triggeringEventRefId: 'op',
    })).toBeNull();
  });

  it('threshold override flips a borderline non-alert into an alert', () => {
    insertRunForCase(db, 'c-1', 'r-prev', 90, { runAt: 100 });
    insertRunForCase(db, 'c-1', 'r-now',  88, { runAt: 200 });
    const currentRun = listRunsForCase(db, 'c-1', 1)[0]!;
    const out = detectRegression(db, {
      currentRun,
      triggeringEventKind: 'manual', triggeringEventRefId: 'op',
      threshold: -1, // 1-point drop is enough
    });
    expect(out).not.toBeNull();
  });

  it('default threshold is -5 (sanity check on the public constant)', () => {
    expect(REGRESSION_DELTA_THRESHOLD).toBe(-5);
  });
});
