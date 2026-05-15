/**
 * knowledge_candidates repo (Phase 78).
 *
 * Pins:
 *   - insertCandidateIfNew + getCandidateById round-trip
 *   - listCandidatesForRole filters by status (default 'pending')
 *   - setCandidateStatus only fires on pending → terminal (idempotent)
 *   - updateCandidateText only works while pending; collides on dup hash
 *   - pendingCountsByRole groups correctly + skips terminal statuses
 *   - countPendingCandidatesForRole single-role count
 *   - cascade: deleting the role wipes its candidates
 *   - host_session SET NULL on chat row delete keeps the candidate
 */

import { createHash, randomUUID } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import {
  countPendingCandidatesForRole,
  getCandidateById,
  insertCandidateIfNew,
  listCandidatesForRole,
  pendingCountsByRole,
  setCandidateStatus,
  updateCandidateText,
} from '../../../src/storage/repos/knowledge-candidates.js';
import { upsertRole } from '../../../src/storage/repos/roles.js';
import { upsertHostSession } from '../../../src/storage/repos/host-sessions.js';
import type { KnowledgeCandidate } from '../../../src/storage/types.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedRole(db: BetterSqlite3.Database, id: string): void {
  upsertRole(db, { id, name: id, systemPrompt: 'p', isBuiltin: false, createdAt: '2026-05-14' });
}

function makeCandidate(overrides: Partial<KnowledgeCandidate> = {}): KnowledgeCandidate {
  const chunkText = overrides.chunkText ?? `text ${randomUUID()}`;
  return {
    id: overrides.id ?? randomUUID(),
    roleId: overrides.roleId ?? 'r1',
    chunkText,
    sourceSegmentIndex: overrides.sourceSegmentIndex ?? 0,
    kind: overrides.kind ?? 'other',
    scoreEntity: overrides.scoreEntity ?? 2,
    scoreCosine: overrides.scoreCosine ?? 0.3,
    textHash: overrides.textHash ?? createHash('sha256').update(chunkText).digest('hex'),
    status: overrides.status ?? 'pending',
    createdAt: overrides.createdAt ?? '2026-05-14T12:00:00.000Z',
    ...(overrides.hostSessionId ? { hostSessionId: overrides.hostSessionId } : {}),
    ...(overrides.decidedAt ? { decidedAt: overrides.decidedAt } : {}),
  };
}

describe('insertCandidateIfNew — error surface (reviewer must-fix #1)', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); seedRole(db, 'r1'); });
  afterEach(() => { db.close(); });

  it('FK violation (unknown role_id) THROWS — not a silent "false"', () => {
    // Capture is fire-and-forget; if a role gets deleted between the
    // pipeline read and the insert, we need the FK violation to surface
    // so the caller can log + skip. Silent `false` would look like
    // dedup, dropping the candidate without trace.
    const c = makeCandidate({ roleId: 'role-does-not-exist' });
    expect(() => insertCandidateIfNew(db, c)).toThrow();
  });

  it('UNIQUE violation (re-insert pending) returns false — the only swallowed case', () => {
    const c = makeCandidate({ chunkText: 'sample dedup text' });
    expect(insertCandidateIfNew(db, c)).toBe(true);
    const dupe = makeCandidate({
      // New id, same roleId + textHash so the partial unique index trips.
      id: 'dupe',
      roleId: c.roleId,
      chunkText: c.chunkText,
      textHash: c.textHash,
    });
    expect(insertCandidateIfNew(db, dupe)).toBe(false);
  });
});

describe('knowledge_candidates — basic CRUD', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); seedRole(db, 'r1'); });
  afterEach(() => { db.close(); });

  it('insertCandidateIfNew + getCandidateById round-trips all fields', () => {
    const c = makeCandidate({ scoreEntity: 5, scoreCosine: 0.91 });
    expect(insertCandidateIfNew(db, c)).toBe(true);
    const row = getCandidateById(db, c.id);
    expect(row).toBeDefined();
    expect(row!.id).toBe(c.id);
    expect(row!.scoreEntity).toBe(5);
    expect(row!.scoreCosine).toBeCloseTo(0.91, 5);
  });

  it('listCandidatesForRole defaults to status=pending', () => {
    insertCandidateIfNew(db, makeCandidate({ id: 'a', chunkText: 'a-text' }));
    const accepted = makeCandidate({ id: 'b', chunkText: 'b-text' });
    insertCandidateIfNew(db, accepted);
    setCandidateStatus(db, 'b', 'accepted', '2026-05-14T12:00:00.000Z');

    expect(listCandidatesForRole(db, 'r1').map((c) => c.id)).toEqual(['a']);
    expect(listCandidatesForRole(db, 'r1', { status: 'all' }).map((c) => c.id).sort())
      .toEqual(['a', 'b']);
  });
});

