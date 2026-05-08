/**
 * `ClaudeCodeAgent` — drives `claude -p` per turn for the role-trainer
 * (Phase 60b). Tests pin the contract WITHOUT spawning real claude:
 *   - args sent to the subprocess (--mcp-config injection,
 *     --strict-mcp-config default, --append-system-prompt forwarding)
 *   - tmp MCP-config file content
 *   - `dispose()` cleans up the tmpdir
 *   - transcript serialization keeps the last user msg as the active prompt
 *
 * The exec function is stubbed; the real claude binary is never invoked.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAgent, serializeTranscript, detectClaudeCli } from '../../../src/cli-agent/claude.js';

interface RecordedSpawn {
  bin: string;
  args: readonly string[];
  options?: unknown;
}

function makeStubExec(stdout = 'ok', stderr = '') {
  const spawns: RecordedSpawn[] = [];
  const exec = async (
    bin: string,
    args: readonly string[],
    options?: unknown,
  ): Promise<{ stdout: string; stderr: string }> => {
    spawns.push({ bin, args, options });
    return { stdout, stderr };
  };
  return { exec, spawns };
}

let tmpHomeDir: string;

beforeEach(() => {
  // Each test creates the agent which mkdtempSyncs into the system tmp.
  // Track stale dirs so afterEach can sanity-clean.
  tmpHomeDir = mkdtempSync(join(tmpdir(), 'helm-claude-test-cwd-'));
});

afterEach(() => {
  rmSync(tmpHomeDir, { recursive: true, force: true });
});

describe('ClaudeCodeAgent — sendConversation args', () => {
  it('passes --print --output-format text --mcp-config <tmpfile> --strict-mcp-config + transcript', async () => {
    const stub = makeStubExec('hello back');
    const agent = new ClaudeCodeAgent({
      cwd: tmpHomeDir,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: stub.exec as any,
    });

    const result = await agent.sendConversation([
      { role: 'user', content: 'hi' },
    ]);
    expect(result.text).toBe('hello back');

    expect(stub.spawns).toHaveLength(1);
    const { bin, args } = stub.spawns[0]!;
    expect(bin).toBe('claude');
    expect(args).toContain('--print');
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('text');
    expect(args).toContain('--mcp-config');
    expect(args).toContain('--strict-mcp-config');
    // The transcript ("hi") MUST be the last arg so claude treats it as the
    // active prompt, not a flag.
    expect(args[args.length - 1]).toBe('hi');

    agent.dispose();
  });

  it('writes a tmp MCP-config file containing the helm SSE entry', async () => {
    const stub = makeStubExec();
    const agent = new ClaudeCodeAgent({
      cwd: tmpHomeDir,
      helmMcpUrl: 'http://127.0.0.1:9999/mcp/sse',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: stub.exec as any,
    });

    await agent.sendConversation([{ role: 'user', content: 'hi' }]);
    const { args } = stub.spawns[0]!;
    const mcpFlag = args.indexOf('--mcp-config');
    const path = args[mcpFlag + 1]!;
    expect(existsSync(path)).toBe(true);
    const json = JSON.parse(readFileSync(path, 'utf8'));
    expect(json.mcpServers.helm).toEqual({
      type: 'sse',
      url: 'http://127.0.0.1:9999/mcp/sse',
    });

    agent.dispose();
    expect(existsSync(path)).toBe(false);
  });

  it('forwards systemPrompt via --append-system-prompt', async () => {
    const stub = makeStubExec();
    const agent = new ClaudeCodeAgent({
      cwd: tmpHomeDir,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: stub.exec as any,
    });

    await agent.sendConversation(
      [{ role: 'user', content: 'hi' }],
      { systemPrompt: 'You are a role coach.' },
    );

    const { args } = stub.spawns[0]!;
    const flagIdx = args.indexOf('--append-system-prompt');
    expect(flagIdx).toBeGreaterThan(-1);
    expect(args[flagIdx + 1]).toBe('You are a role coach.');

    agent.dispose();
  });

  it('omits --strict-mcp-config when allowGlobalMcp is set', async () => {
    const stub = makeStubExec();
    const agent = new ClaudeCodeAgent({
      cwd: tmpHomeDir,
      allowGlobalMcp: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: stub.exec as any,
    });
    await agent.sendConversation([{ role: 'user', content: 'hi' }]);
    expect(stub.spawns[0]!.args).not.toContain('--strict-mcp-config');
    expect(stub.spawns[0]!.args).toContain('--mcp-config');
    agent.dispose();
  });

  it('attack: empty messages array → throws synchronously', async () => {
    const stub = makeStubExec();
    const agent = new ClaudeCodeAgent({
      cwd: tmpHomeDir,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: stub.exec as any,
    });
    await expect(agent.sendConversation([])).rejects.toThrow(/empty messages/);
    agent.dispose();
  });

  it('attack: last message must be user (assistant-last is rejected)', async () => {
    const stub = makeStubExec();
    const agent = new ClaudeCodeAgent({
      cwd: tmpHomeDir,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: stub.exec as any,
    });
    await expect(agent.sendConversation([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ])).rejects.toThrow(/last message must be from user/);
    agent.dispose();
  });

  it('dispose() removes the tmp MCP-config dir; second call is a no-op', async () => {
    const stub = makeStubExec();
    const agent = new ClaudeCodeAgent({
      cwd: tmpHomeDir,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: stub.exec as any,
    });
    await agent.sendConversation([{ role: 'user', content: 'hi' }]);
    const path = stub.spawns[0]!.args[stub.spawns[0]!.args.indexOf('--mcp-config') + 1]!;
    expect(statSync(path).isFile()).toBe(true);

    agent.dispose();
    expect(existsSync(path)).toBe(false);
    // Second dispose is harmless.
    expect(() => agent.dispose()).not.toThrow();
  });
});

describe('serializeTranscript', () => {
  it('single user message → just the content', () => {
    expect(serializeTranscript([{ role: 'user', content: 'hi' }])).toBe('hi');
  });

  it('user/assistant/user → prior turns labeled, last user as raw prompt at end', () => {
    const out = serializeTranscript([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'tell me about Goofy' },
    ]);
    expect(out).toContain('User: hi');
    expect(out).toContain('Assistant: hello');
    expect(out).toContain('---');
    // Active prompt sits at the end without a label so claude treats it as
    // the live question.
    expect(out.endsWith('tell me about Goofy')).toBe(true);
  });
});

describe('detectClaudeCli', () => {
  it('returns the version when the probe succeeds', async () => {
    const exec = async () => ({ stdout: 'claude 1.2.3\n', stderr: '' });
    const r = await detectClaudeCli({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: exec as any,
    });
    expect(r).toEqual({ version: 'claude 1.2.3' });
  });

  it('returns null when the probe throws (claude not installed)', async () => {
    const exec = async () => { throw new Error('ENOENT'); };
    const r = await detectClaudeCli({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: exec as any,
    });
    expect(r).toBeNull();
  });
});
