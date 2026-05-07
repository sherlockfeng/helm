/**
 * LarkCliRunner — abstraction over `lark-cli` invocations.
 *
 * The default impl shells out via node:child_process. Tests substitute a
 * fake so we can verify command shape and route fake responses through
 * without touching a real Lark workspace.
 *
 * Two distinct invocation modes:
 *   - `run(args)` — short-lived: send a reply, create a chat. Resolves with
 *     the captured stdout/stderr and exit code.
 *   - `spawn(args)` — long-lived: `event +subscribe`. Returns a handle the
 *     listener controls (read stdout lines, kill, error events).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LARK_CLI_COMMAND_ENV = 'LARK_CLI_COMMAND';

export interface LarkCliRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface LarkCliSpawnHandle {
  /** Kill the underlying process. Idempotent. */
  kill(signal?: NodeJS.Signals): void;
  /** Resolves with exit code when the process exits naturally. */
  exited: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  /** stdout / stderr lines as they arrive (after newline split). */
  onStdoutLine(handler: (line: string) => void): () => void;
  onStderrLine(handler: (line: string) => void): () => void;
  /** Fired on spawn errors (ENOENT, EACCES, …) before the process is alive. */
  onError(handler: (err: Error) => void): () => void;
}

export interface LarkCliRunner {
  run(args: readonly string[], options?: { timeoutMs?: number }): Promise<LarkCliRunResult>;
  spawn(args: readonly string[]): LarkCliSpawnHandle;
}

export interface LarkCliRunnerOptions {
  /** Override the lark-cli executable path. Otherwise resolves from env / node_modules. */
  command?: string;
  /** Override env passed to the subprocess. */
  env?: NodeJS.ProcessEnv;
  /** cwd for the subprocess. */
  cwd?: string;
}

/**
 * Walk up from this compiled module to find `<repo>/node_modules/.bin/lark-cli`.
 * Same trick Phase 33's `defaultHookBinPath()` uses: works from a clone with
 * no global install, and from the dist bundle alike.
 */
function repoLarkCliBin(binName: string): string | null {
  let here: string;
  try {
    here = fileURLToPath(import.meta.url);
  } catch {
    return null;
  }
  let dir = path.dirname(here);
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'node_modules', '.bin', binName);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Phase 37: resolve the `lark-cli` executable path with a sane fallback chain.
 * Old code returned `~/.helm/bin/lark-cli` unconditionally — a path that only
 * existed for packaged installs that bundle lark-cli, breaking every dev who
 * has lark-cli on PATH or in node_modules. Symptom: helm's listener spawned a
 * non-existent path in a tight retry loop, spamming `ENOENT` warnings.
 *
 * Resolution order:
 *   1. options.command (Settings UI's `cliCommand` field)
 *   2. LARK_CLI_COMMAND env var
 *   3. <repo>/node_modules/.bin/lark-cli (works for `pnpm install`-d clones)
 *   4. ~/.helm/bin/lark-cli (packaged install — only if the file exists)
 *   5. Bare `lark-cli` — child_process.spawn falls back to PATH lookup
 */
export function resolveLarkCliCommand(options: LarkCliRunnerOptions = {}): string {
  if (options.command && options.command.trim()) return options.command.trim();
  const env = options.env ?? process.env;
  const fromEnv = String(env[LARK_CLI_COMMAND_ENV] ?? '').trim();
  if (fromEnv) return fromEnv;

  const binName = process.platform === 'win32' ? 'lark-cli.cmd' : 'lark-cli';

  const repoBin = repoLarkCliBin(binName);
  if (repoBin) return repoBin;

  // Packaged-install fallback: only return this path if the file actually
  // exists. Previously returned unconditionally, which broke every dev.
  const packagedBin = path.join(homedir(), '.helm', 'bin', binName);
  if (existsSync(packagedBin)) return packagedBin;

  // Bare command — relies on PATH lookup at spawn time. Faster than calling
  // `which` ourselves; child_process.spawn does the work natively.
  return binName;
}

/**
 * Buffer chunks until \n, emit completed lines.
 *
 * Used by both stdout and stderr paths in the spawn() handle.
 */
function makeLineSplitter(emit: (line: string) => void): (chunk: Buffer | string) => void {
  let buffer = '';
  return (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      // Trim trailing CR for Windows-spawned lark-cli.
      emit(line.endsWith('\r') ? line.slice(0, -1) : line);
      nl = buffer.indexOf('\n');
    }
  };
}

export function createLarkCliRunner(options: LarkCliRunnerOptions = {}): LarkCliRunner {
  const command = resolveLarkCliCommand(options);
  const env = options.env ?? process.env;
  const cwd = options.cwd;

  return {
    async run(args, runOptions = {}): Promise<LarkCliRunResult> {
      return new Promise((resolve, reject) => {
        const child = spawn(command, [...args], { env, cwd });
        let stdout = '';
        let stderr = '';
        let timer: NodeJS.Timeout | undefined;

        if (runOptions.timeoutMs) {
          timer = setTimeout(() => {
            child.kill('SIGTERM');
            reject(new Error(`lark-cli timeout after ${runOptions.timeoutMs}ms: ${args.join(' ')}`));
          }, runOptions.timeoutMs);
          timer.unref?.();
        }

        child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
        child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
        child.on('error', (err) => {
          if (timer) clearTimeout(timer);
          reject(err);
        });
        child.on('close', (exitCode) => {
          if (timer) clearTimeout(timer);
          resolve({ stdout, stderr, exitCode });
        });
      });
    },

    spawn(args): LarkCliSpawnHandle {
      let child: ChildProcess;
      try {
        child = spawn(command, [...args], { env, cwd });
      } catch (err) {
        // Synchronous spawn failure (rare; usually surfaces via 'error' event).
        const fakeHandle: LarkCliSpawnHandle = {
          kill: () => {},
          exited: Promise.resolve({ exitCode: -1, signal: null }),
          onStdoutLine: () => () => {},
          onStderrLine: () => () => {},
          onError: (h) => { queueMicrotask(() => h(err as Error)); return () => {}; },
        };
        return fakeHandle;
      }

      const stdoutHandlers = new Set<(line: string) => void>();
      const stderrHandlers = new Set<(line: string) => void>();
      const errorHandlers = new Set<(err: Error) => void>();

      const outSplit = makeLineSplitter((line) => {
        for (const h of [...stdoutHandlers]) {
          try { h(line); } catch { /* ignore */ }
        }
      });
      const errSplit = makeLineSplitter((line) => {
        for (const h of [...stderrHandlers]) {
          try { h(line); } catch { /* ignore */ }
        }
      });
      child.stdout?.on('data', outSplit);
      child.stderr?.on('data', errSplit);
      child.on('error', (err) => {
        for (const h of [...errorHandlers]) {
          try { h(err); } catch { /* ignore */ }
        }
      });

      const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on('close', (exitCode, signal) => resolve({ exitCode, signal }));
      });

      let killed = false;
      return {
        kill(signal: NodeJS.Signals = 'SIGTERM'): void {
          if (killed) return;
          killed = true;
          try { child.kill(signal); } catch { /* already gone */ }
        },
        exited,
        onStdoutLine(h): () => void { stdoutHandlers.add(h); return () => { stdoutHandlers.delete(h); }; },
        onStderrLine(h): () => void { stderrHandlers.add(h); return () => { stderrHandlers.delete(h); }; },
        onError(h): () => void { errorHandlers.add(h); return () => { errorHandlers.delete(h); }; },
      };
    },
  };
}
