/**
 * Unit tests for the repo importer (PR 5.5b.3).
 *
 * Uses an in-memory filesystem stub so no actual disk IO occurs.
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { importRepoIntoLibrary } from '../../../src/knowledge-repo/importer.js';
import { getRole, upsertRole } from '../../../src/storage/repos/roles.js';
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
    // helm-native repos publish role-shaped collections — stay Experts.
    expect(role?.bindable).toBe(true);

    expect(getAliasesForPoint(db, 'dr-overview').map((a) => a.alias).sort())
      .toEqual(['DR', '容灾']);
    expect(getOutgoingRels(db, 'dr-overview').map((r) => r.toPointId))
      .toEqual(['cdn-dr']);
    expect(getRolesForPoint(db, 'dr-overview')).toEqual(['tiktok-web-dr']);
  });

  it('helm-native: synthesizes a role name from the slug when role.yaml is missing', () => {
    const fs = makeFs({
      '/repo/roles/argos/points/x.md': '# x\nbody',
    });
    importRepoIntoLibrary({ db, localPath: '/repo', profile: 'helm-native', fs });
    expect(getRole(db, 'argos')?.name).toBe('argos');
  });

  it('llm-wiki layout: top-level non-hidden dirs become roles, recursive .md walk', () => {
    const fs = makeFs({
      '/repo/dr-docs/index.md': '---\n---\n# DR overview\n',
      '/repo/dr-docs/cdn/cdn-dr.md': '---\nid: cdn-dr\n---\n# CDN\n',
      '/repo/doc-lsp-docs/intro.md': '---\nid: lsp-intro\n---\n# LSP\n',
      // Should be skipped: hidden dirs + the curated skip-list.
      '/repo/.github/workflows/ci.yml': 'name: ci',
      '/repo/node_modules/foo/bar.md': '# nope',
      '/repo/.codebase/info': 'should-skip',
      // Empty-dir bucket (no .md anywhere): should not produce a role.
      '/repo/empty-dir/notes.txt': 'no markdown here',
      // Top-level file at repo root — should be ignored too (not a dir).
      '/repo/AGENTS.md': '# agents',
    });
    const summary = importRepoIntoLibrary({
      db, localPath: '/repo', profile: 'llm-wiki', fs,
    });
    expect(summary.rolesImported).toBe(2);
    expect(getRole(db, 'dr-docs')?.name).toBe('dr-docs');
    // PR-δ: imported top-level dirs are Collections, not Experts.
    expect(getRole(db, 'dr-docs')?.bindable).toBe(false);
    expect(getRole(db, 'doc-lsp-docs')?.name).toBe('doc-lsp-docs');
    expect(getRole(db, '.github')).toBeUndefined();
    expect(getRole(db, 'node_modules')).toBeUndefined();
    expect(getRole(db, 'empty-dir')).toBeUndefined();
    // Each .md became a chunk under the right role.
    expect(summary.pointsUpserted).toBe(3);
  });

  it('generic layout: synthesizes one "imported" role with every .md flattened', () => {
    const fs = makeFs({
      '/repo/README.md': '# readme',
      '/repo/docs/a.md': '---\nid: a\n---\n# A',
      '/repo/docs/sub/b.md': '---\nid: b\n---\n# B',
      '/repo/.git/HEAD': 'ref: …',
    });
    const summary = importRepoIntoLibrary({
      db, localPath: '/repo', profile: 'generic', fs,
    });
    expect(summary.rolesImported).toBe(1);
    expect(getRole(db, 'imported')?.name).toBe('Imported');
    // README + a + b — .git is skipped.
    expect(summary.pointsUpserted).toBe(3);
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
    expect(summary).toEqual({
      rolesImported: 0, pointsUpserted: 0, conflictsDetected: 0, errors: {},
    });
  });

  it('R-10: indexes entities for each imported chunk so retrieval picks it up', () => {
    const fs = makeFs({
      '/repo/roles/r/points/p.md': [
        '---', 'id: p-ent',
        '---', '',
        '# DR overview',
        'observability dashboards live in qps.argos; failover is via gateway-handler.',
      ].join('\n'),
    });
    importRepoIntoLibrary({ db, localPath: '/repo', profile: 'helm-native', fs });
    const rows = db.prepare(
      `SELECT entity FROM knowledge_chunk_entities WHERE chunk_id = 'p-ent'`,
    ).all() as Array<{ entity: string }>;
    expect(rows.length).toBeGreaterThan(0);
  });

  it('R-11: round-trips visibility + source through frontmatter', () => {
    const fs = makeFs({
      '/repo/roles/r/points/p-rt.md': [
        '---', 'id: p-rt',
        'visibility: public',
        'source: {"kind":"conversation","ref":"sess-123"}',
        '---', '',
        '# Round-trip body',
        'this body survives round-trip.',
      ].join('\n'),
    });
    importRepoIntoLibrary({ db, localPath: '/repo', profile: 'helm-native', fs });
    const row = db.prepare(
      `SELECT visibility, source FROM knowledge_chunks WHERE id = 'p-rt'`,
    ).get() as { visibility: string; source: string };
    expect(row.visibility).toBe('public');
    expect(JSON.parse(row.source)).toEqual({
      kind: 'conversation', ref: 'sess-123',
    });
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

  it('llm-wiki: chat-captured/<user>/<role> uses the third path segment as role', () => {
    const fs = makeFs({
      '/repo/dr-docs/index.md': '# DR\nbody',
      // doc-lsp shape (what promote will write in PR-2): concept fence
      // carries the explicit id.
      '/repo/chat-captured/hyf/dr-docs/og-v5.md':
        '# OG v5\n\n```concept\nid: cap-og-v5\n```\n\nbody',
      // Plain markdown — id falls back to the file basename.
      '/repo/chat-captured/hyf/argos/alerts.md': '# Alerts\nbody',
      '/repo/chat-captured/zhang/dr-docs/cdn.md': '# CDN\nbody',
      // Hidden user dir — skipped entirely.
      '/repo/chat-captured/.tmp/dr-docs/x.md': '# hidden',
      // Role dir with no .md — no bucket, no role.
      '/repo/chat-captured/hyf/empty-role/notes.txt': 'no markdown',
    });
    const summary = importRepoIntoLibrary({
      db, localPath: '/repo', profile: 'llm-wiki', fs,
    });
    // Unique roles: dr-docs (shared by the ETL dir + two captured
    // users) and argos. chat-captured itself must NOT become a role.
    expect(summary.rolesImported).toBe(2);
    expect(getRole(db, 'chat-captured')).toBeUndefined();
    expect(getRole(db, 'empty-role')).toBeUndefined();
    expect(getRole(db, '.tmp')).toBeUndefined();
    expect(getRole(db, 'argos')?.name).toBe('argos');
    expect(summary.pointsUpserted).toBe(4);
    expect(getRolesForPoint(db, 'cap-og-v5')).toEqual(['dr-docs']);
    // v28: plain-markdown fallback ids are full path slugs (collision-free).
    expect(getRolesForPoint(db, 'chat-captured-zhang-dr-docs-cdn')).toEqual(['dr-docs']);
    expect(getRolesForPoint(db, 'chat-captured-hyf-argos-alerts')).toEqual(['argos']);
  });

  it('persists source_file repo-root-relative on insert and refreshes it on update', () => {
    // Concept id keeps the point's identity stable across a file move
    // (v28: plain-markdown fallback ids are path-derived, so they change
    // with the path by design).
    const doc = '# OG\n\n```concept\nid: og\n```\n\nbody';
    const v1 = makeFs({
      '/repo/chat-captured/hyf/dr/og.md': doc,
    });
    importRepoIntoLibrary({ db, localPath: '/repo', profile: 'llm-wiki', fs: v1 });
    const read = (): string => (db.prepare(
      `SELECT source_file FROM knowledge_chunks WHERE id = 'og'`,
    ).get() as { source_file: string }).source_file;
    expect(read()).toBe('chat-captured/hyf/dr/og.md');
    // Same point id moved to a regular wiki dir — the update path must
    // refresh source_file so publish round-trips into the new location.
    const v2 = makeFs({
      '/repo/dr/og.md': doc,
    });
    importRepoIntoLibrary({ db, localPath: '/repo', profile: 'llm-wiki', fs: v2 });
    expect(read()).toBe('dr/og.md');
  });

  it('helm-native: source_file keeps the roles/<slug>/points/ prefix', () => {
    const fs = makeFs({
      '/repo/roles/dr/points/p.md': '---\nid: sf-native\n---\n# P\nbody',
    });
    importRepoIntoLibrary({ db, localPath: '/repo', profile: 'helm-native', fs });
    const row = db.prepare(
      `SELECT source_file FROM knowledge_chunks WHERE id = 'sf-native'`,
    ).get() as { source_file: string };
    expect(row.source_file).toBe('roles/dr/points/p.md');
  });

  it('re-import without briefing preserves a trained systemPrompt + createdAt', () => {
    upsertRole(db, {
      id: 'dr-docs', name: 'dr-docs',
      systemPrompt: 'trained prompt — do not clobber',
      isBuiltin: false, createdAt: '2026-01-01T00:00:00.000Z',
    });
    const fs = makeFs({
      '/repo/dr-docs/index.md': '# X\nbody',
    });
    importRepoIntoLibrary({ db, localPath: '/repo', profile: 'llm-wiki', fs });
    const role = getRole(db, 'dr-docs');
    expect(role?.systemPrompt).toBe('trained prompt — do not clobber');
    expect(role?.createdAt).toBe('2026-01-01T00:00:00.000Z');
    // PR-δ: re-import must not demote an existing Expert to Collection.
    expect(role?.bindable).toBe(true);
  });

  it('v28 regression: same-named files in different dirs stay distinct chunks', () => {
    // Before the path-slug fallback, wiki/index.md and domains/index.md
    // both got id 'index' and overwrote each other (role stuck on
    // whichever imported first).
    const fs = makeFs({
      '/repo/wiki/index.md': '# Wiki home\nwiki body',
      '/repo/domains/index.md': '# Domains home\ndomains body',
    });
    const summary = importRepoIntoLibrary({
      db, localPath: '/repo', profile: 'llm-wiki', fs,
    });
    expect(summary.pointsUpserted).toBe(2);
    const rows = db.prepare(
      `SELECT id, role_id FROM knowledge_chunks ORDER BY id`,
    ).all() as Array<{ id: string; role_id: string }>;
    expect(rows).toEqual([
      { id: 'domains-index', role_id: 'domains' },
      { id: 'wiki-index', role_id: 'wiki' },
    ]);
  });

  it('v28: importDirs whitelist filters top-level dirs; chat-captured is exempt', () => {
    const fs = makeFs({
      '/repo/dr-docs/a.md': '# A\nbody',
      '/repo/scripts/README.md': '# build scripts\nnot knowledge',
      '/repo/raw/dump.md': '# raw dump\nnoise',
      '/repo/chat-captured/hyf/dr-docs/cap.md': '# Cap\ncaptured body',
    });
    const summary = importRepoIntoLibrary({
      db, localPath: '/repo', profile: 'llm-wiki', fs,
      importDirs: ['dr-docs'],
    });
    // dr-docs (whitelisted) + captured bucket merge into ONE role.
    expect(summary.rolesImported).toBe(1);
    expect(summary.pointsUpserted).toBe(2);
    expect(getRole(db, 'scripts')).toBeUndefined();
    expect(getRole(db, 'raw')).toBeUndefined();
    expect(getRolesForPoint(db, 'chat-captured-hyf-dr-docs-cap')).toEqual(['dr-docs']);
  });

  it('v28: empty importDirs behaves like no whitelist (import everything)', () => {
    const fs = makeFs({
      '/repo/dr-docs/a.md': '# A\nbody',
      '/repo/raw/dump.md': '# raw\nnoise',
    });
    const summary = importRepoIntoLibrary({
      db, localPath: '/repo', profile: 'llm-wiki', fs, importDirs: [],
    });
    expect(summary.rolesImported).toBe(2);
  });
});
