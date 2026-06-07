/**
 * Concrete PrPlatformRunner backed by node:child_process (PR 5.5d).
 *
 * Spawns either `gh` or `glab` with the requested args. Errors do NOT
 * throw — `exitCode` is the signal, matching the GitRunner contract.
 */

import { spawn } from 'node:child_process';
import type { GitRunResult } from './git-runner.js';
import type { PrPlatformRunner } from './publish.js';

const DEFAULT_TIMEOUT_MS = 60_000;

export interface NodePrRunnerOptions {
  /** Override command lookup ('gh' / 'glab' → custom path). */
  resolveBinary?: (bin: 'gh' | 'glab') => string;
  timeoutMs?: number;
}

export function createNodePrRunner(opts: NodePrRunnerOptions = {}): PrPlatformRunner {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const resolveBinary = opts.resolveBinary ?? ((bin) => bin);
  return (bin, args, cwd) => new Promise<GitRunResult>((resolve) => {
    const command = resolveBinary(bin);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const child = spawn(command, [...args], {
      cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout?.on('data', (b: Buffer) => stdoutChunks.push(b));
    child.stderr?.on('data', (b: Buffer) => stderrChunks.push(b));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout: '', stderr: `spawn failed: ${err.message}`, exitCode: -1 });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode: code ?? -1,
      });
    });
  });
}
