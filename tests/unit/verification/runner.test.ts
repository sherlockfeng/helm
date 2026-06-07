/**
 * Unit tests for the two-phase runner (PR 5.4).
 *
 * Uses an injected CompletionClient + retriever + repoProbe so no real
 * LLM is involved. Covers:
 *   - happy path: answer + judge + run row + recall + alignment
 *   - judge JSON with markdown fence is still parsed
 *   - judge returning prose with embedded JSON fields → permissive
 *     fallback rather than throw
 *   - retrieve failure → RunCaseError stage='retrieve'
 *   - answer failure → stage='answer'
 *   - judge failure → stage='judge'
 *   - repoProbe returning empty → knowledgeStateSha gets 'local-' prefix
 *     and isReproducible is false
 *   - recall calculation: hits/expected
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { getCostForDate, insertCase, recordCostDelta } from '../../../src/storage/repos/benchmark.js';
import { upsertRole } from '../../../src/storage/repos/roles.js';
import {
  parseJudgeVerdict,
  runCase,
  RunCaseError,
  type CompletionClient,
  type RepoStateProbe,
  type Retriever,
} from '../../../src/verification/runner.js';
import type { ResolvedConfig } from '../../../src/verification/provider-config.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedCase(db: BetterSqlite3.Database, id: string, goldenIds: string[]): void {
  upsertRole(db, {
    id: 'r-x', name: 'R', systemPrompt: 'sp',
    isBuiltin: false, createdAt: new Date().toISOString(),
  });
  for (const pid of goldenIds) {
    db.prepare(`
      INSERT OR IGNORE INTO knowledge_chunks (id, role_id, chunk_text, kind, created_at)
      VALUES (?, 'r-x', 'body', 'spec', ?)
    `).run(pid, new Date().toISOString());
  }
  insertCase(db, {
    id, name: 'n', question: 'Q?', expectedTruth: 'expected.',
    goldenPointIds: goldenIds,
  });
}

const providers: ResolvedConfig = {
  answer: { id: 'fake-answer', model: { id: 'm', api: 'a', provider: 'p', baseUrl: 'u', contextWindow: 0, maxTokens: 0 }, apiKey: 'k' },
  judge:  { id: 'fake-judge',  model: { id: 'm', api: 'a', provider: 'p', baseUrl: 'u', contextWindow: 0, maxTokens: 0 }, apiKey: 'k' },
};

function makeLlm(
  answer: string,
  judge: string,
): CompletionClient {
  let n = 0;
  return {
    async complete() {
      n += 1;
      if (n === 1) return { text: answer, costUsd: 0.01 };
      return { text: judge, costUsd: 0.02 };
    },
  };
}

const passingRetriever: Retriever = async (ids) =>
  ids.map((id) => ({ pointId: id, text: `body for ${id}` }));

const noRepoProbe: RepoStateProbe = {
  async probe() { return []; },
  async localFingerprint() { return 'local-fp-abc'; },
};

const repoProbe: RepoStateProbe = {
  async probe() { return [{ repoUrl: 'git@host:wiki.git', repoSha: 'sha-A' }]; },
  async localFingerprint() { return null; },
};

describe('runCase', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); });
  afterEach(() => { db.close(); });

  it('happy path: records a run with recall + alignment + reproducible state', async () => {
    seedCase(db, 'c-1', ['p-1', 'p-2']);
    const llm = makeLlm(
      'answer body',
      '{"aligned": true, "score": 88, "summary": "close enough"}',
    );
    const out = await runCase({
      db, caseId: 'c-1', providers, llm,
      retrieve: passingRetriever, repoProbe,
    });
    expect(out.recallPct).toBe(100);
    expect(out.alignmentPct).toBe(88);
    expect(out.isReproducible).toBe(true);
    expect(out.knowledgeStateSha).not.toMatch(/^local-/);
  });

  it('falls back to local-fingerprint sha when no upstream repo state is available', async () => {
    seedCase(db, 'c-local', ['p-1']);
    const llm = makeLlm(
      'answer',
      '{"aligned": true, "score": 50, "summary": "okay"}',
    );
    const out = await runCase({
      db, caseId: 'c-local', providers, llm,
      retrieve: passingRetriever, repoProbe: noRepoProbe,
    });
    expect(out.isReproducible).toBe(false);
    expect(out.knowledgeStateSha).toMatch(/^local-/);
  });

  it('recall reflects which goldens were retrieved', async () => {
    seedCase(db, 'c-partial', ['p-1', 'p-2', 'p-3']);
    const partialRetriever: Retriever = async () =>
      [{ pointId: 'p-1', text: 'b1' }, { pointId: 'p-2', text: 'b2' }];
    const llm = makeLlm('a', '{"aligned": false, "score": 0, "summary": "miss"}');
    const out = await runCase({
      db, caseId: 'c-partial', providers, llm,
      retrieve: partialRetriever, repoProbe,
    });
    expect(out.recallPct).toBeCloseTo((2 / 3) * 100, 2);
  });

  it('handles judge JSON wrapped in markdown fence', async () => {
    seedCase(db, 'c-fence', ['p-1']);
    const fenced = '```json\n{"aligned": true, "score": 77, "summary": "ok"}\n```';
    const llm = makeLlm('a', fenced);
    const out = await runCase({
      db, caseId: 'c-fence', providers, llm,
      retrieve: passingRetriever, repoProbe,
    });
    expect(out.alignmentPct).toBe(77);
  });

  it('judge text that is not parseable JSON yields a permissive 0-score fallback', async () => {
    seedCase(db, 'c-junk', ['p-1']);
    const llm = makeLlm('a', 'sorry, I think the model output is bad');
    const out = await runCase({
      db, caseId: 'c-junk', providers, llm,
      retrieve: passingRetriever, repoProbe,
    });
    expect(out.alignmentPct).toBe(0); // permissive parse defaults to 0
  });

  it('retrieve failure surfaces as RunCaseError stage=retrieve', async () => {
    seedCase(db, 'c-retfail', ['p-1']);
    const llm = makeLlm('a', '{"aligned": true, "score": 50, "summary": "x"}');
    await expect(runCase({
      db, caseId: 'c-retfail', providers, llm,
      retrieve: async () => { throw new Error('boom'); },
      repoProbe,
    })).rejects.toThrowError(RunCaseError);
  });

  it('unknown case id throws stage=retrieve before any LLM call', async () => {
    const llm = makeLlm('a', '{}');
    await expect(runCase({
      db, caseId: 'does-not-exist', providers, llm,
      retrieve: passingRetriever, repoProbe,
    })).rejects.toThrowError(/does not exist/);
  });

  it('answer-phase throw surfaces as stage=answer', async () => {
    seedCase(db, 'c-aerr', ['p-1']);
    const llm: CompletionClient = {
      async complete() { throw new Error('answer model timed out'); },
    };
    try {
      await runCase({ db, caseId: 'c-aerr', providers, llm, retrieve: passingRetriever, repoProbe });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RunCaseError);
      expect((err as RunCaseError).stage).toBe('answer');
    }
  });
});

describe('runCase R-5 status guard', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); });
  afterEach(() => { db.close(); });

  it('refuses to run a proposed case unless allowUnconfirmed=true', async () => {
    seedCase(db, 'c-prop', ['p-1']);
    // Flip the case to 'proposed' to simulate an LLM-on-edit candidate
    // that hasn't been human-confirmed yet (R-5).
    db.prepare(`UPDATE benchmark_case SET status = 'proposed' WHERE id = ?`).run('c-prop');
    const llm = makeLlm('a', '{"aligned": true, "score": 60, "summary": "ok"}');

    await expect(runCase({
      db, caseId: 'c-prop', providers, llm,
      retrieve: passingRetriever, repoProbe,
    })).rejects.toThrowError(/only confirmed cases run/);

    // Explicit override still works (for debug paths).
    const out = await runCase({
      db, caseId: 'c-prop', providers, llm,
      retrieve: passingRetriever, repoProbe,
      options: { allowUnconfirmed: true },
    });
    expect(out.alignmentPct).toBe(60);
  });
});

describe('runCase cost cap (§4.7.6)', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); });
  afterEach(() => { db.close(); });

  it('refuses to start when today\'s spend already exceeds the cap', async () => {
    seedCase(db, 'c-cap', ['p-1']);
    const today = new Date().toISOString().slice(0, 10);
    // Seed today's row to look like we already spent $0.50.
    recordCostDelta(db, today, null, 1, 0.50);

    const llm = makeLlm('a', '{"aligned": true, "score": 60, "summary": "ok"}');
    await expect(runCase({
      db, caseId: 'c-cap', providers, llm,
      retrieve: passingRetriever, repoProbe,
      options: { costCapUsd: 0.10 },
    })).rejects.toThrowError(/daily benchmark spend/);
  });

  it('records the run\'s cost into today\'s aggregate so the cap moves', async () => {
    seedCase(db, 'c-acc', ['p-1']);
    const llm = makeLlm('a', '{"aligned": true, "score": 60, "summary": "ok"}');
    await runCase({
      db, caseId: 'c-acc', providers, llm,
      retrieve: passingRetriever, repoProbe,
    });
    const today = new Date().toISOString().slice(0, 10);
    const row = getCostForDate(db, today, null);
    expect(row?.llmCalls).toBe(2);
    expect(row?.estimatedCostUsd).toBeCloseTo(0.03, 4);
  });
});

describe('parseJudgeVerdict', () => {
  it('parses a clean JSON object', () => {
    const v = parseJudgeVerdict('{"aligned": true, "score": 92, "summary": "great"}');
    expect(v).toEqual({ aligned: true, score: 92, summary: 'great' });
  });

  it('strips a markdown fence', () => {
    const v = parseJudgeVerdict('```\n{"aligned": false, "score": 20, "summary": "off"}\n```');
    expect(v.score).toBe(20);
  });

  it('clamps a score above 100 down to 100', () => {
    const v = parseJudgeVerdict('{"aligned": true, "score": 200, "summary": "yay"}');
    expect(v.score).toBe(100);
  });

  it('fallback path extracts fields out of unstructured prose', () => {
    const v = parseJudgeVerdict('verdict "aligned": true , "score": 65, "summary": "partial"');
    expect(v.aligned).toBe(true);
    expect(v.score).toBe(65);
    expect(v.summary).toBe('partial');
  });
});
