/**
 * Regression tests for the engine-backed verification runner.
 *
 * These cover the three bugs the benchmark Run-now path shipped with
 * (caught only by manual UI clicks, not CI):
 *   - #187: engine fallback — buildVerificationRunner with engineLlm (and
 *     no providers.json) must actually BUILD a runner.
 *   - #188: that runner must RUN a case end-to-end against the engine.
 *   - #189: the run it returns must be the camelCase BenchmarkRun shape
 *     (alignmentPct / recallPct), not the raw snake_case row — the renderer
 *     does run.alignmentPct.toFixed(1) and crashed on undefined.
 * Plus: no engine AND no providers.json → null (the 503 precondition).
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { insertCase } from '../../../src/storage/repos/benchmark.js';
import { upsertRole } from '../../../src/storage/repos/roles.js';
import { buildVerificationRunner } from '../../../src/verification/bootstrap.js';
import type { LlmClient } from '../../../src/summarizer/campaign.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

// Fake engine: answers normal prompts with text; returns a judge verdict
// JSON when handed the judge system prompt.
const fakeLlm: LlmClient = {
  async generate(prompt: string): Promise<string> {
    if (prompt.includes('You are a judge')) {
      return '{"aligned": true, "score": 88, "summary": "ok"}';
    }
    return 'the candidate answer';
  },
};

let db: BetterSqlite3.Database;
beforeEach(() => {
  db = openDb();
  upsertRole(db, { id: 'r-x', name: 'R', systemPrompt: 'sp', isBuiltin: false, createdAt: new Date().toISOString() });
  db.prepare(`INSERT INTO knowledge_chunks (id, role_id, chunk_text, kind, created_at) VALUES ('p1','r-x','body','spec',?)`)
    .run(new Date().toISOString());
  insertCase(db, {
    id: 'c1', name: 'n', question: 'Q?', expectedTruth: 'expected.',
    goldenPointIds: ['p1'], targetRoleIds: ['r-x'], status: 'confirmed',
  });
});
afterEach(() => db.close());

describe('buildVerificationRunner — engine fallback', () => {
  it('builds + runs against the engine and returns a camelCase BenchmarkRun', async () => {
    const built = buildVerificationRunner({
      db,
      providerConfigPath: '/nonexistent/providers.json', // skip Path A
      engineLlm: () => fakeLlm,
      engineModel: 'test',
    });
    expect(built).not.toBeNull();

    const run = await built!.runner('c1');
    expect(run).not.toBeNull();
    // #189: these must be camelCase numbers (raw snake_case row → undefined).
    expect(typeof run!.alignmentPct).toBe('number');
    expect(run!.alignmentPct).toBe(88);
    expect(typeof run!.recallPct).toBe('number');
    expect(run!.recallPct).toBe(100); // golden p1 retrieved
    expect(run!.answerText).toBe('the candidate answer');
  });

  it('returns null when there is neither providers.json nor an engine (→ 503)', () => {
    const built = buildVerificationRunner({
      db,
      providerConfigPath: '/nonexistent/providers.json',
    });
    expect(built).toBeNull();
  });
});
