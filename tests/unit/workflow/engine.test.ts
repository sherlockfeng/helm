import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { WorkflowEngine } from '../../../src/workflow/engine.js';
import { insertDocAudit } from '../../../src/storage/repos/doc-audit.js';

let db: BetterSqlite3.Database;
let engine: WorkflowEngine;

beforeEach(() => {
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  engine = new WorkflowEngine(db);
});

afterEach(() => { db.close(); });

describe('WorkflowEngine.initWorkflow', () => {
  it('creates campaign + first cycle in product phase', () => {
    const c = engine.initWorkflow('/proj', 'My Campaign', 'why');
    expect(c.id).toBeTruthy();
    expect(c.title).toBe('My Campaign');
    const state = engine.getCycleState(undefined, c.id);
    expect(state?.cycle.cycleNum).toBe(1);
    expect(state?.cycle.status).toBe('product');
  });
});

describe('WorkflowEngine.createTasks → dev', () => {
  it('creates tasks and advances cycle to dev', () => {
    const c = engine.initWorkflow('/proj', 'C', 'b');
    const cycle = engine.getCycleState(undefined, c.id)!.cycle;
    const tasks = engine.createTasks(cycle.id, [
      { role: 'dev', title: 'Add login' },
      { role: 'test', title: 'Test login' },
    ]);
    expect(tasks).toHaveLength(2);
    expect(engine.getCycleState(cycle.id)?.cycle.status).toBe('dev');
  });

  it('attack: cannot createTasks unless cycle status=product', () => {
    const c = engine.initWorkflow('/proj', 'C');
    const cycle = engine.getCycleState(undefined, c.id)!.cycle;
    engine.createTasks(cycle.id, [{ role: 'dev', title: 'a' }]);
    // Now cycle status is 'dev' — second createTasks should throw
    expect(() => engine.createTasks(cycle.id, [{ role: 'dev', title: 'b' }]))
      .toThrow(/must be "product"/);
  });

  it('attack: unknown cycle id throws', () => {
    expect(() => engine.createTasks('ghost', [{ role: 'dev', title: 'a' }]))
      .toThrow(/Cycle not found/);
  });
});

describe('WorkflowEngine.completeTask → test phase advance', () => {
  it('dev task without docAuditToken throws', () => {
    const c = engine.initWorkflow('/proj', 'C');
    const cycle = engine.getCycleState(undefined, c.id)!.cycle;
    const tasks = engine.createTasks(cycle.id, [{ role: 'dev', title: 't' }]);
    expect(() => engine.completeTask(tasks[0]!.id, { result: 'done' }))
      .toThrow(/docAuditToken/);
  });

  it('dev task with invalid docAuditToken throws', () => {
    const c = engine.initWorkflow('/proj', 'C');
    const cycle = engine.getCycleState(undefined, c.id)!.cycle;
    const tasks = engine.createTasks(cycle.id, [{ role: 'dev', title: 't' }]);
    expect(() => engine.completeTask(tasks[0]!.id, { result: 'done', docAuditToken: 'fake' }))
      .toThrow(/Invalid docAuditToken/);
  });

  it('test task does not require docAuditToken', () => {
    const c = engine.initWorkflow('/proj', 'C');
    const cycle = engine.getCycleState(undefined, c.id)!.cycle;
    const [, testTask] = engine.createTasks(cycle.id, [
      { role: 'dev', title: 'd' },
      { role: 'test', title: 't' },
    ]);
    // Cycle is in 'dev' so completing the test task is allowed (no doc audit check for test role)
    expect(() => engine.completeTask(testTask!.id, { result: 'ok' })).not.toThrow();
  });

  it('all dev tasks completed → cycle advances to test', () => {
    const c = engine.initWorkflow('/proj', 'C');
    const cycle = engine.getCycleState(undefined, c.id)!.cycle;
    const [d1, d2] = engine.createTasks(cycle.id, [
      { role: 'dev', title: 'd1' },
      { role: 'dev', title: 'd2' },
    ]);

    const now = new Date().toISOString();
    insertDocAudit(db, { token: 'tok-1', filePath: '/x', contentHash: 'h', createdAt: now });
    insertDocAudit(db, { token: 'tok-2', filePath: '/y', contentHash: 'h', createdAt: now });
    engine.completeTask(d1!.id, { result: 'r1', docAuditToken: 'tok-1' });
    expect(engine.getCycleState(cycle.id)?.cycle.status).toBe('dev'); // still dev
    engine.completeTask(d2!.id, { result: 'r2', docAuditToken: 'tok-2' });
    expect(engine.getCycleState(cycle.id)?.cycle.status).toBe('test');
  });
});

describe('WorkflowEngine.completeCycle', () => {
  it('only allowed in test phase', () => {
    const c = engine.initWorkflow('/proj', 'C');
    const cycle = engine.getCycleState(undefined, c.id)!.cycle;
    expect(() => engine.completeCycle(cycle.id, {})).toThrow(/must be "test"/);
  });

  it('completes cycle and auto-creates next product cycle', () => {
    const c = engine.initWorkflow('/proj', 'C');
    const cycle = engine.getCycleState(undefined, c.id)!.cycle;
    const tasks = engine.createTasks(cycle.id, [{ role: 'dev', title: 'd' }]);
    insertDocAudit(db, { token: 'tok', filePath: '/x', contentHash: 'h', createdAt: new Date().toISOString() });
    engine.completeTask(tasks[0]!.id, { result: 'r', docAuditToken: 'tok' });
    // Now in test phase
    const completed = engine.completeCycle(cycle.id, {});
    expect(completed.status).toBe('completed');
    const next = engine.getCycleState(undefined, c.id)!.cycle;
    expect(next.cycleNum).toBe(2);
    expect(next.status).toBe('product');
  });
});

