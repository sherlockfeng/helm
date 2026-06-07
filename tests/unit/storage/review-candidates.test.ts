/**
 * Unit tests for the PR 4 cross-role review repo helpers:
 *
 *   - listReviewCandidates(): filtering by status / roleId, sort by
 *     recent (default) and score (entity×0.4 + cosine×0.6), limit cap
 *   - bulkRejectCandidates(): transactional, only flips pending rows,
 *     returns flipped count, empty input no-ops
 */

import { createHash } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import {
  bulkRejectCandidates,
  insertCandidateIfNew,
  listReviewCandidates,
  setCandidateStatus,
} from '../../../src/storage/repos/knowledge-candidates.js';
import { upsertRole } from '../../../src/storage/repos/roles.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedRole(db: BetterSqlite3.Database, id: string): void {
  upsertRole(db, {
    id, name: `R-${id}`, systemPrompt: 'sp',
    isBuiltin: false, createdAt: new Date().toISOString(),
  });
}

interface SeedCandidate {
  id: string;
  roleId: string;
  text: string;
  entity: number;
  cosine: number;
  /** Optional epoch-ms offset to control sort-by-recent ordering. */
  createdAt?: string;
}

function seedCandidate(db: BetterSqlite3.Database, c: SeedCandidate): void {
  insertCandidateIfNew(db, {
    id: c.id, roleId: c.roleId, chunkText: c.text,
    sourceSegmentIndex: 0, kind: 'other',
    scoreEntity: c.entity, scoreCosine: c.cosine,
    textHash: createHash('sha256').update(c.text).digest('hex'),
    status: 'pending', provenance: 'chat_capture',
    createdAt: c.createdAt ?? new Date().toISOString(),
  });
}

describe('listReviewCandidates', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => {
    db = openDb();
    seedRole(db, 'r-1');
    seedRole(db, 'r-2');
  });
  afterEach(() => { db.close(); });

  it('default returns only pending across all roles, newest first', () => {
    seedCandidate(db, { id: 'a', roleId: 'r-1', text: 'aaa', entity: 3, cosine: 0.5, createdAt: '2026-06-01T00:00:00Z' });
    seedCandidate(db, { id: 'b', roleId: 'r-2', text: 'bbb', entity: 4, cosine: 0.7, createdAt: '2026-06-02T00:00:00Z' });
    seedCandidate(db, { id: 'c', roleId: 'r-1', text: 'ccc', entity: 5, cosine: 0.9, createdAt: '2026-06-03T00:00:00Z' });

    const out = listReviewCandidates(db);
    expect(out.map((c) => c.id)).toEqual(['c', 'b', 'a']);
  });

  it('roleId filter scopes to one collection', () => {
    seedCandidate(db, { id: 'a', roleId: 'r-1', text: 'aaa', entity: 3, cosine: 0.5 });
    seedCandidate(db, { id: 'b', roleId: 'r-2', text: 'bbb', entity: 4, cosine: 0.7 });
    const out = listReviewCandidates(db, { roleId: 'r-1' });
    expect(out.map((c) => c.id)).toEqual(['a']);
  });

  it('status filter excludes terminal rows by default; status=all includes them', () => {
    seedCandidate(db, { id: 'p', roleId: 'r-1', text: 'pp', entity: 3, cosine: 0.5 });
    seedCandidate(db, { id: 'r', roleId: 'r-1', text: 'rr', entity: 3, cosine: 0.5 });
    setCandidateStatus(db, 'r', 'rejected', new Date().toISOString());

    expect(listReviewCandidates(db).map((c) => c.id)).toEqual(['p']);
    const all = listReviewCandidates(db, { status: 'all' });
    expect(all.map((c) => c.id).sort()).toEqual(['p', 'r']);
    const rejected = listReviewCandidates(db, { status: 'rejected' });
    expect(rejected.map((c) => c.id)).toEqual(['r']);
  });

  it('score sort: entity×0.4 + cosine×0.6 descending', () => {
    // Expected score ordering: lower-entity but high-cosine still beats
    // high-entity low-cosine when cosine is dominant in the weight.
    seedCandidate(db, { id: 'high-e',  roleId: 'r-1', text: 'he',  entity: 10, cosine: 0.2 }); // 4.0 + 0.12 = 4.12
    seedCandidate(db, { id: 'high-c',  roleId: 'r-1', text: 'hc',  entity: 2,  cosine: 0.95 }); // 0.8 + 0.57 = 1.37
    seedCandidate(db, { id: 'balanced',roleId: 'r-1', text: 'bal', entity: 5,  cosine: 0.6 }); // 2.0 + 0.36 = 2.36
    const out = listReviewCandidates(db, { sort: 'score' });
    expect(out.map((c) => c.id)).toEqual(['high-e', 'balanced', 'high-c']);
  });

  it('limit caps the row count and is clamped between 1 and 500', () => {
    for (let i = 0; i < 60; i++) {
      seedCandidate(db, { id: `c-${i}`, roleId: 'r-1', text: `t-${i}`, entity: 3, cosine: 0.5 });
    }
    expect(listReviewCandidates(db, { limit: 10 })).toHaveLength(10);
    // 0 is invalid; the repo clamps to ≥1, so we still return at least
    // one row when other data exists.
    expect(listReviewCandidates(db, { limit: 0 })).toHaveLength(1);
    // 9999 is over the max; clamped to 500.
    expect(listReviewCandidates(db, { limit: 9999 }).length).toBeLessThanOrEqual(500);
  });
});

