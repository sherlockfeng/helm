/**
 * Integration test for the Claude Code hook entry.
 *
 * Spins up an in-process bridge that captures the payloads helm would
 * receive, then drives `runHook` with claude-shaped stdin/argv and asserts
 * the events that flow through.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import { runHook } from '../../../../src/host/claude-code/hook-entry.js';
import type { AnyBridgeRequest } from '../../../../src/bridge/protocol.js';

let dir: string;
let socketPath: string;
let server: Server | null = null;
const captured: AnyBridgeRequest[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'helm-claude-entry-'));
  socketPath = join(dir, 'bridge.sock');
  captured.length = 0;
});

afterEach(() => {
  try { server?.close(); } catch { /* swallow */ }
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Spin up a UDS server that captures each request and responds with an
 * empty success object. Wire format: the bridge client (src/bridge/client.ts)
 * writes the request JSON directly + newline; sendBridgeMessage waits for
 * a single newline-terminated JSON response back.
 */
function startCapturingBridge(): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = createServer((conn) => {
      let buf = '';
      conn.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const req = JSON.parse(line) as AnyBridgeRequest;
            captured.push(req);
            conn.write(JSON.stringify({}) + '\n');
          } catch (err) {
            conn.write(JSON.stringify({ error: 'parse_error', message: String(err) }) + '\n');
          }
        }
      });
    });
    s.on('error', reject);
    s.listen(socketPath, () => { server = s; resolve(); });
  });
}

async function drive(args: string[], payload: Record<string, unknown>): Promise<string> {
  const stdin = Readable.from([JSON.stringify(payload)]);
  const chunks: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
  });
  await runHook({ argv: args, stdin, stdout, socketPath, env: { HELM_BRIDGE_TIMEOUT_MS: '5000' } });
  return Buffer.concat(chunks).toString('utf8');
}