describe('WorkflowEngine.createBugTasks', () => {
  it('files bugs and reverts cycle to dev', () => {
    const c = engine.initWorkflow('/proj', 'C');
    const cycle = engine.getCycleState(undefined, c.id)!.cycle;
    engine.createTasks(cycle.id, [{ role: 'dev', title: 'd' }]);
    // We're in dev now. Force into test phase by adding another bug-only fixture path:
    // Just create bug tasks directly — they revert to dev regardless of incoming status.
    const bugs = engine.createBugTasks(cycle.id, [
      { title: 'login broken', expected: 'works', actual: 'crashes' },
    ]);
    expect(bugs).toHaveLength(1);
    expect(bugs[0]?.title).toContain('[BUG]');
    expect(bugs[0]?.acceptance).toEqual(['works']);
    expect(engine.getCycleState(cycle.id)?.cycle.status).toBe('dev');
  });

  it('attack: empty bug list still requires valid cycle', () => {
    expect(() => engine.createBugTasks('ghost', []))
      .toThrow(/Cycle not found/);
  });
});

describe('WorkflowEngine.addProductFeedback / captureScreenshot', () => {
  it('addProductFeedback appends to cycle.productBrief', () => {
    const c = engine.initWorkflow('/proj', 'C');
    const cycle = engine.getCycleState(undefined, c.id)!.cycle;
    engine.addProductFeedback(cycle.id, 'design feels cluttered');
    const refreshed = engine.getCycleState(cycle.id)!.cycle;
    expect(refreshed.productBrief).toContain('cluttered');
  });

  it('captureScreenshot stores screenshot metadata', () => {
    const c = engine.initWorkflow('/proj', 'C');
    const cycle = engine.getCycleState(undefined, c.id)!.cycle;
    engine.captureScreenshot(cycle.id, '/tmp/a.png', 'login form');
    const refreshed = engine.getCycleState(cycle.id)!.cycle;
    expect(refreshed.screenshots).toHaveLength(1);
    expect(refreshed.screenshots?.[0]?.description).toBe('login form');
  });
});

describe('WorkflowEngine.addTaskComment', () => {
  it('appends comments and returns the updated task', () => {
    const c = engine.initWorkflow('/proj', 'C');
    const cycle = engine.getCycleState(undefined, c.id)!.cycle;
    const [t] = engine.createTasks(cycle.id, [{ role: 'dev', title: 'd' }]);
    engine.addTaskComment(t!.id, 'first');
    const after = engine.addTaskComment(t!.id, 'second');
    expect(after.comments).toEqual(['first', 'second']);
  });
});

describe('WorkflowEngine — docFirst enforcement toggle (B4)', () => {
  it('default behaviour: dev task requires docAuditToken (matches §12.3 default)', () => {
    const e = new WorkflowEngine(db);
    const c = e.initWorkflow('/proj', 'C');
    const cycle = e.getCycleState(undefined, c.id)!.cycle;
    const [t] = e.createTasks(cycle.id, [{ role: 'dev', title: 'd' }]);
    expect(() => e.completeTask(t!.id, { result: 'done' })).toThrow(/docAuditToken/);
  });

  it('toggle off: dev task completes without docAuditToken', () => {
    const e = new WorkflowEngine(db, { isDocFirstEnforced: () => false });
    const c = e.initWorkflow('/proj', 'C');
    const cycle = e.getCycleState(undefined, c.id)!.cycle;
    const [t] = e.createTasks(cycle.id, [{ role: 'dev', title: 'd' }]);
    const after = e.completeTask(t!.id, { result: 'done' });
    expect(after.status).toBe('completed');
    expect(after.docAuditToken).toBeUndefined();
  });

  it('toggle off: invalid docAuditToken still rejected if supplied', () => {
    const e = new WorkflowEngine(db, { isDocFirstEnforced: () => false });
    const c = e.initWorkflow('/proj', 'C');
    const cycle = e.getCycleState(undefined, c.id)!.cycle;
    const [t] = e.createTasks(cycle.id, [{ role: 'dev', title: 'd' }]);
    expect(() => e.completeTask(t!.id, { result: 'done', docAuditToken: 'ghost' }))
      .toThrow(/Invalid docAuditToken/);
  });

  it('callback re-evaluated per call — flip mid-flight', () => {
    let enforced = true;
    const e = new WorkflowEngine(db, { isDocFirstEnforced: () => enforced });
    const c = e.initWorkflow('/proj', 'C');
    const cycle = e.getCycleState(undefined, c.id)!.cycle;
    const [t1, t2] = e.createTasks(cycle.id, [
      { role: 'dev', title: 'a' },
      { role: 'dev', title: 'b' },
    ]);
    expect(() => e.completeTask(t1!.id, { result: 'a' })).toThrow();
    enforced = false;
    expect(e.completeTask(t2!.id, { result: 'b' }).status).toBe('completed');
  });
});
