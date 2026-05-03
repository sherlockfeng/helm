import { Readable, Writable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runHook, parseArgs } from '../../../../src/host/cursor/hook-entry.js';
import { BridgeServer } from '../../../../src/bridge/server.js';
import type { BridgeMessageType } from '../../../../src/bridge/protocol.js';

let tmpDir: string;
let socketPath: string;
let server: BridgeServer | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'helm-hookentry-'));
  socketPath = join(tmpDir, 'bridge.sock');
});

afterEach(async () => {
  if (server) {
    await server.stop();
    server = undefined;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeStdin(payload: object): Readable {
  return Readable.from([Buffer.from(JSON.stringify(payload), 'utf8')]);
}

class CapturingStdout extends Writable {
  chunks: Buffer[] = [];
  override _write(chunk: Buffer, _enc: string, cb: (err?: Error | null) => void): void {
    this.chunks.push(chunk);
    cb();
  }
  result(): unknown {
    const text = Buffer.concat(this.chunks).toString('utf8').trim();
    if (!text) return null;
    return JSON.parse(text);
  }
}

async function startServer(handlers: Partial<Record<BridgeMessageType, (req: unknown) => unknown>>): Promise<BridgeServer> {
  const s = new BridgeServer({ socketPath });
  await s.start();
  for (const [type, handler] of Object.entries(handlers)) {
    s.registerHandler(type as BridgeMessageType, handler as never);
  }
  return s;
}

describe('parseArgs', () => {
  it('--event <name>', () => {
    expect(parseArgs(['--event', 'sessionStart'])).toEqual({ event: 'sessionStart' });
  });
  it('--event=<name>', () => {
    expect(parseArgs(['--event=sessionStart'])).toEqual({ event: 'sessionStart' });
  });
  it('no --event', () => {
    expect(parseArgs([])).toEqual({});
  });
  it('attack: --event with no following arg', () => {
    expect(parseArgs(['--event'])).toEqual({ event: '' });
  });
});

describe('runHook — full pipeline with bridge', () => {
  it('sessionStart → bridge → additional_context written to stdout', async () => {
    server = await startServer({
      host_session_start: () => ({ additional_context: 'role: senior dev' }),
    });
    const stdout = new CapturingStdout();
    await runHook({
      argv: ['--event', 'sessionStart'],
      stdin: makeStdin({ session_id: 's1', cwd: '/proj' }),
      stdout,
      socketPath,
    });
    expect(stdout.result()).toEqual({ additional_context: 'role: senior dev' });
  });

  it('beforeSubmitPrompt → continue=true by default', async () => {
    server = await startServer({
      host_prompt_submit: () => ({ continue: true }),
    });
    const stdout = new CapturingStdout();
    await runHook({
      argv: ['--event', 'beforeSubmitPrompt'],
      stdin: makeStdin({ session_id: 's1', prompt: 'hi' }),
      stdout,
      socketPath,
    });
    expect(stdout.result()).toEqual({ continue: true });
  });

  it('approval allow → permission: allow', async () => {
    server = await startServer({
      host_approval_request: () => ({ decision: 'allow', reason: 'policy match' }),
    });
    const stdout = new CapturingStdout();
    await runHook({
      argv: ['--event', 'beforeShellExecution'],
      stdin: makeStdin({ session_id: 's1', command: 'pnpm test' }),
      stdout,
      socketPath,
    });
    const out = stdout.result() as Record<string, unknown>;
    expect(out['permission']).toBe('allow');
    expect(String(out['agent_message'])).toContain('policy match');
  });

  it('approval deny → permission: deny', async () => {
    server = await startServer({
      host_approval_request: () => ({ decision: 'deny', reason: 'risky' }),
    });
    const stdout = new CapturingStdout();
    await runHook({
      argv: ['--event', 'preToolUse'],
      stdin: makeStdin({ session_id: 's1', tool_name: 'Write', tool_input: { path: '/etc/passwd' } }),
      stdout,
      socketPath,
    });
    expect((stdout.result() as Record<string, unknown>)['permission']).toBe('deny');
  });

  it('afterShellExecution → empty object', async () => {
    server = await startServer({
      host_progress: () => ({ ok: true }),
    });
    const stdout = new CapturingStdout();
    await runHook({
      argv: ['--event', 'afterShellExecution'],
      stdin: makeStdin({ session_id: 's1', command: 'ls', exit_code: 0 }),
      stdout,
      socketPath,
    });
    expect(stdout.result()).toEqual({});
  });

  it('stop forwards followup_message', async () => {
    server = await startServer({
      host_stop: () => ({ followup_message: 'now do this' }),
    });
    const stdout = new CapturingStdout();
    await runHook({
      argv: ['--event', 'stop'],
      stdin: makeStdin({ session_id: 's1' }),
      stdout,
      socketPath,
    });
    expect(stdout.result()).toEqual({ followup_message: 'now do this' });
  });
});

describe('runHook — fast paths (never touch the bridge)', () => {
  it('low-risk preToolUse short-circuits to allow without contacting bridge', async () => {
    // No server started; if we hit the bridge path we'd error
    const stdout = new CapturingStdout();
    await runHook({
      argv: ['--event', 'preToolUse'],
      stdin: makeStdin({ session_id: 's1', tool_name: 'Read' }),
      stdout,
      socketPath,
    });
    const out = stdout.result() as Record<string, unknown>;
    expect(out['permission']).toBe('allow');
    expect(String(out['agent_message'])).toContain('low-risk');
  });
});

describe('runHook — fallbacks when bridge is unreachable', () => {
  it('approval falls back to ask with bridge-down reason', async () => {
    const stdout = new CapturingStdout();
    await runHook({
      argv: ['--event', 'beforeShellExecution'],
      stdin: makeStdin({ session_id: 's1', command: 'rm -rf /' }),
      stdout,
      socketPath,
    });
    const out = stdout.result() as Record<string, unknown>;
    expect(out['permission']).toBe('ask');
    expect(String(out['user_message']).toLowerCase()).toContain('not running');
  });

  it('beforeSubmitPrompt falls back to continue=true', async () => {
    const stdout = new CapturingStdout();
    await runHook({
      argv: ['--event', 'beforeSubmitPrompt'],
      stdin: makeStdin({ session_id: 's1', prompt: 'hi' }),
      stdout,
      socketPath,
    });
    expect(stdout.result()).toEqual({ continue: true });
  });

  it('sessionStart falls back to empty object', async () => {
    const stdout = new CapturingStdout();
    await runHook({
      argv: ['--event', 'sessionStart'],
      stdin: makeStdin({ session_id: 's1' }),
      stdout,
      socketPath,
    });
    expect(stdout.result()).toEqual({});
  });
});

describe('runHook — bridge errors', () => {
  it('handler that throws → fallback decision', async () => {
    server = await startServer({
      host_approval_request: () => { throw new Error('boom'); },
    });
    const stdout = new CapturingStdout();
    await runHook({
      argv: ['--event', 'beforeShellExecution'],
      stdin: makeStdin({ session_id: 's1', command: 'ls' }),
      stdout,
      socketPath,
    });
    // bridge returned { error: 'handler_error', message: 'boom' } → mapper sees error → fallback ask
    expect((stdout.result() as Record<string, unknown>)['permission']).toBe('ask');
  });

  it('attack: malformed stdin payload → unknown event → fallback', async () => {
    const stdout = new CapturingStdout();
    await runHook({
      argv: [],
      stdin: Readable.from([Buffer.from('garbage', 'utf8')]),
      stdout,
      socketPath,
    });
    // Empty input + no --event → unknown event → synthesized session_start fallback
    expect(stdout.result()).toEqual({});
  });

  it('attack: empty stdin → no crash', async () => {
    const stdout = new CapturingStdout();
    await runHook({
      argv: ['--event', 'sessionStart'],
      stdin: Readable.from([]),
      stdout,
      socketPath,
    });
    expect(stdout.result()).toEqual({});
  });

  it('attack: unknown event name → fallback empty', async () => {
    const stdout = new CapturingStdout();
    await runHook({
      argv: ['--event', 'somethingWeird'],
      stdin: makeStdin({ session_id: 's1' }),
      stdout,
      socketPath,
    });
    expect(stdout.result()).toEqual({});
  });
});
