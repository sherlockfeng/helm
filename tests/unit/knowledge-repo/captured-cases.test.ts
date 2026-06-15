/**
 * Regression: benchmark-case files under chat-captured/<user>/<role>/cases/
 * must be flagged isCase by listUnpublishedCaptured (publishable via
 * extraFiles), NOT treated as "un-indexed, will skip" like a knowledge-point
 * file with no DB chunk. Bug: the 8 doc-lsp case files showed "未入索引（将跳过）"
 * and never synced.
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../../../src/storage/migrations.js';
import { upsertRole } from '../../../src/storage/repos/roles.js';
import { KnowledgeRepoManager } from '../../../src/knowledge-repo/manager.js';
import type { GitRunner } from '../../../src/knowledge-repo/git.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

let db: BetterSqlite3.Database;
let reposRoot: string;
let cloneDir: string;

beforeEach(() => {
  db = openDb();
  reposRoot = mkdtempSync(join(tmpdir(), 'helm-cases-'));
  cloneDir = join(reposRoot, 'clone');
  mkdirSync(cloneDir, { recursive: true });
});
afterEach(() => { db.close(); rmSync(reposRoot, { recursive: true, force: true }); });

describe('listUnpublishedCaptured — case files', () => {
  it('flags cases/ files as isCase (publishable), points get pointId, neither is "un-indexed"', async () => {
    const repoId = 'repo-x';
    db.prepare(`
      INSERT INTO knowledge_repo
        (id, url, branch, local_path, classification, status,
         sync_interval_minutes, auto_apply, profile, created_at, updated_at)
      VALUES (?, 'https://x/wiki', 'main', ?, 'internal', 'active', 30, 0, 'llm-wiki', ?, ?)
    `).run(repoId, cloneDir, Date.now(), Date.now());

    // A knowledge point whose source_file matches the porcelain path.
    upsertRole(db, { id: 'dr', name: 'dr', systemPrompt: '', isBuiltin: false, createdAt: new Date().toISOString() });
    db.prepare(`INSERT INTO knowledge_chunks (id, role_id, chunk_text, source_file, kind, created_at) VALUES ('pt1','dr','# T\nbody','chat-captured/u/dr/pt1.md','spec',?)`)
      .run(new Date().toISOString());

    // Fake git: status lists one point file + one case file, both untracked.
    const fakeGit: GitRunner = async (args) => {
      if (args[0] === 'status') {
        return {
          exitCode: 0,
          stdout: '?? chat-captured/u/dr/pt1.md\n?? chat-captured/u/dr/cases/c1.md\n',
          stderr: '',
        };
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    };

    const mgr = new KnowledgeRepoManager({ db, git: fakeGit, reposRoot });
    const out = await mgr.listUnpublishedCaptured(repoId);

    const pt = out.find((u) => u.relPath.endsWith('pt1.md'))!;
    const cs = out.find((u) => u.relPath.endsWith('c1.md'))!;
    expect(pt.pointId).toBe('pt1');
    expect(pt.isCase).toBeFalsy();
    expect(cs.isCase).toBe(true);
    expect(cs.pointId).toBeUndefined();
    // The "un-indexed (will skip)" set = no pointId AND not a case → empty.
    expect(out.filter((u) => !u.pointId && !u.isCase)).toHaveLength(0);
  });
});