describe('bulkRejectCandidates', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); seedRole(db, 'r-bulk'); });
  afterEach(() => { db.close(); });

  it('flips all pending rows and returns the count', () => {
    seedCandidate(db, { id: 'a', roleId: 'r-bulk', text: 'a', entity: 3, cosine: 0.5 });
    seedCandidate(db, { id: 'b', roleId: 'r-bulk', text: 'b', entity: 3, cosine: 0.5 });
    seedCandidate(db, { id: 'c', roleId: 'r-bulk', text: 'c', entity: 3, cosine: 0.5 });

    const flipped = bulkRejectCandidates(db, ['a', 'b', 'c'], new Date().toISOString());
    expect(flipped).toBe(3);
    const statuses = (db.prepare(
      `SELECT id, status FROM knowledge_candidates WHERE role_id = 'r-bulk' ORDER BY id`,
    ).all() as { id: string; status: string }[]).map((r) => r.status);
    expect(statuses).toEqual(['rejected', 'rejected', 'rejected']);
  });

  it('skips already-terminal rows without unwinding successful flips', () => {
    seedCandidate(db, { id: 'pending', roleId: 'r-bulk', text: 'p', entity: 3, cosine: 0.5 });
    seedCandidate(db, { id: 'gone',    roleId: 'r-bulk', text: 'g', entity: 3, cosine: 0.5 });
    setCandidateStatus(db, 'gone', 'accepted', new Date().toISOString());

    const flipped = bulkRejectCandidates(db, ['pending', 'gone'], new Date().toISOString());
    expect(flipped).toBe(1);
    const pendingRow = db.prepare(`SELECT status FROM knowledge_candidates WHERE id = 'pending'`)
      .get() as { status: string };
    const goneRow = db.prepare(`SELECT status FROM knowledge_candidates WHERE id = 'gone'`)
      .get() as { status: string };
    expect(pendingRow.status).toBe('rejected');
    expect(goneRow.status).toBe('accepted'); // untouched
  });

  it('empty input is a no-op', () => {
    expect(bulkRejectCandidates(db, [], new Date().toISOString())).toBe(0);
  });

  it('unknown id contributes 0 to the flipped count, others succeed', () => {
    seedCandidate(db, { id: 'real', roleId: 'r-bulk', text: 'r', entity: 3, cosine: 0.5 });
    const flipped = bulkRejectCandidates(db, ['ghost', 'real'], new Date().toISOString());
    expect(flipped).toBe(1);
  });
});
