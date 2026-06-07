/**
 * Unit tests for the repo importer (PR 5.5b.3).
 *
 * Uses an in-memory filesystem stub so no actual disk IO occurs.
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { importRepoIntoLibrary } from '../../../src/knowledge-repo/importer.js';
import { getRole } from '../../../src/storage/repos/roles.js';
import { getAliasesForPoint } from '../../../src/storage/repos/knowledge-point-alias.js';
import { getOutgoingRels } from '../../../src/storage/repos/knowledge-point-rel.js';
import { getRolesForPoint } from '../../../src/storage/repos/knowledge-point-roles.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

/**
 * Tiny in-memory filesystem keyed by absolute path. Directories are
 * implicit — we infer them from the file paths. Stat returns a
 * minimal object with the two predicates the importer uses.
 */
function makeFs(files: Record<string, string>) {
  const paths = new Set(Object.keys(files));
  const dirs = new Set<string>();
  for (const p of paths) {
    let cur = p;
    while (true) {
      const idx = cur.lastIndexOf('/');
      if (idx <= 0) break;
      cur = cur.slice(0, idx);
      dirs.add(cur);
    }
  }
  return {
    readdirSync: ((root: string): string[] => {
      const entries = new Set<string>();
      for (const p of [...paths, ...dirs]) {
        if (p.startsWith(root + '/')) {
          const rest = p.slice(root.length + 1);
          const head = rest.split('/')[0]!;
          entries.add(head);
        }
      }
      return [...entries];
    }) as typeof import('node:fs').readdirSync,
    statSync: ((full: string) => ({
      isDirectory: (): boolean => dirs.has(full),
      isFile: (): boolean => paths.has(full),
    })) as unknown as typeof import('node:fs').statSync,
    readFileSync: ((p: string): string => {
      const data = files[p];
      if (data == null) throw new Error(`ENOENT: ${p}`);
      return data;
    }) as unknown as typeof import('node:fs').readFileSync,
    existsSync: ((p: string): boolean => paths.has(p) || dirs.has(p)) as typeof import('node:fs').existsSync,
  };
}

describe('importRepoIntoLibrary', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); });
  afterEach(() => { db.close(); });

  it('walks roles/<slug>/points and upserts points with the right metadata', () => {
    const fs = makeFs({
      '/repo/roles/dr/role.yaml': [
        'id: tiktok-web-dr',
        'name: TikTok Web 容灾专家',
        'briefingText: How to use this collection of DR knowledge.',
      ].join('\n'),
      '/repo/roles/dr/points/overview.md': [
        '---',
        'id: dr-overview',
        'kind: spec',
        'aliases: [DR, 容灾]',
        'rel:',
        '  includes: [cdn-dr]',
        '---', '',
        '# Overview',
        'Body.',
      ].join('\n'),
      '/repo/roles/dr/points/cdn-dr.md': [
        '---',
        'id: cdn-dr',
        'kind: runbook',
        'aliases: [cdn]',
        '---', '',
        '# CDN DR',
        'CDN body.',
      ].join('\n'),
    });
    const summary = importRepoIntoLibrary({
      db, localPath: '/repo', profile: 'helm-native', fs,
    });
    expect(summary.rolesImported).toBe(1);
    expect(summary.pointsUpserted).toBe(2);
    expect(summary.errors).toEqual({});

    const role = getRole(db, 'tiktok-web-dr');
    expect(role?.name).toBe('TikTok Web 容灾专家');
    expect(role?.systemPrompt).toBe('How to use this collection of DR knowledge.');

    expect(getAliasesForPoint(db, 'dr-overview').map((a) => a.alias).sort())
      .toEqual(['DR', '容灾']);
    expect(getOutgoingRels(db, 'dr-overview').map((r) => r.toPointId))
      .toEqual(['cdn-dr']);
    expect(getRolesForPoint(db, 'dr-overview')).toEqual(['tiktok-web-dr']);
  });

  it('synthesizes a role name from the slug when role.yaml is missing', () => {
    const fs = makeFs({
      '/repo/roles/argos/points/x.md': '# x\nbody',
    });
    importRepoIntoLibrary({ db, localPath: '/repo', profile: 'generic', fs });
    expect(getRole(db, 'argos')?.name).toBe('argos');
  });

  it('is idempotent: re-running rebuilds aliases + rels without duplicating', () => {
    const v1 = makeFs({
      '/repo/roles/r/points/p.md': [
        '---', 'id: p',
        'aliases: [a, b]', 'rel:', '  includes: [child-x]',
        '---', '',
      ].join('\n'),
    });
    importRepoIntoLibrary({ db, localPath: '/repo', profile: 'helm-native', fs: v1 });
    // Second import with one alias removed + a new rel target.
    const v2 = makeFs({
      '/repo/roles/r/points/p.md': [
        '---', 'id: p',
        'aliases: [a]', 'rel:', '  includes: [child-y]',
        '---', '',
      ].join('\n'),
    });
    importRepoIntoLibrary({ db, localPath: '/repo', profile: 'helm-native', fs: v2 });
    expect(getAliasesForPoint(db, 'p').map((a) => a.alias)).toEqual(['a']);
    expect(getOutgoingRels(db, 'p').map((r) => r.toPointId)).toEqual(['child-y']);
  });

  it('does not throw when roles/ is missing — returns an empty summary', () => {
    const fs = makeFs({
      '/repo/README.md': 'a repo without roles/',
    });
    const summary = importRepoIntoLibrary({
      db, localPath: '/repo', profile: 'helm-native', fs,
    });
    expect(summary).toEqual({ rolesImported: 0, pointsUpserted: 0, errors: {} });
  });

  it('captures per-file errors in the errors map without aborting siblings', () => {
    const fs = makeFs({
      '/repo/roles/r/points/good.md': '---\nid: good\n---\nbody',
      // Throw on this file via readFileSync — we patch in a guard
      // that explodes on this specific path.
      '/repo/roles/r/points/bad.md': 'ok',
    });
    const fsWithThrow = {
      ...fs,
      readFileSync: ((p: string) => {
        if (String(p).endsWith('bad.md')) throw new Error('disk failed');
        return fs.readFileSync(p as string);
      }) as unknown as typeof import('node:fs').readFileSync,
    };
    const summary = importRepoIntoLibrary({
      db, localPath: '/repo', profile: 'helm-native', fs: fsWithThrow,
    });
    expect(summary.pointsUpserted).toBe(1);
    expect(Object.keys(summary.errors)).toHaveLength(1);
    expect(Object.values(summary.errors)[0]).toMatch(/disk failed/);
  });
});
