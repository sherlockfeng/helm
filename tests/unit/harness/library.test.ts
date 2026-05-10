/**
 * Harness library unit tests (Phase 67).
 *
 * Cover the contract-level guarantees:
 *   - stage transitions are forward-only
 *   - archiveTask double-writes file + DB and is idempotent
 *   - searchArchive returns hits scoped by project
 *   - createTask auto-populates Related Tasks from intent tokens
 */

import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  advanceStage,
  appendStageLog,
  archiveTask,
  createTask,
  getTask,
  pushReviewToImplementChat,
  searchArchive,
  updateField,
} from '../../../src/harness/library.js';
import {
  insertReview,
} from '../../../src/storage/repos/harness.js';
import { runMigrations } from '../../../src/storage/migrations.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

let projectPath: string;

beforeEach(() => {
  projectPath = mkdtempSync(join(tmpdir(), 'harness-lib-'));
});

afterEach(() => {
  try { rmSync(projectPath, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('createTask', () => {
  it('writes task.md to disk + DB index row + empty Related Tasks for first task', () => {
    const db = openDb();
    const r = createTask(db, {
      taskId: '2026-05-10-foo',
      title: 'Foo feature',
      projectPath,
      intent: { background: 'why', objective: 'what', scopeIn: ['x'], scopeOut: ['y'] },
    });
    expect(r.task.id).toBe('2026-05-10-foo');
    expect(r.task.currentStage).toBe('new_feature');
    expect(r.relatedFound).toEqual([]); // archive empty for first task
    expect(existsSync(join(projectPath, '.harness/tasks/2026-05-10-foo/task.md'))).toBe(true);
    const file = readFileSync(join(projectPath, '.harness/tasks/2026-05-10-foo/task.md'), 'utf8');
    expect(file).toContain('Foo feature');
    expect(file).toContain('why');
    expect(file).toContain('what');
  });

  it('refuses to recreate an existing task id', () => {
    const db = openDb();
    createTask(db, { taskId: 'dup', title: 'A', projectPath });
    expect(() => createTask(db, { taskId: 'dup', title: 'B', projectPath })).toThrow(/already exists/);
  });

  it('auto-fills Related Tasks when archive cards match intent tokens', () => {
    const db = openDb();
    // Seed an archive card mentioning "Order" + "checkout"
    const a = createTask(db, { taskId: '2026-04-01-prior', title: 'Order checkout', projectPath });
    advanceStage(db, { taskId: a.task.id, toStage: 'implement', implementBaseCommit: 'a'.repeat(40) });
    archiveTask(db, {
      taskId: a.task.id,
      oneLiner: 'Built Order checkout flow',
      entities: ['Order', 'Checkout'],
      filesTouched: ['src/order.ts'],
    });

    // New task with overlapping intent text
    const b = createTask(db, {
      taskId: '2026-05-10-bar',
      title: 'Order refunds',
      projectPath,
      intent: { background: 'extend Order entity for refunds' },
    });
    expect(b.relatedFound.length).toBe(1);
    expect(b.relatedFound[0]!.taskId).toBe('2026-04-01-prior');
  });
});

describe('advanceStage', () => {
  it('refuses backwards transitions', () => {
    const db = openDb();
    createTask(db, { taskId: 't1', title: 'T1', projectPath });
    advanceStage(db, { taskId: 't1', toStage: 'implement', implementBaseCommit: 'a'.repeat(40) });
    expect(() => advanceStage(db, { taskId: 't1', toStage: 'implement' })).toThrow(/forward-only/);
    // archived → new_feature also refused (no allowed forward step from archived).
    advanceStage(db, { taskId: 't1', toStage: 'archived' });
    expect(() => advanceStage(db, { taskId: 't1', toStage: 'archived' })).toThrow(/forward-only/);
  });

  it('refuses transition to implement without implementBaseCommit', () => {
    const db = openDb();
    createTask(db, { taskId: 't1', title: 'T1', projectPath });
    expect(() => advanceStage(db, { taskId: 't1', toStage: 'implement' })).toThrow(/requires implementBaseCommit/);
  });

  it('records the base commit when entering implement', () => {
    const db = openDb();
    createTask(db, { taskId: 't1', title: 'T1', projectPath });
    advanceStage(db, { taskId: 't1', toStage: 'implement', implementBaseCommit: 'b'.repeat(40) });
    expect(getTask(db, 't1').implementBaseCommit).toBe('b'.repeat(40));
  });
});

describe('archiveTask', () => {
  it('writes archive markdown + index row + bumps stage to archived', () => {
    const db = openDb();
    createTask(db, { taskId: 't1', title: 'T1', projectPath });
    advanceStage(db, { taskId: 't1', toStage: 'implement', implementBaseCommit: 'a'.repeat(40) });
    const r = archiveTask(db, {
      taskId: 't1', oneLiner: 'one-liner here',
      entities: ['Foo'], filesTouched: ['src/foo.ts'],
    });
    expect(r.task.currentStage).toBe('archived');
    expect(r.card.entities).toEqual(['Foo']);
    expect(existsSync(join(projectPath, '.harness/archive/t1.md'))).toBe(true);
    const md = readFileSync(join(projectPath, '.harness/archive/t1.md'), 'utf8');
    expect(md).toContain('one-liner here');
    expect(md).toContain('Foo');
  });

  it('is idempotent — re-archiving regenerates the card without erroring', () => {
    const db = openDb();
    createTask(db, { taskId: 't1', title: 'T1', projectPath });
    advanceStage(db, { taskId: 't1', toStage: 'implement', implementBaseCommit: 'a'.repeat(40) });
    archiveTask(db, { taskId: 't1', oneLiner: 'first', entities: ['A'] });
    const r = archiveTask(db, { taskId: 't1', oneLiner: 'second', entities: ['B'] });
    expect(r.card.oneLiner).toBe('second');
    expect(r.card.entities).toEqual(['B']);
  });
});

describe('searchArchive', () => {
  it('returns matching cards by token; respects project scope', () => {
    const db = openDb();
    const projB = mkdtempSync(join(tmpdir(), 'harness-other-'));
    try {
      createTask(db, { taskId: 'a', title: 'A', projectPath });
      advanceStage(db, { taskId: 'a', toStage: 'implement', implementBaseCommit: 'a'.repeat(40) });
      archiveTask(db, { taskId: 'a', oneLiner: 'about Order', entities: ['Order'] });

      createTask(db, { taskId: 'c', title: 'C', projectPath: projB });
      advanceStage(db, { taskId: 'c', toStage: 'implement', implementBaseCommit: 'a'.repeat(40) });
      archiveTask(db, { taskId: 'c', oneLiner: 'about Order in other proj', entities: ['Order'] });

      const all = searchArchive(db, { tokens: ['Order'] });
      expect(all.length).toBe(2);
      const scoped = searchArchive(db, { tokens: ['Order'], projectPath });
      expect(scoped.length).toBe(1);
      expect(scoped[0]!.taskId).toBe('a');
    } finally {
      try { rmSync(projB, { recursive: true, force: true }); } catch { /* noop */ }
    }
  });
});

describe('updateField + appendStageLog', () => {
  it('updateField persists intent merge', () => {
    const db = openDb();
    createTask(db, {
      taskId: 't1', title: 'T1', projectPath,
      intent: { background: 'b', objective: 'o', scopeIn: ['x'], scopeOut: [] },
    });
    updateField(db, 't1', 'intent', { objective: 'o2' });
    expect(getTask(db, 't1').intent).toEqual({
      background: 'b', objective: 'o2', scopeIn: ['x'], scopeOut: [],
    });
  });

  it('appendStageLog adds an entry; entries accumulate', () => {
    const db = openDb();
    createTask(db, { taskId: 't1', title: 'T1', projectPath });
    appendStageLog(db, 't1', 'first');
    appendStageLog(db, 't1', 'second');
    const log = getTask(db, 't1').stageLog;
    expect(log[log.length - 1]!.message).toBe('second');
    expect(log.length).toBeGreaterThanOrEqual(3); // initial + 2
  });
});

describe('pushReviewToImplementChat', () => {
  it('fails if no host_session_id is bound', () => {
    const db = openDb();
    createTask(db, { taskId: 't1', title: 'T1', projectPath });
    insertReview(db, {
      id: 'r1', taskId: 't1', status: 'completed', reportText: 'looks good',
      spawnedAt: new Date().toISOString(),
    });
    expect(() => pushReviewToImplementChat(db, { taskId: 't1', reviewId: 'r1' }))
      .toThrow(/no host_session_id/);
  });

  it('fails if review status != completed', () => {
    const db = openDb();
    // Directly insert host_session row to satisfy FK
    db.prepare(
      `INSERT INTO host_sessions (id, host, status, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
    ).run('hs1', 'cursor', 'active', new Date().toISOString(), new Date().toISOString());
    createTask(db, { taskId: 't1', title: 'T1', projectPath, hostSessionId: 'hs1' });
    insertReview(db, {
      id: 'r1', taskId: 't1', status: 'pending',
      spawnedAt: new Date().toISOString(),
    });
    expect(() => pushReviewToImplementChat(db, { taskId: 't1', reviewId: 'r1' }))
      .toThrow(/not completed/);
  });
});
