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
import { getConversationDetail, groupEventsIntoTurns } from '../../../src/api/conversation-detail.js';
import type { HostEventLogEntry } from '../../../src/storage/types.js';
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
  // OR IGNORE on roles so two chunks under the same role don't trip
  // the PRIMARY KEY constraint when the helper is called twice.
  db.prepare(`
    INSERT OR IGNORE INTO roles (id, name, system_prompt, is_builtin, created_at, version)
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

  it('hydrates retrieved points with chunk title + source_file + role name', () => {
    seedSession(db, 's-1');
    seedRoleAndChunk(db, 'r-1', 'p-1');
    // Backfill the chunk title + source_file that seedRoleAndChunk omits —
    // matches what the importer would write at chunk-create time.
    db.prepare(`
      UPDATE knowledge_chunks
         SET title = ?, source_file = ?
       WHERE id = ?
    `).run('middleware-conventions.md', 'docs/middleware/conventions.md', 'p-1');
    recordRetrieval(db, {
      id: 'log-1', hostSessionId: 's-1', turn: 1, queryText: 'q', ts: 100,
    }, [
      { pointId: 'p-1', rank: 0, fusionScore: 0.82, injected: true },
    ]);

    const detail = getConversationDetail(db, 's-1')!;
    const pt = detail.knowledgeInPlay[0]!.points[0]!;
    expect(pt.title).toBe('middleware-conventions.md');
    expect(pt.sourceFile).toBe('docs/middleware/conventions.md');
    expect(pt.roleId).toBe('r-1');
    expect(pt.roleName).toBe('Role-r-1');
  });

  it('hydration tolerates a deleted chunk — point survives with no title/source', () => {
    seedSession(db, 's-1');
    seedRoleAndChunk(db, 'r-1', 'p-orphan');
    recordRetrieval(db, {
      id: 'log-1', hostSessionId: 's-1', turn: 1, queryText: 'q', ts: 100,
    }, [
      { pointId: 'p-orphan', rank: 0, fusionScore: 0.5, injected: false },
    ]);
    db.prepare('DELETE FROM knowledge_chunks WHERE id = ?').run('p-orphan');

    const detail = getConversationDetail(db, 's-1')!;
    const pt = detail.knowledgeInPlay[0]!.points[0]!;
    expect(pt.pointId).toBe('p-orphan');
    expect(pt.fusionScore).toBe(0.5);
    expect(pt.injected).toBe(false);
    expect(pt.title).toBeUndefined();
    expect(pt.roleName).toBeUndefined();
  });

  it('returns pending candidates tied to this session only', () => {
    seedSession(db, 's-1');
    seedSession(db, 's-2');
    seedRoleAndChunk(db, 'r-1', 'p-1');
    // Two pending for s-1, one accepted, one for s-2 → only the two
    // pending for s-1 should appear in the detail.
    const now = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO knowledge_candidates
        (id, role_id, host_session_id, chunk_text, source_segment_index, kind,
         score_entity, score_cosine, text_hash, status, provenance, created_at)
      VALUES (?, 'r-1', ?, ?, 0, 'other', ?, ?, ?, ?, 'chat_capture', ?)
    `);
    insert.run('cand-1', 's-1', 'first body',  3, 0.8, 'h1', 'pending',  now);
    insert.run('cand-2', 's-1', 'second body', 2, 0.7, 'h2', 'pending',  now);
    insert.run('cand-3', 's-1', 'third body',  4, 0.9, 'h3', 'accepted', now);
    insert.run('cand-4', 's-2', 'other body',  3, 0.8, 'h4', 'pending',  now);

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

  it('exposes pre-grouped turns alongside the raw timeline', () => {
    seedSession(db, 's-1');
    const t1 = '2026-06-09T10:00:00.000Z';
    const t2 = '2026-06-09T10:00:05.000Z';
    const t3 = '2026-06-09T10:01:00.000Z';
    appendHostEvent(db, { hostSessionId: 's-1', kind: 'prompt',   payload: { text: 'hi' },     createdAt: t1 });
    appendHostEvent(db, { hostSessionId: 's-1', kind: 'response', payload: { text: 'hello' },  createdAt: t2 });
    appendHostEvent(db, { hostSessionId: 's-1', kind: 'prompt',   payload: { text: 'more?' }, createdAt: t3 });
    const detail = getConversationDetail(db, 's-1')!;
    expect(detail.turns).toHaveLength(2);
    expect(detail.turns[0]!.userPrompt.text).toBe('hi');
    expect(detail.turns[0]!.assistantResponse?.text).toBe('hello');
    expect(detail.turns[1]!.userPrompt.text).toBe('more?');
    expect(detail.turns[1]!.assistantResponse).toBeUndefined(); // in-flight
  });
});

