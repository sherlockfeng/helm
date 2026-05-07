import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getHostSession, listActiveSessions, setHostSessionFirstPrompt, setHostSessionRole, updateHostSession, upsertHostSession } from '../../../src/storage/repos/host-sessions.js';
import { upsertRole } from '../../../src/storage/repos/roles.js';
import { runMigrations } from '../../../src/storage/migrations.js';
import type { HostSession } from '../../../src/storage/types.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeSession(overrides: Partial<HostSession> = {}): HostSession {
  const now = new Date().toISOString();
  return { id: 's1', host: 'cursor', status: 'active', firstSeenAt: now, lastSeenAt: now, ...overrides };
}

describe('host sessions', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); });
  afterEach(() => { db.close(); });

  it('upserts and retrieves a session', () => {
    upsertHostSession(db, makeSession());
    const got = getHostSession(db, 's1');
    expect(got?.host).toBe('cursor');
    expect(got?.status).toBe('active');
  });

  it('upsert updates mutable fields on conflict', () => {
    upsertHostSession(db, makeSession({ cwd: '/old' }));
    const later = new Date(Date.now() + 1000).toISOString();
    upsertHostSession(db, makeSession({ cwd: '/new', lastSeenAt: later }));
    const got = getHostSession(db, 's1');
    expect(got?.cwd).toBe('/new');
    expect(got?.lastSeenAt).toBe(later);
  });

  it('listActiveSessions only returns active', () => {
    upsertHostSession(db, makeSession({ id: 's1', status: 'active' }));
    upsertHostSession(db, makeSession({ id: 's2', status: 'closed' }));
    const active = listActiveSessions(db);
    expect(active.map((s) => s.id)).toContain('s1');
    expect(active.map((s) => s.id)).not.toContain('s2');
  });

  it('updateHostSession closes a session', () => {
    upsertHostSession(db, makeSession());
    updateHostSession(db, 's1', { status: 'closed' });
    expect(getHostSession(db, 's1')?.status).toBe('closed');
  });

  it('attack: empty patch update is a no-op', () => {
    upsertHostSession(db, makeSession());
    expect(() => updateHostSession(db, 's1', {})).not.toThrow();
    expect(getHostSession(db, 's1')?.status).toBe('active');
  });

  it('attack: getting non-existent session returns undefined', () => {
    expect(getHostSession(db, 'ghost')).toBeUndefined();
  });

  it('attack: concurrent upserts on same id — last write wins on lastSeenAt', () => {
    const t1 = '2024-01-01T00:00:00.000Z';
    const t2 = '2024-01-02T00:00:00.000Z';
    upsertHostSession(db, makeSession({ lastSeenAt: t1 }));
    upsertHostSession(db, makeSession({ lastSeenAt: t2 }));
    expect(getHostSession(db, 's1')?.lastSeenAt).toBe(t2);
  });

  // ── Phase 25: chat ↔ role binding ────────────────────────────────────
  describe('Phase 25 role binding', () => {
    function seedRole(id = 'role-pm'): void {
      upsertRole(db, {
        id,
        name: 'Product Manager',
        systemPrompt: 'You are a PM',
        isBuiltin: true,
        createdAt: new Date().toISOString(),
      });
    }

    it('setHostSessionRole binds and unbinds via UPDATE', () => {
      seedRole();
      upsertHostSession(db, makeSession());
      setHostSessionRole(db, 's1', 'role-pm');
      expect(getHostSession(db, 's1')?.roleId).toBe('role-pm');
      setHostSessionRole(db, 's1', null);
      expect(getHostSession(db, 's1')?.roleId).toBeUndefined();
    });

    it('upsert preserves role_id on conflict — session_start hook bumping last_seen_at must not clear binding', () => {
      seedRole();
      upsertHostSession(db, makeSession({ cwd: '/proj' }));
      setHostSessionRole(db, 's1', 'role-pm');

      // Simulate the next session_start hook firing — same id, new lastSeenAt.
      const later = new Date(Date.now() + 1000).toISOString();
      upsertHostSession(db, makeSession({ cwd: '/proj', lastSeenAt: later }));

      expect(getHostSession(db, 's1')?.roleId).toBe('role-pm');
      expect(getHostSession(db, 's1')?.lastSeenAt).toBe(later);
    });

    it('upsert sets role_id when caller explicitly provides one', () => {
      seedRole();
      upsertHostSession(db, makeSession({ roleId: 'role-pm' }));
      expect(getHostSession(db, 's1')?.roleId).toBe('role-pm');
    });

    it('updateHostSession can change role_id', () => {
      seedRole('role-a');
      seedRole('role-b');
      upsertHostSession(db, makeSession({ roleId: 'role-a' }));
      updateHostSession(db, 's1', { roleId: 'role-b' });
      expect(getHostSession(db, 's1')?.roleId).toBe('role-b');
    });

    it('FK ON DELETE SET NULL — deleting a role unbinds chats pointing at it', () => {
      seedRole();
      upsertHostSession(db, makeSession({ roleId: 'role-pm' }));
      db.prepare(`DELETE FROM roles WHERE id = ?`).run('role-pm');
      expect(getHostSession(db, 's1')?.roleId).toBeUndefined();
    });

    it('attack: binding to a non-existent role fails the FK', () => {
      upsertHostSession(db, makeSession());
      expect(() => setHostSessionRole(db, 's1', 'ghost-role')).toThrow();
    });
  });

  // ── Phase 32: first_prompt capture ──────────────────────────────────
  describe('Phase 32 first_prompt', () => {
    it('setHostSessionFirstPrompt records the opening message', () => {
      upsertHostSession(db, makeSession());
      setHostSessionFirstPrompt(db, 's1', 'fix the login redirect bug');
      expect(getHostSession(db, 's1')?.firstPrompt).toBe('fix the login redirect bug');
    });

    it('first-write-wins: subsequent calls do NOT overwrite (per WHERE first_prompt IS NULL)', () => {
      upsertHostSession(db, makeSession());
      setHostSessionFirstPrompt(db, 's1', 'first');
      setHostSessionFirstPrompt(db, 's1', 'second-message-after');
      expect(getHostSession(db, 's1')?.firstPrompt).toBe('first');
    });

    it('upsert preserves first_prompt on conflict — next session_start hook bumping last_seen_at must not clear it', () => {
      upsertHostSession(db, makeSession({ cwd: '/proj' }));
      setHostSessionFirstPrompt(db, 's1', 'kick off the audit');

      const later = new Date(Date.now() + 1000).toISOString();
      upsertHostSession(db, makeSession({ cwd: '/proj', lastSeenAt: later }));

      expect(getHostSession(db, 's1')?.firstPrompt).toBe('kick off the audit');
    });

    it('attack: setting on a non-existent session is a no-op (UPDATE matches zero rows)', () => {
      expect(() => setHostSessionFirstPrompt(db, 'ghost', 'whatever')).not.toThrow();
      expect(getHostSession(db, 'ghost')).toBeUndefined();
    });
  });
});
