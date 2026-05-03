import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getCampaign, getActiveCycle, getCycle, getTask,
  insertCampaign, insertCycle, insertTask,
  listCampaigns, listCycles, listTasks,
  updateCampaign, updateCycle, updateTask,
} from '../../../src/storage/repos/campaigns.js';
import { runMigrations } from '../../../src/storage/migrations.js';
import type { Campaign, Cycle, Task } from '../../../src/storage/types.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeCampaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: 'c1', projectPath: '/proj', title: 'Test Campaign',
    status: 'active', startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeCycle(overrides: Partial<Cycle> = {}): Cycle {
  return {
    id: 'cy1', campaignId: 'c1', cycleNum: 1, status: 'pending',
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1', cycleId: 'cy1', role: 'dev', title: 'Do something',
    status: 'pending', createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('campaigns', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); });
  afterEach(() => { db.close(); });

  it('inserts and retrieves a campaign', () => {
    insertCampaign(db, makeCampaign());
    const got = getCampaign(db, 'c1');
    expect(got?.title).toBe('Test Campaign');
    expect(got?.status).toBe('active');
  });

  it('lists campaigns ordered by startedAt DESC', () => {
    insertCampaign(db, makeCampaign({ id: 'c1', startedAt: '2024-01-01T00:00:00.000Z' }));
    insertCampaign(db, makeCampaign({ id: 'c2', startedAt: '2024-06-01T00:00:00.000Z' }));
    const list = listCampaigns(db);
    expect(list[0]?.id).toBe('c2');
  });

  it('updates campaign status and summary', () => {
    insertCampaign(db, makeCampaign());
    updateCampaign(db, 'c1', { status: 'completed', summary: 'done' });
    expect(getCampaign(db, 'c1')?.status).toBe('completed');
    expect(getCampaign(db, 'c1')?.summary).toBe('done');
  });

  it('attack: updating non-existent campaign is a no-op', () => {
    expect(() => updateCampaign(db, 'ghost', { status: 'completed' })).not.toThrow();
  });

  it('attack: duplicate campaign id throws', () => {
    insertCampaign(db, makeCampaign());
    expect(() => insertCampaign(db, makeCampaign())).toThrow();
  });

  it('returns undefined for missing campaign', () => {
    expect(getCampaign(db, 'missing')).toBeUndefined();
  });
});

describe('cycles', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => {
    db = openDb();
    insertCampaign(db, makeCampaign());
  });
  afterEach(() => { db.close(); });

  it('inserts and retrieves a cycle', () => {
    insertCycle(db, makeCycle());
    const got = getCycle(db, 'cy1');
    expect(got?.cycleNum).toBe(1);
    expect(got?.status).toBe('pending');
  });

  it('getActiveCycle returns the latest non-completed cycle', () => {
    insertCycle(db, makeCycle({ id: 'cy1', cycleNum: 1, status: 'completed' }));
    insertCycle(db, makeCycle({ id: 'cy2', cycleNum: 2, status: 'dev' }));
    const active = getActiveCycle(db, 'c1');
    expect(active?.id).toBe('cy2');
  });

  it('getActiveCycle returns undefined when all cycles completed', () => {
    insertCycle(db, makeCycle({ status: 'completed' }));
    expect(getActiveCycle(db, 'c1')).toBeUndefined();
  });

  it('serializes and deserializes screenshots', () => {
    const screenshots = [{ filePath: '/x.png', description: 'home', capturedAt: '2024-01-01T00:00:00.000Z' }];
    insertCycle(db, makeCycle({ screenshots }));
    const got = getCycle(db, 'cy1');
    expect(got?.screenshots).toEqual(screenshots);
  });

  it('attack: inserting cycle with non-existent campaignId throws (FK)', () => {
    expect(() => insertCycle(db, makeCycle({ campaignId: 'ghost' }))).toThrow();
  });

  it('lists cycles ordered by cycleNum', () => {
    insertCycle(db, makeCycle({ id: 'cy2', cycleNum: 2 }));
    insertCycle(db, makeCycle({ id: 'cy1', cycleNum: 1 }));
    const list = listCycles(db, 'c1');
    expect(list.map((c) => c.cycleNum)).toEqual([1, 2]);
  });

  it('update cycle status', () => {
    insertCycle(db, makeCycle());
    updateCycle(db, 'cy1', { status: 'completed' });
    expect(getCycle(db, 'cy1')?.status).toBe('completed');
  });
});

describe('tasks', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => {
    db = openDb();
    insertCampaign(db, makeCampaign());
    insertCycle(db, makeCycle());
  });
  afterEach(() => { db.close(); });

  it('inserts and retrieves a task', () => {
    insertTask(db, makeTask());
    const got = getTask(db, 't1');
    expect(got?.title).toBe('Do something');
    expect(got?.role).toBe('dev');
  });

  it('serializes acceptance and e2eScenarios', () => {
    insertTask(db, makeTask({ acceptance: ['must pass'], e2eScenarios: ['scenario A'] }));
    const got = getTask(db, 't1');
    expect(got?.acceptance).toEqual(['must pass']);
    expect(got?.e2eScenarios).toEqual(['scenario A']);
  });

  it('filters by role', () => {
    insertTask(db, makeTask({ id: 't1', role: 'dev' }));
    insertTask(db, makeTask({ id: 't2', role: 'test' }));
    expect(listTasks(db, 'cy1', 'dev')).toHaveLength(1);
    expect(listTasks(db, 'cy1', 'test')).toHaveLength(1);
    expect(listTasks(db, 'cy1')).toHaveLength(2);
  });

  it('updates task status and result', () => {
    insertTask(db, makeTask());
    updateTask(db, 't1', { status: 'completed', result: 'all green' });
    const got = getTask(db, 't1');
    expect(got?.status).toBe('completed');
    expect(got?.result).toBe('all green');
  });

  it('attack: task with non-existent cycleId throws (FK)', () => {
    expect(() => insertTask(db, makeTask({ cycleId: 'ghost' }))).toThrow();
  });

  it('attack: empty update patch is a no-op', () => {
    insertTask(db, makeTask());
    expect(() => updateTask(db, 't1', {})).not.toThrow();
    expect(getTask(db, 't1')?.status).toBe('pending');
  });
});
