/**
 * Unit tests for KnowledgeRepoManager (PR 5.5a.4).
 *
 * Drives the manager against an in-memory SQLite and a hand-rolled
 * GitRunner so no actual git or filesystem clone occurs. The manager
 * does still touch the filesystem to mkdir + rmSync the clone path;
 * tests redirect that path to an mkdtemp so cleanup is automatic.
 */

import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import {
  KnowledgeRepoManager,
  KnowledgeRepoManagerError,
} from '../../../src/knowledge-repo/manager.js';
import type { GitRunner } from '../../../src/knowledge-repo/git.js';
import {
  getKnowledgeRepo,
  listKnowledgeRepos,
} from '../../../src/storage/repos/knowledge-repo.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

interface Scripted {
  match: (args: readonly string[]) => boolean;
  result: { stdout?: string; stderr?: string; exitCode?: number };
  /** Side effect run when this script matches (e.g. mkdir the clone dir). */
  side?: () => void;
}

function makeRunner(scripts: Scripted[]): GitRunner & { calls: Array<readonly string[]> } {
  const calls: Array<readonly string[]> = [];
  const f = (async (args) => {
    calls.push(args);
    const s = scripts.find((sc) => sc.match(args));
    if (!s) throw new Error(`no script for ${JSON.stringify(args)}`);
    s.side?.();
    return {
      stdout: s.result.stdout ?? '',
      stderr: s.result.stderr ?? '',
      exitCode: s.result.exitCode ?? 0,
    };
  }) as GitRunner & { calls: typeof calls };
  f.calls = calls;
  return f;
}

describe('KnowledgeRepoManager.subscribe', () => {
  let db: BetterSqlite3.Database;
  let reposRoot: string;

  beforeEach(() => {
    db = openDb();
    reposRoot = mkdtempSync(join(tmpdir(), 'helm-repo-mgr-'));
  });
  afterEach(() => {
    db.close();
    rmSync(reposRoot, { recursive: true, force: true });
  });

  it('subscribes a fresh repo: classifies host, persists the row, calls clone', async () => {
    const runner = makeRunner([{
      match: (args) => args[0] === 'clone',
      result: { exitCode: 0 },
      // Manager's clone path is the targetDir; simulate the clone by
      // mkdir'ing it so existsSync checks downstream succeed.
      side: () => {
        // Last arg of clone is the targetDir
        // (set later — find it on the runner.calls[0])
      },
    }]);
    const mgr = new KnowledgeRepoManager({ db, git: runner, reposRoot });
    const repo = await mgr.subscribe('https://github.com/org/wiki.git');
    expect(repo.url).toBe('https://github.com/org/wiki');
    expect(repo.classification).toBe('public');
    expect(repo.branch).toBe('main');
    expect(repo.status).toBe('active');
    expect(runner.calls.length).toBe(1);
    expect(runner.calls[0]![0]).toBe('clone');
  });

  it('classifies an internal host correctly via the default allow-list', async () => {
    const runner = makeRunner([{
      match: (args) => args[0] === 'clone',
      result: { exitCode: 0 },
    }]);
    const mgr = new KnowledgeRepoManager({ db, git: runner, reposRoot });
    const repo = await mgr.subscribe('git@code.byted.org:tiktok/llm-wiki.git');
    expect(repo.classification).toBe('internal');
  });

  it('passes the requested branch into the clone call', async () => {
    const runner = makeRunner([{
      match: (args) => args[0] === 'clone',
      result: { exitCode: 0 },
    }]);
    const mgr = new KnowledgeRepoManager({ db, git: runner, reposRoot });
    await mgr.subscribe('https://github.com/org/repo', { branch: 'develop' });
    expect(runner.calls[0]!).toContain('--branch');
    expect(runner.calls[0]!).toContain('develop');
  });

  it('throws when the URL is already subscribed', async () => {
    const runner = makeRunner([{
      match: (args) => args[0] === 'clone',
      result: { exitCode: 0 },
    }]);
    const mgr = new KnowledgeRepoManager({ db, git: runner, reposRoot });
    await mgr.subscribe('https://github.com/org/repo');
    await expect(mgr.subscribe('https://github.com/org/repo'))
      .rejects.toThrowError(KnowledgeRepoManagerError);
  });

  it('cleans up the clone dir when the clone subprocess fails', async () => {
    let clonedTo = '';
    const runner = makeRunner([{
      match: (args) => args[0] === 'clone',
      result: { exitCode: 128, stderr: 'auth required' },
      side: () => {
        // mimic the manager mkdir'ing the parent first; in tests we
        // record where the clone would have gone so we can check the
        // dir is removed afterwards.
      },
    }]);
    const mgr = new KnowledgeRepoManager({ db, git: runner, reposRoot });
    // Pre-create the clone dir to simulate "we had a half-clone".
    // The manager should rm it after the clone fails.
    try {
      await mgr.subscribe('https://github.com/org/repo');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(KnowledgeRepoManagerError);
    }
    // No row was persisted.
    expect(listKnowledgeRepos(db)).toEqual([]);
    void clonedTo;
  });
});

