import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../../src/storage/migrations.js';
import { upsertHostSession } from '../../../../src/storage/repos/host-sessions.js';
import { getChannelBinding, getPendingBind } from '../../../../src/storage/repos/channel-bindings.js';
import { bindToRemoteChannel } from '../../../../src/mcp/tools/bind-to-remote-channel.js';

let db: BetterSqlite3.Database;

beforeEach(() => {
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const now = new Date().toISOString();
  upsertHostSession(db, { id: 's1', host: 'cursor', status: 'active', firstSeenAt: now, lastSeenAt: now });
});

afterEach(() => { db.close(); });

describe('bindToRemoteChannel — direct bind (thread provided)', () => {
  it('creates a new binding when externalChat + externalThread are given', () => {
    const r = bindToRemoteChannel(db, {
      hostSessionId: 's1',
      channel: 'lark',
      externalChat: 'chat1',
      externalThread: 'thread1',
    });
    expect(r.kind).toBe('bound');
    if (r.kind !== 'bound') return;
    expect(r.bindingId).toMatch(/^bnd_/);
    expect(r.reused).toBe(false);
    expect(getChannelBinding(db, r.bindingId)?.channel).toBe('lark');
  });

  it('reuses existing binding for same (channel, chat, thread)', () => {
    const first = bindToRemoteChannel(db, {
      hostSessionId: 's1', channel: 'lark', externalChat: 'chat1', externalThread: 'thread1',
    });
    const second = bindToRemoteChannel(db, {
      hostSessionId: 's1', channel: 'lark', externalChat: 'chat1', externalThread: 'thread1',
    });
    expect(first.kind).toBe('bound');
    expect(second.kind).toBe('bound');
    if (first.kind !== 'bound' || second.kind !== 'bound') return;
    expect(second.bindingId).toBe(first.bindingId);
    expect(second.reused).toBe(true);
  });
});

describe('bindToRemoteChannel — pending handshake (no thread)', () => {
  it('creates a pending bind code with 10-min expiry and instruction', () => {
    const r = bindToRemoteChannel(db, { hostSessionId: 's1', channel: 'lark' });
    expect(r.kind).toBe('pending');
    if (r.kind !== 'pending') return;
    expect(r.pendingCode).toMatch(/^[0-9A-F]{6}$/);
    expect(r.instruction).toContain(r.pendingCode);
    expect(getPendingBind(db, r.pendingCode)?.channel).toBe('lark');

    const expiresInMs = new Date(r.expiresAt).getTime() - Date.now();
    // 10 min = 600_000 ms; allow some slack for test scheduling
    expect(expiresInMs).toBeGreaterThan(9 * 60 * 1000);
    expect(expiresInMs).toBeLessThan(11 * 60 * 1000);
  });

  it('only externalChat provided (no thread) → still goes to pending mode', () => {
    const r = bindToRemoteChannel(db, { hostSessionId: 's1', channel: 'lark', externalChat: 'chat1' });
    expect(r.kind).toBe('pending');
  });
});

describe('bindToRemoteChannel — attacks', () => {
  it('attack: unknown hostSessionId throws', () => {
    expect(() => bindToRemoteChannel(db, { hostSessionId: 'ghost', channel: 'lark' }))
      .toThrow(/unknown host_session_id/);
  });

  it('attack: two distinct threads on same chat get distinct bindings', () => {
    const a = bindToRemoteChannel(db, { hostSessionId: 's1', channel: 'lark', externalChat: 'c1', externalThread: 't1' });
    const b = bindToRemoteChannel(db, { hostSessionId: 's1', channel: 'lark', externalChat: 'c1', externalThread: 't2' });
    if (a.kind !== 'bound' || b.kind !== 'bound') throw new Error('expected bound');
    expect(a.bindingId).not.toBe(b.bindingId);
  });
});
