/**
 * Publish wrappers (PR 5.5d).
 *
 * Thin wrappers around `git` and `gh` / `glab` so the manager can push
 * a branch + open a PR without us inlining process plumbing
 * everywhere. Each helper takes a runner so tests stay deterministic.
 */

import type { GitRunner } from './git.js';
import type { GitRunResult } from './git-runner.js';

export class PublishError extends Error {
  override readonly name = 'PublishError';
  constructor(
    msg: string,
    public readonly stage: 'branch' | 'commit' | 'push' | 'pr' | 'precheck',
    public readonly stderr?: string,
  ) {
    super(msg);
  }
}

export interface CreateBranchInput {
  cwd: string;
  branch: string;
  /** If true, --force-create overwrites an existing branch of the same name. */
  force?: boolean;
}

export async function checkoutBranch(
  run: GitRunner,
  input: CreateBranchInput,
): Promise<void> {
  const args = ['checkout', input.force ? '-B' : '-b', input.branch];
  const r = await run(args, input.cwd);
  if (r.exitCode !== 0) {
    throw new PublishError(
      `git checkout ${input.branch} failed: ${r.stderr.slice(0, 512)}`,
      'branch', r.stderr,
    );
  }
}

export async function addAndCommit(
  run: GitRunner,
  cwd: string,
  message: string,
  userOverride?: { name: string; email: string },
): Promise<void> {
  const addRes = await run(['add', '-A'], cwd);
  if (addRes.exitCode !== 0) {
    throw new PublishError(
      `git add failed: ${addRes.stderr.slice(0, 512)}`,
      'commit', addRes.stderr,
    );
  }
  const commitArgs = [
    ...(userOverride
      ? ['-c', `user.name=${userOverride.name}`, '-c', `user.email=${userOverride.email}`]
      : []),
    'commit', '-m', message,
  ];
  const r = await run(commitArgs, cwd);
  if (r.exitCode !== 0) {
    throw new PublishError(
      `git commit failed: ${r.stderr.slice(0, 512)}`,
      'commit', r.stderr,
    );
  }
}

export interface PushBranchInput {
  cwd: string;
  branch: string;
  /** Remote name; defaults to 'origin'. */
  remote?: string;
  /** Set upstream tracking on the first push. */
  setUpstream?: boolean;
  /**
   * Force-update the remote branch. helm regenerates publish branches from the
   * base ref in a fresh worktree on every sync, and the branch name is
   * deterministic (date + hash of the point set). So re-syncing the same
   * content targets a branch that may already exist remotely from a prior
   * attempt — a plain push is then rejected as non-fast-forward. Forcing makes
   * the local regeneration authoritative (it updates the same single MR).
   */
  force?: boolean;
}

export async function pushBranch(
  run: GitRunner,
  input: PushBranchInput,
): Promise<void> {
  const remote = input.remote ?? 'origin';
  const args = [
    'push',
    ...(input.force ? ['--force'] : []),
    ...(input.setUpstream ? ['--set-upstream'] : []),
    remote, input.branch,
  ];
  const r = await run(args, input.cwd);
  if (r.exitCode !== 0) {
    throw new PublishError(
      `git push ${remote} ${input.branch} failed: ${r.stderr.slice(0, 512)}`,
      'push', r.stderr,
    );
  }
}

// ── gh / glab subprocess wrappers ─────────────────────────────────────────

export type PrPlatformRunner = (
  binary: string,
  args: readonly string[],
  cwd?: string,
) => Promise<GitRunResult>;

/**
 * A user-configured MR/PR command for hosts whose CLI isn't gh/glab
 * (knowledge.mrCommand). `bin` + `prefixArgs` front the call; helm appends the
 * standard `--source/--target/--title/--body` flags.
 */
export interface CustomMrCommand {
  bin: string;
  prefixArgs: readonly string[];
}

export interface CreatePrInput {
  cwd: string;
  /** Built-in platform. Omitted when `custom` is provided. */
  platform?: 'github' | 'gitlab';
  /** User-configured MR command; takes precedence over `platform`. */
  custom?: CustomMrCommand;
  title: string;
  body: string;
  /** Branch the PR/MR will land into; defaults to the repo's default. */
  baseBranch?: string;
  /** Head branch — the one carrying the publish work. */
  headBranch: string;
  /** Push the head branch first (--push-now for GitLab via glab). */
  push?: boolean;
}

export interface CreatePrResult {
  /** PR / MR URL returned by the CLI. Empty when we can't parse it. */
  url: string;
}

