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

export interface AddWorktreeOptions {
  /** Existing clone whose .git the worktree attaches to. */
  cwd: string;
  /** Disk location for the new worktree. Parent must exist. */
  worktreePath: string;
  /** Branch to create inside the worktree. */
  branch: string;
  /** Base ref the new branch forks from. Defaults to current HEAD. */
  baseRef?: string;
  /** When true, overwrites an existing branch of the same name. */
  force?: boolean;
}

/**
 * `git worktree add` an ephemeral working tree for an isolated edit.
 * Used by `KnowledgeRepoManager.publish` so file writes + commits never
 * touch the user-facing clone — the next `importNow` reads the same
 * tracked branch the user subscribed to.
 *
 * The companion `removeWorktree` must run in a `finally` so a failed
 * publish doesn't leak the temp directory.
 */
export async function addWorktree(
  run: GitRunner,
  opts: AddWorktreeOptions,
): Promise<void> {
  const args = [
    'worktree', 'add',
    opts.force ? '-B' : '-b', opts.branch,
    opts.worktreePath,
    opts.baseRef ?? 'HEAD',
  ];
  const r = await run(args, opts.cwd);
  if (r.exitCode !== 0) {
    throw new GitCommandError(
      `git worktree add failed: ${r.stderr.slice(0, 512)}`,
      r.stderr, r.exitCode,
    );
  }
}

export async function removeWorktree(
  run: GitRunner,
  cwd: string,
  worktreePath: string,
): Promise<void> {
  const r = await run(['worktree', 'remove', '--force', worktreePath], cwd);
  if (r.exitCode !== 0) {
    throw new GitCommandError(
      `git worktree remove failed: ${r.stderr.slice(0, 512)}`,
      r.stderr, r.exitCode,
    );
  }
}

/**
 * Files-as-truth PR-3: file paths changed between two refs.
 * `git diff --name-only <from> <to>` — used to predict which incoming
 * files would collide with untracked local ones before a merge.
 */
export async function listChangedFiles(
  run: GitRunner,
  cwd: string,
  fromRef: string,
  toRef: string,
): Promise<string[]> {
  const r = await run(['diff', '--name-only', fromRef, toRef], cwd);
  if (r.exitCode !== 0) {
    throw new GitCommandError(
      `git diff --name-only failed: ${r.stderr.slice(0, 512)}`,
      r.stderr, r.exitCode,
    );
  }
  return r.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

export interface PorcelainEntry {
  /** Two-char porcelain XY code, e.g. '??' (untracked) or ' M'. */
  status: string;
  path: string;
}

/**
 * Decode git's C-style quoted path (the `"…"` form): octal byte escapes
 * (\NNN) reassembled into a UTF-8 buffer, plus the common single-char
 * escapes. Only needed when a path still arrives quoted despite
 * core.quotePath=false (genuinely special chars like quote/backslash/control).
 */
export function unquoteGitPath(quoted: string): string {
  const inner = quoted.startsWith('"') && quoted.endsWith('"')
    ? quoted.slice(1, -1) : quoted;
  const bytes: number[] = [];
  const ESC: Record<string, number> = {
    a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92,
  };
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (c !== '\\') {
      for (const b of Buffer.from(c, 'utf8')) bytes.push(b);
      continue;
    }
    const next = inner[i + 1] ?? '';
    if (next >= '0' && next <= '7') {
      bytes.push(parseInt(inner.slice(i + 1, i + 4), 8) & 0xff);
      i += 3;
    } else {
      bytes.push(ESC[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Files-as-truth PR-3: `git status --porcelain -uall [-- pathspec]`.
 * `-uall` matters: without it a fully-untracked directory collapses to
 * one `?? dir/` line and individual captured files are invisible.
 */
export async function statusPorcelain(
  run: GitRunner,
  cwd: string,
  pathspec?: string,
): Promise<PorcelainEntry[]> {
  // core.quotePath=false: without it git renders non-ASCII path bytes as
  // octal escapes inside quotes (e.g. a CJK topic dir → "…/og-\347\275\221…").
  // That octal string then never matches the UTF-8 source_file stored in the
  // index, so every chunk under a Chinese-named topic shows as "未入索引" and
  // gets skipped from personal-sync — and the path renders garbled in the UI.
  // Turning it off makes git emit real UTF-8 paths.
  const args = ['-c', 'core.quotePath=false', 'status', '--porcelain', '-uall'];
  if (pathspec) args.push('--', pathspec);
  const r = await run(args, cwd);
  if (r.exitCode !== 0) {
    throw new GitCommandError(
      `git status --porcelain failed: ${r.stderr.slice(0, 512)}`,
      r.stderr, r.exitCode,
    );
  }
  const out: PorcelainEntry[] = [];
  for (const line of r.stdout.split('\n')) {
    if (line.length < 4) continue;
    const status = line.slice(0, 2);
    let p = line.slice(3);
    // With quotePath=false git only quotes paths with genuinely special
    // chars (quote/backslash/control); our slugs never have those, but
    // unquote defensively so such a path doesn't 404 later.
    if (p.startsWith('"') && p.endsWith('"')) p = unquoteGitPath(p);
    out.push({ status, path: p });
  }
  return out;
}

/**
 * Files-as-truth PR-3: file content at `<ref>:<path>`. Returns null
 * when the path doesn't exist at that ref (instead of throwing) so
 * collision handling can treat "new upstream file" uniformly.
 */
export async function showFileAtRef(
  run: GitRunner,
  cwd: string,
  ref: string,
  relPath: string,
): Promise<string | null> {
  const r = await run(['show', `${ref}:${relPath}`], cwd);
  if (r.exitCode !== 0) return null;
  return r.stdout;
}

/**
 * Files-as-truth PR-3: fast-forward the current branch to `ref`.
 * The subscribed clone never commits locally (captured files stay
 * untracked until publish), so ff-only always applies — unless git
 * refuses because an untracked file would be overwritten, which the
 * caller must clear beforehand (see KnowledgeRepoManager.fetchNow).
 */
export async function mergeFfOnly(
  run: GitRunner,
  cwd: string,
  ref: string,
): Promise<void> {
  const r = await run(['merge', '--ff-only', ref], cwd);
  if (r.exitCode !== 0) {
    throw new GitCommandError(
      `git merge --ff-only ${ref} failed: ${r.stderr.slice(0, 512)}`,
      r.stderr, r.exitCode,
    );
  }
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
