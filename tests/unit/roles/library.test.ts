import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import {
  chunkDocument,
  cosineSimilarity,
  getRole,
  listRoles,
  searchKnowledge,
  seedBuiltinRoles,
  trainRole,
} from '../../../src/roles/library.js';
import { makePseudoEmbedFn } from '../../../src/mcp/embed.js';

let db: BetterSqlite3.Database;

beforeEach(() => {
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => { db.close(); });

describe('seedBuiltinRoles', () => {
  it('inserts product / developer / tester', () => {
    seedBuiltinRoles(db);
    const ids = listRoles(db).map((r) => r.id).sort();
    expect(ids).toEqual(['developer', 'product', 'tester']);
  });

  it('is idempotent — re-seed updates without duplicating', () => {
    seedBuiltinRoles(db);
    seedBuiltinRoles(db);
    expect(listRoles(db)).toHaveLength(3);
  });
});

describe('getRole', () => {
  beforeEach(() => seedBuiltinRoles(db));

  it('returns the requested role', () => {
    expect(getRole(db, 'developer').name).toBe('Developer Agent');
  });

  it('attack: unknown role throws', () => {
    expect(() => getRole(db, 'ghost')).toThrow(/not found/);
  });
});

describe('trainRole', () => {
  it('creates new role + indexes chunks', async () => {
    const role = await trainRole(db, {
      roleId: 'expert',
      name: 'Expert Agent',
      documents: [{ filename: 'a.md', content: 'one\ntwo\nthree' }],
      embedFn: makePseudoEmbedFn(),
    });
    expect(role.name).toBe('Expert Agent');
    expect(role.isBuiltin).toBe(false);
  });

  it('retrains: deletes old chunks before indexing new ones', async () => {
    const embedFn = makePseudoEmbedFn();
    const docs1 = [{ filename: 'a.md', content: 'first version' }];
    await trainRole(db, { roleId: 'r', name: 'R', documents: docs1, embedFn });
    const docs2 = [{ filename: 'b.md', content: 'second version' }];
    await trainRole(db, { roleId: 'r', name: 'R2', documents: docs2, embedFn });

    const results = await searchKnowledge(db, 'r', 'first version', embedFn, 10);
    // Old chunks should be gone — no hit on 'first version' content
    expect(results.every((r) => !r.chunkText.includes('first version'))).toBe(true);
  });

  it('preserves systemPrompt when retraining without baseSystemPrompt', async () => {
    const embedFn = makePseudoEmbedFn();
    await trainRole(db, {
      roleId: 'r', name: 'R', baseSystemPrompt: 'custom prompt',
      documents: [{ filename: 'a.md', content: 'x' }], embedFn,
    });
    await trainRole(db, {
      roleId: 'r', name: 'R',
      documents: [{ filename: 'a.md', content: 'y' }], embedFn,
    });
    expect(getRole(db, 'r').systemPrompt).toBe('custom prompt');
  });
});

describe('searchKnowledge', () => {
  it('returns empty when role has no chunks', async () => {
    const results = await searchKnowledge(db, 'nonexistent', 'q', makePseudoEmbedFn(), 5);
    expect(results).toEqual([]);
  });

  it('returns topK chunks sorted by score desc', async () => {
    const embedFn = makePseudoEmbedFn();
    await trainRole(db, {
      roleId: 'r', name: 'R',
      documents: [{ filename: 'a.md', content: Array(200).fill('foo bar baz').join('\n') }],
      embedFn,
    });
    const results = await searchKnowledge(db, 'r', 'foo', embedFn, 3);
    expect(results.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
  });
});

describe('chunkDocument', () => {
  it('splits long documents into multiple chunks', () => {
    const content = Array(200).fill('lorem ipsum dolor sit amet').join('\n');
    const chunks = chunkDocument(content, 'long.md');
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.text).toContain('[long.md]');
  });

  it('short content stays as a single chunk', () => {
    const chunks = chunkDocument('short', 'a.md');
    expect(chunks).toHaveLength(1);
  });
});

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('returns 0 when one vector is zero', () => {
    const a = new Float32Array([0, 0]);
    const b = new Float32Array([1, 1]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });
});
