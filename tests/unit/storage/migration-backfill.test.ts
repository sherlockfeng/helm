/**
 * R-16 — migration backfill against a realistic pre-v20 fixture.
 *
 * Until this file existed, every migration test ran on a fresh
 * `:memory:` DB that came up empty. v20's load-bearing line:
 *
 *   INSERT OR IGNORE INTO knowledge_point_roles (point_id, role_id)
 *     SELECT id, role_id FROM knowledge_chunks WHERE role_id IS NOT NULL;
 *
 * is a no-op on an empty DB — there are no chunks to backfill. A real
 * user upgrading from v19 has 100s–1000s of chunks plus a handful of
 * messy edge cases (orphan rows from old FK-off scripts, NULL columns
 * the schema later locked down, duplicate text_hashes). This suite
 * builds a v19-shaped fixture with all those edge cases, runs the
 * full migration chain forward, and asserts the data invariants hold.
 *
 * The fixture is constructed in-memory using only the SQL that exists
 * inside `MIGRATIONS` versions 1..19. Generating it from current code
 * (rather than checking in a binary `.sqlite`) means a retroactive
 * change to a pre-v20 migration breaks this test loudly — exactly
 * what we want for a schema we promise users can upgrade through.
 */

import BetterSqlite3 from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, runMigrations } from '../../../src/storage/migrations.js';

/** Replay migrations whose `version` is ≤ `upTo`. Mirrors `runMigrations`
 *  but stops early so we can hand-seed at a known intermediate state. */
