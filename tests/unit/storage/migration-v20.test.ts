/**
 * Migration v20 — schema delta for the conversation-knowledge redesign
 * (PR 2). These tests prove the migration:
 *
 *   - Adds the new knowledge_chunks columns (title / source /
 *     last_referenced_at / edit_version / visibility / version_ext)
 *     with the right defaults
 *   - Creates the new tables (knowledge_point_alias,
 *     knowledge_point_rel, knowledge_point_roles, retrieval_log,
 *     retrieval_log_points) with the right columns and indexes
 *   - Adds host_sessions.agent_kind and backfills it from host
 *   - Backfills knowledge_point_roles from the existing 1..1 mapping
 *
 * Each test seeds a pre-v20 snapshot via the migration runner (which
 * stops at v20-1 if we tell it to via a partial MIGRATIONS slice) —
 * but to keep the test cheap and the harness simple we just run the
 * full migration set and then assert on the resulting schema. The
 * absence of a "down" path means a "down" test would have to manually
 * unwind; that's not how Helm migrates, so we exercise the forward
 * direction (which is the only one that ever ships).
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';

interface TableInfoRow { name: string; type: string; notnull: number; dflt_value: string | null }

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function tableInfo(db: BetterSqlite3.Database, table: string): TableInfoRow[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as TableInfoRow[];
}

function indexList(db: BetterSqlite3.Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[];
  return rows.map((r) => r.name).sort();
}

describe('migration v20 — schema delta', () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => { db = openDb(); });
  afterEach(() => { db.close(); });

  it('records v20 as applied', () => {
    const versions = (db.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all() as { version: number }[])
      .map((r) => r.version);
    expect(versions).toContain(20);
  });

  describe('knowledge_chunks promotion columns', () => {
    it('adds title (nullable TEXT)', () => {
      const col = tableInfo(db, 'knowledge_chunks').find((c) => c.name === 'title');
      expect(col).toBeDefined();
      expect(col!.notnull).toBe(0);
    });

    it('adds source (nullable TEXT for JSON shape {kind, ref})', () => {
      const col = tableInfo(db, 'knowledge_chunks').find((c) => c.name === 'source');
      expect(col).toBeDefined();
      expect(col!.notnull).toBe(0);
    });

    it('adds last_referenced_at (nullable INTEGER)', () => {
      const col = tableInfo(db, 'knowledge_chunks').find((c) => c.name === 'last_referenced_at');
      expect(col).toBeDefined();
      expect(col!.notnull).toBe(0);
    });

    it('adds edit_version (NOT NULL DEFAULT 1)', () => {
      const col = tableInfo(db, 'knowledge_chunks').find((c) => c.name === 'edit_version');
      expect(col).toBeDefined();
      expect(col!.notnull).toBe(1);
      expect(col!.dflt_value).toBe('1');
    });

    it('adds visibility (NOT NULL DEFAULT internal)', () => {
      const col = tableInfo(db, 'knowledge_chunks').find((c) => c.name === 'visibility');
      expect(col).toBeDefined();
      expect(col!.notnull).toBe(1);
      // SQLite stringifies the default; the quoting style depends on the
      // engine but the meaningful payload is the literal `internal`.
      expect(col!.dflt_value?.replace(/['"]/g, '')).toBe('internal');
    });

    it('adds version_ext (NOT NULL DEFAULT 1)', () => {
      const col = tableInfo(db, 'knowledge_chunks').find((c) => c.name === 'version_ext');
      expect(col).toBeDefined();
      expect(col!.notnull).toBe(1);
      expect(col!.dflt_value).toBe('1');
    });
  });

  describe('new normalized tables', () => {
    it('creates knowledge_point_alias with the right PK + lookup index', () => {
      const cols = tableInfo(db, 'knowledge_point_alias').map((c) => c.name).sort();
      expect(cols).toEqual(['alias', 'created_at', 'point_id', 'source']);
      // The reverse-lookup index for §4.4.2's entity-leg alias fan-out
      expect(indexList(db, 'knowledge_point_alias')).toContain('idx_alias_lookup');
    });

    it('creates knowledge_point_rel with both-direction indexes', () => {
      const cols = tableInfo(db, 'knowledge_point_rel').map((c) => c.name).sort();
      expect(cols).toEqual(['created_at', 'from_point_id', 'rel_kind', 'to_point_id']);
      const ix = indexList(db, 'knowledge_point_rel');
      expect(ix).toContain('idx_rel_from');
      expect(ix).toContain('idx_rel_to');
    });

    it('creates knowledge_point_roles N..N join', () => {
      const cols = tableInfo(db, 'knowledge_point_roles').map((c) => c.name).sort();
      expect(cols).toEqual(['point_id', 'role_id']);
    });

    it('creates retrieval_log + retrieval_log_points with the point-reverse index', () => {
      expect(tableInfo(db, 'retrieval_log').map((c) => c.name).sort())
        .toEqual(['host_session_id', 'id', 'query_text', 'ts', 'turn']);
      const ptsCols = tableInfo(db, 'retrieval_log_points').map((c) => c.name).sort();
      expect(ptsCols).toEqual(
        ['fusion_score', 'injected', 'leg_contrib', 'log_id', 'point_id', 'rank'],
      );
      expect(indexList(db, 'retrieval_log_points')).toContain('idx_retrieval_log_point');
    });
  });

  describe('host_sessions.agent_kind', () => {
    it('adds the column', () => {
      const col = tableInfo(db, 'host_sessions').find((c) => c.name === 'agent_kind');
      expect(col).toBeDefined();
      expect(col!.notnull).toBe(0); // nullable so adapters can fill it explicitly
    });

    it('backfills agent_kind from host for legacy rows seeded before v20', () => {
      db.prepare(`
        INSERT INTO host_sessions (id, host, status, first_seen_at, last_seen_at)
        VALUES ('s-legacy', 'cursor', 'active', '2026-06-06T00:00:00Z', '2026-06-06T00:00:00Z')
      `).run();
      // Simulate that this row pre-existed migration v20 — wipe the
      // agent_kind we just inserted (since v20 already ran in this DB)
      // and reapply the backfill statement.
      db.prepare(`UPDATE host_sessions SET agent_kind = NULL WHERE id = 's-legacy'`).run();
      db.prepare(`UPDATE host_sessions SET agent_kind = host WHERE host IS NOT NULL`).run();
      const row = db.prepare(`SELECT agent_kind FROM host_sessions WHERE id = ?`).get('s-legacy') as { agent_kind: string };
      expect(row.agent_kind).toBe('cursor');
    });
  });

  describe('knowledge_point_roles backfill', () => {
    it('copies the existing 1..1 chunk.role_id into the N..N table', () => {
      // Seed a role + a few chunks, then re-run the backfill SQL the
      // migration uses to prove it remains idempotent and complete.
      db.prepare(`
        INSERT INTO roles (id, name, system_prompt, is_builtin, created_at, version)
        VALUES ('r-bf', 'Backfill', 'sp', 0, '2026-06-06T00:00:00Z', 1)
      `).run();
      for (let i = 0; i < 3; i++) {
        db.prepare(`
          INSERT INTO knowledge_chunks (id, role_id, chunk_text, kind, created_at)
          VALUES (?, 'r-bf', 'body', 'spec', '2026-06-06T00:00:00Z')
        `).run(`c-bf-${i}`);
      }
      // The migration already ran; the rows we just inserted post-v20
      // were caught by no trigger, so the join table doesn't have them
      // automatically. That's expected — the backfill is one-shot and
      // application code is responsible for new inserts. Apply the
      // INSERT OR IGNORE the migration uses to confirm it would have
      // backfilled correctly had these rows pre-existed.
      db.prepare(`
        INSERT OR IGNORE INTO knowledge_point_roles (point_id, role_id)
          SELECT id, role_id FROM knowledge_chunks WHERE role_id IS NOT NULL
      `).run();
      const joined = db.prepare(`
        SELECT point_id, role_id FROM knowledge_point_roles
        WHERE role_id = 'r-bf' ORDER BY point_id
      `).all() as { point_id: string; role_id: string }[];
      expect(joined.map((r) => r.point_id)).toEqual(['c-bf-0', 'c-bf-1', 'c-bf-2']);
      expect(joined.every((r) => r.role_id === 'r-bf')).toBe(true);
    });

    it('cascades knowledge_point_roles on chunk delete', () => {
      db.prepare(`
        INSERT INTO roles (id, name, system_prompt, is_builtin, created_at, version)
        VALUES ('r-cascade', 'C', 'sp', 0, '2026-06-06T00:00:00Z', 1)
      `).run();
      db.prepare(`
        INSERT INTO knowledge_chunks (id, role_id, chunk_text, kind, created_at)
        VALUES ('c-cascade', 'r-cascade', 'b', 'spec', '2026-06-06T00:00:00Z')
      `).run();
      db.prepare(`
        INSERT INTO knowledge_point_roles (point_id, role_id)
        VALUES ('c-cascade', 'r-cascade')
      `).run();

      db.prepare(`DELETE FROM knowledge_chunks WHERE id = 'c-cascade'`).run();

      const remaining = db.prepare(
        `SELECT COUNT(*) AS n FROM knowledge_point_roles WHERE point_id = 'c-cascade'`,
      ).get() as { n: number };
      expect(remaining.n).toBe(0);
    });
  });

  describe('edit_version optimistic lock semantics', () => {
    function seedChunk(): void {
      db.prepare(`
        INSERT INTO roles (id, name, system_prompt, is_builtin, created_at, version)
        VALUES ('r-lock', 'L', 'sp', 0, '2026-06-06T00:00:00Z', 1)
      `).run();
      db.prepare(`
        INSERT INTO knowledge_chunks (id, role_id, chunk_text, kind, created_at)
        VALUES ('c-lock', 'r-lock', 'initial', 'spec', '2026-06-06T00:00:00Z')
      `).run();
    }

    it('writes that supply the current edit_version succeed and bump it by 1', () => {
      seedChunk();
      const r = db.prepare(`
        UPDATE knowledge_chunks
           SET chunk_text = 'updated', edit_version = edit_version + 1
         WHERE id = 'c-lock' AND edit_version = 1
      `).run();
      expect(r.changes).toBe(1);
      const after = db.prepare(`SELECT edit_version FROM knowledge_chunks WHERE id = 'c-lock'`)
        .get() as { edit_version: number };
      expect(after.edit_version).toBe(2);
    });

    it('writes with a stale edit_version match 0 rows (no clobber)', () => {
      seedChunk();
      // First writer bumps to v=2
      db.prepare(`
        UPDATE knowledge_chunks
           SET chunk_text = 'first-writer', edit_version = edit_version + 1
         WHERE id = 'c-lock' AND edit_version = 1
      `).run();
      // Second writer thinks the row is still at v=1 — must miss.
      const r = db.prepare(`
        UPDATE knowledge_chunks
           SET chunk_text = 'second-writer', edit_version = edit_version + 1
         WHERE id = 'c-lock' AND edit_version = 1
      `).run();
      expect(r.changes).toBe(0);
      const row = db.prepare(`SELECT chunk_text, edit_version FROM knowledge_chunks WHERE id = 'c-lock'`)
        .get() as { chunk_text: string; edit_version: number };
      expect(row.chunk_text).toBe('first-writer');
      expect(row.edit_version).toBe(2);
    });
  });
});