describe('setCandidateStatus — state machine', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); seedRole(db, 'r1'); });
  afterEach(() => { db.close(); });

  it('flips pending → accepted with decided_at', () => {
    const c = makeCandidate();
    insertCandidateIfNew(db, c);
    const t = '2026-05-14T13:00:00.000Z';
    expect(setCandidateStatus(db, c.id, 'accepted', t)).toBe(true);
    const row = getCandidateById(db, c.id)!;
    expect(row.status).toBe('accepted');
    expect(row.decidedAt).toBe(t);
  });

  it('refuses to flip an already-terminal row', () => {
    const c = makeCandidate();
    insertCandidateIfNew(db, c);
    setCandidateStatus(db, c.id, 'rejected', '2026-05-14T13:00:00.000Z');
    // Second call → false (row no longer pending)
    expect(setCandidateStatus(db, c.id, 'accepted', '2026-05-14T14:00:00.000Z')).toBe(false);
    expect(getCandidateById(db, c.id)!.status).toBe('rejected');
  });

  it('returns false for unknown id', () => {
    expect(setCandidateStatus(db, 'ghost', 'rejected', '2026-05-14T13:00:00.000Z')).toBe(false);
  });
});

describe('updateCandidateText', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); seedRole(db, 'r1'); });
  afterEach(() => { db.close(); });

  it('updates text + hash on a pending row', () => {
    const c = makeCandidate({ chunkText: 'old' });
    insertCandidateIfNew(db, c);
    const newText = 'new text';
    const newHash = createHash('sha256').update(newText).digest('hex');
    expect(updateCandidateText(db, c.id, newText, newHash)).toBe(true);
    const row = getCandidateById(db, c.id)!;
    expect(row.chunkText).toBe(newText);
    expect(row.textHash).toBe(newHash);
  });

  it('refuses to update a non-pending row', () => {
    const c = makeCandidate();
    insertCandidateIfNew(db, c);
    setCandidateStatus(db, c.id, 'accepted', '2026-05-14T13:00:00.000Z');
    expect(updateCandidateText(db, c.id, 'whatever', 'h')).toBe(false);
  });

  it('throws SQLITE_CONSTRAINT on hash collision with another pending row', () => {
    const c1 = makeCandidate({ id: 'a', chunkText: 'unique-A' });
    const c2 = makeCandidate({ id: 'b', chunkText: 'unique-B' });
    insertCandidateIfNew(db, c1);
    insertCandidateIfNew(db, c2);
    // Try to make c2 collide with c1's text.
    const collidingHash = createHash('sha256').update('unique-A').digest('hex');
    expect(() => updateCandidateText(db, 'b', 'unique-A', collidingHash)).toThrow();
  });
});

describe('pending counts', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => {
    db = openDb();
    seedRole(db, 'r1');
    seedRole(db, 'r2');
  });
  afterEach(() => { db.close(); });

  it('countPendingCandidatesForRole counts only pending', () => {
    insertCandidateIfNew(db, makeCandidate({ id: 'a', chunkText: 'a' }));
    const acc = makeCandidate({ id: 'b', chunkText: 'b' });
    insertCandidateIfNew(db, acc);
    setCandidateStatus(db, 'b', 'accepted', '2026-05-14T12:00:00.000Z');

    expect(countPendingCandidatesForRole(db, 'r1')).toBe(1);
    expect(countPendingCandidatesForRole(db, 'r2')).toBe(0);
  });

  it('pendingCountsByRole groups across roles', () => {
    insertCandidateIfNew(db, makeCandidate({ id: 'a', roleId: 'r1', chunkText: 'a' }));
    insertCandidateIfNew(db, makeCandidate({ id: 'b', roleId: 'r1', chunkText: 'b' }));
    insertCandidateIfNew(db, makeCandidate({ id: 'c', roleId: 'r2', chunkText: 'c' }));
    const map = pendingCountsByRole(db);
    expect(map.get('r1')).toBe(2);
    expect(map.get('r2')).toBe(1);
  });
});

describe('FK behavior', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => {
    db = openDb();
    seedRole(db, 'r1');
    upsertHostSession(db, {
      id: 'chat-1', host: 'cursor', status: 'active',
      firstSeenAt: '2026-05-14', lastSeenAt: '2026-05-14',
    });
  });
  afterEach(() => { db.close(); });

  it('deleting the role cascades all candidates', () => {
    insertCandidateIfNew(db, makeCandidate({ id: 'a', hostSessionId: 'chat-1' }));
    insertCandidateIfNew(db, makeCandidate({ id: 'b', chunkText: 'b' }));
    db.prepare(`DELETE FROM roles WHERE id = ?`).run('r1');
    expect(getCandidateById(db, 'a')).toBeUndefined();
    expect(getCandidateById(db, 'b')).toBeUndefined();
  });

  it('deleting the host_session sets candidate.host_session_id to NULL', () => {
    insertCandidateIfNew(db, makeCandidate({ id: 'a', hostSessionId: 'chat-1' }));
    db.prepare(`DELETE FROM host_sessions WHERE id = ?`).run('chat-1');
    const row = getCandidateById(db, 'a');
    expect(row).toBeDefined();
    expect(row!.hostSessionId).toBeUndefined();
  });
});
