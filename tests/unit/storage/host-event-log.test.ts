import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendHostEvent, countHostEvents, deleteHostEvents, listHostEvents, pruneHostEvents } from '../../../src/storage/repos/host-event-log.js';
import { upsertHostSession } from '../../../src/storage/repos/host-sessions.js';
import { runMigrations } from '../../../src/storage/migrations.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedSession(db: BetterSqlite3.Database, id = 's1'): void {
  const now = new Date().toISOString();
  upsertHostSession(db, { id, host: 'cursor', status: 'active', firstSeenAt: now, lastSeenAt: now });
}

describe('host event log', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); seedSession(db); });
  afterEach(() => { db.close(); });

  it('appends and lists events', () => {
    const now = new Date().toISOString();
    appendHostEvent(db, { hostSessionId: 's1', kind: 'prompt', payload: { text: 'hi' }, createdAt: now });
    appendHostEvent(db, { hostSessionId: 's1', kind: 'response', payload: { text: 'hello' }, createdAt: now });
    const events = listHostEvents(db, 's1');
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe('prompt');
  });

  it('listHostEvents respects afterId cursor', () => {
    const now = new Date().toISOString();
    const id1 = appendHostEvent(db, { hostSessionId: 's1', kind: 'prompt', payload: {}, createdAt: now });
    appendHostEvent(db, { hostSessionId: 's1', kind: 'response', payload: {}, createdAt: now });
    const events = listHostEvents(db, 's1', { afterId: id1 });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('response');
  });

  it('listHostEvents respects limit', () => {
    const now = new Date().toISOString();
    for (let i = 0; i < 5; i++) {
      appendHostEvent(db, { hostSessionId: 's1', kind: 'progress', payload: { i }, createdAt: now });
    }
    expect(listHostEvents(db, 's1', { limit: 3 })).toHaveLength(3);
  });

  it('serializes and deserializes payload', () => {
    appendHostEvent(db, { hostSessionId: 's1', kind: 'tool_use', payload: { tool: 'shell', cmd: 'ls' }, createdAt: new Date().toISOString() });
    const got = listHostEvents(db, 's1')[0];
    expect(got?.payload).toEqual({ tool: 'shell', cmd: 'ls' });
  });

  it('countHostEvents returns correct count', () => {
    const now = new Date().toISOString();
    appendHostEvent(db, { hostSessionId: 's1', kind: 'prompt', payload: {}, createdAt: now });
    appendHostEvent(db, { hostSessionId: 's1', kind: 'response', payload: {}, createdAt: now });
    expect(countHostEvents(db, 's1')).toBe(2);
  });

  it('deleteHostEvents removes all events for a session', () => {
    appendHostEvent(db, { hostSessionId: 's1', kind: 'prompt', payload: {}, createdAt: new Date().toISOString() });
    deleteHostEvents(db, 's1');
    expect(listHostEvents(db, 's1')).toHaveLength(0);
  });

  it('pruneHostEvents removes oldest events when over limit', () => {
    const now = new Date().toISOString();
    for (let i = 0; i < 5; i++) {
      appendHostEvent(db, { hostSessionId: 's1', kind: 'progress', payload: { i }, createdAt: now });
    }
    const pruned = pruneHostEvents(db, 's1', 3);
    expect(pruned).toBe(2);
    expect(countHostEvents(db, 's1')).toBe(3);
  });

  it('attack: event with non-existent hostSessionId throws (FK)', () => {
    expect(() => appendHostEvent(db, { hostSessionId: 'ghost', kind: 'prompt', payload: {}, createdAt: new Date().toISOString() })).toThrow();
  });

  it('attack: listHostEvents on session with no events returns empty array', () => {
    expect(listHostEvents(db, 's1')).toEqual([]);
  });

  it('attack: pruneHostEvents when count <= maxEvents is a no-op', () => {
    appendHostEvent(db, { hostSessionId: 's1', kind: 'prompt', payload: {}, createdAt: new Date().toISOString() });
    expect(pruneHostEvents(db, 's1', 10)).toBe(0);
  });
});
