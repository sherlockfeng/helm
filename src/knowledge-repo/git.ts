/**
 * Git subprocess wrapper (PR 5.5a / design §7.7).
 *
 * Helm uses the system `git` binary rather than bundling its own
 * library. Pros: matches user credentials (SSH keys, gh credential
 * helper, gitconfig) without extra setup; cons: every command needs
 * exec-mode plumbing, and we can't rely on libgit2 niceties like
 * "fetch one branch and prune deleted refs". The shape here keeps to
 * exactly what the §7.3 sync protocol needs:
 *
 *   - cloneRepo: shallow git clone of a fresh subscription
 *   - fetchRepo: git fetch + read the post-fetch HEAD of `branch`
 *   - revParseHead: read the current HEAD without a network round-trip
 *
 * Each helper takes a `git` callable so tests can inject a mock without
 * spawning a child process. Production binds to a node:child_process
 * runner that returns the captured stdout/stderr.
 */

import type { GitRunResult } from './git-runner.js';

export type GitRunner = (args: readonly string[], cwd?: string) => Promise<GitRunResult>;

export class GitCommandError extends Error {
  override readonly name = 'GitCommandError';
  constructor(
    msg: string,
    public readonly stderr: string,
    public readonly exitCode: number,
  ) {
    super(msg);
  }
}

export interface CloneOptions {
  /** Where the clone lands on disk. Parent dir must exist. */
  targetDir: string;
  /** Default 1 — shallow clone keeps the disk + bandwidth budget tight. */
  depth?: number;
  /** Optional branch to clone directly (saves a checkout step). */
  branch?: string;
}

export async function cloneRepo(
  run: GitRunner,
  url: string,
  opts: CloneOptions,
): Promise<void> {
  const args = [
    'clone', '--quiet',
    ...(opts.depth ? ['--depth', String(opts.depth)] : []),
    ...(opts.branch ? ['--branch', opts.branch] : []),
    url, opts.targetDir,
  ];
  const r = await run(args);
  if (r.exitCode !== 0) {
    throw new GitCommandError(
      `git clone failed: ${r.stderr.slice(0, 512)}`,
      r.stderr, r.exitCode,
    );
  }
}

export interface FetchOptions {
  /** Working directory of the existing clone. */
  cwd: string;
  /** Branch we want to read after the fetch. Defaults to 'main'. */
  branch?: string;
  /** Remote name; almost always 'origin'. */
  remote?: string;
}

export interface FetchResult {
  /** Commit SHA the branch points at AFTER the fetch. */
  headSha: string;
  /**
   * SHA the branch pointed at BEFORE the fetch. `undefined` on the
   * first fetch after a clone (we have nothing to compare to).
   */
  previousSha?: string;
  /** Whether the fetch moved the branch forward. */
  moved: boolean;
}

/**
 * Run `git fetch <remote> <branch>` and report the before / after SHAs
 * so the manager can decide whether to apply changes.
 *
 * On networking errors the underlying GitCommandError bubbles up; the
 * caller (manager) catches and flips the row to status='error' with
 * the captured stderr.
 */
export async function fetchRepo(
  run: GitRunner,
  opts: FetchOptions,
): Promise<FetchResult> {
  const branch = opts.branch ?? 'main';
  const remote = opts.remote ?? 'origin';
  const cwd = opts.cwd;
  // Pre-fetch HEAD — `previousSha` is undefined when the ref doesn't
  // exist yet (fresh clone).
  const pre = await run(['rev-parse', `${remote}/${branch}`], cwd);
  const previousSha = pre.exitCode === 0 ? pre.stdout.trim() : undefined;

  const fetched = await run(['fetch', '--quiet', remote, branch], cwd);
  if (fetched.exitCode !== 0) {
    throw new GitCommandError(
      `git fetch failed: ${fetched.stderr.slice(0, 512)}`,
      fetched.stderr, fetched.exitCode,
    );
  }
  const post = await run(['rev-parse', `${remote}/${branch}`], cwd);
  if (post.exitCode !== 0) {
    throw new GitCommandError(
      `git rev-parse after fetch failed: ${post.stderr.slice(0, 512)}`,
      post.stderr, post.exitCode,
    );
  }
  const headSha = post.stdout.trim();
  return {
    headSha,
    ...(previousSha ? { previousSha } : {}),
    moved: previousSha !== undefined && previousSha !== headSha,
  };
}

/**
 * Read the current HEAD without touching the network. Used by the
 * sync loop to decide whether the local state already matches a
 * previously-recorded `last_fetched_sha`.
 */
export async function revParseHead(
  run: GitRunner,
  cwd: string,
  ref = 'HEAD',
): Promise<string> {
  const r = await run(['rev-parse', ref], cwd);
  if (r.exitCode !== 0) {
    throw new GitCommandError(
      `git rev-parse ${ref} failed: ${r.stderr.slice(0, 512)}`,
      r.stderr, r.exitCode,
    );
  }
  return r.stdout.trim();
}
