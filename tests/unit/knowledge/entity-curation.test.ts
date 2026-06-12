/**
 * LLM curation of the unknown-entity strip: monotone filter semantics,
 * tolerant parsing, hash-gated re-runs.
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import {
  applyCuration,
  curateChatEntities,
  getEntityCuration,
  hashEntities,
  parseKeptList,
} from '../../../src/knowledge/entity-curation.js';
import type { UnknownEntity } from '../../../src/knowledge/chat-unknown-entities.js';
import { appendHostEvent } from '../../../src/storage/repos/host-event-log.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedSession(db: BetterSqlite3.Database, id: string): void {
  db.prepare(`
    INSERT INTO host_sessions (id, host, cwd, status, first_seen_at, last_seen_at)
    VALUES (?, 'cursor', '/tmp', 'active', ?, ?)
  `).run(id, new Date().toISOString(), new Date().toISOString());
}

function appendPrompt(db: BetterSqlite3.Database, sessionId: string, text: string): void {
  appendHostEvent(db, {
    hostSessionId: sessionId, kind: 'prompt',
    payload: { text }, createdAt: new Date().toISOString(),
  });
}

const u = (entity: string, mentions: number): UnknownEntity => ({ entity, mentions });

describe('applyCuration (pure)', () => {
  it('drops rejected, keeps kept, passes unseen-since-curation', () => {
    const unknowns = [u('SSO', 18), u('github', 29), u('DECC', 4)];
    const curation = {
      hostSessionId: 's', inputHash: 'h', curatedAt: 1,
      inputEntities: ['SSO', 'github'],   // DECC appeared after the pass
      kept: ['SSO'],
    };
    expect(applyCuration(unknowns, curation).map((x) => x.entity))
      .toEqual(['SSO', 'DECC']);
  });

  it('no curation row → passthrough', () => {
    const unknowns = [u('github', 29)];
    expect(applyCuration(unknowns, undefined)).toEqual(unknowns);
  });
});

describe('parseKeptList (tolerant)', () => {
  const input = ['SSO', 'ETL', 'github'];
  it('plain JSON array', () => {
    expect(parseKeptList('["SSO","ETL"]', input)).toEqual(['SSO', 'ETL']);
  });
  it('code-fenced + chatter, case-insensitive match, no inventions', () => {
    const raw = '挑选结果：\n```json\n["sso", "ETL", "kubernetes"]\n```';
    expect(parseKeptList(raw, input)).toEqual(['SSO', 'ETL']);
  });
  it('no array → null (skip caching rather than hide everything)', () => {
    expect(parseKeptList('都不值得保留。', input)).toBeNull();
  });
});

describe('curateChatEntities (db + fake llm)', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); seedSession(db, 's1'); });
  afterEach(() => { db.close(); });

  // github surfaces via the URL-host fold (github.com → github), same
  // mechanism that produced the noise in the real screenshot.
  const CHAT = 'SSO SSO SSO 的接入和 ETL ETL ETL 流程要沉淀；相关讨论在 '
    + 'https://github.com/org/a 和 https://github.com/org/b 还有 https://github.com/org/c 上。';

  it('runs the LLM, stores the verdict, and detail-side filter applies it', async () => {
    appendPrompt(db, 's1', CHAT);
    const llm = { generate: vi.fn(async () => '["SSO","ETL"]') };
    const kept = await curateChatEntities(db, 's1', { llm });
    expect(kept).toEqual(['SSO', 'ETL']);
    const row = getEntityCuration(db, 's1');
    expect(row?.kept).toEqual(['SSO', 'ETL']);
    expect(row?.inputEntities).toContain('github');
  });

  it('same entity list → hash gate skips the second LLM call', async () => {
    appendPrompt(db, 's1', CHAT);
    const llm = { generate: vi.fn(async () => '["SSO","ETL"]') };
    await curateChatEntities(db, 's1', { llm });
    const second = await curateChatEntities(db, 's1', { llm });
    expect(second).toBeNull();
    expect(llm.generate).toHaveBeenCalledTimes(1);
  });

  it('LLM failure → no cache row, next call retries', async () => {
    appendPrompt(db, 's1', CHAT);
    const failing = { generate: vi.fn(async () => { throw new Error('engine down'); }) };
    expect(await curateChatEntities(db, 's1', { llm: failing })).toBeNull();
    expect(getEntityCuration(db, 's1')).toBeUndefined();
  });

  it('hashEntities is order-insensitive but count-sensitive', () => {
    const a = [u('SSO', 2), u('ETL', 3)];
    const b = [u('ETL', 3), u('SSO', 2)];
    const c = [u('ETL', 4), u('SSO', 2)];
    expect(hashEntities(a)).toBe(hashEntities(b));
    expect(hashEntities(a)).not.toBe(hashEntities(c));
  });
});
