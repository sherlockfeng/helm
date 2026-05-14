/**
 * Knowledge lifecycle (Phase 77) — decay math + archival sweep.
 *
 * Pins for the decay function (`scoreDecay`):
 *   - lastAccessedAt = now    → factor ≈ 1.0
 *   - lastAccessedAt = now - τ → factor = 1/e ≈ 0.368
 *   - missing lastAccessedAt  → falls back to createdAt (so freshly-trained
 *     chunks don't decay before they get queried)
 *   - tau ≤ 0 doesn't divide-by-zero
 *
 * Pins for the sweep (`runArchivalSweep`):
 *   - only old + cold chunks get archived
 *   - young chunks are spared even when access_count = 0
 *   - well-accessed chunks (≥ threshold) are spared even when ancient
 *   - already-archived chunks aren't re-archived
 *   - empty corpus returns scanned=0 / archived=0
 *   - per-role mode only touches the requested role
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import {
  insertChunk,
  insertSource,
  upsertRole,
} from '../../../src/storage/repos/roles.js';
import {
  DEFAULT_DECAY_ALPHA,
  applyDecayBoost,
  runArchivalSweep,
  scoreDecay,
} from '../../../src/roles/lifecycle.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seed(db: BetterSqlite3.Database, roleId = 'r1'): string {
  const now = new Date().toISOString();
  upsertRole(db, { id: roleId, name: roleId, systemPrompt: 'p', isBuiltin: false, createdAt: now });
  const sourceId = `${roleId}-src1`;
  insertSource(db, {
    id: sourceId, roleId, kind: 'file', origin: 'spec.md', fingerprint: 'fp',
    createdAt: now,
  });
  return sourceId;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('scoreDecay — exponential weighting on chunk freshness', () => {
  const now = new Date('2026-05-14T00:00:00.000Z');

  it('returns ~1 when lastAccessedAt is right now', () => {
    expect(scoreDecay(now.toISOString(), now.toISOString(), now, 30)).toBeCloseTo(1, 5);
  });

  it('returns ~1/e at exactly τ days old', () => {
    const oneTauAgo = new Date(now.getTime() - 30 * MS_PER_DAY).toISOString();
    expect(scoreDecay(oneTauAgo, oneTauAgo, now, 30)).toBeCloseTo(1 / Math.E, 4);
  });

  it('falls back to createdAt when lastAccessedAt is undefined', () => {
    const createdAt = new Date(now.getTime() - 5 * MS_PER_DAY).toISOString();
    const withFallback = scoreDecay(undefined, createdAt, now, 30);
    const explicit = scoreDecay(createdAt, createdAt, now, 30);
    expect(withFallback).toBeCloseTo(explicit, 5);
  });

  it('handles tau=0 without crashing (clamps to a tiny positive)', () => {
    // tau=0 means "everything decays instantly" — formula goes to ~0 but
    // doesn't NaN. Acceptable for a defensive bound; user can't reasonably
    // configure tau=0 from the UI either way.
    const v = scoreDecay(now.toISOString(), now.toISOString(), now, 0);
    expect(Number.isFinite(v)).toBe(true);
  });

  it('treats invalid ISO strings as "treat as new" (factor=1)', () => {
    expect(scoreDecay('not-a-date', 'not-a-date', now, 30)).toBe(1);
  });

  it('clamps negative ages (future timestamps) to 0 days', () => {
    const future = new Date(now.getTime() + 5 * MS_PER_DAY).toISOString();
    expect(scoreDecay(future, future, now, 30)).toBe(1);
  });
});

describe('applyDecayBoost — final = rrf * (1 + α * decay)', () => {
  it('with α=0 reduces to identity', () => {
    expect(applyDecayBoost(0.5, 0.7, 0)).toBe(0.5);
  });

  it('with default α=0.3 and decay=1 caps boost at +30%', () => {
    expect(applyDecayBoost(0.5, 1, DEFAULT_DECAY_ALPHA)).toBeCloseTo(0.5 * 1.3, 5);
  });

  it('with decay=0 leaves rrf unchanged regardless of α', () => {
    expect(applyDecayBoost(0.5, 0, 0.3)).toBe(0.5);
  });
});

describe('runArchivalSweep — old + cold rule', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); });
  afterEach(() => { db.close(); });

  const now = new Date('2026-05-14T00:00:00.000Z');

  function insert(
    db: BetterSqlite3.Database,
    roleId: string,
    sourceId: string,
    id: string,
    createdAt: string,
    accessCount: number,
    lastAccessedAt?: string,
  ): void {
    insertChunk(db, {
      id, roleId, chunkText: `chunk ${id}`, kind: 'other',
      sourceId, createdAt,
    });
    if (accessCount > 0 || lastAccessedAt) {
      db.prepare(`
        UPDATE knowledge_chunks
        SET access_count = ?, last_accessed_at = ?
        WHERE id = ?
      `).run(accessCount, lastAccessedAt ?? null, id);
    }
  }

  it('archives an OLD chunk with access_count=0', () => {
    const sourceId = seed(db);
    const veryOld = new Date(now.getTime() - 120 * MS_PER_DAY).toISOString();
    insert(db, 'r1', sourceId, 'old-cold', veryOld, 0);

    const result = runArchivalSweep(db, { now });
    expect(result.archived).toBe(1);
    expect(result.scanned).toBe(1);
    const row = db.prepare(`SELECT archived FROM knowledge_chunks WHERE id = ?`).get('old-cold') as { archived: number };
    expect(row.archived).toBe(1);
  });

  it('SPARES a YOUNG chunk with access_count=0', () => {
    const sourceId = seed(db);
    const recent = new Date(now.getTime() - 5 * MS_PER_DAY).toISOString();
    insert(db, 'r1', sourceId, 'young-cold', recent, 0);

    const result = runArchivalSweep(db, { now });
    expect(result.archived).toBe(0);
    const row = db.prepare(`SELECT archived FROM knowledge_chunks WHERE id = ?`).get('young-cold') as { archived: number };
    expect(row.archived).toBe(0);
  });

  it('SPARES an OLD chunk that crossed the access-count threshold', () => {
    const sourceId = seed(db);
    const veryOld = new Date(now.getTime() - 120 * MS_PER_DAY).toISOString();
    // access_count = 5 ≥ default threshold of 3
    insert(db, 'r1', sourceId, 'old-warm', veryOld, 5, veryOld);

    const result = runArchivalSweep(db, { now });
    expect(result.archived).toBe(0);
  });

  it('SPARES an old chunk that was accessed recently', () => {
    const sourceId = seed(db);
    const veryOldCreate = new Date(now.getTime() - 200 * MS_PER_DAY).toISOString();
    const recentAccess = new Date(now.getTime() - 2 * MS_PER_DAY).toISOString();
    // Created long ago but accessed two days back — still warm.
    insert(db, 'r1', sourceId, 'recently-touched', veryOldCreate, 1, recentAccess);

    const result = runArchivalSweep(db, { now });
    expect(result.archived).toBe(0);
  });

  it('does not re-archive an already-archived chunk', () => {
    const sourceId = seed(db);
    const veryOld = new Date(now.getTime() - 120 * MS_PER_DAY).toISOString();
    insert(db, 'r1', sourceId, 'old-cold', veryOld, 0);
    // First sweep archives the chunk; second sweep should find nothing
    // to do (skipped: the archived chunks are filtered out of the
    // candidate scan to begin with).
    runArchivalSweep(db, { now });
    const second = runArchivalSweep(db, { now });
    expect(second.archived).toBe(0);
    expect(second.scanned).toBe(0);
  });

  it('per-role mode does not touch other roles', () => {
    const src1 = seed(db, 'r1');
    const src2 = seed(db, 'r2');
    const veryOld = new Date(now.getTime() - 120 * MS_PER_DAY).toISOString();
    insert(db, 'r1', src1, 'r1-cold', veryOld, 0);
    insert(db, 'r2', src2, 'r2-cold', veryOld, 0);

    const result = runArchivalSweep(db, { roleId: 'r1', now });
    expect(result.byRole.map((b) => b.roleId)).toEqual(['r1']);
    expect(result.archived).toBe(1);

    const r1Row = db.prepare(`SELECT archived FROM knowledge_chunks WHERE id = ?`).get('r1-cold') as { archived: number };
    const r2Row = db.prepare(`SELECT archived FROM knowledge_chunks WHERE id = ?`).get('r2-cold') as { archived: number };
    expect(r1Row.archived).toBe(1);
    expect(r2Row.archived).toBe(0); // untouched
  });

  it('empty corpus returns scanned=0 / archived=0', () => {
    const result = runArchivalSweep(db, { now });
    expect(result.scanned).toBe(0);
    expect(result.archived).toBe(0);
    expect(result.byRole).toEqual([]);
  });

  it('user-tuned thresholds override defaults (Decision §3)', () => {
    const sourceId = seed(db);
    const sevenDayOld = new Date(now.getTime() - 7 * MS_PER_DAY).toISOString();
    insert(db, 'r1', sourceId, 'fresh-but-tuned', sevenDayOld, 0);

    // Default (90d) would spare. archiveAfterDays=5 catches it.
    const tight = runArchivalSweep(db, {
      now,
      thresholds: { archiveAfterDays: 5, archiveBelowAccessCount: 3, decayTauDays: 30, decayAlpha: 0.3 },
    });
    expect(tight.archived).toBe(1);
  });
});