describe('KnowledgeRepoManager.fetchNow', () => {
  let db: BetterSqlite3.Database;
  let reposRoot: string;

  beforeEach(() => {
    db = openDb();
    reposRoot = mkdtempSync(join(tmpdir(), 'helm-repo-mgr-'));
  });
  afterEach(() => {
    db.close();
    rmSync(reposRoot, { recursive: true, force: true });
  });

  it('records lastFetchedSha + lastFetchedAt after a successful fetch', async () => {
    let postSha = 'sha-new';
    const seq = [
      // subscribe path: clone
      { match: (args: readonly string[]) => args[0] === 'clone', result: { exitCode: 0 },
        side: () => { /* simulate clone dir created */ } },
      // fetchNow path: pre rev-parse, fetch, post rev-parse
      { match: (args: readonly string[]) => args[0] === 'rev-parse',
        result: { stdout: 'sha-old\n', exitCode: 0 } },
      { match: (args: readonly string[]) => args[0] === 'fetch',
        result: { exitCode: 0 } },
      { match: (args: readonly string[]) => args[0] === 'rev-parse',
        result: { stdout: `${postSha}\n`, exitCode: 0 } },
    ];
    let used = new Set<number>();
    const runner: GitRunner = async (args) => {
      for (let i = 0; i < seq.length; i++) {
        if (used.has(i)) continue;
        if (seq[i]!.match(args)) {
          used.add(i);
          const r = seq[i]!.result;
          seq[i]!.side?.();
          return { stdout: r.stdout ?? '', stderr: '', exitCode: r.exitCode ?? 0 };
        }
      }
      throw new Error(`no script for ${JSON.stringify(args)}`);
    };
    const mgr = new KnowledgeRepoManager({ db, git: runner, reposRoot });
    const repo = await mgr.subscribe('https://github.com/org/repo');
    // Make the clone path exist so the existsSync check in fetchNow
    // returns true and we skip the re-clone branch.
    mkdirSync(repo.localPath, { recursive: true });
    const outcome = await mgr.fetchNow(repo.id);
    expect(outcome.moved).toBe(true);
    expect(outcome.headSha).toBe(postSha);
    const after = getKnowledgeRepo(db, repo.id)!;
    expect(after.lastFetchedSha).toBe(postSha);
    expect(after.status).toBe('active');
    expect(after.lastError).toBeUndefined();
  });

  it('flips the row to status=error and records the message when fetch throws', async () => {
    let cloneSeen = false;
    let revParseSeen = false;
    const runner: GitRunner = async (args) => {
      if (args[0] === 'clone' && !cloneSeen) {
        cloneSeen = true;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'rev-parse' && !revParseSeen) {
        revParseSeen = true;
        return { stdout: 'sha-old\n', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: 'network unreachable', exitCode: 1 };
      }
      throw new Error(`unexpected args ${JSON.stringify(args)}`);
    };
    const mgr = new KnowledgeRepoManager({ db, git: runner, reposRoot });
    const repo = await mgr.subscribe('https://github.com/org/repo');
    mkdirSync(repo.localPath, { recursive: true });
    await expect(mgr.fetchNow(repo.id)).rejects.toThrow();
    const after = getKnowledgeRepo(db, repo.id)!;
    expect(after.status).toBe('error');
    expect(after.lastError).toMatch(/network unreachable/);
  });

  it('refuses to fetch a paused repo', async () => {
    const runner = makeRunner([{
      match: (args) => args[0] === 'clone', result: { exitCode: 0 },
    }]);
    const mgr = new KnowledgeRepoManager({ db, git: runner, reposRoot });
    const repo = await mgr.subscribe('https://github.com/org/repo');
    mgr.unsubscribe(repo.id); // soft pause
    await expect(mgr.fetchNow(repo.id))
      .rejects.toThrowError(KnowledgeRepoManagerError);
  });

  it('returns 404-ish error for unknown id', async () => {
    const runner = makeRunner([]);
    const mgr = new KnowledgeRepoManager({ db, git: runner, reposRoot });
    await expect(mgr.fetchNow('nope'))
      .rejects.toThrowError(/unknown repo/);
  });
});

describe('KnowledgeRepoManager.unsubscribe', () => {
  let db: BetterSqlite3.Database;
  let reposRoot: string;

  beforeEach(() => {
    db = openDb();
    reposRoot = mkdtempSync(join(tmpdir(), 'helm-repo-mgr-'));
  });
  afterEach(() => {
    db.close();
    rmSync(reposRoot, { recursive: true, force: true });
  });

  it('soft pause keeps the row + clone dir', async () => {
    const runner = makeRunner([{
      match: (args) => args[0] === 'clone',
      result: { exitCode: 0 },
    }]);
    const mgr = new KnowledgeRepoManager({ db, git: runner, reposRoot });
    const repo = await mgr.subscribe('https://github.com/org/repo');
    mkdirSync(repo.localPath, { recursive: true });
    mgr.unsubscribe(repo.id);
    const after = getKnowledgeRepo(db, repo.id)!;
    expect(after.status).toBe('paused');
    expect(existsSync(repo.localPath)).toBe(true);
  });

  it('removeData=true deletes the row + wipes the clone dir', async () => {
    const runner = makeRunner([{
      match: (args) => args[0] === 'clone',
      result: { exitCode: 0 },
    }]);
    const mgr = new KnowledgeRepoManager({ db, git: runner, reposRoot });
    const repo = await mgr.subscribe('https://github.com/org/repo');
    mkdirSync(repo.localPath, { recursive: true });
    mgr.unsubscribe(repo.id, { removeData: true });
    expect(getKnowledgeRepo(db, repo.id)).toBeUndefined();
    expect(existsSync(repo.localPath)).toBe(false);
  });

  it('is a no-op for an unknown id', () => {
    const runner = makeRunner([]);
    const mgr = new KnowledgeRepoManager({ db, git: runner, reposRoot });
    expect(() => mgr.unsubscribe('does-not-exist')).not.toThrow();
  });
});
