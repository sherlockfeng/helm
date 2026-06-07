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
}

export async function pushBranch(
  run: GitRunner,
  input: PushBranchInput,
): Promise<void> {
  const remote = input.remote ?? 'origin';
  const args = [
    'push',
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
  binary: 'gh' | 'glab',
  args: readonly string[],
  cwd?: string,
) => Promise<GitRunResult>;

export interface CreatePrInput {
  cwd: string;
  /** Either 'github' or 'gitlab'. We pick the matching CLI. */
  platform: 'github' | 'gitlab';
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

/** Resolve which CLI binary to spawn given a parsed host. */
export function pickPlatform(host: string): 'github' | 'gitlab' | null {
  const h = host.toLowerCase();
  if (h === 'github.com') return 'github';
  if (h === 'gitlab.com') return 'gitlab';
  if (h.startsWith('gitlab.')) return 'gitlab';
  // Internal hosts (code.byted.org etc.) typically run gitlab too.
  if (h.endsWith('.byted.org')) return 'gitlab';
  return null;
}
