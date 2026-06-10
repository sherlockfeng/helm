import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { upsertHostSession } from '../../../src/storage/repos/host-sessions.js';
import { appendHostEvent } from '../../../src/storage/repos/host-event-log.js';
import { upsertRole } from '../../../src/storage/repos/roles.js';
import { unknownEntitiesForChat } from '../../../src/knowledge/chat-unknown-entities.js';

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
function seedKnownEntities(db: BetterSqlite3.Database, entities: readonly string[]): void {
  upsertRole(db, { id: 'r1', name: 'r1', systemPrompt: 'p', isBuiltin: false, createdAt: 't' });
  db.prepare(`
    INSERT INTO knowledge_chunks (id, role_id, chunk_text, kind, created_at)
    VALUES ('chunk-1', 'r1', 'body', 'spec', datetime('now'))
  `).run();
  const stmt = db.prepare(`
    INSERT INTO knowledge_chunk_entities (chunk_id, role_id, entity, weight, created_at)
    VALUES ('chunk-1', 'r1', ?, 1.0, datetime('now'))
  `);
  for (const e of entities) stmt.run(e);
}
function appendPrompt(db: BetterSqlite3.Database, sid: string, text: string): void {
  appendHostEvent(db, { hostSessionId: sid, kind: 'prompt', payload: { text }, createdAt: new Date().toISOString() });
}
function appendResponse(db: BetterSqlite3.Database, sid: string, text: string): void {
  appendHostEvent(db, { hostSessionId: sid, kind: 'response', payload: { text }, createdAt: new Date().toISOString() });
}

describe('unknownEntitiesForChat', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); });
  afterEach(() => { db.close(); });

  it('returns [] for a chat with no events', () => {
    seedSession(db);
    expect(unknownEntitiesForChat(db, 's1')).toEqual([]);
  });

  it('returns [] when chat has entities but they\'re ALL known to some role', () => {
    seedSession(db);
    seedKnownEntities(db, ['TCE', 'CSR', 'BAM']);
    appendPrompt(db, 's1', 'TCE TCE CSR BAM TCE');
    expect(unknownEntitiesForChat(db, 's1')).toEqual([]);
  });

  it('surfaces only the entities NOT covered by any role, sorted by mentions desc', () => {
    seedSession(db);
    // Note: entities must be ≥3 uppercase chars to clear extractEntities
    // Tier 2 (the regex \b[A-Z]{3,}\d{0,3}\b). 2-letter "OG" would never
    // be extracted; use BAM / DECC / TCE which are real-world acronyms.
    seedKnownEntities(db, ['TCE', 'CSR']);
    // DECC ×4, BAM ×3, TCE ×5 (but TCE is known)
    appendPrompt(db, 's1', 'TCE TCE TCE TCE TCE DECC DECC BAM');
    appendResponse(db, 's1', 'DECC DECC BAM BAM');
    const out = unknownEntitiesForChat(db, 's1');
    expect(out.map((u) => u.entity)).toEqual(['DECC', 'BAM']);
    expect(out[0]!.mentions).toBe(4);
    expect(out[1]!.mentions).toBe(3);
  });

  it('respects the minMentions threshold', () => {
    seedSession(db);
    seedKnownEntities(db, ['TCE']);
    appendPrompt(db, 's1', 'BAM DECC ABC'); // each ×1, below default minMentions=3
    expect(unknownEntitiesForChat(db, 's1')).toEqual([]);
    // Relax: at least 1 mention → all 3 unknowns appear
    const relaxed = unknownEntitiesForChat(db, 's1', { minMentions: 1 });
    expect(relaxed.map((u) => u.entity).sort()).toEqual(['ABC', 'BAM', 'DECC']);
  });

  it('caps result at topN sorted slots', () => {
    seedSession(db);
    seedKnownEntities(db, []);
    // 10 distinct entities, each ×3
    appendPrompt(db, 's1',
      'AAA AAA AAA BBB BBB BBB CCC CCC CCC DDD DDD DDD '
      + 'EEE EEE EEE FFF FFF FFF GGG GGG GGG HHH HHH HHH '
      + 'III III III JJJ JJJ JJJ');
    const out = unknownEntitiesForChat(db, 's1', { topN: 4 });
    expect(out).toHaveLength(4);
  });

  it('drops result entirely when fewer than minDistinct clear the threshold', () => {
    seedSession(db);
    seedKnownEntities(db, []);
    appendPrompt(db, 's1', 'XYZ XYZ XYZ'); // only 1 unknown
    expect(unknownEntitiesForChat(db, 's1', { minDistinct: 2 })).toEqual([]);
  });
});
