/**
 * Unit tests for the benchmark repo (PR 5 / migration v21).
 *
 * Covers:
 *   - benchmark_case insert with goldenPointIds + targetRoleIds joins
 *   - default status: llm-on-edit → 'proposed', other sources → 'confirmed'
 *   - R-5: flipCaseStatus only flips from 'proposed'; rejects others
 *   - listCases status/role filtering
 *   - benchmark_run + run_repo_state transactional insert
 *   - regression_alert insert + status update (open → resolved)
 *   - cost audit: separate global vs role rows; add-onto semantics
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import {
  flipCaseStatus,
  getCase,
  getCostForDate,
  getRepoStateForRun,
  insertAlert,
  insertCase,
  insertRun,
  listAlerts,
  listCases,
  listRunsForCase,
  recordCostDelta,
  updateAlertStatus,
  updateCase,
} from '../../../src/storage/repos/benchmark.js';
import { upsertRole } from '../../../src/storage/repos/roles.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedRoleAndChunk(
  db: BetterSqlite3.Database,
  roleId: string,
  pointId: string,
): void {
  upsertRole(db, {
    id: roleId, name: `R-${roleId}`, systemPrompt: 'sp',
    isBuiltin: false, createdAt: new Date().toISOString(),
  });
  db.prepare(`
    INSERT INTO knowledge_chunks (id, role_id, chunk_text, kind, created_at)
    VALUES (?, ?, 'body', 'spec', ?)
  `).run(pointId, roleId, new Date().toISOString());
}

describe('benchmark_case', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => {
    db = openDb();
    seedRoleAndChunk(db, 'r-1', 'p-1');
    seedRoleAndChunk(db, 'r-2', 'p-2');
  });
  afterEach(() => { db.close(); });

  it('insert + getCase round-trips with joined golden + target roles', () => {
    insertCase(db, {
      id: 'c-1', name: 'rollback check',
      question: 'How do I roll back?',
      expectedTruth: 'Pause then wait 60s.',
      goldenPointIds: ['p-1', 'p-2'],
      targetRoleIds: ['r-1', 'r-2'],
      notes: 'manual seed',
    });
    const c = getCase(db, 'c-1');
    expect(c).toBeDefined();
    expect(c!.name).toBe('rollback check');
    expect(c!.goldenPointIds.slice().sort()).toEqual(['p-1', 'p-2']);
    expect(c!.targetRoleIds.slice().sort()).toEqual(['r-1', 'r-2']);
    expect(c!.status).toBe('confirmed'); // default for manual source
    expect(c!.proposedSource).toBe('manual');
  });

  it('default status for llm-on-edit cases is "proposed" (R-5)', () => {
    insertCase(db, {
      id: 'c-llm', name: 'llm proposal',
      question: 'q', expectedTruth: 't',
      proposedSource: 'llm-on-edit',
    });
    expect(getCase(db, 'c-llm')!.status).toBe('proposed');
  });

  it('flipCaseStatus refuses to flip a confirmed case (R-5 hardening)', () => {
    insertCase(db, {
      id: 'c-conf', name: 'already confirmed',
      question: 'q', expectedTruth: 't',
    });
    const ok = flipCaseStatus(db, 'c-conf', 'rejected');
    expect(ok).toBe(false);
    expect(getCase(db, 'c-conf')!.status).toBe('confirmed');
  });

  it('flipCaseStatus advances proposed → confirmed and records confirmedBy + confirmedAt', () => {
    insertCase(db, {
      id: 'c-pp', name: 'proposed', question: 'q', expectedTruth: 't',
      proposedSource: 'llm-on-edit',
    });
    const ok = flipCaseStatus(db, 'c-pp', 'confirmed', 'reviewer@example.com');
    expect(ok).toBe(true);
    const after = getCase(db, 'c-pp')!;
    expect(after.status).toBe('confirmed');
    expect(after.confirmedBy).toBe('reviewer@example.com');
    expect(typeof after.confirmedAt).toBe('number');
  });

  it('flipCaseStatus records rejection reason on proposed → rejected', () => {
    insertCase(db, {
      id: 'c-rej', name: 'to reject', question: 'q', expectedTruth: 't',
      proposedSource: 'llm-on-edit',
    });
    const ok = flipCaseStatus(db, 'c-rej', 'rejected', undefined, 'duplicate of existing case');
    expect(ok).toBe(true);
    const after = getCase(db, 'c-rej')!;
    expect(after.status).toBe('rejected');
    expect(after.rejectedReason).toBe('duplicate of existing case');
  });

  it('listCases filters by status and role and orders by proposed_at DESC', () => {
    insertCase(db, {
      id: 'c-a', name: 'A', question: 'q', expectedTruth: 't',
      targetRoleIds: ['r-1'], proposedAt: 100,
    });
    insertCase(db, {
      id: 'c-b', name: 'B', question: 'q', expectedTruth: 't',
      targetRoleIds: ['r-2'], proposedAt: 200,
    });
    insertCase(db, {
      id: 'c-c', name: 'C', question: 'q', expectedTruth: 't',
      proposedSource: 'llm-on-edit', proposedAt: 300,
    });
    expect(listCases(db).map((c) => c.id)).toEqual(['c-b', 'c-a']);
    expect(listCases(db, { roleId: 'r-1' }).map((c) => c.id)).toEqual(['c-a']);
    const proposed = listCases(db, { status: 'proposed' });
    expect(proposed.map((c) => c.id)).toEqual(['c-c']);
  });
});

describe('updateCase', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => {
    db = openDb();
    seedRoleAndChunk(db, 'r-1', 'p-1');
    seedRoleAndChunk(db, 'r-2', 'p-2');
  });
  afterEach(() => { db.close(); });

  it('returns false for an unknown case id and writes nothing', () => {
    expect(updateCase(db, 'nope', { name: 'x' })).toBe(false);
  });

  it('patches only the provided scalar fields and bumps updated_at', () => {
    insertCase(db, {
      id: 'c-1', name: 'orig', question: 'q-orig', expectedTruth: 't-orig',
      proposedSource: 'llm-on-edit',
    });
    const before = getCase(db, 'c-1')!;
    const ok = updateCase(db, 'c-1', { question: 'q-new' });
    expect(ok).toBe(true);
    const after = getCase(db, 'c-1')!;
    expect(after.question).toBe('q-new');
    expect(after.name).toBe('orig');         // untouched
    expect(after.expectedTruth).toBe('t-orig'); // untouched
    expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
  });

  it('replaces golden + target role joins when provided', () => {
    insertCase(db, {
      id: 'c-2', name: 'n', question: 'q', expectedTruth: 't',
      goldenPointIds: ['p-1'], targetRoleIds: ['r-1'],
      proposedSource: 'llm-on-edit',
    });
    const ok = updateCase(db, 'c-2', {
      goldenPointIds: ['p-2'], targetRoleIds: ['r-2'],
    });
    expect(ok).toBe(true);
    const after = getCase(db, 'c-2')!;
    expect(after.goldenPointIds).toEqual(['p-2']);
    expect(after.targetRoleIds).toEqual(['r-2']);
  });

  it('leaves joins intact when those fields are omitted', () => {
    insertCase(db, {
      id: 'c-3', name: 'n', question: 'q', expectedTruth: 't',
      goldenPointIds: ['p-1'], targetRoleIds: ['r-1'],
      proposedSource: 'llm-on-edit',
    });
    updateCase(db, 'c-3', { name: 'renamed' });
    const after = getCase(db, 'c-3')!;
    expect(after.name).toBe('renamed');
    expect(after.goldenPointIds).toEqual(['p-1']);
    expect(after.targetRoleIds).toEqual(['r-1']);
  });

  it('can clear joins by passing an empty array', () => {
    insertCase(db, {
      id: 'c-4', name: 'n', question: 'q', expectedTruth: 't',
      goldenPointIds: ['p-1'], proposedSource: 'llm-on-edit',
    });
    updateCase(db, 'c-4', { goldenPointIds: [] });
    expect(getCase(db, 'c-4')!.goldenPointIds).toEqual([]);
  });
});

describe('benchmark_run', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => {
    db = openDb();
    seedRoleAndChunk(db, 'r-1', 'p-1');
    insertCase(db, {
      id: 'c-1', name: 'name', question: 'q', expectedTruth: 't',
      goldenPointIds: ['p-1'], targetRoleIds: ['r-1'],
    });
  });
  afterEach(() => { db.close(); });

  it('insertRun persists header + repoState atomically', () => {
    insertRun(db, {
      id: 'run-1', caseId: 'c-1', runAt: 1000,
      answerProviderId: 'openai-mini', judgeProviderId: 'openai-mini',
      recallPct: 100, alignmentPct: 90,
      answerText: 'answer', judgeVerdictText: '{}', judgeVerdictJson: '{}',
      durationMs: 1234,
      knowledgeStateSha: 'abc123',
      isReproducible: true,
      repoState: [
        { repoUrl: 'git@host:org/wiki.git', repoSha: 'sha-A' },
        { repoUrl: 'https://example/other.git', repoSha: 'sha-B' },
      ],
    });
    const runs = listRunsForCase(db, 'c-1');
    expect(runs).toHaveLength(1);
    expect(runs[0]!.knowledgeStateSha).toBe('abc123');
    expect(runs[0]!.isReproducible).toBe(true);
    const repo = getRepoStateForRun(db, 'run-1');
    expect(repo.map((r) => r.repoUrl).sort()).toEqual([
      'git@host:org/wiki.git',
      'https://example/other.git',
    ]);
  });

  it('cascades repoState rows when the run is deleted', () => {
    insertRun(db, {
      id: 'run-2', caseId: 'c-1', runAt: 1000,
      answerProviderId: 'p', judgeProviderId: 'p',
      recallPct: 100, alignmentPct: 90,
      answerText: 'a', judgeVerdictText: 'v', judgeVerdictJson: '{}',
      durationMs: 1, knowledgeStateSha: 'sha', isReproducible: true,
      repoState: [{ repoUrl: 'r', repoSha: 's' }],
    });
    db.prepare(`DELETE FROM benchmark_run WHERE id = 'run-2'`).run();
    expect(getRepoStateForRun(db, 'run-2')).toEqual([]);
  });
});

describe('regression_alert', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => {
    db = openDb();
    seedRoleAndChunk(db, 'r-1', 'p-1');
    insertCase(db, {
      id: 'c-1', name: 'n', question: 'q', expectedTruth: 't',
      goldenPointIds: ['p-1'],
    });
    // Two runs the alert can reference.
    for (const id of ['run-prev', 'run-now'] as const) {
      insertRun(db, {
        id, caseId: 'c-1', runAt: 1,
        answerProviderId: 'p', judgeProviderId: 'p',
        recallPct: 100, alignmentPct: id === 'run-prev' ? 90 : 72,
        answerText: 'a', judgeVerdictText: 'v', judgeVerdictJson: '{}',
        durationMs: 1, knowledgeStateSha: id, isReproducible: true,
      });
    }
  });
  afterEach(() => { db.close(); });

  it('insertAlert creates an open row that listAlerts surfaces by default', () => {
    insertAlert(db, {
      id: 'a-1', caseId: 'c-1',
      prevRunId: 'run-prev', currentRunId: 'run-now',
      prevScore: 90, currentScore: 72, delta: -18,
      triggeringEventKind: 'candidate_accept',
      triggeringEventRefId: 'cand-x',
    });
    expect(listAlerts(db)).toHaveLength(1);
    expect(listAlerts(db, 'open')[0]!.delta).toBe(-18);
  });

  it('updateAlertStatus moves open → resolved + records the note', () => {
    insertAlert(db, {
      id: 'a-2', caseId: 'c-1',
      prevRunId: 'run-prev', currentRunId: 'run-now',
      prevScore: 90, currentScore: 72, delta: -18,
      triggeringEventKind: 'manual', triggeringEventRefId: 'op-x',
    });
    const ok = updateAlertStatus(db, 'a-2', 'resolved', 'fixed by reverting commit');
    expect(ok).toBe(true);
    expect(listAlerts(db)).toEqual([]); // 'open' default no longer matches
    expect(listAlerts(db, 'resolved')[0]!.resolvedNote).toBe('fixed by reverting commit');
  });
});

describe('benchmark_cost_audit', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); });
  afterEach(() => { db.close(); });

  it('global vs role row are tracked separately', () => {
    seedRoleAndChunk(db, 'r-tcc', 'p-1');
    recordCostDelta(db, '2026-06-07', null, 1, 0.05);
    recordCostDelta(db, '2026-06-07', 'r-tcc', 1, 0.05);
    const global = getCostForDate(db, '2026-06-07', null)!;
    const role = getCostForDate(db, '2026-06-07', 'r-tcc')!;
    expect(global.llmCalls).toBe(1);
    expect(role.llmCalls).toBe(1);
    expect(role.roleId).toBe('r-tcc');
  });

  it('recordCostDelta adds onto existing totals on the same (date, role) pair', () => {
    recordCostDelta(db, '2026-06-07', null, 3, 0.30);
    recordCostDelta(db, '2026-06-07', null, 4, 0.42);
    const out = getCostForDate(db, '2026-06-07', null)!;
    expect(out.llmCalls).toBe(7);
    expect(out.estimatedCostUsd).toBeCloseTo(0.72, 6);
  });
});
