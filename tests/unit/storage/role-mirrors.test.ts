import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import {
  bumpRoleVersion,
  upsertRole,
} from '../../../src/storage/repos/roles.js';
import {
  clearMirrorError,
  deleteMirror,
  getMirror,
  listDueForPush,
  listMirrors,
  recordPushFailure,
  recordPushSuccess,
  upsertMirror,
} from '../../../src/storage/repos/role-mirrors.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

const NOW = '2026-05-19T00:00:00.000Z';

function seedRole(db: BetterSqlite3.Database, id = 'r1'): void {
  upsertRole(db, { id, name: id, systemPrompt: 'p', isBuiltin: false, createdAt: NOW });
}

describe('role-mirrors repo', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); seedRole(db); });
  afterEach(() => { db.close(); });

  describe('upsertMirror', () => {
    it('creates a new row with last_pushed_* NULL', () => {
      const m = upsertMirror(db, { roleId: 'r1', targetUrl: 'tos://b', now: NOW });
      expect(m.targetUrl).toBe('tos://b');
      expect(m.enabled).toBe(true);
      expect(m.lastPushedVersion).toBeUndefined();
      expect(m.lastError).toBeUndefined();
    });

    it('honors enabled=false', () => {
      const m = upsertMirror(db, { roleId: 'r1', targetUrl: 'tos://b', enabled: false, now: NOW });
      expect(m.enabled).toBe(false);
    });

    it('updating preserves last_pushed_version (target_url swap is rare)', () => {
      upsertMirror(db, { roleId: 'r1', targetUrl: 'tos://old', now: NOW });
      recordPushSuccess(db, { roleId: 'r1', pushedVersion: 3, etag: 'e1', at: NOW });
      upsertMirror(db, { roleId: 'r1', targetUrl: 'tos://new', now: NOW });
      const after = getMirror(db, 'r1');
      expect(after?.targetUrl).toBe('tos://new');
      expect(after?.lastPushedVersion).toBe(3);
    });

    it('updating clears last_error (user explicitly changed config)', () => {
      upsertMirror(db, { roleId: 'r1', targetUrl: 'tos://b', now: NOW });
      recordPushFailure(db, { roleId: 'r1', error: 'boom', at: NOW });
      expect(getMirror(db, 'r1')?.lastError).toBe('boom');
      upsertMirror(db, { roleId: 'r1', targetUrl: 'tos://b', now: NOW });
      expect(getMirror(db, 'r1')?.lastError).toBeUndefined();
    });
  });

  describe('deleteMirror', () => {
    it('returns true when removed', () => {
      upsertMirror(db, { roleId: 'r1', targetUrl: 'tos://b', now: NOW });
      expect(deleteMirror(db, 'r1')).toBe(true);
      expect(getMirror(db, 'r1')).toBeUndefined();
    });

    it('returns false when not present', () => {
      expect(deleteMirror(db, 'ghost')).toBe(false);
    });

    it('cascades when the role is deleted', () => {
      upsertMirror(db, { roleId: 'r1', targetUrl: 'tos://b', now: NOW });
      db.prepare(`DELETE FROM roles WHERE id = ?`).run('r1');
      expect(getMirror(db, 'r1')).toBeUndefined();
    });
  });

  describe('listDueForPush', () => {
    it('returns nothing when no mirrors', () => {
      expect(listDueForPush(db)).toEqual([]);
    });

    it('includes mirrors that were never pushed', () => {
      upsertMirror(db, { roleId: 'r1', targetUrl: 'tos://b', now: NOW });
      const due = listDueForPush(db);
      expect(due).toHaveLength(1);
      expect(due[0]?.roleId).toBe('r1');
      expect(due[0]?.lastPushedVersion).toBeUndefined();
    });

    it('skips mirrors caught up to current role.version', () => {
      upsertMirror(db, { roleId: 'r1', targetUrl: 'tos://b', now: NOW });
      // Role at v=1 (default). Mirror "pushed v=1" → not due.
      recordPushSuccess(db, { roleId: 'r1', pushedVersion: 1, at: NOW });
      expect(listDueForPush(db)).toHaveLength(0);
    });

    it('includes mirrors where role.version > last_pushed_version', () => {
      upsertMirror(db, { roleId: 'r1', targetUrl: 'tos://b', now: NOW });
      recordPushSuccess(db, { roleId: 'r1', pushedVersion: 1, at: NOW });
      // Bump role to v=2 — mirror now lags.
      bumpRoleVersion(db, 'r1');
      const due = listDueForPush(db);
      expect(due).toHaveLength(1);
      expect(due[0]?.lastPushedVersion).toBe(1);
      expect(due[0]?.roleVersion).toBe(2);
    });

    it('skips disabled mirrors', () => {
      upsertMirror(db, { roleId: 'r1', targetUrl: 'tos://b', enabled: false, now: NOW });
      expect(listDueForPush(db)).toEqual([]);
    });

    it('skips mirrors with last_error set (avoid sweep hammering a broken target)', () => {
      upsertMirror(db, { roleId: 'r1', targetUrl: 'tos://b', now: NOW });
      recordPushFailure(db, { roleId: 'r1', error: 'boom', at: NOW });
      expect(listDueForPush(db)).toEqual([]);
    });
  });

  describe('recordPushSuccess / recordPushFailure', () => {
    it('success updates pushed fields + clears error', () => {
      upsertMirror(db, { roleId: 'r1', targetUrl: 'tos://b', now: NOW });
      recordPushFailure(db, { roleId: 'r1', error: 'boom', at: NOW });
      recordPushSuccess(db, { roleId: 'r1', pushedVersion: 5, etag: 'e1', at: NOW });
      const m = getMirror(db, 'r1');
      expect(m?.lastPushedVersion).toBe(5);
      expect(m?.lastPushedEtag).toBe('e1');
      expect(m?.lastError).toBeUndefined();
    });

    it('failure writes last_error but leaves last_pushed_version alone', () => {
      upsertMirror(db, { roleId: 'r1', targetUrl: 'tos://b', now: NOW });
      recordPushSuccess(db, { roleId: 'r1', pushedVersion: 3, at: NOW });
      recordPushFailure(db, { roleId: 'r1', error: 'boom', at: NOW });
      const m = getMirror(db, 'r1');
      expect(m?.lastPushedVersion).toBe(3); // unchanged
      expect(m?.lastError).toBe('boom');
    });
  });

  describe('clearMirrorError', () => {
    it('clears last_error', () => {
      upsertMirror(db, { roleId: 'r1', targetUrl: 'tos://b', now: NOW });
      recordPushFailure(db, { roleId: 'r1', error: 'boom', at: NOW });
      clearMirrorError(db, 'r1');
      expect(getMirror(db, 'r1')?.lastError).toBeUndefined();
    });
  });

  describe('listMirrors', () => {
    it('returns all mirrors sorted by roleId', () => {
      seedRole(db, 'r2');
      upsertMirror(db, { roleId: 'r2', targetUrl: 'tos://b2', now: NOW });
      upsertMirror(db, { roleId: 'r1', targetUrl: 'tos://b1', now: NOW });
      const list = listMirrors(db);
      expect(list.map((m) => m.roleId)).toEqual(['r1', 'r2']);
    });
  });
});
