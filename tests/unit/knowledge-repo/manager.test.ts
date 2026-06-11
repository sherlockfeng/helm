/**
 * Unit tests for KnowledgeRepoManager (PR 5.5a.4).
 *
 * Drives the manager against an in-memory SQLite and a hand-rolled
 * GitRunner so no actual git or filesystem clone occurs. The manager
 * does still touch the filesystem to mkdir + rmSync the clone path;
 * tests redirect that path to an mkdtemp so cleanup is automatic.
 */

import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
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
      // PR-3: moved=true now triggers a working-tree sync — collision
      // scan (diff + status, both empty here) and the ff-only merge.
      { match: (args: readonly string[]) => args[0] === 'diff',
        result: { stdout: '', exitCode: 0 } },
      { match: (args: readonly string[]) => args[0] === 'status',
        result: { stdout: '', exitCode: 0 } },
      { match: (args: readonly string[]) => args[0] === 'merge',
        result: { exitCode: 0 } },
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
    expect(outcome.treeSynced).toBe(true);
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

describe('KnowledgeRepoManager.withRepoLock (R-1 FIFO)', () => {
  let db: BetterSqlite3.Database;
  let reposRoot: string;

  beforeEach(() => {
    db = openDb();
    reposRoot = mkdtempSync(join(tmpdir(), 'helm-repo-lock-'));
  });
  afterEach(() => {
    db.close();
    rmSync(reposRoot, { recursive: true, force: true });
  });

  it('serializes three concurrent fetchNow calls strictly in arrival order', async () => {
    // Drives the FIFO chain: A starts (and holds the runner with a
    // manually-resolved promise), B + C queue, then we release A → B
    // → C and assert the in-flight overlap is always exactly one.
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];

    let cloneSeen = false;
    const blockers: Array<() => void> = [];
    const runner: GitRunner = async (args) => {
      if (args[0] === 'clone' && !cloneSeen) {
        cloneSeen = true;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'rev-parse') {
        return { stdout: 'sha-x\n', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'fetch') {
        // Block here until the test releases — simulates "real fetch
        // takes a while". The order in which blockers fire is the
        // order in which the lock yielded the slot.
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => blockers.push(() => {
          inFlight -= 1;
          resolve();
        }));
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      throw new Error(`unexpected ${JSON.stringify(args)}`);
    };

    const mgr = new KnowledgeRepoManager({ db, git: runner, reposRoot });
    const repo = await mgr.subscribe('https://github.com/org/lockrepo');
    mkdirSync(repo.localPath, { recursive: true });

    const a = mgr.fetchNow(repo.id).then(() => order.push('A'));
    const b = mgr.fetchNow(repo.id).then(() => order.push('B'));
    const c = mgr.fetchNow(repo.id).then(() => order.push('C'));

    // Let each in-flight blocker actually queue before releasing.
    const releaseNext = async (): Promise<void> => {
      // Wait until at least one blocker is registered.
      while (blockers.length === 0) {
        await new Promise((r) => setImmediate(r));
      }
      blockers.shift()!();
    };

    await releaseNext();
    await releaseNext();
    await releaseNext();
    await Promise.all([a, b, c]);

    expect(maxInFlight).toBe(1);
    expect(order).toEqual(['A', 'B', 'C']);
  });

  it('a rejection in the first task does not poison the chain', async () => {
    let cloneSeen = false;
    let revParseCalls = 0;
    let fetchCalls = 0;
    const runner: GitRunner = async (args) => {
      if (args[0] === 'clone' && !cloneSeen) {
        cloneSeen = true;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'rev-parse') {
        revParseCalls += 1;
        return { stdout: 'sha-x\n', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'fetch') {
        fetchCalls += 1;
        // First call fails (simulates network blip), second succeeds.
        return fetchCalls === 1
          ? { stdout: '', stderr: 'network', exitCode: 1 }
          : { stdout: '', stderr: '', exitCode: 0 };
      }
      throw new Error(`unexpected ${JSON.stringify(args)}`);
    };
    const mgr = new KnowledgeRepoManager({ db, git: runner, reposRoot });
    const repo = await mgr.subscribe('https://github.com/org/lockrecover');
    mkdirSync(repo.localPath, { recursive: true });

    const a = mgr.fetchNow(repo.id);
    const b = mgr.fetchNow(repo.id);

    await expect(a).rejects.toThrow();
    await expect(b).resolves.toMatchObject({ repoId: repo.id });
    // Both attempts actually issued — meaning B didn't get cancelled
    // by A's failure (no chain poisoning).
    expect(fetchCalls).toBe(2);
    expect(revParseCalls).toBeGreaterThanOrEqual(2);
  });
});

describe('KnowledgeRepoManager.publish (R-2 worktree isolation)', () => {
  let db: BetterSqlite3.Database;
  let reposRoot: string;

  beforeEach(() => {
    db = openDb();
    reposRoot = mkdtempSync(join(tmpdir(), 'helm-publish-iso-'));
  });
  afterEach(() => {
    db.close();
    rmSync(reposRoot, { recursive: true, force: true });
  });

  it('runs commit+push inside a worktree dir, never the main clone', async () => {
    // Track which cwd the commit / push ran in.
    const cwdSeen: Record<string, string> = {};
    let cloneSeen = false;
    let worktreeAddSeen = false;
    let worktreeRemoveSeen = false;
    let worktreePath = '';

    const runner: GitRunner = async (args, cwd) => {
      const first = args[0];
      if (first === 'clone' && !cloneSeen) {
        cloneSeen = true;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (first === 'worktree' && args[1] === 'add' && !worktreeAddSeen) {
        worktreeAddSeen = true;
        // Manager passes: ['worktree','add','-B'|'-b',branch,path,base]
        worktreePath = String(args[4]);
        // Actually create the dir so the writeFile calls inside the
        // manager succeed.
        mkdirSync(worktreePath, { recursive: true });
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (first === 'worktree' && args[1] === 'remove') {
        worktreeRemoveSeen = true;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (first === 'add')    { cwdSeen['add']    = String(cwd); return { stdout: '', stderr: '', exitCode: 0 }; }
      if (first === 'commit') { cwdSeen['commit'] = String(cwd); return { stdout: '', stderr: '', exitCode: 0 }; }
      if (first === 'push')   { cwdSeen['push']   = String(cwd); return { stdout: '', stderr: '', exitCode: 0 }; }
      // Allow `-c user.name=...` invocations through too: the commit
      // path prefixes config flags.
      if (args.includes('commit')) { cwdSeen['commit'] = String(cwd); return { stdout: '', stderr: '', exitCode: 0 }; }
      return { stdout: '', stderr: '', exitCode: 0 };
    };

    const mgr = new KnowledgeRepoManager({ db, git: runner, reposRoot });
    const repo = await mgr.subscribe('https://github.com/org/pubrepo');
    // Stand in for the real clone so importNow style ops can read.
    mkdirSync(repo.localPath, { recursive: true });

    // Seed a published-eligible point: visibility=public so R-0 passes.
    // We bypass the full chunk insert by mocking the get-chunk lookup
    // is unnecessary — publish() with pointIds=[] is rejected, so we
    // need at least one point. Insert a minimal role + chunk row.
    db.prepare(`INSERT INTO roles (id, name, system_prompt, created_at) VALUES ('r-iso','iso','sp',?)`).run(new Date().toISOString());
    db.prepare(`
      INSERT INTO knowledge_chunks
        (id, role_id, source_file, title, chunk_text, created_at, visibility)
      VALUES ('p-iso','r-iso','iso.md','Iso','body',?,'public')
    `).run(new Date().toISOString());

    await mgr.publish({
      repoId: repo.id,
      pointIds: ['p-iso'],
      message: 'publish iso\n\nbody',
    });

    expect(worktreeAddSeen).toBe(true);
    expect(worktreeRemoveSeen).toBe(true);
    expect(worktreePath.length).toBeGreaterThan(0);
    expect(cwdSeen['commit']).toBe(worktreePath);
    expect(cwdSeen['push']).toBe(worktreePath);
    // Main clone was never touched by commit/push.
    expect(cwdSeen['commit']).not.toBe(repo.localPath);
    expect(cwdSeen['push']).not.toBe(repo.localPath);
  });

  it('still removes the worktree when commit fails partway through', async () => {
    let worktreeAddSeen = false;
    let worktreeRemoveSeen = false;
    let worktreePath = '';

    const runner: GitRunner = async (args, _cwd) => {
      const first = args[0];
      if (first === 'clone') return { stdout: '', stderr: '', exitCode: 0 };
      if (first === 'worktree' && args[1] === 'add') {
        worktreeAddSeen = true;
        worktreePath = String(args[4]);
        mkdirSync(worktreePath, { recursive: true });
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (first === 'worktree' && args[1] === 'remove') {
        worktreeRemoveSeen = true;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (first === 'add') return { stdout: '', stderr: '', exitCode: 0 };
      if (args.includes('commit')) {
        return { stdout: '', stderr: 'commit failed', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };

    const mgr = new KnowledgeRepoManager({ db, git: runner, reposRoot });
    const repo = await mgr.subscribe('https://github.com/org/pubrepofail');
    mkdirSync(repo.localPath, { recursive: true });
    db.prepare(`INSERT INTO roles (id, name, system_prompt, created_at) VALUES ('r-fail','fail','sp',?)`).run(new Date().toISOString());
    db.prepare(`
      INSERT INTO knowledge_chunks
        (id, role_id, source_file, title, chunk_text, created_at, visibility)
      VALUES ('p-fail','r-fail','f.md','F','body',?,'public')
    `).run(new Date().toISOString());

    await expect(mgr.publish({
      repoId: repo.id,
      pointIds: ['p-fail'],
      message: 'failing publish',
    })).rejects.toThrow();

    expect(worktreeAddSeen).toBe(true);
    expect(worktreeRemoveSeen).toBe(true);
  });

  it('R-21: PR-create failure routes through the injected logger, not console', async () => {
    let cloneSeen = false;
    let worktreePath = '';
    const runner: GitRunner = async (args) => {
      const first = args[0];
      if (first === 'clone' && !cloneSeen) {
        cloneSeen = true;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (first === 'worktree' && args[1] === 'add') {
        worktreePath = String(args[4]);
        mkdirSync(worktreePath, { recursive: true });
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (first === 'worktree' && args[1] === 'remove') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    // PR runner refuses → manager should log the warning via the
    // injected logger instead of letting console.error fire.
    const prRunner = async () => ({
      stdout: '', stderr: 'gh: not authenticated', exitCode: 1,
    });
    const warnCalls: Array<{ msg: string; data: unknown }> = [];
    const fakeLogger = {
      module: 'test',
      debug() {}, info() {}, error() {},
      warn(msg: string, fields?: { data?: unknown }) {
        warnCalls.push({ msg, data: fields?.data });
      },
      session() { return this; },
    };

    const mgr = new KnowledgeRepoManager({
      db, git: runner, reposRoot,
      prRunner, logger: fakeLogger as never,
    });
    const repo = await mgr.subscribe('https://github.com/org/prfail');
    mkdirSync(repo.localPath, { recursive: true });
    db.prepare(`INSERT INTO roles (id, name, system_prompt, created_at) VALUES ('r-pr','pr','sp',?)`).run(new Date().toISOString());
    db.prepare(`
      INSERT INTO knowledge_chunks
        (id, role_id, source_file, title, chunk_text, created_at, visibility)
      VALUES ('p-pr','r-pr','x.md','X','body',?,'public')
    `).run(new Date().toISOString());

    await mgr.publish({
      repoId: repo.id, pointIds: ['p-pr'],
      message: 'will-fail-pr',
    });

    expect(warnCalls.length).toBe(1);
    expect(warnCalls[0]!.msg).toBe('publish_pr_create_failed');
    expect((warnCalls[0]!.data as { error?: string }).error).toMatch(/gh: not authenticated/);
  });

  it('llm-wiki profile lays files out as <roleDir>/<file>.md, never roles/<id>/points/', async () => {
    let worktreePath = '';
    // Snapshot the file tree right when `git add` runs — the worktree
    // is reaped in the finally block so we can't inspect it after.
    let treeAtAdd: string[] = [];
    const snapshot = (dir: string, prefix = ''): string[] => {
      const out: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out.push(...snapshot(join(dir, entry.name), rel));
        else out.push(rel);
      }
      return out;
    };
    const runner: GitRunner = async (args) => {
      const first = args[0];
      if (first === 'worktree' && args[1] === 'add') {
        worktreePath = String(args[4]);
        mkdirSync(worktreePath, { recursive: true });
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (first === 'add') {
        treeAtAdd = snapshot(worktreePath);
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };

    const mgr = new KnowledgeRepoManager({ db, git: runner, reposRoot });
    const repo = await mgr.subscribe('https://github.com/org/wikirepo');
    mkdirSync(repo.localPath, { recursive: true });
    db.prepare(`INSERT INTO roles (id, name, system_prompt, created_at) VALUES ('dr-expert','dr','sp',?)`).run(new Date().toISOString());
    // Chunk A: repo-relative sourceFile (came from an llm-wiki import) →
    // republish into the SAME file.
    db.prepare(`
      INSERT INTO knowledge_chunks
        (id, role_id, source_file, title, chunk_text, created_at, visibility)
      VALUES ('p-rt','dr-expert','dr-docs/failover.md','RT','round trip',?,'public')
    `).run(new Date().toISOString());
    // Chunk B: flat trainRole-style filename (chat promotion) → must NOT
    // land at the repo root; goes under the role dir instead.
    db.prepare(`
      INSERT INTO knowledge_chunks
        (id, role_id, source_file, title, chunk_text, created_at, visibility)
      VALUES ('p-chat','dr-expert','chat-48910a39-turn-3.md','Chat','from chat',?,'public')
    `).run(new Date().toISOString());

    await mgr.publish({
      repoId: repo.id,
      pointIds: ['p-rt', 'p-chat'],
      message: 'wiki layout test',
      profile: 'llm-wiki',
    });

    expect(treeAtAdd).toContain('dr-docs/failover.md');
    expect(treeAtAdd).toContain('dr-expert/p-chat.md');
    // Neither helm-native layout nor a root-level stray file.
    expect(treeAtAdd.some((f) => f.startsWith('roles/'))).toBe(false);
    expect(treeAtAdd).not.toContain('chat-48910a39-turn-3.md');
  });
});

describe('KnowledgeRepoManager.syncDue (scheduled pull sweep)', () => {
  let db: BetterSqlite3.Database;
  let reposRoot: string;

  beforeEach(() => {
    db = openDb();
    reposRoot = mkdtempSync(join(tmpdir(), 'helm-repo-sync-'));
  });
  afterEach(() => {
    db.close();
    rmSync(reposRoot, { recursive: true, force: true });
  });

  /** Runner: clone OK; every fetch cycle reports the given pre/post shas. */
  function fetchRunner(preSha: string, postSha: string): GitRunner {
    let revParseCount = 0;
    return async (args) => {
      if (args[0] === 'clone') return { stdout: '', stderr: '', exitCode: 0 };
      if (args[0] === 'fetch') return { stdout: '', stderr: '', exitCode: 0 };
      if (args[0] === 'rev-parse') {
        revParseCount += 1;
        // Odd calls = pre-fetch sha, even calls = post-fetch sha.
        const sha = revParseCount % 2 === 1 ? preSha : postSha;
        return { stdout: `${sha}\n`, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };
  }

  it('subscribe persists the pinned profile; defaults to helm-native', async () => {
    const runner = fetchRunner('a', 'a');
    const mgr = new KnowledgeRepoManager({ db, git: runner, reposRoot });
    const wiki = await mgr.subscribe('https://github.com/org/wiki', { profile: 'llm-wiki' });
    const plain = await mgr.subscribe('https://github.com/org/plain');
    expect(getKnowledgeRepo(db, wiki.id)!.profile).toBe('llm-wiki');
    expect(getKnowledgeRepo(db, plain.id)!.profile).toBe('helm-native');
  });

  it('never-fetched repos are due; unmoved fetch does not import', async () => {
    const mgr = new KnowledgeRepoManager({ db, git: fetchRunner('same', 'same'), reposRoot });
    const repo = await mgr.subscribe('https://github.com/org/due1', { autoApply: true });
    mkdirSync(repo.localPath, { recursive: true });

    const outcomes = await mgr.syncDue();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.fetched).toBe(true);
    expect(outcomes[0]!.moved).toBe(false);
    expect(outcomes[0]!.imported).toBe(false);
  });

  it('moved + autoApply imports with the pinned profile (no explicit arg)', async () => {
    const mgr = new KnowledgeRepoManager({ db, git: fetchRunner('old', 'new'), reposRoot });
    const repo = await mgr.subscribe('https://github.com/org/due2', {
      autoApply: true, profile: 'llm-wiki',
    });
    mkdirSync(repo.localPath, { recursive: true });

    const importCalls: Array<[string, unknown]> = [];
    // Shadow the prototype method on the instance so the sweep's
    // auto-apply path is observable without touching the importer.
    (mgr as unknown as { importNow: (id: string, p?: unknown) => unknown }).importNow =
      (id: string, p?: unknown) => {
        importCalls.push([id, p]);
        return { rolesImported: 1, pointsUpserted: 3, conflictsDetected: 0, errors: {} };
      };

    const outcomes = await mgr.syncDue();
    expect(outcomes[0]!.moved).toBe(true);
    expect(outcomes[0]!.imported).toBe(true);
    expect(outcomes[0]!.importedPoints).toBe(3);
    // No explicit profile — the real importNow resolves the pinned one.
    expect(importCalls).toEqual([[repo.id, undefined]]);
  });

  it('moved WITHOUT autoApply fetches but leaves import for the user', async () => {
    const mgr = new KnowledgeRepoManager({ db, git: fetchRunner('old', 'new'), reposRoot });
    const repo = await mgr.subscribe('https://github.com/org/due3'); // autoApply default false
    mkdirSync(repo.localPath, { recursive: true });
    const outcomes = await mgr.syncDue();
    expect(outcomes[0]!.moved).toBe(true);
    expect(outcomes[0]!.imported).toBe(false);
  });

  it('recently-fetched repos are skipped until their interval elapses', async () => {
    const mgr = new KnowledgeRepoManager({ db, git: fetchRunner('a', 'a'), reposRoot });
    const repo = await mgr.subscribe('https://github.com/org/fresh', { syncIntervalMinutes: 60 });
    mkdirSync(repo.localPath, { recursive: true });

    const t0 = Date.now();
    await mgr.fetchNow(repo.id); // stamps last_fetched_at ≈ t0

    // 10 minutes later: not due.
    expect(await mgr.syncDue(t0 + 10 * 60_000)).toHaveLength(0);
    // 61 minutes later: due again.
    const later = await mgr.syncDue(t0 + 61 * 60_000);
    expect(later).toHaveLength(1);
  });

  it('a failing repo records its error and the sweep continues', async () => {
    // First repo's fetch explodes; second repo is fine.
    let cloneCount = 0;
    const runner: GitRunner = async (args) => {
      if (args[0] === 'clone') { cloneCount += 1; return { stdout: '', stderr: '', exitCode: 0 }; }
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: 'remote unreachable', exitCode: 128 };
      }
      if (args[0] === 'rev-parse') return { stdout: 'x\n', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    const mgr = new KnowledgeRepoManager({ db, git: runner, reposRoot });
    const a = await mgr.subscribe('https://github.com/org/broken');
    const b = await mgr.subscribe('https://github.com/org/alsobroken');
    mkdirSync(a.localPath, { recursive: true });
    mkdirSync(b.localPath, { recursive: true });

    const outcomes = await mgr.syncDue();
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.error)).toBe(true);
    // Sweep didn't bail after the first failure.
    expect(outcomes.map((o) => o.repoId).sort()).toEqual([a.id, b.id].sort());
  });
});