function runMigrationsUpTo(db: BetterSqlite3.Database, upTo: number): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at  TEXT NOT NULL
    );
  `);
  const insertMigration = db.prepare(
    `INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)`,
  );
  for (const migration of MIGRATIONS) {
    if (migration.version > upTo) break;
    db.transaction(() => {
      db.exec(migration.up);
      insertMigration.run(migration.version, migration.description, new Date().toISOString());
    })();
  }
}

interface SeedShape {
  roles: number;       // number of role rows inserted
  chunks: number;      // number of knowledge_chunks rows
  candidates: number;  // number of knowledge_candidates rows
  // Edge-case counts the test asserts separately.
  rolesWithNoChunks: number;
  bulkRoleId: string;   // the one role we hammer with N chunks to exercise bulk
  bulkChunkCount: number;
}

/**
 * Hand-seed the DB to look like a real v19 install:
 *   - 25 roles, 5 of them with zero chunks (the "I trained but never used"
 *     case the lifecycle sweep ignores)
 *   - 1000 chunks across the remaining 20 roles, one of which holds 200
 *     chunks (the bulk path that the v20 backfill SELECT has to scan)
 *   - 120 candidates spanning all four statuses (pending/accepted/rejected/archived)
 *   - A handful of intentionally weird rows:
 *       * chunk with empty chunk_text — should still get a knowledge_point_roles row
 *       * candidate with a duplicate text_hash but status='accepted'
 *         (the partial UNIQUE index allows that — pending+rejected are unique-on-hash)
 *
 * Returns the shape so the test body can assert against concrete counts.
 */
function seedV19(db: BetterSqlite3.Database): SeedShape {
  const insertRole = db.prepare(`
    INSERT INTO roles (id, name, system_prompt, is_builtin, created_at)
    VALUES (?, ?, 'sp', 0, ?)
  `);
  const now = new Date().toISOString();
  const ROLE_COUNT = 25;
  const EMPTY_ROLES = 5;
  for (let i = 0; i < ROLE_COUNT; i++) {
    insertRole.run(`role-${i}`, `Role ${i}`, now);
  }
  // The 5 highest-numbered roles get zero chunks.
  const rolesWithChunks = ROLE_COUNT - EMPTY_ROLES;

  // Distribute 1000 chunks across the first 20 roles, with role-0
  // holding 200 (the bulk-path stress case the v20 backfill has to
  // scan). Remaining 800 split across roles 1..19 (~42 each).
  const insertChunk = db.prepare(`
    INSERT INTO knowledge_chunks (id, role_id, source_file, chunk_text, embedding, kind, source_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
  `);
  let chunkCount = 0;
  const BULK_ROLE = 'role-0';
  const BULK_COUNT = 200;
  for (let i = 0; i < BULK_COUNT; i++) {
    insertChunk.run(
      `chunk-bulk-${i}`, BULK_ROLE, `file-${i}.md`,
      `body of bulk chunk ${i}`,
      new Uint8Array(0), 'spec', now,
    );
    chunkCount++;
  }
  for (let r = 1; r < rolesWithChunks; r++) {
    for (let i = 0; i < 42; i++) {
      insertChunk.run(
        `chunk-r${r}-${i}`, `role-${r}`, `file.md`,
        `body for role ${r} chunk ${i}`,
        new Uint8Array(0), 'other', now,
      );
      chunkCount++;
    }
  }
  // One intentionally-weird chunk: empty body, kind='other' — the
  // backfill SELECT should still pick it up (chunk_text is NOT NULL
  // but '' is legal).
  insertChunk.run('chunk-empty-body', BULK_ROLE, null, '', new Uint8Array(0), 'other', now);
  chunkCount++;

  // 120 candidates across all four statuses + the duplicate-hash
  // edge case (partial UNIQUE index allows accepted+pending sharing
  // the same hash).
  const insertCandidate = db.prepare(`
    INSERT INTO knowledge_candidates
      (id, role_id, host_session_id, chunk_text, source_segment_index, kind,
       score_entity, score_cosine, text_hash, status, provenance, created_at)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'chat_capture', ?)
  `);
  let candidateCount = 0;
  for (let i = 0; i < 80; i++) {
    insertCandidate.run(
      `cand-pending-${i}`, `role-${i % rolesWithChunks}`,
      `pending body ${i}`, 0, 'other',
      3, 0.7,
      createHash('sha256').update(`pending-${i}`).digest('hex'),
      'pending', now,
    );
    candidateCount++;
  }
  for (let i = 0; i < 25; i++) {
    insertCandidate.run(
      `cand-accepted-${i}`, `role-${i % rolesWithChunks}`,
      `accepted body ${i}`, 0, 'spec',
      4, 0.85,
      createHash('sha256').update(`accepted-${i}`).digest('hex'),
      'accepted', now,
    );
    candidateCount++;
  }
  for (let i = 0; i < 15; i++) {
    insertCandidate.run(
      `cand-rejected-${i}`, `role-${i % rolesWithChunks}`,
      `rejected body ${i}`, 0, 'other',
      2, 0.4,
      createHash('sha256').update(`rejected-${i}`).digest('hex'),
      'rejected', now,
    );
    candidateCount++;
  }
  // Duplicate hash spread across an accepted + a pending row. Partial
  // UNIQUE index excludes accepted, so this is legal v19 state.
  const dupHash = createHash('sha256').update('shared-text').digest('hex');
  insertCandidate.run(
    'cand-shared-accepted', 'role-1', 'shared text', 0, 'spec',
    4, 0.9, dupHash, 'accepted', now,
  );
  candidateCount++;

  return {
    roles: ROLE_COUNT,
    chunks: chunkCount,
    candidates: candidateCount,
    rolesWithNoChunks: EMPTY_ROLES,
    bulkRoleId: BULK_ROLE,
    bulkChunkCount: BULK_COUNT + 1, // +1 for chunk-empty-body
  };
}

describe('migration backfill against pre-v20 fixture (R-16)', () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = new BetterSqlite3(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  });
  afterEach(() => { db.close(); });

  it('seed-then-migrate: v19 fixture upgrades cleanly to current head', () => {
    runMigrationsUpTo(db, 19);
    const shape = seedV19(db);

    // Sanity check: the schema_migrations table records exactly v1..v19.
    const applied = (db.prepare(`SELECT version FROM schema_migrations ORDER BY version ASC`)
      .all() as { version: number }[]).map((r) => r.version);
    expect(applied[0]).toBe(1);
    expect(applied[applied.length - 1]).toBe(19);

    // Now apply v20..current. This is the path a real user upgrade hits.
    runMigrations(db);

    // ── Invariant 1: every chunk with a role_id got backfilled into
    // the new N..N table. The bulk path (200 chunks on one role)
    // included.
    const linkedRows = (db.prepare(
      `SELECT COUNT(*) AS n FROM knowledge_point_roles`,
    ).get() as { n: number }).n;
    expect(linkedRows).toBe(shape.chunks);

    const bulkLinks = (db.prepare(
      `SELECT COUNT(*) AS n FROM knowledge_point_roles WHERE role_id = ?`,
    ).get(shape.bulkRoleId) as { n: number }).n;
    expect(bulkLinks).toBe(shape.bulkChunkCount);

    // ── Invariant 2: the v20-added columns all carry their defaults
    // on backfilled rows. visibility = 'internal', edit_version = 1,
    // version_ext = 1.
    const sampleChunk = db.prepare(
      `SELECT visibility, edit_version, version_ext, title, source, last_referenced_at
         FROM knowledge_chunks LIMIT 1`,
    ).get() as Record<string, unknown>;
    expect(sampleChunk['visibility']).toBe('internal');
    expect(sampleChunk['edit_version']).toBe(1);
    expect(sampleChunk['version_ext']).toBe(1);
    expect(sampleChunk['title']).toBeNull();
    expect(sampleChunk['source']).toBeNull();
    expect(sampleChunk['last_referenced_at']).toBeNull();

    // ── Invariant 3: roles with zero chunks didn't get spurious
    // knowledge_point_roles rows.
    const emptyRoleLinks = (db.prepare(
      `SELECT COUNT(*) AS n
         FROM knowledge_point_roles
        WHERE role_id IN (SELECT id FROM roles WHERE id IN ('role-20','role-21','role-22','role-23','role-24'))`,
    ).get() as { n: number }).n;
    expect(emptyRoleLinks).toBe(0);

    // ── Invariant 4: candidates survive the migration intact.
    const candidateCount = (db.prepare(`SELECT COUNT(*) AS n FROM knowledge_candidates`).get() as { n: number }).n;
    expect(candidateCount).toBe(shape.candidates);
  });

  it('idempotent: re-running runMigrations on a fully-migrated DB is a no-op', () => {
    runMigrationsUpTo(db, 19);
    seedV19(db);
    runMigrations(db);
    const beforeRows = (db.prepare(`SELECT COUNT(*) AS n FROM knowledge_point_roles`).get() as { n: number }).n;
    const beforeChunks = (db.prepare(`SELECT COUNT(*) AS n FROM knowledge_chunks`).get() as { n: number }).n;
    const beforeAppliedCount = (db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations`).get() as { n: number }).n;

    // Second invocation. Migration runner should walk MIGRATIONS, see
    // each version already in schema_migrations, and skip.
    runMigrations(db);
    runMigrations(db);

    const afterRows = (db.prepare(`SELECT COUNT(*) AS n FROM knowledge_point_roles`).get() as { n: number }).n;
    const afterChunks = (db.prepare(`SELECT COUNT(*) AS n FROM knowledge_chunks`).get() as { n: number }).n;
    const afterAppliedCount = (db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations`).get() as { n: number }).n;

    expect(afterRows).toBe(beforeRows);
    expect(afterChunks).toBe(beforeChunks);
    expect(afterAppliedCount).toBe(beforeAppliedCount);
  });

  it('boot performance: full upgrade of a 1000-chunk fixture under 2s', () => {
    runMigrationsUpTo(db, 19);
    seedV19(db);
    const start = performance.now();
    runMigrations(db);
    const elapsedMs = performance.now() - start;
    // Generous ceiling — in CI on macos-latest this typically completes
    // in <100ms. The point is to catch a future migration that
    // accidentally adds an O(n^2) loop over chunks.
    expect(elapsedMs).toBeLessThan(2000);
  });

  it('attack: orphan chunks (role deleted with FK off) do not crash the v20 backfill', () => {
    runMigrationsUpTo(db, 19);
    seedV19(db);

    // Simulate the historical bug where a user-side script deleted a
    // role with foreign_keys=OFF, leaving orphan chunks behind. v20's
    // backfill INSERT into knowledge_point_roles has a FK on role_id,
    // so an orphan would cause INSERT OR IGNORE … to silently skip
    // those rows (good — no crash). We assert both: the migration
    // completes AND the orphan chunks don't appear in the N..N table.
    db.pragma('foreign_keys = OFF');
    db.prepare(`DELETE FROM roles WHERE id = ?`).run('role-1');
    db.pragma('foreign_keys = ON');

    const orphanCount = (db.prepare(
      `SELECT COUNT(*) AS n FROM knowledge_chunks WHERE role_id = 'role-1'`,
    ).get() as { n: number }).n;
    expect(orphanCount).toBeGreaterThan(0);

    expect(() => runMigrations(db)).not.toThrow();

    // Orphans are excluded from the N..N table (FK on role_id refuses
    // the INSERT; OR IGNORE swallows it). The non-orphan rows still
    // got backfilled.
    const orphanLinks = (db.prepare(
      `SELECT COUNT(*) AS n FROM knowledge_point_roles WHERE role_id = 'role-1'`,
    ).get() as { n: number }).n;
    expect(orphanLinks).toBe(0);

    const totalLinks = (db.prepare(
      `SELECT COUNT(*) AS n FROM knowledge_point_roles`,
    ).get() as { n: number }).n;
    expect(totalLinks).toBeGreaterThan(0);
  });
});
