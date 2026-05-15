/**
 * Candidate-writer (Phase 78).
 *
 * Pins:
 *   - first insert succeeds and returns inserted=true
 *   - second insert of same (roleId, chunkText) while pending → inserted=false
 *   - rejected row still blocks re-insert (Decision §8: reject is terminal)
 *   - different roleId same text → BOTH insert (cross-role dedup is OFF)
 *   - text_hash is sha256 of chunkText (verifiable, not random)
 *   - hostSessionId is optional and round-trips when set
 *   - one-character edit → different hash → insertable
 */

import { createHash } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { insertSource, upsertRole } from '../../../src/storage/repos/roles.js';
import { upsertHostSession } from '../../../src/storage/repos/host-sessions.js';
import { writeCandidateIfNew } from '../../../src/capture/candidate-writer.js';
import {
  getCandidateById,
  listCandidatesForRole,
  setCandidateStatus,
} from '../../../src/storage/repos/knowledge-candidates.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seed(db: BetterSqlite3.Database, roleId = 'r1'): void {
  const now = new Date().toISOString();
  upsertRole(db, { id: roleId, name: roleId, systemPrompt: 'p', isBuiltin: false, createdAt: now });
  insertSource(db, {
    id: `${roleId}-src1`, roleId, kind: 'file', origin: 'spec.md',
    fingerprint: 'fp', createdAt: now,
  });
  // BASE_INPUT references hostSessionId: 'chat-1'; the FK requires the
  // row to exist. Idempotent (UPSERT) so calling seed twice works.
  upsertHostSession(db, {
    id: 'chat-1', host: 'cursor', status: 'active',
    firstSeenAt: now, lastSeenAt: now,
  });
}

const BASE_INPUT = {
  roleId: 'r1',
  hostSessionId: 'chat-1',
  chunkText: 'TCE rollback runbook: drain, scale-down, reseed leader.',
  sourceSegmentIndex: 2,
  kind: 'runbook' as const,
  scoreEntity: 3,
  scoreCosine: 0.42,
  createdAt: '2026-05-14T12:00:00.000Z',
};

describe('writeCandidateIfNew — happy path', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); seed(db); });
  afterEach(() => { db.close(); });

  it('first insert succeeds and stores all fields', () => {
    const r = writeCandidateIfNew(db, BASE_INPUT);
    expect(r.inserted).toBe(true);
    const row = getCandidateById(db, r.candidate.id)!;
    expect(row.chunkText).toBe(BASE_INPUT.chunkText);
    expect(row.kind).toBe('runbook');
    expect(row.scoreEntity).toBe(3);
    expect(row.scoreCosine).toBeCloseTo(0.42, 5);
    expect(row.status).toBe('pending');
    expect(row.hostSessionId).toBe('chat-1');
    expect(row.sourceSegmentIndex).toBe(2);
  });

  it('text_hash is sha256 of chunkText', () => {
    const r = writeCandidateIfNew(db, BASE_INPUT);
    const expected = createHash('sha256').update(BASE_INPUT.chunkText).digest('hex');
    expect(r.candidate.textHash).toBe(expected);
  });

  it('without hostSessionId the column stays null', () => {
    const r = writeCandidateIfNew(db, { ...BASE_INPUT, hostSessionId: undefined });
    expect(r.inserted).toBe(true);
    const row = getCandidateById(db, r.candidate.id)!;
    expect(row.hostSessionId).toBeUndefined();
  });
});

describe('writeCandidateIfNew — dedup gate', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); seed(db); });
  afterEach(() => { db.close(); });

  it('second insert of identical (roleId, text) while pending → skipped', () => {
    const a = writeCandidateIfNew(db, BASE_INPUT);
    const b = writeCandidateIfNew(db, BASE_INPUT);
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
    // The first row stays exactly as inserted; nothing new appeared.
    expect(listCandidatesForRole(db, 'r1', { status: 'all' }).length).toBe(1);
  });

  it('rejected row STILL blocks re-insert (Decision §8: reject is terminal)', () => {
    const a = writeCandidateIfNew(db, BASE_INPUT);
    setCandidateStatus(db, a.candidate.id, 'rejected', new Date().toISOString());
    const b = writeCandidateIfNew(db, BASE_INPUT);
    expect(b.inserted).toBe(false);
  });

  it('accepted row does NOT block — same text may be re-suggested after the chunk is deleted', () => {
    const a = writeCandidateIfNew(db, BASE_INPUT);
    setCandidateStatus(db, a.candidate.id, 'accepted', new Date().toISOString());
    const b = writeCandidateIfNew(db, BASE_INPUT);
    expect(b.inserted).toBe(true);
  });

  it('one-character edit produces a different hash and inserts', () => {
    const a = writeCandidateIfNew(db, BASE_INPUT);
    const b = writeCandidateIfNew(db, {
      ...BASE_INPUT,
      chunkText: BASE_INPUT.chunkText + '.', // trailing punctuation differs
    });
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(true);
    expect(a.candidate.textHash).not.toBe(b.candidate.textHash);
  });

  it('cross-role dedup is OFF — same text inserts for a different role', () => {
    seed(db, 'r2');
    const a = writeCandidateIfNew(db, BASE_INPUT);
    const b = writeCandidateIfNew(db, { ...BASE_INPUT, roleId: 'r2' });
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(true);
  });
});
