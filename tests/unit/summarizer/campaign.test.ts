import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { WorkflowEngine } from '../../../src/workflow/engine.js';
import { insertDocAudit } from '../../../src/storage/repos/doc-audit.js';
import { getCampaign } from '../../../src/storage/repos/campaigns.js';
import {
  buildSummarizationPrompt,
  parseSummaryResponse,
  summarizeCampaign,
  type LlmClient,
} from '../../../src/summarizer/campaign.js';

let db: BetterSqlite3.Database;
let engine: WorkflowEngine;

beforeEach(() => {
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  engine = new WorkflowEngine(db);
});

afterEach(() => { db.close(); });

class FakeLlm implements LlmClient {
  constructor(public canned: string) {}
  lastPrompt = '';
  async generate(prompt: string): Promise<string> {
    this.lastPrompt = prompt;
    return this.canned;
  }
}

describe('buildSummarizationPrompt', () => {
  it('embeds campaign + cycle data', () => {
    const out = buildSummarizationPrompt('My Campaign', 'why', [
      { cycleNum: 1, productBrief: 'PB1', devWork: ['t1: r1'], testResults: '1/1', screenshots: [{ description: 'login' }] },
    ]);
    expect(out).toContain('My Campaign');
    expect(out).toContain('why');
    expect(out).toContain('PB1');
    expect(out).toContain('t1: r1');
    expect(out).toContain('login');
  });
});

describe('parseSummaryResponse', () => {
  it('extracts Why / Key Decisions / Overall Path sections', () => {
    const raw = [
      '## Why', 'because reasons', '',
      '## Key Decisions', '1. chose X', '2. avoided Y', '',
      '## What Was Built', 'a thing', '',
      '## Overall Path', 'arc summary',
    ].join('\n');
    const parsed = parseSummaryResponse(raw, []);
    expect(parsed.why).toBe('because reasons');
    expect(parsed.keyDecisions).toEqual(['chose X', 'avoided Y']);
    expect(parsed.overallPath).toBe('arc summary');
  });

  it('attack: missing sections fall back to first 500 chars / empty arrays', () => {
    const parsed = parseSummaryResponse('no markers here', []);
    expect(parsed.why).toBe('no markers here');
    expect(parsed.keyDecisions).toEqual([]);
    expect(parsed.overallPath).toBe('');
  });

  it('preserves the cycles array passed in', () => {
    const cycles = [{ cycleNum: 1, devWork: [], testResults: 'x', screenshots: [] }];
    const parsed = parseSummaryResponse('## Why\nx', cycles);
    expect(parsed.cycles).toBe(cycles);
  });
});

describe('summarizeCampaign', () => {
  function withDocToken(): string {
    const token = 'tok_' + Math.random().toString(36).slice(2, 8);
    insertDocAudit(db, { token, filePath: '/x', contentHash: 'h', createdAt: new Date().toISOString() });
    return token;
  }

  function setupCampaign(): string {
    const c = engine.initWorkflow('/proj', 'Test Campaign', 'initial brief');
    const cycle = engine.getCycleState(undefined, c.id)!.cycle;
    const tasks = engine.createTasks(cycle.id, [
      { role: 'dev', title: 'Add login' },
      { role: 'test', title: 'Test login' },
    ]);
    engine.completeTask(tasks[0]!.id, { result: 'login impl', docAuditToken: withDocToken() });
    engine.completeTask(tasks[1]!.id, { result: 'login covered' });
    engine.completeCycle(cycle.id, {});
    return c.id;
  }

  it('aggregates cycles + persists summary onto campaign', async () => {
    const id = setupCampaign();
    const llm = new FakeLlm([
      '## Why', 'experiment with login', '',
      '## Key Decisions', '- use OAuth', '',
      '## Overall Path', 'iterate',
    ].join('\n'));

    const result = await summarizeCampaign(db, id, { llm });
    expect(result.why).toBe('experiment with login');
    expect(result.keyDecisions).toEqual(['use OAuth']);
    expect(result.cycles).toHaveLength(2); // original + auto-created next
    expect(getCampaign(db, id)?.status).toBe('completed');
    expect(getCampaign(db, id)?.summary).toContain('use OAuth');
  });

  it('passes title and brief into the prompt', async () => {
    const id = setupCampaign();
    const llm = new FakeLlm('## Why\nx');
    await summarizeCampaign(db, id, { llm });
    expect(llm.lastPrompt).toContain('Test Campaign');
    expect(llm.lastPrompt).toContain('initial brief');
  });

  it('attack: unknown campaign throws', async () => {
    const llm = new FakeLlm('## Why\nx');
    await expect(summarizeCampaign(db, 'ghost', { llm })).rejects.toThrow(/not found/);
  });

  it('uses default model + maxTokens when not overridden', async () => {
    const id = setupCampaign();
    const calls: Array<{ model: string; maxTokens: number }> = [];
    const llm: LlmClient = {
      generate: async (_p, opts) => { calls.push(opts); return '## Why\nx'; },
    };
    await summarizeCampaign(db, id, { llm });
    expect(calls[0]?.model).toMatch(/claude-sonnet/);
    expect(calls[0]?.maxTokens).toBe(2048);
  });
});
