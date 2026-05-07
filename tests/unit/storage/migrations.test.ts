import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, runMigrations } from '../../../src/storage/migrations.js';

function openMemoryDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

describe('migrations', () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => { db = openMemoryDb(); });
  afterEach(() => { db.close(); });

  it('creates schema_migrations table and applies all migrations', () => {
    runMigrations(db);

    const versions = (db.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as { version: number }[]).map((r) => r.version);
    expect(versions).toEqual(MIGRATIONS.map((m) => m.version));
  });

  it('is idempotent — running twice does not throw or duplicate rows', () => {
    runMigrations(db);
    runMigrations(db);

    const count = (db.prepare('SELECT COUNT(*) as cnt FROM schema_migrations').get() as { cnt: number }).cnt;
    expect(count).toBe(MIGRATIONS.length);
  });

  it('creates every expected table', () => {
    runMigrations(db);

    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[]).map((r) => r.name);

    const expected = [
      'schema_migrations',
      'campaigns', 'cycles', 'tasks', 'roles', 'knowledge_chunks',
      'agent_sessions', 'doc_audit_log', 'requirements', 'capture_sessions',
      'host_sessions', 'channel_bindings', 'channel_message_queue',
      'pending_binds', 'approval_requests', 'approval_policies', 'host_event_log',
    ];
    for (const t of expected) {
      expect(tables, `table '${t}' should exist`).toContain(t);
    }
  });

  it('attack: corrupted schema_migrations row does not re-apply applied migrations', () => {
    runMigrations(db);
    // Simulate a stale row left with a future version — should not cause double-apply
    db.prepare(`INSERT INTO schema_migrations (version, description, applied_at) VALUES (999, 'fake', '2099-01-01T00:00:00.000Z')`).run();
    // Re-running should not throw
    expect(() => runMigrations(db)).not.toThrow();
  });

  it('Phase 25 migration: host_sessions.role_id column + index', () => {
    runMigrations(db);
    const cols = (db.prepare(`PRAGMA table_info(host_sessions)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('role_id');
    const indexes = (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='host_sessions'`).all() as { name: string }[]).map((i) => i.name);
    expect(indexes).toContain('idx_host_sessions_role');
  });

  it('Phase 32 migration: host_sessions.first_prompt column', () => {
    runMigrations(db);
    const cols = (db.prepare(`PRAGMA table_info(host_sessions)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('first_prompt');
  });

  it('Phase 36 migration: pending_binds.label + channel_bindings.label columns', () => {
    runMigrations(db);
    const pendingCols = (db.prepare(`PRAGMA table_info(pending_binds)`).all() as { name: string }[]).map((c) => c.name);
    const bindingsCols = (db.prepare(`PRAGMA table_info(channel_bindings)`).all() as { name: string }[]).map((c) => c.name);
    expect(pendingCols).toContain('label');
    expect(bindingsCols).toContain('label');
  });

  it('Phase 42 migration: host_session_roles join table + indexes', () => {
    runMigrations(db);
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((r) => r.name);
    expect(tables).toContain('host_session_roles');
    const indexes = (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='host_session_roles'`).all() as { name: string }[]).map((i) => i.name);
    expect(indexes).toContain('idx_session_roles_session');
    expect(indexes).toContain('idx_session_roles_role');
  });

  it('Phase 42 migration: backfills legacy host_sessions.role_id into host_session_roles', async () => {
    // Apply 1..5 only, seed a legacy single-role binding, run 6, verify backfill.
    const { MIGRATIONS } = await import('../../../src/storage/migrations.js');
    db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT NOT NULL);`);
    for (const m of MIGRATIONS.filter((x) => x.version <= 5)) {
      db.exec(m.up);
      db.prepare(`INSERT INTO schema_migrations VALUES (?, ?, ?)`).run(m.version, m.description, new Date().toISOString());
    }
    db.prepare(`INSERT INTO roles (id, name, system_prompt, is_builtin, created_at) VALUES (?, ?, ?, 0, ?)`)
      .run('legacy-pm', 'Legacy PM', 'sp', new Date().toISOString());
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO host_sessions (id, host, status, role_id, first_seen_at, last_seen_at) VALUES ('s', 'cursor', 'active', 'legacy-pm', ?, ?)`).run(now, now);

    runMigrations(db);

    const back = db.prepare(`SELECT role_id FROM host_session_roles WHERE host_session_id = ?`).get('s') as { role_id: string } | undefined;
    expect(back?.role_id).toBe('legacy-pm');
  });

  it('attack: foreign_keys pragma is respected by runMigrations (FK violation throws)', () => {
    runMigrations(db);
    // WAL is not available in :memory: databases; foreign_keys should be enforced
    const fk = (db.pragma('foreign_keys') as { foreign_keys: number }[])[0]?.foreign_keys;
    expect(fk).toBe(1);
    // Confirm FK enforcement: inserting cycle with missing campaign_id must throw
    expect(() => db.prepare(`INSERT INTO cycles (id, campaign_id, cycle_num, status) VALUES ('x','ghost',1,'pending')`).run()).toThrow();
  });
});