// ── groupEventsIntoTurns — unit (pure) ───────────────────────────────────

function ev(
  kind: HostEventLogEntry['kind'],
  payload: Record<string, unknown>,
  createdAt: string,
): HostEventLogEntry {
  return { id: 0, hostSessionId: 's', kind, payload, createdAt };
}

describe('groupEventsIntoTurns', () => {
  it('returns [] for empty timeline', () => {
    expect(groupEventsIntoTurns([])).toEqual([]);
  });

  it('one prompt + one response → one turn with both', () => {
    const turns = groupEventsIntoTurns([
      ev('prompt',   { text: 'q' }, 't1'),
      ev('response', { text: 'a' }, 't2'),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.userPrompt).toEqual({ text: 'q', createdAt: 't1' });
    expect(turns[0]!.assistantResponse).toEqual({ text: 'a', createdAt: 't2' });
    expect(turns[0]!.toolEvents).toEqual([]);
    expect(turns[0]!.index).toBe(1);
  });

  it('tool_use + tool_result between prompt and next prompt land in the right turn', () => {
    const turns = groupEventsIntoTurns([
      ev('prompt',      { text: 'q1' },              't1'),
      ev('tool_use',    { tool: 'Bash', cmd: 'ls' }, 't2'),
      ev('tool_result', { ok: true },                't3'),
      ev('response',    { text: 'done' },            't4'),
      ev('prompt',      { text: 'q2' },              't5'),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.toolEvents).toHaveLength(2);
    expect(turns[0]!.toolEvents[0]!.kind).toBe('tool_use');
    expect(turns[1]!.toolEvents).toEqual([]);
  });

  it('multiple response chunks: last one wins (long-response coalescing)', () => {
    const turns = groupEventsIntoTurns([
      ev('prompt',   { text: 'q' },                't1'),
      ev('response', { text: 'partial' },          't2'),
      ev('response', { text: 'final, longer one' }, 't3'),
    ]);
    expect(turns[0]!.assistantResponse?.text).toBe('final, longer one');
    expect(turns[0]!.assistantResponse?.createdAt).toBe('t3');
  });

  it('orphan response (no prior prompt) is dropped, not crashed', () => {
    const turns = groupEventsIntoTurns([
      ev('response', { text: 'orphan' }, 't1'),
      ev('prompt',   { text: 'q' },      't2'),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.userPrompt.text).toBe('q');
    expect(turns[0]!.assistantResponse).toBeUndefined();
  });

  it('in-flight turn (prompt without response) still emitted', () => {
    const turns = groupEventsIntoTurns([
      ev('prompt',   { text: 'q1' }, 't1'),
      ev('response', { text: 'a1' }, 't2'),
      ev('prompt',   { text: 'q2' }, 't3'),
      // no response for q2 yet
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[1]!.assistantResponse).toBeUndefined();
    expect(turns[1]!.userPrompt.text).toBe('q2');
  });

  it('non-string payload.text becomes empty string (defensive)', () => {
    const turns = groupEventsIntoTurns([
      ev('prompt',   { /* no text field */ },     't1'),
      ev('response', { text: 12345 as unknown }, 't2'),
    ]);
    expect(turns[0]!.userPrompt.text).toBe('');
    expect(turns[0]!.assistantResponse?.text).toBe('');
  });
});
