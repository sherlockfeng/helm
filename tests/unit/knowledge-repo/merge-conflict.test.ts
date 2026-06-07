/**
 * Unit tests for the 3-way merge backend (PR 5.5c).
 *
 *   - Importer records a conflict when local body diverged AND remote
 *     body changed (edit_version > 1 AND bodies differ)
 *   - Importer skips conflict recording when only metadata changed
 *   - Listing / resolving the conflict via the repo helpers
 *   - Re-resolving a resolved conflict is a no-op
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { importRepoIntoLibrary } from '../../../src/knowledge-repo/importer.js';
import {
  listMergeConflicts,
  resolveMergeConflict,
} from '../../../src/storage/repos/knowledge-merge-conflict.js';
import {
  updateChunkWithVersionCheck,
} from '../../../src/storage/repos/roles.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeFs(files: Record<string, string>) {
  const paths = new Set(Object.keys(files));
  const dirs = new Set<string>();
  for (const p of paths) {
    let cur = p;
    while (true) {
      const i = cur.lastIndexOf('/');
      if (i <= 0) break;
      cur = cur.slice(0, i);
      dirs.add(cur);
    }
  }
  return {
    readdirSync: ((root: string): string[] => {
      const out = new Set<string>();
      for (const p of [...paths, ...dirs]) {
        if (p.startsWith(root + '/')) {
          const rest = p.slice(root.length + 1);
          out.add(rest.split('/')[0]!);
        }
      }
      return [...out];
    }) as typeof import('node:fs').readdirSync,
    statSync: ((p: string) => ({
      isDirectory: (): boolean => dirs.has(p),
      isFile: (): boolean => paths.has(p),
    })) as unknown as typeof import('node:fs').statSync,
    readFileSync: ((p: string): string => {
      if (paths.has(p)) return files[p]!;
      throw new Error(`ENOENT ${p}`);
    }) as unknown as typeof import('node:fs').readFileSync,
    existsSync: ((p: string): boolean => paths.has(p) || dirs.has(p)) as typeof import('node:fs').existsSync,
  };
}

function seedRepo(db: BetterSqlite3.Database, id = 'repo-1'): void {
  db.prepare(`
    INSERT INTO knowledge_repo
      (id, url, branch, local_path, classification, status,
       sync_interval_minutes, auto_apply, created_at, updated_at)
    VALUES (?, 'https://x', 'main', '/repo', 'internal', 'active',
      30, 0, ?, ?)
  `).run(id, Date.now(), Date.now());
}

describe('importer × merge-conflict', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); seedRepo(db); });
  afterEach(() => { db.close(); });

  it('records a conflict instead of overwriting when local is touched and remote body differs', () => {
    const v1 = makeFs({
      '/repo/roles/r/points/p.md': '---\nid: p\n---\noriginal remote body',
    });
    importRepoIntoLibrary({
      db, localPath: '/repo', profile: 'helm-native', fs: v1, repoId: 'repo-1', remoteRevision: 'sha-1',
    });
    // User edits the chunk locally — bumps edit_version past 1.
    updateChunkWithVersionCheck(db, 'p', 1, { body: 'LOCAL EDITED BODY' });
    // Remote then changes the body too.
    const v2 = makeFs({
      '/repo/roles/r/points/p.md': '---\nid: p\n---\nNEW REMOTE BODY',
    });
    const summary = importRepoIntoLibrary({
      db, localPath: '/repo', profile: 'helm-native', fs: v2, repoId: 'repo-1', remoteRevision: 'sha-2',
    });
    expect(summary.conflictsDetected).toBe(1);
    // The chunk body STAYED as the user's edit — not clobbered.
    const row = db.prepare(`SELECT chunk_text FROM knowledge_chunks WHERE id = 'p'`)
      .get() as { chunk_text: string };
    expect(row.chunk_text).toBe('LOCAL EDITED BODY');
    // A conflict row landed.
    const conflicts = listMergeConflicts(db);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.remoteBody).toBe('NEW REMOTE BODY');
    expect(conflicts[0]!.localBody).toBe('LOCAL EDITED BODY');
    expect(conflicts[0]!.remoteRevision).toBe('sha-2');
  });

  it('does NOT record a conflict when only metadata (aliases) changed', () => {
    const v1 = makeFs({
      '/repo/roles/r/points/p.md': [
        '---', 'id: p', 'aliases: [a]', '---', '',
        'same body',
      ].join('\n'),
    });
    importRepoIntoLibrary({
      db, localPath: '/repo', profile: 'helm-native', fs: v1, repoId: 'repo-1',
    });
    // User flips edit_version via UpdateChunk but body unchanged.
    updateChunkWithVersionCheck(db, 'p', 1, { body: 'same body' });
    const v2 = makeFs({
      '/repo/roles/r/points/p.md': [
        '---', 'id: p', 'aliases: [a, b, c]', '---', '',
        'same body',
      ].join('\n'),
    });
    const summary = importRepoIntoLibrary({
      db, localPath: '/repo', profile: 'helm-native', fs: v2, repoId: 'repo-1',
    });
    expect(summary.conflictsDetected).toBe(0);
  });

  it('skips conflict path when no repoId is passed (legacy sync-overwrite)', () => {
    const v1 = makeFs({
      '/repo/roles/r/points/p.md': '---\nid: p\n---\nremote v1',
    });
    importRepoIntoLibrary({ db, localPath: '/repo', profile: 'helm-native', fs: v1 });
    updateChunkWithVersionCheck(db, 'p', 1, { body: 'LOCAL EDIT' });
    const v2 = makeFs({
      '/repo/roles/r/points/p.md': '---\nid: p\n---\nremote v2 differs',
    });
    const summary = importRepoIntoLibrary({
      db, localPath: '/repo', profile: 'helm-native', fs: v2,
    });
    // No repoId → legacy behavior, body gets overwritten.
    expect(summary.conflictsDetected).toBe(0);
    const row = db.prepare(`SELECT chunk_text FROM knowledge_chunks WHERE id = 'p'`)
      .get() as { chunk_text: string };
    expect(row.chunk_text).toBe('remote v2 differs');
  });
});

describe('resolveMergeConflict', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => {
    db = openDb();
    seedRepo(db);
    const v1 = makeFs({ '/repo/roles/r/points/p.md': '---\nid: p\n---\nremote A' });
    importRepoIntoLibrary({ db, localPath: '/repo', profile: 'helm-native', fs: v1, repoId: 'repo-1' });
    updateChunkWithVersionCheck(db, 'p', 1, { body: 'local A' });
    const v2 = makeFs({ '/repo/roles/r/points/p.md': '---\nid: p\n---\nremote B' });
    importRepoIntoLibrary({ db, localPath: '/repo', profile: 'helm-native', fs: v2, repoId: 'repo-1' });
  });
  afterEach(() => { db.close(); });

  it('flips an open conflict to resolved with the supplied body', () => {
    const conflict = listMergeConflicts(db, { status: 'open' })[0]!;
    const ok = resolveMergeConflict(db, conflict.id, 'merged result');
    expect(ok).toBe(true);
    const after = listMergeConflicts(db, { status: 'resolved' })[0]!;
    expect(after.resolvedBody).toBe('merged result');
    expect(typeof after.resolvedAt).toBe('number');
  });

  it('no-ops on already-resolved or unknown id', () => {
    const conflict = listMergeConflicts(db, { status: 'open' })[0]!;
    resolveMergeConflict(db, conflict.id, 'x');
    expect(resolveMergeConflict(db, conflict.id, 'y')).toBe(false);
    expect(resolveMergeConflict(db, 'does-not-exist', 'z')).toBe(false);
  });
});
