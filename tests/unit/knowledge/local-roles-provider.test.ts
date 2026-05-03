import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { seedBuiltinRoles, trainRole } from '../../../src/roles/library.js';
import { LocalRolesProvider } from '../../../src/knowledge/local-roles-provider.js';
import { makePseudoEmbedFn } from '../../../src/mcp/embed.js';
import type { KnowledgeContext } from '../../../src/knowledge/types.js';

let db: BetterSqlite3.Database;

const ctx: KnowledgeContext = { hostSessionId: 's1', cwd: '/proj' };

beforeEach(() => {
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  seedBuiltinRoles(db);
});

afterEach(() => { db.close(); });

describe('LocalRolesProvider — basics', () => {
  it('id and displayName are stable', () => {
    const p = new LocalRolesProvider({ db, embedFn: makePseudoEmbedFn() });
    expect(p.id).toBe('local-roles');
    expect(p.displayName).toBe('Local Roles');
  });

  it('canHandle is always true', () => {
    const p = new LocalRolesProvider({ db, embedFn: makePseudoEmbedFn() });
    expect(p.canHandle()).toBe(true);
  });
});

describe('LocalRolesProvider — healthcheck', () => {
  it('reports counts when roles exist', async () => {
    const p = new LocalRolesProvider({ db, embedFn: makePseudoEmbedFn() });
    const r = await p.healthcheck();
    expect(r.ok).toBe(true);
    expect(r.reason).toMatch(/3 roles, \d+ chunks/);
  });

  it('reports unhealthy when no roles seeded', async () => {
    const empty = new BetterSqlite3(':memory:');
    empty.pragma('foreign_keys = ON');
    runMigrations(empty);
    try {
      const p = new LocalRolesProvider({ db: empty, embedFn: makePseudoEmbedFn() });
      const r = await p.healthcheck();
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('no roles');
    } finally {
      empty.close();
    }
  });
});

describe('LocalRolesProvider — getSessionContext', () => {
  it('returns null when no resolveRoleId is provided', async () => {
    const p = new LocalRolesProvider({ db, embedFn: makePseudoEmbedFn() });
    expect(await p.getSessionContext(ctx)).toBeNull();
  });

  it('returns null when resolver yields no roleId', async () => {
    const p = new LocalRolesProvider({
      db, embedFn: makePseudoEmbedFn(),
      resolveRoleId: () => undefined,
    });
    expect(await p.getSessionContext(ctx)).toBeNull();
  });

  it('returns markdown with role systemPrompt when bound', async () => {
    const p = new LocalRolesProvider({
      db, embedFn: makePseudoEmbedFn(),
      resolveRoleId: () => 'developer',
    });
    const md = await p.getSessionContext(ctx);
    expect(md).toContain('# Role: Developer Agent');
    expect(md).toContain('Doc-first');
  });

  it('appends knowledge excerpts up to sessionContextChunkCap', async () => {
    const embedFn = makePseudoEmbedFn();
    await trainRole(db, {
      roleId: 'expert',
      name: 'Expert',
      documents: [
        { filename: 'a.md', content: Array(200).fill('line a').join('\n') },
        { filename: 'b.md', content: Array(200).fill('line b').join('\n') },
      ],
      embedFn,
    });
    const p = new LocalRolesProvider({
      db, embedFn,
      resolveRoleId: () => 'expert',
      sessionContextChunkCap: 2,
    });
    const md = await p.getSessionContext(ctx);
    expect(md).toContain('# Role: Expert');
    expect(md).toContain('## Knowledge excerpts');
    // Should include exactly 2 excerpts (cap)
    const matches = (md ?? '').match(/\[a\.md\]|\[b\.md\]/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it('attack: resolver returning unknown roleId yields null (no throw)', async () => {
    const p = new LocalRolesProvider({
      db, embedFn: makePseudoEmbedFn(),
      resolveRoleId: () => 'no-such-role',
    });
    expect(await p.getSessionContext(ctx)).toBeNull();
  });

  it('attack: async resolver is awaited', async () => {
    const p = new LocalRolesProvider({
      db, embedFn: makePseudoEmbedFn(),
      resolveRoleId: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return 'product';
      },
    });
    const md = await p.getSessionContext(ctx);
    expect(md).toContain('Product Agent');
  });
});

describe('LocalRolesProvider — search', () => {
  beforeEach(async () => {
    const embedFn = makePseudoEmbedFn();
    await trainRole(db, {
      roleId: 'expert', name: 'Expert',
      documents: [{ filename: 'a.md', content: Array(120).fill('foo bar baz').join('\n') }],
      embedFn,
    });
  });

  it('returns snippets tagged with provider id and role-name title', async () => {
    const p = new LocalRolesProvider({ db, embedFn: makePseudoEmbedFn() });
    const results = await p.search('foo');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.source).toBe('local-roles');
    expect(results[0]?.title).toContain('Expert');
    expect(results[0]?.citation).toContain('local-roles:expert');
  });

  it('topK is honored', async () => {
    const p = new LocalRolesProvider({ db, embedFn: makePseudoEmbedFn(), topK: 2 });
    const results = await p.search('foo');
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('results are sorted by score desc', async () => {
    const p = new LocalRolesProvider({ db, embedFn: makePseudoEmbedFn() });
    const results = await p.search('foo');
    for (let i = 1; i < results.length; i++) {
      const prev = results[i - 1]?.score ?? 0;
      const curr = results[i]?.score ?? 0;
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });

  it('empty across-roles search returns empty array', async () => {
    // Fresh DB without trained custom role
    const empty = new BetterSqlite3(':memory:');
    empty.pragma('foreign_keys = ON');
    runMigrations(empty);
    seedBuiltinRoles(empty);
    try {
      const p = new LocalRolesProvider({ db: empty, embedFn: makePseudoEmbedFn() });
      expect(await p.search('anything')).toEqual([]);
    } finally {
      empty.close();
    }
  });

  it('embedFn errors do not crash the search', async () => {
    const errEmbedFn = vi.fn(async () => { throw new Error('embed boom'); });
    const p = new LocalRolesProvider({ db, embedFn: errEmbedFn });
    await expect(p.search('foo')).rejects.toThrow(/embed boom/);
    // Documents the current behavior: the provider doesn't catch embed errors
    // — that's the aggregator's job. This test pins the contract so changes
    // are intentional.
  });
});
