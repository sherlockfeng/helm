import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { confirmCapture, startCapture, submitAnswers } from '../../../src/requirements/capture.js';
import { recallRequirements, formatRequirementForInjection } from '../../../src/requirements/recall.js';
import { getRequirement } from '../../../src/storage/repos/requirements.js';

let db: BetterSqlite3.Database;

beforeEach(() => {
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => { db.close(); });

describe('startCapture (new)', () => {
  it('returns clarifying questions and a sessionId', () => {
    const r = startCapture(db, 'chat context here', 'New Feature');
    expect(r.sessionId).toBeTruthy();
    expect(r.isUpdate).toBe(false);
    expect(r.questions.length).toBeGreaterThan(0);
    expect(r.questions.some((q) => q.key === 'purpose')).toBe(true);
  });
});

describe('startCapture (update existing)', () => {
  it('returns update questions and pre-fills answers', async () => {
    const start = startCapture(db, 'ctx', 'feat');
    const answered = submitAnswers(db, start.sessionId, {
      purpose: 'fix it',
      changes: 'changed A\nchanged B',
      tags: 'perf, ux',
    });
    expect(answered.draft.purpose).toBe('fix it');
    const confirmed = confirmCapture(db, start.sessionId);

    // Now restart with requirementId → should be update mode
    const update = startCapture(db, 'new ctx', 'feat', confirmed.id);
    expect(update.isUpdate).toBe(true);
    expect(update.existing?.id).toBe(confirmed.id);
    expect(update.questions.some((q) => q.question.includes('上次'))).toBe(true);
  });
});

describe('submitAnswers', () => {
  it('builds a draft from answers (purpose / changes / tags)', () => {
    const start = startCapture(db, 'ctx', 'feat');
    const r = submitAnswers(db, start.sessionId, {
      purpose: 'fix bug',
      changes: 'edit X; edit Y',
      tags: 'bugfix, ux',
      background: 'see PRD\nrelated link',
      outcome: 'tests pass',
    });
    expect(r.draft.purpose).toBe('fix bug');
    expect(r.draft.tags).toEqual(['bugfix', 'ux']);
    expect(r.draft.changes).toEqual(['edit X', 'edit Y']);
    expect(r.draft.relatedDocs).toEqual(['see PRD', 'related link']);
    expect(r.draft.summary).toContain('**目的**：fix bug');
  });

  it('attack: unknown sessionId throws', () => {
    expect(() => submitAnswers(db, 'ghost', {})).toThrow(/Session not found/);
  });
});

describe('confirmCapture', () => {
  it('persists a new requirement', () => {
    const start = startCapture(db, 'ctx', 'New');
    submitAnswers(db, start.sessionId, { purpose: 'p', changes: 'c1', tags: 'tag' });
    const req = confirmCapture(db, start.sessionId);
    expect(req.status).toBe('confirmed');
    expect(getRequirement(db, req.id)?.name).toBe('New');
  });

  it('edits override draft fields', () => {
    const start = startCapture(db, 'ctx', 'orig');
    submitAnswers(db, start.sessionId, { purpose: 'orig purpose' });
    const req = confirmCapture(db, start.sessionId, { name: 'edited', purpose: 'new purpose' });
    expect(req.name).toBe('edited');
    expect(req.purpose).toBe('new purpose');
  });

  it('updating an existing requirement merges changes + appends context', () => {
    const start1 = startCapture(db, 'first ctx', 'feat');
    submitAnswers(db, start1.sessionId, { purpose: 'p1', changes: 'change 1' });
    const r1 = confirmCapture(db, start1.sessionId);

    const start2 = startCapture(db, 'second ctx', '', r1.id);
    submitAnswers(db, start2.sessionId, { changes: 'change 2', outcome: 'ok' });
    const r2 = confirmCapture(db, start2.sessionId);

    expect(r2.changes).toContain('change 1');
    expect(r2.changes).toContain('change 2');
    expect(r2.context).toContain('first ctx');
    expect(r2.context).toContain('second ctx');
  });

  it('attack: confirm without prior submitAnswers throws', () => {
    const start = startCapture(db, 'ctx', 'feat');
    expect(() => confirmCapture(db, start.sessionId)).toThrow(/No draft/);
  });

  it('attack: unknown sessionId throws', () => {
    expect(() => confirmCapture(db, 'ghost')).toThrow(/Session not found/);
  });
});

describe('recallRequirements / formatRequirementForInjection', () => {
  it('recall returns saved requirements; query filters by name/summary/purpose', () => {
    const start = startCapture(db, 'ctx', 'login feature');
    submitAnswers(db, start.sessionId, { purpose: 'enable login', tags: 'auth' });
    confirmCapture(db, start.sessionId);

    expect(recallRequirements(db)).toHaveLength(1);
    expect(recallRequirements(db, 'login')).toHaveLength(1);
    expect(recallRequirements(db, 'unrelated')).toHaveLength(0);
  });

  it('formatRequirementForInjection produces well-structured markdown', () => {
    const start = startCapture(db, 'context line', 'feat');
    submitAnswers(db, start.sessionId, { purpose: 'x', changes: 'a\nb', tags: 'tag1, tag2' });
    const req = confirmCapture(db, start.sessionId);
    const md = formatRequirementForInjection(req);
    expect(md).toContain('# 需求：feat');
    expect(md).toContain('## 目的');
    expect(md).toContain('## 主要改动');
    expect(md).toContain('## 标签');
  });

  it('truncates long context at 800 chars', () => {
    const longContext = 'x'.repeat(2000);
    const start = startCapture(db, longContext, 'feat');
    submitAnswers(db, start.sessionId, { purpose: 'p' });
    const req = confirmCapture(db, start.sessionId);
    const md = formatRequirementForInjection(req);
    expect(md).toContain('已截断');
  });
});
