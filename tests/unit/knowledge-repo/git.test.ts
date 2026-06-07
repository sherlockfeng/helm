/**
 * Unit tests for the git subprocess wrapper (PR 5.5a.3).
 *
 * No real git process spawned — every call goes through an injected
 * GitRunner so the matrix is deterministic.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  GitCommandError,
  cloneRepo,
  fetchRepo,
  revParseHead,
  type GitRunner,
} from '../../../src/knowledge-repo/git.js';

interface ScriptedCall {
  /** Predicate matching the args list — first match wins. */
  match: (args: readonly string[], cwd?: string) => boolean;
  result: { stdout?: string; stderr?: string; exitCode?: number };
}

function scriptedRunner(scripts: ScriptedCall[]): GitRunner & { calls: Array<{ args: readonly string[]; cwd?: string }> } {
  const calls: Array<{ args: readonly string[]; cwd?: string }> = [];
  const fn = ((args, cwd) => {
    calls.push({ args, cwd });
    const m = scripts.find((s) => s.match(args, cwd));
    if (!m) throw new Error(`no script for args=${JSON.stringify(args)}`);
    return Promise.resolve({
      stdout: m.result.stdout ?? '',
      stderr: m.result.stderr ?? '',
      exitCode: m.result.exitCode ?? 0,
    });
  }) as GitRunner & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

describe('cloneRepo', () => {
  it('calls git clone with --quiet and --depth + --branch when set', async () => {
    const run = scriptedRunner([{
      match: (args) => args[0] === 'clone',
      result: { exitCode: 0 },
    }]);
    await cloneRepo(run, 'https://github.com/org/repo', {
      targetDir: '/tmp/x', branch: 'main', depth: 1,
    });
    expect(run.calls[0]!.args).toEqual([
      'clone', '--quiet', '--depth', '1', '--branch', 'main',
      'https://github.com/org/repo', '/tmp/x',
    ]);
  });

  it('throws GitCommandError with stderr + exitCode on failure', async () => {
    const run = scriptedRunner([{
      match: (args) => args[0] === 'clone',
      result: { exitCode: 128, stderr: 'fatal: repo not found' },
    }]);
    try {
      await cloneRepo(run, 'bad', { targetDir: '/tmp/y' });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GitCommandError);
      const e = err as GitCommandError;
      expect(e.exitCode).toBe(128);
      expect(e.stderr).toMatch(/repo not found/);
    }
  });
});

describe('fetchRepo', () => {
  it('captures pre + post SHAs and computes `moved`', async () => {
    const run = scriptedRunner([
      { match: (args) => args[0] === 'rev-parse' && args[1] === 'origin/main' && false,
        result: { stdout: '' } },
      // First call is the pre-fetch rev-parse → returns SHA-pre
      { match: (args, _) => args[0] === 'rev-parse' && args[1] === 'origin/main',
        result: { stdout: 'sha-pre\n' } },
      { match: (args) => args[0] === 'fetch',
        result: { exitCode: 0 } },
      // Second rev-parse is the post-fetch one. We append after the
      // fetch script so the scriptedRunner finds the next entry.
    ]);
    // Override: scriptedRunner first-match-wins means we need a more
    // sophisticated mock for the two rev-parse calls. Roll a quick
    // sequence-based runner instead.
    const seq = [
      { stdout: 'sha-pre\n', exitCode: 0 },   // pre rev-parse
      { stdout: '', exitCode: 0 },             // fetch
      { stdout: 'sha-post\n', exitCode: 0 },  // post rev-parse
    ];
    let i = 0;
    const seqRun: GitRunner = async () => {
      const r = seq[i++]!;
      return { stdout: r.stdout, stderr: '', exitCode: r.exitCode };
    };
    const out = await fetchRepo(seqRun, { cwd: '/tmp', branch: 'main' });
    expect(out.previousSha).toBe('sha-pre');
    expect(out.headSha).toBe('sha-post');
    expect(out.moved).toBe(true);
    // Touch the run + script bindings so the lint stays quiet.
    void run;
  });

  it('moved=false when before === after', async () => {
    const seq = [
      { stdout: 'sha-same\n', exitCode: 0 },
      { stdout: '', exitCode: 0 },
      { stdout: 'sha-same\n', exitCode: 0 },
    ];
    let i = 0;
    const seqRun: GitRunner = async () => {
      const r = seq[i++]!;
      return { stdout: r.stdout, stderr: '', exitCode: r.exitCode };
    };
    const out = await fetchRepo(seqRun, { cwd: '/tmp' });
    expect(out.moved).toBe(false);
  });

  it('moved=false and previousSha undefined on fresh clone (first fetch)', async () => {
    const seq = [
      { stdout: '', stderr: 'unknown ref', exitCode: 128 },
      { stdout: '', exitCode: 0 },
      { stdout: 'sha-first\n', exitCode: 0 },
    ];
    let i = 0;
    const seqRun: GitRunner = async () => {
      const r = seq[i++]!;
      return { stdout: r.stdout, stderr: r.stderr ?? '', exitCode: r.exitCode };
    };
    const out = await fetchRepo(seqRun, { cwd: '/tmp' });
    expect(out.previousSha).toBeUndefined();
    expect(out.headSha).toBe('sha-first');
    expect(out.moved).toBe(false);
  });

  it('throws GitCommandError when the fetch itself fails', async () => {
    const seq = [
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: 'network down', exitCode: 1 },
    ];
    let i = 0;
    const seqRun: GitRunner = async () => {
      const r = seq[i++]!;
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
    };
    try {
      await fetchRepo(seqRun, { cwd: '/tmp' });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GitCommandError);
    }
  });
});

describe('revParseHead', () => {
  it('returns the trimmed sha on success', async () => {
    const run: GitRunner = async () => ({ stdout: 'sha-abc\n', stderr: '', exitCode: 0 });
    expect(await revParseHead(run, '/tmp')).toBe('sha-abc');
  });

  it('throws when rev-parse exits non-zero', async () => {
    const run: GitRunner = async () => ({ stdout: '', stderr: 'bad ref', exitCode: 1 });
    try {
      await revParseHead(run, '/tmp');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GitCommandError);
    }
  });

  it('default ref is HEAD; can be overridden', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: 'x\n', stderr: '', exitCode: 0 });
    await revParseHead(run as unknown as GitRunner, '/tmp');
    expect(run.mock.calls[0]![0]).toEqual(['rev-parse', 'HEAD']);
    await revParseHead(run as unknown as GitRunner, '/tmp', 'origin/develop');
    expect(run.mock.calls[1]![0]).toEqual(['rev-parse', 'origin/develop']);
  });
});
