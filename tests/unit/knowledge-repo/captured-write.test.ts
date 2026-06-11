/**
 * Unit tests for KnowledgeRepoManager.writeCapturedPoint
 * (files-as-truth PR-2).
 *
 * Uses a real tmp dir as the repo working copy — the method only does
 * fs writes (no git), so no runner scripting is needed.
 */

import BetterSqlite3 from 'better-sqlite3';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import {
  KnowledgeRepoManager,
  KnowledgeRepoManagerError,
} from '../../../src/knowledge-repo/manager.js';
import type { GitRunner } from '../../../src/knowledge-repo/git.js';
import { importRepoIntoLibrary } from '../../../src/knowledge-repo/importer.js';
import { upsertRole } from '../../../src/storage/repos/roles.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

const neverGit: GitRunner = async () => {
  throw new Error('writeCapturedPoint must not shell out to git');
};

describe('KnowledgeRepoManager.writeCapturedPoint', () => {
  let db: BetterSqlite3.Database;
  let reposRoot: string;
  let cloneDir: string;

  beforeEach(() => {
    db = openDb();
    reposRoot = mkdtempSync(join(tmpdir(), 'helm-cap-'));
    cloneDir = join(reposRoot, 'clone');
  });
  afterEach(() => {
    db.close();
    rmSync(reposRoot, { recursive: true, force: true });
  });

  function makeRepo(profile: 'llm-wiki' | 'helm-native'): string {
    const repoId = `repo-${profile}`;
    db.prepare(`
      INSERT INTO knowledge_repo
        (id, url, branch, local_path, classification, status,
         sync_interval_minutes, auto_apply, profile, created_at, updated_at)
      VALUES (?, 'https://code.byted.org/team/wiki', 'main', ?, 'internal',
        'active', 30, 0, ?, ?, ?)
    `).run(repoId, cloneDir, profile, Date.now(), Date.now());
    return repoId;
  }

  function seedChunk(roleId: string, chunkId: string, body: string): void {
    upsertRole(db, {
      id: roleId, name: roleId, systemPrompt: '',
      isBuiltin: false, createdAt: new Date().toISOString(),
    });
    db.prepare(`
      INSERT INTO knowledge_chunks (id, role_id, chunk_text, kind, created_at)
      VALUES (?, ?, ?, 'decision', ?)
    `).run(chunkId, roleId, body, new Date().toISOString());
  }

  it('writes chat-captured/<user>/<role>/<id>.md and points source_file at it', async () => {
    const repoId = makeRepo('llm-wiki');
    seedChunk('dr-docs', 'og-v5-schema-mismatch', 'OG v5 schema mismatch\n\ndetail body');
    const mgr = new KnowledgeRepoManager({ db, git: neverGit, reposRoot });

    const out = await mgr.writeCapturedPoint({
      repoId, chunkId: 'og-v5-schema-mismatch', username: 'heyunfeng.feng',
    });
    expect(out.relPath).toBe(
      'chat-captured/heyunfeng.feng/dr-docs/og-v5-schema-mismatch.md',
    );
    expect(existsSync(out.absPath)).toBe(true);
    const text = readFileSync(out.absPath, 'utf8');
    expect(text).toContain('```concept');
    expect(text).toContain('id: og-v5-schema-mismatch');

    const row = db.prepare(
      `SELECT source_file FROM knowledge_chunks WHERE id = 'og-v5-schema-mismatch'`,
    ).get() as { source_file: string };
    expect(row.source_file).toBe(out.relPath);
  });

  it('round-trips: the written file re-imports onto the same chunk id', async () => {
    const repoId = makeRepo('llm-wiki');
    seedChunk('dr-docs', 'cdn-failover', 'CDN failover decision\n\nbody');
    const mgr = new KnowledgeRepoManager({ db, git: neverGit, reposRoot });
    await mgr.writeCapturedPoint({
      repoId, chunkId: 'cdn-failover', username: 'heyunfeng.feng',
    });

    const summary = importRepoIntoLibrary({
      db, localPath: cloneDir, profile: 'llm-wiki',
    });
    expect(summary.errors).toEqual({});
    // Upserted onto the existing row — no duplicate chunk appeared.
    const count = db.prepare(
      `SELECT COUNT(*) AS n FROM knowledge_chunks WHERE id LIKE 'cdn-failover%'`,
    ).get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('sanitizes path segments: no separators, no leading dots', async () => {
    const repoId = makeRepo('llm-wiki');
    seedChunk('dr', 'pt-1', 'body');
    const mgr = new KnowledgeRepoManager({ db, git: neverGit, reposRoot });
    const out = await mgr.writeCapturedPoint({
      repoId, chunkId: 'pt-1', username: '../.evil/user',
    });
    // ".." and "/" collapse away; the leading dot is stripped so the
    // importer (which skips hidden dirs) still sees the directory.
    expect(out.relPath).toBe('chat-captured/evil-user/dr/pt-1.md');
  });

  it('rejects a repo whose profile is not llm-wiki', async () => {
    const repoId = makeRepo('helm-native');
    seedChunk('dr', 'pt-2', 'body');
    const mgr = new KnowledgeRepoManager({ db, git: neverGit, reposRoot });
    await expect(
      mgr.writeCapturedPoint({ repoId, chunkId: 'pt-2', username: 'u' }),
    ).rejects.toBeInstanceOf(KnowledgeRepoManagerError);
  });

  it('rejects an unknown chunk id', async () => {
    const repoId = makeRepo('llm-wiki');
    const mgr = new KnowledgeRepoManager({ db, git: neverGit, reposRoot });
    await expect(
      mgr.writeCapturedPoint({ repoId, chunkId: 'nope', username: 'u' }),
    ).rejects.toBeInstanceOf(KnowledgeRepoManagerError);
  });
});
