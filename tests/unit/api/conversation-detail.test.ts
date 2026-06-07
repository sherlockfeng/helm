/**
 * Unit tests for the Conversation Detail aggregator (PR 3.2).
 *
 * Covers the load-bearing joins:
 *   - returns null on unknown session id (API layer maps to 404)
 *   - session header is the same shape as the active-chats list response
 *   - timeline reads from host_event_log in insertion order
 *   - knowledgeInPlay pairs retrieval_log header rows with their
 *     retrieval_log_points children
 *   - candidates filters by host_session_id + status='pending'
 *   - Limits are respected even when underlying data is larger
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { getConversationDetail } from '../../../src/api/conversation-detail.js';
import { appendHostEvent } from '../../../src/storage/repos/host-event-log.js';
import { recordRetrieval } from '../../../src/storage/repos/retrieval-log.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedSession(db: BetterSqlite3.Database, id: string): void {
  db.prepare(`
    INSERT INTO host_sessions (id, host, agent_kind, cwd, status, first_seen_at, last_seen_at)
    VALUES (?, 'cursor', 'cursor', '/tmp', 'active', ?, ?)
  `).run(id, new Date().toISOString(), new Date().toISOString());
}

function seedRoleAndChunk(db: BetterSqlite3.Database, roleId: string, chunkId: string): void {
  db.prepare(`
    INSERT INTO roles (id, name, system_prompt, is_builtin, created_at, version)
    VALUES (?, ?, 'sp', 0, ?, 1)
  `).run(roleId, `Role-${roleId}`, new Date().toISOString());
  db.prepare(`
    INSERT INTO knowledge_chunks (id, role_id, chunk_text, kind, created_at)
    VALUES (?, ?, 'body', 'spec', ?)
  `).run(chunkId, roleId, new Date().toISOString());
}

describe('getConversationDetail', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); });
  afterEach(() => { db.close(); });

  it('returns null for an unknown session', () => {
    expect(getConversationDetail(db, 'does-not-exist')).toBeNull();
  });

  it('hydrates a freshly-created session with empty sub-collections', () => {
    seedSession(db, 's-empty');
    const detail = getConversationDetail(db, 's-empty');
    expect(detail).not.toBeNull();
    expect(detail!.session.id).toBe('s-empty');
    expect(detail!.session.agentKind).toBe('cursor');
    expect(detail!.timeline).toEqual([]);
    expect(detail!.knowledgeInPlay).toEqual([]);
    expect(detail!.candidates).toEqual([]);
  });

  it('returns the timeline in chronological order', () => {
    seedSession(db, 's-1');
    appendHostEvent(db, {
      hostSessionId: 's-1', kind: 'prompt', payload: { text: 'hi' },
      createdAt: new Date().toISOString(),
    });
    appendHostEvent(db, {
      hostSessionId: 's-1', kind: 'response', payload: { text: 'hello' },
      createdAt: new Date().toISOString(),
    });
    appendHostEvent(db, {
      hostSessionId: 's-1', kind: 'prompt', payload: { text: 'again' },
      createdAt: new Date().toISOString(),
    });

    const detail = getConversationDetail(db, 's-1')!;
    expect(detail.timeline.map((e) => e.kind))
      .toEqual(['prompt', 'response', 'prompt']);
  });

  it('joins retrieval_log rows with their per-point children', () => {
    seedSession(db, 's-1');
    seedRoleAndChunk(db, 'r-1', 'p-1');
    seedRoleAndChunk(db, 'r-1', 'p-2');
    recordRetrieval(db, {
      id: 'log-1', hostSessionId: 's-1', turn: 1, queryText: 'q1', ts: 100,
    }, [
      { pointId: 'p-1', rank: 0, fusionScore: 0.9, injected: true },
      { pointId: 'p-2', rank: 1, fusionScore: 0.7, injected: true },
    ]);
    recordRetrieval(db, {
      id: 'log-2', hostSessionId: 's-1', turn: 2, queryText: 'q2', ts: 200,
    }, [
      { pointId: 'p-1', rank: 0, fusionScore: 0.95, injected: true },
    ]);

    const detail = getConversationDetail(db, 's-1')!;
    // Newest first (getRetrievalsForSession orders by ts DESC).
    expect(detail.knowledgeInPlay.map((k) => k.log.id)).toEqual(['log-2', 'log-1']);
    expect(detail.knowledgeInPlay[0]!.points).toHaveLength(1);
    expect(detail.knowledgeInPlay[1]!.points).toHaveLength(2);
    expect(detail.knowledgeInPlay[1]!.points[0]!.fusionScore).toBe(0.9);
  });

  it('returns pending candidates tied to this session only', () => {
    seedSession(db, 's-1');
    seedSession(db, 's-2');
    seedRoleAndChunk(db, 'r-1', 'p-1');
    // Two pending for s-1, one accepted, one for s-2 → only the two
    // pending for s-1 should appear in the detail.
    db.prepare(`
      INSERT INTO knowledge_candidates
        (id, role_id, host_session_id, chunk_text, source_segment_index, kind,
         score_entity, score_cosine, text_hash, status, provenance, created_at, updated_at)
      VALUES (?, 'r-1', ?, ?, 0, 'other', 3, 0.7, ?, ?, 'chat_capture', ?, ?)
    `);
    const now = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO knowledge_candidates
        (id, role_id, host_session_id, chunk_text, source_segment_index, kind,
         score_entity, score_cosine, text_hash, status, provenance, created_at, updated_at)
      VALUES (?, 'r-1', ?, ?, 0, 'other', ?, ?, ?, ?, 'chat_capture', ?, ?)
    `);
    insert.run('cand-1', 's-1', 'first body',  3, 0.8, 'h1', 'pending',  now, now);
    insert.run('cand-2', 's-1', 'second body', 2, 0.7, 'h2', 'pending',  now, now);
    insert.run('cand-3', 's-1', 'third body',  4, 0.9, 'h3', 'accepted', now, now);
    insert.run('cand-4', 's-2', 'other body',  3, 0.8, 'h4', 'pending',  now, now);

    const detail = getConversationDetail(db, 's-1')!;
    expect(detail.candidates.map((c) => c.id).sort()).toEqual(['cand-1', 'cand-2']);
  });

  it('respects the timelineLimit option', () => {
    seedSession(db, 's-1');
    const ts = new Date().toISOString();
    for (let i = 0; i < 100; i++) {
      appendHostEvent(db, {
        hostSessionId: 's-1', kind: 'prompt', payload: { i },
        createdAt: ts,
      });
    }
    const detail = getConversationDetail(db, 's-1', { timelineLimit: 10 })!;
    expect(detail.timeline).toHaveLength(10);
  });
});
