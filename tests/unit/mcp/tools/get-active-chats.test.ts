import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../../src/storage/migrations.js';
import { upsertHostSession } from '../../../../src/storage/repos/host-sessions.js';
import { getActiveChats } from '../../../../src/mcp/tools/get-active-chats.js';

let db: BetterSqlite3.Database;

beforeEach(() => {
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => { db.close(); });

describe('getActiveChats', () => {
  it('returns empty array when no sessions exist', () => {
    expect(getActiveChats(db)).toEqual({ chats: [] });
  });

  it('lists active sessions with cwd / composerMode / lastSeenAt', () => {
    const now = new Date().toISOString();
    upsertHostSession(db, {
      id: 's1', host: 'cursor', cwd: '/proj', composerMode: 'agent',
      status: 'active', firstSeenAt: now, lastSeenAt: now,
    });
    const r = getActiveChats(db);
    expect(r.chats).toHaveLength(1);
    expect(r.chats[0]).toMatchObject({
      hostSessionId: 's1', host: 'cursor', cwd: '/proj', composerMode: 'agent',
    });
  });

  it('omits closed sessions', () => {
    const now = new Date().toISOString();
    upsertHostSession(db, { id: 's1', host: 'cursor', status: 'active', firstSeenAt: now, lastSeenAt: now });
    upsertHostSession(db, { id: 's2', host: 'cursor', status: 'closed', firstSeenAt: now, lastSeenAt: now });
    expect(getActiveChats(db).chats.map((c) => c.hostSessionId)).toEqual(['s1']);
  });

  it('orders by lastSeenAt descending', () => {
    upsertHostSession(db, { id: 's1', host: 'cursor', status: 'active', firstSeenAt: '2024-01-01T00:00:00.000Z', lastSeenAt: '2024-01-01T00:00:00.000Z' });
    upsertHostSession(db, { id: 's2', host: 'cursor', status: 'active', firstSeenAt: '2024-06-01T00:00:00.000Z', lastSeenAt: '2024-06-01T00:00:00.000Z' });
    expect(getActiveChats(db).chats.map((c) => c.hostSessionId)).toEqual(['s2', 's1']);
  });
});