describe('runHook (claude code)', () => {
  it('UserPromptSubmit → host_prompt_submit on the bridge; stdout is empty allow', async () => {
    await startCapturingBridge();
    const out = await drive(
      ['--event', 'UserPromptSubmit'],
      { session_id: 'sess-X', cwd: '/proj', hook_event_name: 'UserPromptSubmit', prompt: 'hi there' },
    );
    expect(out.trim()).toBe('{}');
    expect(captured).toHaveLength(1);
    expect(captured[0]!.type).toBe('host_prompt_submit');
    const req = captured[0] as Extract<AnyBridgeRequest, { type: 'host_prompt_submit' }>;
    expect(req.host_session_id).toBe('sess-X');
    expect(req.prompt).toBe('hi there');
    expect(req.cwd).toBe('/proj');
  });

  it('Stop fires agent_response (from transcript) then stop, in that order', async () => {
    await startCapturingBridge();
    const transcriptPath = join(dir, 'transcript.jsonl');
    writeFileSync(transcriptPath, [
      JSON.stringify({ role: 'user', content: 'hello' }),
      JSON.stringify({ role: 'assistant', content: 'world response' }),
    ].join('\n') + '\n');

    const out = await drive(
      ['--event', 'Stop'],
      { session_id: 'sess-Y', cwd: '/p', hook_event_name: 'Stop', transcript_path: transcriptPath },
    );
    expect(out.trim()).toBe('{}');
    expect(captured.map((r) => r.type)).toEqual(['host_stop', 'host_agent_response']);
    const resp = captured.find((r) => r.type === 'host_agent_response') as Extract<AnyBridgeRequest, { type: 'host_agent_response' }>;
    expect(resp.response_text).toBe('world response');
  });

  it('Stop emits host_chat_rename when transcript carries a custom-title', async () => {
    await startCapturingBridge();
    const transcriptPath = join(dir, 'transcript.jsonl');
    writeFileSync(transcriptPath, [
      JSON.stringify({ role: 'user', content: 'kick off' }),
      JSON.stringify({ role: 'assistant', content: 'sure' }),
      JSON.stringify({ type: 'custom-title', customTitle: 'helm-build-fix', sessionId: 'sess-Y2' }),
    ].join('\n') + '\n');

    await drive(
      ['--event', 'Stop'],
      { session_id: 'sess-Y2', hook_event_name: 'Stop', transcript_path: transcriptPath },
    );
    const rename = captured.find((r) => r.type === 'host_chat_rename') as Extract<AnyBridgeRequest, { type: 'host_chat_rename' }>;
    expect(rename).toBeDefined();
    expect(rename.host_session_id).toBe('sess-Y2');
    expect(rename.title).toBe('helm-build-fix');
  });

  it('Stop does NOT emit host_chat_rename when transcript has no custom-title row', async () => {
    await startCapturingBridge();
    const transcriptPath = join(dir, 'transcript.jsonl');
    writeFileSync(transcriptPath, JSON.stringify({ role: 'assistant', content: 'hi' }) + '\n');
    await drive(
      ['--event', 'Stop'],
      { session_id: 'sess-Y3', hook_event_name: 'Stop', transcript_path: transcriptPath },
    );
    expect(captured.find((r) => r.type === 'host_chat_rename')).toBeUndefined();
  });

  it('Stop with no transcript path still emits stop (no agent_response)', async () => {
    await startCapturingBridge();
    const out = await drive(
      ['--event', 'Stop'],
      { session_id: 'sess-Z', hook_event_name: 'Stop' },
    );
    expect(out.trim()).toBe('{}');
    expect(captured).toHaveLength(1);
    expect(captured[0]!.type).toBe('host_stop');
  });

  it('Stop with missing transcript file gracefully emits stop only', async () => {
    await startCapturingBridge();
    const out = await drive(
      ['--event', 'Stop'],
      { session_id: 'sess-Q', hook_event_name: 'Stop', transcript_path: join(dir, 'no-such.jsonl') },
    );
    expect(out.trim()).toBe('{}');
    expect(captured.map((r) => r.type)).toEqual(['host_stop']);
  });

  it('bridge socket missing → no captures, stdout still empty allow (never blocks claude)', async () => {
    // Note: no startCapturingBridge() call — socket file does not exist.
    const out = await drive(
      ['--event', 'UserPromptSubmit'],
      { session_id: 'sess-A', hook_event_name: 'UserPromptSubmit', prompt: 'p' },
    );
    expect(out.trim()).toBe('{}');
    expect(captured).toEqual([]);
  });

  it('unknown event name → no bridge traffic, stdout still empty allow', async () => {
    await startCapturingBridge();
    const out = await drive(
      ['--event', 'PreToolUse'],
      { session_id: 'sess-B', hook_event_name: 'PreToolUse' },
    );
    expect(out.trim()).toBe('{}');
    expect(captured).toEqual([]);
  });

  it('HELM_INTERNAL_LLM=1 → short-circuits before any bridge call', async () => {
    // Bridge IS up, event name IS valid — but the env flag tells the hook
    // "this is helm spawning claude for its own LLM use, do not log".
    // Prevents the TL;DR-generation recursion bug (claude -p spawned by
    // helm fires a UserPromptSubmit hook that helm captures as a new
    // chat, whose Stop then spawns another TL;DR generation, ad inf.).
    await startCapturingBridge();
    const stdin = Readable.from([JSON.stringify({
      session_id: 'helm-internal', hook_event_name: 'UserPromptSubmit', prompt: 'tl;dr template body',
    })]);
    const chunks: Buffer[] = [];
    const stdout = new Writable({
      write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
    });
    await runHook({
      argv: ['--event', 'UserPromptSubmit'],
      stdin,
      stdout,
      socketPath,
      env: { HELM_INTERNAL_LLM: '1' },
    });
    expect(Buffer.concat(chunks).toString('utf8').trim()).toBe('{}');
    expect(captured).toEqual([]);
  });
});