export async function createPullRequest(
  run: PrPlatformRunner,
  input: CreatePrInput,
): Promise<CreatePrResult> {
  // Custom command (knowledge.mrCommand) wins: append the standard flags and
  // run the user's CLI. No internal tool name is baked into helm.
  if (input.custom) {
    const args = [
      ...input.custom.prefixArgs,
      '--source', input.headBranch,
      ...(input.baseBranch ? ['--target', input.baseBranch] : []),
      '--title', input.title,
      '--body', input.body,
    ];
    const r = await run(input.custom.bin, args, input.cwd);
    if (r.exitCode !== 0) {
      throw new PublishError(
        `${input.custom.bin} mr create failed: ${r.stderr.slice(0, 512)}`,
        'pr', r.stderr,
      );
    }
    return { url: extractAnyMrUrl(r.stdout) };
  }
  if (input.platform === 'github') {
    const args = [
      'pr', 'create',
      '--title', input.title,
      '--body', input.body,
      '--head', input.headBranch,
      ...(input.baseBranch ? ['--base', input.baseBranch] : []),
    ];
    const r = await run('gh', args, input.cwd);
    if (r.exitCode !== 0) {
      throw new PublishError(
        `gh pr create failed: ${r.stderr.slice(0, 512)}`,
        'pr', r.stderr,
      );
    }
    return { url: extractGhPrUrl(r.stdout) };
  }
  // gitlab
  const args = [
    'mr', 'create',
    '--title', input.title,
    '--description', input.body,
    '--source-branch', input.headBranch,
    ...(input.baseBranch ? ['--target-branch', input.baseBranch] : []),
  ];
  const r = await run('glab', args, input.cwd);
  if (r.exitCode !== 0) {
    throw new PublishError(
      `glab mr create failed: ${r.stderr.slice(0, 512)}`,
      'pr', r.stderr,
    );
  }
  return { url: extractGlabMrUrl(r.stdout) };
}

function extractGhPrUrl(stdout: string): string {
  // `gh pr create` returns the URL on its own line at the end.
  const m = stdout.match(/(https?:\/\/[^\s]+\/pull\/\d+)/);
  return m?.[1] ?? '';
}

function extractGlabMrUrl(stdout: string): string {
  const m = stdout.match(/(https?:\/\/[^\s]+\/merge_requests\/\d+)/);
  return m?.[1] ?? '';
}

// Matches an MR/PR URL. Char class excludes quotes/brackets so it stops at JSON
// delimiters — a custom CLI often prints one compact JSON blob (no spaces), and
// a greedy \S+ would swallow the whole thing up to the merge_requests segment.
const MR_URL_RE = /https?:\/\/[^\s"'<>\\)]+\/(?:merge_requests|pull|-\/merge_requests)\/\d+/;

/** Recursively find the first string value matching `re` in parsed JSON. */
function findUrlInJson(value: unknown, re: RegExp): string | null {
  if (typeof value === 'string') return value.match(re)?.[0] ?? null;
  if (Array.isArray(value)) {
    for (const v of value) { const hit = findUrlInJson(v, re); if (hit) return hit; }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) { const hit = findUrlInJson(v, re); if (hit) return hit; }
    return null;
  }
  return null;
}

/** Best-effort URL scrape for a custom MR CLI of unknown output format. */
function extractAnyMrUrl(stdout: string): string {
  // Structured output (codebase / glab-style CLIs print JSON): pull the MR/PR
  // URL field out so we don't surface the whole payload.
  try {
    const hit = findUrlInJson(JSON.parse(stdout.trim()), MR_URL_RE);
    if (hit) return hit;
  } catch { /* not JSON — fall through to regex */ }
  return stdout.match(MR_URL_RE)?.[0]
    ?? stdout.match(/https?:\/\/[^\s"'<>\\)]+/)?.[0]
    ?? '';
}

/**
 * Resolve which built-in CLI to spawn given a parsed host. Returns null for
 * anything that isn't public github/gitlab — those hosts rely on a
 * user-configured `knowledge.mrCommand` instead, which keeps internal host and
 * tool names out of this public repo.
 */
export function pickPlatform(host: string): 'github' | 'gitlab' | null {
  const h = host.toLowerCase();
  if (h === 'github.com') return 'github';
  if (h === 'gitlab.com') return 'gitlab';
  if (h.startsWith('gitlab.')) return 'gitlab';
  return null;
}
