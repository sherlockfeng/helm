/**
 * Unit tests for the benchmark-case MCP tool impls.
 *
 *   - proposeBenchmarkCase inserts a file-less 'proposed' case targeting the topic
 *   - default name derives from a (truncated) question
 *   - updateBenchmarkCase edits a still-proposed case
 *   - missing case → updated:false + 'case not found'
 *   - confirmed case → updated:false + actionable message (no DB mutation)
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../../src/storage/migrations.js';
import { getCase, insertCase } from '../../../../src/storage/repos/benchmark.js';
import { upsertRole } from '../../../../src/storage/repos/roles.js';
import {
  proposeBenchmarkCase,
  updateBenchmarkCase,
} from '../../../../src/mcp/tools/benchmark-cases.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedRole(db: BetterSqlite3.Database, roleId: string): void {
  upsertRole(db, {
    id: roleId, name: `R-${roleId}`, systemPrompt: 'sp',
    isBuiltin: false, createdAt: new Date().toISOString(),
  });
}

function seedChunk(db: BetterSqlite3.Database, roleId: string, pointId: string): void {
  db.prepare(`
    INSERT INTO knowledge_chunks (id, role_id, chunk_text, kind, created_at)
    VALUES (?, ?, 'body', 'spec', ?)
  `).run(pointId, roleId, new Date().toISOString());
}

describe('proposeBenchmarkCase', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); seedRole(db, 'topic-1'); seedChunk(db, 'topic-1', 'p-1'); });
  afterEach(() => { db.close(); });

  it('inserts a proposed, file-less case targeting the topic', () => {
    const out = proposeBenchmarkCase(db, {
      topicId: 'topic-1',
      question: 'How do I roll back a TCE deploy?',
      expectedTruth: 'Pause the rollout, then revert to the prior version.',
      goldenPointIds: ['p-1'],
    });
    expect(out.status).toBe('proposed');
    expect(out.caseId).toMatch(/[0-9a-f-]{36}/);
    const c = getCase(db, out.caseId)!;
    expect(c.status).toBe('proposed');
    expect(c.proposedSource).toBe('manual');
    expect(c.targetRoleIds).toEqual(['topic-1']);
    expect(c.goldenPointIds).toEqual(['p-1']);
    expect(c.question).toBe('How do I roll back a TCE deploy?');
    expect(c.proposedQuestionHash).toBeDefined();
    expect(c.proposedQuestionHash!.length).toBe(32);
  });

  it('derives a truncated default name from the question when none given', () => {
    const longQ = 'x'.repeat(120);
    const out = proposeBenchmarkCase(db, {
      topicId: 'topic-1', question: longQ, expectedTruth: 't',
    });
    const c = getCase(db, out.caseId)!;
    expect(c.name.length).toBeLessThanOrEqual(61); // 60 chars + ellipsis
    expect(c.name.endsWith('…')).toBe(true);
  });

  it('honours an explicit name and defaults goldenPointIds to []', () => {
    const out = proposeBenchmarkCase(db, {
      topicId: 'topic-1', question: 'q', expectedTruth: 't', name: 'my eval',
    });
    const c = getCase(db, out.caseId)!;
    expect(c.name).toBe('my eval');
    expect(c.goldenPointIds).toEqual([]);
  });
});

describe('updateBenchmarkCase', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); seedRole(db, 'topic-1'); });
  afterEach(() => { db.close(); });

  it('returns updated:false + "case not found" for an unknown id', () => {
    const out = updateBenchmarkCase(db, { caseId: 'ghost', name: 'x' });
    expect(out).toEqual({ caseId: 'ghost', updated: false, message: 'case not found' });
  });

  it('edits a still-proposed case', () => {
    const { caseId } = proposeBenchmarkCase(db, {
      topicId: 'topic-1', question: 'q-orig', expectedTruth: 't-orig',
    });
    const out = updateBenchmarkCase(db, {
      caseId, question: 'q-new', expectedTruth: 't-new',
    });
    expect(out).toEqual({ caseId, updated: true });
    const c = getCase(db, caseId)!;
    expect(c.question).toBe('q-new');
    expect(c.expectedTruth).toBe('t-new');
    expect(c.status).toBe('proposed');
  });

  it('refuses to edit a confirmed (file-backed) case and leaves it untouched', () => {
    insertCase(db, {
      id: 'c-conf', name: 'confirmed', question: 'q', expectedTruth: 't',
      // default status for 'manual' source is 'confirmed'
    });
    const out = updateBenchmarkCase(db, { caseId: 'c-conf', question: 'hacked' });
    expect(out.updated).toBe(false);
    expect(out.message).toMatch(/confirmed cases are file-backed/);
    expect(getCase(db, 'c-conf')!.question).toBe('q'); // unchanged
  });
});
