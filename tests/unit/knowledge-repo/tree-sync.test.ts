/**
 * Files-as-truth PR-3 tests:
 *   - fetchNow now fast-forwards the working tree and clears
 *     untracked-vs-incoming collisions first
 *   - listUnpublishedCaptured maps `git status` under chat-captured/
 *     back to indexed chunks
 *   - publishCaptured batches every unpublished captured point into
 *     one publish() call (worktree + branch + MR)
 */

import BetterSqlite3 from 'better-sqlite3';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import {
  KnowledgeRepoManager,
  KnowledgeRepoManagerError,
} from '../../../src/knowledge-repo/manager.js';
import type { GitRunner } from '../../../src/knowledge-repo/git.js';
import { upsertRole } from '../../../src/storage/repos/roles.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('files-as-truth PR-3', () => {
  let db: BetterSqlite3.Database;
  let reposRoot: string;
  let cloneDir: string;

  beforeEach(() => {
    db = openDb();
    reposRoot = mkdtempSync(join(tmpdir(), 'helm-pr3-'));
    cloneDir = join(reposRoot, 'clone');
    mkdirSync(cloneDir, { recursive: true });
  });
  afterEach(() => {
    db.close();
    rmSync(reposRoot, { recursive: true, force: true });
  });

  function makeRepo(id = 'repo-wiki'): string {
    db.prepare(`
      INSERT INTO knowledge_repo
        (id, url, branch, local_path, classification, status,
         sync_interval_minutes, auto_apply, profile, created_at, updated_at)
      VALUES (?, 'https://code.byted.org/team/wiki', 'main', ?, 'internal',
        'active', 30, 0, 'llm-wiki', ?, ?)
    `).run(id, cloneDir, Date.now(), Date.now());
    return id;
  }

  function seedCapturedChunk(roleId: string, chunkId: string, sourceFile: string): void {
    upsertRole(db, {
      id: roleId, name: roleId, systemPrompt: '',
      isBuiltin: false, createdAt: new Date().toISOString(),
    });
    db.prepare(`
      INSERT INTO knowledge_chunks
        (id, role_id, chunk_text, kind, source_file, created_at)
      VALUES (?, ?, 'OG v5 decision body', 'decision', ?, ?)
    `).run(chunkId, roleId, sourceFile, new Date().toISOString());
  }

  describe('fetchNow → working-tree sync', () => {
    it('clears collisions (identical removed, diverged backed up) then ff-merges', async () => {
      const repoId = makeRepo();
      const identicalRel = 'chat-captured/hyf/dr/same.md';
      const divergedRel = 'chat-captured/hyf/dr/edited.md';
      for (const rel of [identicalRel, divergedRel]) {
        mkdirSync(join(cloneDir, rel, '..'), { recursive: true });
      }
      writeFileSync(join(cloneDir, identicalRel), 'merged content', 'utf8');
      writeFileSync(join(cloneDir, divergedRel), 'local draft', 'utf8');

      let revParseCount = 0;
      const calls: Array<readonly string[]> = [];
      const run: GitRunner = async (args) => {
        calls.push(args);
        // statusPorcelain prefixes `-c core.quotePath=false`; skip it to read the subcommand.
        const cmd = args[0] === '-c' ? args[2] : args[0];
        if (cmd === 'rev-parse') {
          revParseCount += 1;
          return { stdout: revParseCount === 1 ? 'aaa\n' : 'bbb\n', stderr: '', exitCode: 0 };
        }
        if (cmd === 'fetch') return { stdout: '', stderr: '', exitCode: 0 };
        if (cmd === 'diff') {
          return { stdout: `${identicalRel}\n${divergedRel}\nother/tracked.md\n`, stderr: '', exitCode: 0 };
        }
        if (cmd === 'status') {
          return {
            stdout: `?? ${identicalRel}\n?? ${divergedRel}\n`,
            stderr: '', exitCode: 0,
          };
        }
        if (cmd === 'show') {
          const spec = String(args[1]);
          if (spec.endsWith(identicalRel)) return { stdout: 'merged content', stderr: '', exitCode: 0 };
          return { stdout: 'reviewed upstream version', stderr: '', exitCode: 0 };
        }
        if (cmd === 'merge') return { stdout: '', stderr: '', exitCode: 0 };
        throw new Error(`unexpected git ${JSON.stringify(args)}`);
      };

      const mgr = new KnowledgeRepoManager({ db, git: run, reposRoot });
      const outcome = await mgr.fetchNow(repoId);

      expect(outcome.moved).toBe(true);
      expect(outcome.treeSynced).toBe(true);
      expect(outcome.collisions).toEqual([
        { relPath: identicalRel, action: 'removed_identical' },
        { relPath: divergedRel, action: 'backed_up' },
      ]);
      // Identical file deleted; diverged file parked under .helm-backup.
      expect(existsSync(join(cloneDir, identicalRel))).toBe(false);
      expect(existsSync(join(cloneDir, divergedRel))).toBe(false);
      expect(readFileSync(join(cloneDir, '.helm-backup', divergedRel), 'utf8'))
        .toBe('local draft');
      // Merge ran ff-only against the remote ref.
      expect(calls.some((a) => a[0] === 'merge' && a[1] === '--ff-only' && a[2] === 'origin/main'))
        .toBe(true);
    });

    it('skips the merge entirely when the branch did not move', async () => {
      const repoId = makeRepo();
      const calls: Array<readonly string[]> = [];
      const run: GitRunner = async (args) => {
        calls.push(args);
        if (args[0] === 'rev-parse') return { stdout: 'aaa\n', stderr: '', exitCode: 0 };
        if (args[0] === 'fetch') return { stdout: '', stderr: '', exitCode: 0 };
        throw new Error(`unexpected git ${JSON.stringify(args)}`);
      };
      const mgr = new KnowledgeRepoManager({ db, git: run, reposRoot });
      const outcome = await mgr.fetchNow(repoId);
      expect(outcome.moved).toBe(false);
      expect(outcome.treeSynced).toBeUndefined();
      expect(calls.every((a) => a[0] !== 'merge')).toBe(true);
    });

    it('reports treeSynced=false (status stays active) when the merge fails', async () => {
      const repoId = makeRepo();
      let revParseCount = 0;
      const run: GitRunner = async (args) => {
        const a0 = args[0] === '-c' ? args[2] : args[0];
        if (a0 === 'rev-parse') {
          revParseCount += 1;
          return { stdout: revParseCount === 1 ? 'aaa\n' : 'bbb\n', stderr: '', exitCode: 0 };
        }
        if (a0 === 'fetch') return { stdout: '', stderr: '', exitCode: 0 };
        if (a0 === 'diff') return { stdout: '', stderr: '', exitCode: 0 };
        if (a0 === 'status') return { stdout: '', stderr: '', exitCode: 0 };
        if (a0 === 'merge') return { stdout: '', stderr: 'cannot ff', exitCode: 1 };
        throw new Error(`unexpected git ${JSON.stringify(args)}`);
      };
      const mgr = new KnowledgeRepoManager({ db, git: run, reposRoot });
      const outcome = await mgr.fetchNow(repoId);
      expect(outcome.treeSynced).toBe(false);
      const row = db.prepare(
        `SELECT status, last_error FROM knowledge_repo WHERE id = ?`,
      ).get(repoId) as { status: string; last_error: string };
      expect(row.status).toBe('active');
      expect(row.last_error).toContain('working-tree sync failed');
    });
  });

  describe('listUnpublishedCaptured', () => {
    it('maps porcelain entries to indexed chunks; flags unindexed files', async () => {
      const repoId = makeRepo();
      seedCapturedChunk('dr', 'og-v5', 'chat-captured/hyf/dr/og-v5.md');
      const run: GitRunner = async (args) => {
        if ((args[0] === '-c' ? args[2] : args[0]) === 'status') {
          return {
            stdout: [
              '?? chat-captured/hyf/dr/og-v5.md',
              ' M chat-captured/hyf/dr/older.md',
              '?? chat-captured/hyf/dr/notes.txt',
            ].join('\n') + '\n',
            stderr: '', exitCode: 0,
          };
        }
        throw new Error(`unexpected git ${JSON.stringify(args)}`);
      };
      const mgr = new KnowledgeRepoManager({ db, git: run, reposRoot });
      const files = await mgr.listUnpublishedCaptured(repoId);
      // .txt filtered out; .md entries kept.
      expect(files).toHaveLength(2);
      expect(files[0]).toEqual({
        relPath: 'chat-captured/hyf/dr/og-v5.md',
        isNew: true,
        pointId: 'og-v5',
        title: 'OG v5 decision body',
      });
      expect(files[1]).toEqual({
        relPath: 'chat-captured/hyf/dr/older.md',
        isNew: false,
      });
    });

    it('throws for an unknown repo', async () => {
      const mgr = new KnowledgeRepoManager({
        db, git: async () => ({ stdout: '', stderr: '', exitCode: 0 }), reposRoot,
      });
      await expect(mgr.listUnpublishedCaptured('nope'))
        .rejects.toBeInstanceOf(KnowledgeRepoManagerError);
    });
  });

  describe('publishCaptured', () => {
    it('publishes every indexed captured point into one branch at its source_file path', async () => {
      const repoId = makeRepo();
      seedCapturedChunk('dr', 'og-v5', 'chat-captured/hyf/dr/og-v5.md');

      const calls: Array<readonly string[]> = [];
      let worktreePath: string | null = null;
      const run: GitRunner = async (args) => {
        calls.push(args);
        if ((args[0] === '-c' ? args[2] : args[0]) === 'status') {
          return { stdout: '?? chat-captured/hyf/dr/og-v5.md\n', stderr: '', exitCode: 0 };
        }
        if (args[0] === 'worktree' && args[1] === 'add') {
          worktreePath = String(args[4]);
          mkdirSync(worktreePath, { recursive: true });
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        // add / commit / push / worktree remove all succeed silently.
        return { stdout: '', stderr: '', exitCode: 0 };
      };

      const mgr = new KnowledgeRepoManager({ db, git: run, reposRoot });
      const result = await mgr.publishCaptured({ repoId });

      expect(result.pointIds).toEqual(['og-v5']);
      expect(result.skipped).toEqual([]);
      expect(result.filesWritten).toBe(1);
      expect(result.branch.startsWith('helm/captured/')).toBe(true);
      // The serialized file landed at the captured path inside the
      // ephemeral worktree (worktree is reaped afterwards, so we assert
      // via the recorded path + push call).
      expect(worktreePath).not.toBeNull();
      expect(calls.some((a) => a[0] === 'push')).toBe(true);
    });

    it('errors when nothing under chat-captured/ is indexed', async () => {
      const repoId = makeRepo();
      const run: GitRunner = async (args) => {
        if ((args[0] === '-c' ? args[2] : args[0]) === 'status') return { stdout: '', stderr: '', exitCode: 0 };
        throw new Error(`unexpected git ${JSON.stringify(args)}`);
      };
      const mgr = new KnowledgeRepoManager({ db, git: run, reposRoot });
      await expect(mgr.publishCaptured({ repoId }))
        .rejects.toBeInstanceOf(KnowledgeRepoManagerError);
    });
  });

  describe('promoteToDomain (知识阶梯 PR-γ)', () => {
    it('writes the consolidated doc into the publish worktree and pushes a promote branch', async () => {
      const repoId = makeRepo('repo-promote');
      let worktreePath: string | null = null;
      let pushedContent: string | null = null;
      const calls: Array<readonly string[]> = [];
      const run: GitRunner = async (args) => {
        calls.push(args);
        if (args[0] === 'worktree' && args[1] === 'add') {
          worktreePath = String(args[4]);
          mkdirSync(worktreePath, { recursive: true });
        }
        if (args[0] === 'push' && worktreePath) {
          // The worktree is reaped after publish — capture the file now.
          pushedContent = readFileSync(
            join(worktreePath, 'domains/stability/og-fallback-convention.md'), 'utf8',
          );
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      };
      const mgr = new KnowledgeRepoManager({ db, git: run, reposRoot });
      const r = await mgr.promoteToDomain({
        repoId, domain: 'stability',
        title: 'OG fallback convention',
        body: 'OG 数据 schema 不匹配时回退 v4。',
      });
      expect(r.relPath).toBe('domains/stability/og-fallback-convention.md');
      expect(r.branch).toMatch(/^helm\/promote\/stability-/);
      expect(r.filesWritten).toBe(1);
      expect(pushedContent).toContain('# OG fallback convention');
      expect(pushedContent).toContain('回退 v4');
    });

    it('sanitizes the domain segment (no traversal)', async () => {
      const repoId = makeRepo('repo-promote-2');
      let captured: string | null = null;
      const run: GitRunner = async (args) => {
        if (args[0] === 'worktree' && args[1] === 'add') {
          mkdirSync(String(args[4]), { recursive: true });
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      };
      const mgr = new KnowledgeRepoManager({ db, git: run, reposRoot });
      const r = await mgr.promoteToDomain({
        repoId, domain: '../evil', title: 'Some doc title', body: 'body',
      });
      captured = r.relPath;
      expect(captured).toBe('domains/evil/some-doc-title.md');
    });

    it('rejects empty fields and non-llm-wiki repos', async () => {
      const repoId = makeRepo('repo-promote-3');
      const mgr = new KnowledgeRepoManager({
        db, git: async () => ({ stdout: '', stderr: '', exitCode: 0 }), reposRoot,
      });
      await expect(mgr.promoteToDomain({ repoId, domain: '', title: 't', body: 'b' }))
        .rejects.toBeInstanceOf(KnowledgeRepoManagerError);
      db.prepare(`UPDATE knowledge_repo SET profile = 'helm-native' WHERE id = ?`).run(repoId);
      await expect(mgr.promoteToDomain({ repoId, domain: 'd', title: 't', body: 'b' }))
        .rejects.toBeInstanceOf(KnowledgeRepoManagerError);
    });
  });
});
