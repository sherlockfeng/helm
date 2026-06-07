/**
 * Concrete GitRunner backed by node:child_process (PR 5.5a).
 *
 * Spawns the system `git` binary, captures stdout + stderr + exit code,
 * and resolves with a typed result. Errors are NEVER thrown — the
 * `exitCode` field is the only signal — so callers can decide whether
 * a non-zero exit is fatal or routine (e.g. `rev-parse` of a non-
 * existent ref is "no baseline yet", not an error).
 */

import { spawn } from 'node:child_process';

export interface GitRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: NodeJS.Signals;
}

export interface NodeGitRunnerOptions {
  /** `git` executable. Default `git`. */
  command?: string;
  /** Per-call timeout (ms). Default 60s. */
  timeoutMs?: number;
  /** Env overrides; merged onto process.env. */
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Returns a runner suitable for production paths. Tests should bind
 * a hand-written runner instead so the suite never spawns a real
 * git subprocess.
 */
export function createNodeGitRunner(opts: NodeGitRunnerOptions = {}) {
  const command = opts.command ?? 'git';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return (args: readonly string[], cwd?: string): Promise<GitRunResult> =>
    new Promise<GitRunResult>((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const child = spawn(command, [...args], {
        cwd,
        env: { ...process.env, ...opts.env },
        // We want fully captured streams without an inherited TTY so
        // tests + headless CI behave identically.
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, timeoutMs);
      child.stdout?.on('data', (b: Buffer) => stdoutChunks.push(b));
      child.stderr?.on('data', (b: Buffer) => stderrChunks.push(b));
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          stdout: '',
          stderr: `spawn failed: ${err.message}`,
          exitCode: -1,
        });
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        const out: GitRunResult = {
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          exitCode: code ?? -1,
        };
        if (signal) out.signal = signal;
        resolve(out);
      });
    });
}
