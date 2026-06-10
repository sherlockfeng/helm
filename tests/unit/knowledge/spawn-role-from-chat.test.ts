import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { upsertHostSession } from '../../../src/storage/repos/host-sessions.js';
import { appendHostEvent } from '../../../src/storage/repos/host-event-log.js';
import {
  pickSeedDocsForUnknownEntities,
  suggestRoleNameFromEntities,
} from '../../../src/knowledge/spawn-role-from-chat.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}
function seedSession(db: BetterSqlite3.Database, id = 's1'): void {
  const now = new Date().toISOString();
  upsertHostSession(db, { id, host: 'claude-code', status: 'active', firstSeenAt: now, lastSeenAt: now });
}

describe('suggestRoleNameFromEntities', () => {
  it('returns null on empty input', () => {
    expect(suggestRoleNameFromEntities([])).toBeNull();
  });

  it('builds id + name from the top entity', () => {
    expect(suggestRoleNameFromEntities(['OG', 'BAM', 'DECC'])).toEqual({
      id: 'og-expert',
      name: 'OG 专家',
    });
  });

  it('slugifies non-alphanumeric chars', () => {
    expect(suggestRoleNameFromEntities(['snake_case_thing'])).toEqual({
      id: 'snake-case-thing-expert',
      name: 'snake_case_thing 专家',
    });
  });

  it('falls back to "unknown" when the entity has no usable chars', () => {
    expect(suggestRoleNameFromEntities(['!!!'])).toEqual({
      id: 'unknown-expert',
      name: '!!! 专家',
    });
  });
});

describe('pickSeedDocsForUnknownEntities', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); seedSession(db); });
  afterEach(() => { db.close(); });

  it('returns [] when no events mention the requested entities', () => {
    appendHostEvent(db, {
      hostSessionId: 's1', kind: 'response', payload: { text: 'react hooks discussion' },
      createdAt: new Date().toISOString(),
    });
    expect(pickSeedDocsForUnknownEntities(db, 's1', ['OG', 'BAM'])).toEqual([]);
  });

  it('returns only the events that mention any of the entities', () => {
    appendHostEvent(db, {
      hostSessionId: 's1', kind: 'response', payload: { text: 'react hooks discussion' },
      createdAt: new Date().toISOString(),
    });
    appendHostEvent(db, {
      hostSessionId: 's1', kind: 'response', payload: { text: 'OG schema is v5 now' },
      createdAt: new Date().toISOString(),
    });
    appendHostEvent(db, {
      hostSessionId: 's1', kind: 'prompt', payload: { text: 'BAM IDL load is the way' },
      createdAt: new Date().toISOString(),
    });
    const docs = pickSeedDocsForUnknownEntities(db, 's1', ['OG', 'BAM']);
    expect(docs).toHaveLength(2);
    expect(docs[0]!.content).toContain('OG schema');
    expect(docs[1]!.content).toContain('BAM IDL');
  });

  it('caps total seed content at the budget', () => {
    const long = 'OG ' + 'x'.repeat(20_000);
    appendHostEvent(db, {
      hostSessionId: 's1', kind: 'response', payload: { text: long },
      createdAt: new Date().toISOString(),
    });
    const docs = pickSeedDocsForUnknownEntities(db, 's1', ['OG']);
    expect(docs).toHaveLength(1);
    // SEED_CHAR_BUDGET is 8000 in the implementation.
    expect(docs[0]!.content.length).toBeLessThanOrEqual(8_000);
  });

  it('caps total docs at MAX_SEED_DOCS (5)', () => {
    for (let i = 0; i < 10; i++) {
      appendHostEvent(db, {
        hostSessionId: 's1', kind: 'response',
        payload: { text: `Turn ${i}: OG is mentioned here` },
        createdAt: new Date().toISOString(),
      });
    }
    const docs = pickSeedDocsForUnknownEntities(db, 's1', ['OG']);
    expect(docs.length).toBeLessThanOrEqual(5);
  });

  it('returns [] for empty entities input', () => {
    appendHostEvent(db, {
      hostSessionId: 's1', kind: 'response', payload: { text: 'some text' },
      createdAt: new Date().toISOString(),
    });
    expect(pickSeedDocsForUnknownEntities(db, 's1', [])).toEqual([]);
  });
});
