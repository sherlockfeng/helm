/**
 * Regression: resolveOrCreateTopic must REUSE a same-name topic instead of
 * spawning duplicates. Bug: accepting several knowledge points into the same
 * suggested new 归类 created og-…/-2/-3/-4 (4 roles, same name) because dedup
 * was by id only, not by name.
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { resolveOrCreateTopic } from '../../../src/storage/repos/chat-knowledge.js';
import { listRoles, upsertRole } from '../../../src/storage/repos/roles.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

let db: BetterSqlite3.Database;
beforeEach(() => { db = openDb(); });
afterEach(() => db.close());

const now = new Date().toISOString();

describe('resolveOrCreateTopic', () => {
  it('reuses a same-name topic across accepts (no duplicates)', () => {
    const a = resolveOrCreateTopic(db, { newTopicName: 'OG 网关与 DECC 打标', now, fallbackSeed: 'p1' });
    const b = resolveOrCreateTopic(db, { newTopicName: 'OG 网关与 DECC 打标', now, fallbackSeed: 'p2' });
    const c = resolveOrCreateTopic(db, { newTopicName: 'og 网关与 decc 打标', now, fallbackSeed: 'p3' }); // case-insensitive
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(listRoles(db).filter((r) => r.name === 'OG 网关与 DECC 打标')).toHaveLength(1);
  });

  it('explicit targetRoleId wins; suggestedRoleId next', () => {
    upsertRole(db, { id: 'r-x', name: 'X', systemPrompt: '', isBuiltin: false, createdAt: now });
    expect(resolveOrCreateTopic(db, { targetRoleId: 'r-x', newTopicName: 'New', now, fallbackSeed: 'p' })).toBe('r-x');
    expect(resolveOrCreateTopic(db, { suggestedRoleId: 'r-x', now, fallbackSeed: 'p' })).toBe('r-x');
  });

  it('creates a new topic when no same-name exists; returns null with no name', () => {
    const id = resolveOrCreateTopic(db, { newTopicName: '全新归类', now, fallbackSeed: 'p' });
    expect(id).toBeTruthy();
    expect(listRoles(db).find((r) => r.id === id)?.name).toBe('全新归类');
    expect(resolveOrCreateTopic(db, { now, fallbackSeed: 'p' })).toBeNull();
  });
});
