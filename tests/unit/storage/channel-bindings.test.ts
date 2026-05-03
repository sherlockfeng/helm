import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deletePendingBind, dequeueMessages, enqueueMessage, getBindingByThread,
  getChannelBinding, getPendingBind, insertChannelBinding, insertPendingBind,
  listBindingsForSession, pendingMessageCount, purgeExpiredPendingBinds,
  updateChannelBinding,
} from '../../../src/storage/repos/channel-bindings.js';
import { upsertHostSession } from '../../../src/storage/repos/host-sessions.js';
import { runMigrations } from '../../../src/storage/migrations.js';
import type { ChannelBinding, HostSession } from '../../../src/storage/types.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedSession(db: BetterSqlite3.Database, id = 's1'): void {
  const now = new Date().toISOString();
  const s: HostSession = { id, host: 'cursor', status: 'active', firstSeenAt: now, lastSeenAt: now };
  upsertHostSession(db, s);
}

function makeBinding(overrides: Partial<ChannelBinding> = {}): ChannelBinding {
  return {
    id: 'b1', channel: 'lark', hostSessionId: 's1',
    externalChat: 'chat1', externalThread: 'thread1',
    waitEnabled: true, createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('channel bindings', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); seedSession(db); });
  afterEach(() => { db.close(); });

  it('inserts and retrieves a binding', () => {
    insertChannelBinding(db, makeBinding());
    const got = getChannelBinding(db, 'b1');
    expect(got?.channel).toBe('lark');
    expect(got?.waitEnabled).toBe(true);
  });

  it('getBindingByThread finds by channel+chat+thread', () => {
    insertChannelBinding(db, makeBinding());
    const got = getBindingByThread(db, 'lark', 'chat1', 'thread1');
    expect(got?.id).toBe('b1');
  });

  it('getBindingByThread returns undefined for unknown thread', () => {
    expect(getBindingByThread(db, 'lark', 'chat1', 'nope')).toBeUndefined();
  });

  it('listBindingsForSession returns all bindings for a session', () => {
    insertChannelBinding(db, makeBinding({ id: 'b1', externalThread: 't1' }));
    insertChannelBinding(db, makeBinding({ id: 'b2', externalThread: 't2' }));
    expect(listBindingsForSession(db, 's1')).toHaveLength(2);
  });

  it('updateChannelBinding toggles waitEnabled', () => {
    insertChannelBinding(db, makeBinding());
    updateChannelBinding(db, 'b1', { waitEnabled: false });
    expect(getChannelBinding(db, 'b1')?.waitEnabled).toBe(false);
  });

  it('attack: inserting binding with non-existent hostSessionId throws (FK)', () => {
    expect(() => insertChannelBinding(db, makeBinding({ hostSessionId: 'ghost' }))).toThrow();
  });

  it('attack: unique constraint on (channel, chat, thread)', () => {
    insertChannelBinding(db, makeBinding());
    expect(() => insertChannelBinding(db, makeBinding({ id: 'b2' }))).toThrow();
  });
});

describe('channel message queue', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); seedSession(db); insertChannelBinding(db, makeBinding()); });
  afterEach(() => { db.close(); });

  it('enqueues and dequeues messages', () => {
    const now = new Date().toISOString();
    enqueueMessage(db, { bindingId: 'b1', text: 'hello', createdAt: now });
    enqueueMessage(db, { bindingId: 'b1', text: 'world', createdAt: now });

    const msgs = dequeueMessages(db, 'b1');
    expect(msgs).toHaveLength(2);
    expect(msgs.map((m) => m.text)).toEqual(['hello', 'world']);
  });

  it('dequeue marks messages as consumed', () => {
    enqueueMessage(db, { bindingId: 'b1', text: 'once', createdAt: new Date().toISOString() });
    dequeueMessages(db, 'b1');
    expect(dequeueMessages(db, 'b1')).toHaveLength(0);
  });

  it('pendingMessageCount counts only unconsumed', () => {
    enqueueMessage(db, { bindingId: 'b1', text: 'a', createdAt: new Date().toISOString() });
    enqueueMessage(db, { bindingId: 'b1', text: 'b', createdAt: new Date().toISOString() });
    expect(pendingMessageCount(db, 'b1')).toBe(2);
    dequeueMessages(db, 'b1');
    expect(pendingMessageCount(db, 'b1')).toBe(0);
  });

  it('attack: dequeue on empty queue returns empty array', () => {
    expect(dequeueMessages(db, 'b1')).toEqual([]);
  });

  it('attack: enqueue with non-existent bindingId throws (FK)', () => {
    expect(() => enqueueMessage(db, { bindingId: 'ghost', text: 'x', createdAt: new Date().toISOString() })).toThrow();
  });
});

describe('pending binds', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); });
  afterEach(() => { db.close(); });

  it('inserts and retrieves an unexpired pending bind', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    insertPendingBind(db, { code: 'ABC123', channel: 'lark', expiresAt: future });
    const got = getPendingBind(db, 'ABC123');
    expect(got?.channel).toBe('lark');
  });

  it('getPendingBind returns undefined for expired code', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    insertPendingBind(db, { code: 'EXP', channel: 'lark', expiresAt: past });
    expect(getPendingBind(db, 'EXP')).toBeUndefined();
  });

  it('deletePendingBind removes the code', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    insertPendingBind(db, { code: 'DEL', channel: 'lark', expiresAt: future });
    deletePendingBind(db, 'DEL');
    expect(getPendingBind(db, 'DEL')).toBeUndefined();
  });

  it('purgeExpiredPendingBinds removes expired rows', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    insertPendingBind(db, { code: 'OLD', channel: 'lark', expiresAt: past });
    insertPendingBind(db, { code: 'NEW', channel: 'lark', expiresAt: future });
    const removed = purgeExpiredPendingBinds(db);
    expect(removed).toBe(1);
    expect(getPendingBind(db, 'NEW')?.code).toBe('NEW');
  });

  it('attack: unknown code returns undefined', () => {
    expect(getPendingBind(db, 'UNKNOWN')).toBeUndefined();
  });
});
