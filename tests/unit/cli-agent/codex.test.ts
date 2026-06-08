/**
 * `CodexCliAgent` — drives `codex exec` per turn. Same shape as the
 * claude tests; the stub exec captures the spawned argv + writes the
 * canned response to the --output-last-message tmpfile so the agent's
 * post-exec read returns the expected text.
 *
 * Pinned contract:
 *   - `exec` subcommand + safety flags (-s read-only, -a never,
 *     --ignore-user-config, --skip-git-repo-check)
 *   - --output-last-message <tmpfile> so the response is extracted
 *     from disk, not stdout (codex's stdout is JSONL events when
 *     --json is set; we don't set --json, but the contract still
 *     uses the tmpfile so future --json flips don't break us)
 *   - -c mcp_servers.helm.url="…" for the per-spawn MCP injection
 *   - -m <model> when configured
 *   - transcript serialization keeps the last user msg as the
 *     active prompt; [System]-prefixed when a system prompt is given
 *   - dispose() removes the tmp dir
 */

import { writeFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CodexCliAgent,
  detectCodexCli,
  interpretCodexError,
  serializeCodexPrompt,
} from '../../../src/cli-agent/codex.js';

interface RecordedSpawn {
  bin: string;
  args: readonly string[];
  options?: unknown;
}

/** Stub that captures the spawn AND writes the canned response into
 *  the --output-last-message tmpfile so the agent's readFileSync sees it. */
function makeStubExec(lastMessage = 'ok', stderr = '') {
  const spawns: RecordedSpawn[] = [];
  const exec = async (
    bin: string,
    args: readonly string[],
    options?: unknown,
  ): Promise<{ stdout: string; stderr: string }> => {
    spawns.push({ bin, args, options });
    const oIdx = args.indexOf('-o');
    if (oIdx >= 0 && oIdx + 1 < args.length) {
      writeFileSync(args[oIdx + 1]!, lastMessage);
    }
    return { stdout: '', stderr };
  };
  return { exec, spawns };
}

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'helm-codex-test-cwd-'));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('CodexCliAgent.sendConversation', () => {
  it('spawns codex exec with safety flags + --output-last-message + MCP url override', async () => {
    const stub = makeStubExec('hello back');
    const agent = new CodexCliAgent({
      cwd,
      helmMcpUrl: 'http://127.0.0.1:9999/mcp/sse',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: stub.exec as any,
    });
    const result = await agent.sendConversation([{ role: 'user', content: 'hi' }]);
    expect(result.text).toBe('hello back');

    const { bin, args } = stub.spawns[0]!;
    expect(bin).toBe('codex');
    expect(args[0]).toBe('exec');
    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('--skip-git-repo-check');
    // Sandbox + approval — adapter ships read-only / never to keep
    // codex from escalating or writing during helm subprocess use.
    expect(args[args.indexOf('-s') + 1]).toBe('read-only');
    expect(args[args.indexOf('-a') + 1]).toBe('never');
    // --output-last-message file is passed AND the file exists post-spawn.
    const oIdx = args.indexOf('-o');
    expect(oIdx).toBeGreaterThanOrEqual(0);
    expect(existsSync(args[oIdx + 1]!)).toBe(true);
    // MCP URL injected via -c override (no touching ~/.codex/config.toml).
    const cIdx = args.indexOf('-c');
    expect(args[cIdx + 1]).toBe('mcp_servers.helm.url="http://127.0.0.1:9999/mcp/sse"');
    // -C cwd matches the spawn cwd.
    expect(args[args.indexOf('-C') + 1]).toBe(cwd);
    // Prompt is the last arg (codex exec treats trailing positional as prompt).
    expect(args[args.length - 1]).toBe('hi');

    agent.dispose();
  });

  it('passes -m <model> only when configured', async () => {
    const stub = makeStubExec();
    const agent = new CodexCliAgent({ cwd, model: 'gpt-5.1', exec: stub.exec as never });
    await agent.sendConversation([{ role: 'user', content: 'q' }]);
    const { args } = stub.spawns[0]!;
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.1');
    agent.dispose();

    const stub2 = makeStubExec();
    const agent2 = new CodexCliAgent({ cwd, exec: stub2.exec as never });
    await agent2.sendConversation([{ role: 'user', content: 'q' }]);
    expect(stub2.spawns[0]!.args).not.toContain('-m');
    agent2.dispose();
  });

  it('serializes prior turns + prepends [System] block when systemPrompt is set', async () => {
    const stub = makeStubExec();
    const agent = new CodexCliAgent({ cwd, exec: stub.exec as never });
    await agent.sendConversation(
      [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
        { role: 'user', content: 'what time is it?' },
      ],
      { systemPrompt: 'be terse' },
    );
    const finalArg = stub.spawns[0]!.args[stub.spawns[0]!.args.length - 1]!;
    expect(finalArg.startsWith('[System]\nbe terse')).toBe(true);
    expect(finalArg).toContain('User: hello');
    expect(finalArg).toContain('Assistant: hi there');
    // Last user message lands at the end without a label so codex
    // treats it as the active prompt.
    expect(finalArg.endsWith('what time is it?')).toBe(true);
    agent.dispose();
  });

  it('dispose() removes the tmp dir', async () => {
    const stub = makeStubExec();
    const agent = new CodexCliAgent({ cwd, exec: stub.exec as never });
    await agent.sendConversation([{ role: 'user', content: 'q' }]);
    // Find the tmp dir codex-prefix from the captured -o path.
    const oArg = stub.spawns[0]!.args[stub.spawns[0]!.args.indexOf('-o') + 1]!;
    const dir = oArg.replace(/\/last-[^/]+$/, '');
    expect(readdirSync(dir).length).toBeGreaterThan(0);
    agent.dispose();
    expect(existsSync(dir)).toBe(false);
  });
});

describe('serializeCodexPrompt', () => {
  it('single user turn → just the body', () => {
    expect(serializeCodexPrompt([{ role: 'user', content: 'hi' }])).toBe('hi');
  });
  it('with prior turns + system → [System] header + labels + trailing body', () => {
    const out = serializeCodexPrompt(
      [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
      ],
      'sys',
    );
    expect(out).toBe('[System]\nsys\n\n---\n\nUser: q1\n\nAssistant: a1\n\n---\n\nq2');
  });
});

describe('interpretCodexError', () => {
  it('ENOENT → install hint', () => {
    const i = interpretCodexError(Object.assign(new Error('spawn codex ENOENT'), {
      code: 'ENOENT',
    }));
    expect(i.hint).toBe('install');
    expect(i.message).toMatch(/codex CLI not found/);
  });

  it('login required → login hint', () => {
    const i = interpretCodexError({
      message: 'failed', stderr: 'Error: please log in to continue', stdout: '',
    });
    expect(i.hint).toBe('login');
    expect(i.message).toMatch(/codex login/);
  });

  it('unknown stderr → passthrough', () => {
    const i = interpretCodexError({ message: 'weird', stderr: 'huh', stdout: '' });
    expect(i.hint).toBe('unknown');
    expect(i.message).toBe('weird');
  });
});

describe('detectCodexCli', () => {
  it('returns version when --version succeeds', async () => {
    const exec = (async () => ({ stdout: 'codex-cli 0.136.0\n', stderr: '' })) as never;
    const r = await detectCodexCli({ exec });
    expect(r).toEqual({ version: 'codex-cli 0.136.0' });
  });

  it('returns null when --version throws', async () => {
    const exec = (async () => { throw new Error('ENOENT'); }) as never;
    const r = await detectCodexCli({ exec });
    expect(r).toBeNull();
  });
});
