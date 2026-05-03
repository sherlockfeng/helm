import net from 'node:net';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BridgeServer } from '../../../src/bridge/server.js';
import { sendBridgeMessage } from '../../../src/bridge/client.js';
import type { BridgeRequest, BridgeResponse } from '../../../src/bridge/protocol.js';

let tmpDir: string;
let socketPath: string;
let server: BridgeServer;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'helm-bridge-'));
  socketPath = join(tmpDir, 'bridge.sock');
});

afterEach(async () => {
  if (server) await server.stop();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('BridgeServer — startup', () => {
  it('creates the socket file on start', async () => {
    server = new BridgeServer({ socketPath });
    await server.start();
    expect(existsSync(socketPath)).toBe(true);
  });

  it('removes the socket file on stop', async () => {
    server = new BridgeServer({ socketPath });
    await server.start();
    await server.stop();
    expect(existsSync(socketPath)).toBe(false);
  });

  it('attack: removes a stale socket file before listening', async () => {
    writeFileSync(socketPath, 'stale');
    expect(existsSync(socketPath)).toBe(true);
    server = new BridgeServer({ socketPath });
    await server.start();
    expect(existsSync(socketPath)).toBe(true);
    // Stale file removed; new one is a real socket
    const stat = await import('node:fs').then((m) => m.statSync(socketPath));
    expect(stat.isSocket()).toBe(true);
  });

  it('attack: starting twice throws', async () => {
    server = new BridgeServer({ socketPath });
    await server.start();
    await expect(server.start()).rejects.toThrow(/already started/i);
  });

  it('attack: stopping a never-started server is a no-op', async () => {
    server = new BridgeServer({ socketPath });
    await expect(server.stop()).resolves.toBeUndefined();
  });
});

describe('BridgeServer — dispatch', () => {
  beforeEach(async () => {
    server = new BridgeServer({ socketPath });
    await server.start();
  });

  it('routes a registered message to its handler and returns the response', async () => {
    server.registerHandler('host_session_start', () => ({ additional_context: 'hello' }));
    const res = await sendBridgeMessage(
      { type: 'host_session_start', host_session_id: 's1' },
      { socketPath, timeoutMs: 5000 },
    );
    expect(res).toEqual({ additional_context: 'hello' });
  });

  it('hasHandler reflects registration', () => {
    expect(server.hasHandler('host_stop')).toBe(false);
    server.registerHandler('host_stop', () => ({}));
    expect(server.hasHandler('host_stop')).toBe(true);
  });

  it('attack: unknown message type returns unknown_type error', async () => {
    const socket = net.createConnection(socketPath);
    const responsePromise = readSocketResponse(socket);
    socket.write(JSON.stringify({ type: 'host_session_end' }) + '\n');
    const res = await responsePromise;
    expect(res).toMatchObject({ error: 'unknown_type' });
  });

  it('attack: malformed JSON returns parse_error', async () => {
    const socket = net.createConnection(socketPath);
    const responsePromise = readSocketResponse(socket);
    socket.write('{not json}\n');
    const res = await responsePromise;
    expect(res).toMatchObject({ error: 'parse_error' });
  });

  it('attack: registered type with no handler returns no_handler', async () => {
    // host_progress is a valid type but no handler registered
    const res = await sendBridgeMessage(
      { type: 'host_progress', host_session_id: 's1', tool: 'shell' },
      { socketPath, timeoutMs: 5000 },
    );
    expect(res).toMatchObject({ error: 'no_handler' });
  });

  it('attack: handler that throws returns handler_error', async () => {
    server.registerHandler('host_stop', () => {
      throw new Error('boom');
    });
    const errs: Error[] = [];
    server = new BridgeServer({
      socketPath: socketPath + '.2',
      onError: (err) => errs.push(err),
    });
    await server.start();
    server.registerHandler('host_stop', () => {
      throw new Error('boom');
    });
    const res = await sendBridgeMessage(
      { type: 'host_stop', host_session_id: 's1' },
      { socketPath: socketPath + '.2', timeoutMs: 5000 },
    );
    expect(res).toMatchObject({ error: 'handler_error', message: 'boom' });
    expect(errs.some((e) => e.message === 'boom')).toBe(true);
  });

  it('attack: async handler that rejects returns handler_error', async () => {
    server.registerHandler('host_stop', async () => {
      await new Promise((r) => setTimeout(r, 5));
      throw new Error('async fail');
    });
    const res = await sendBridgeMessage(
      { type: 'host_stop', host_session_id: 's1' },
      { socketPath, timeoutMs: 5000 },
    );
    expect(res).toMatchObject({ error: 'handler_error', message: 'async fail' });
  });

  it('handles 20 concurrent connections correctly', async () => {
    server.registerHandler('host_progress', (req) => {
      const out: BridgeResponse = {
        ok: true,
        sent: true,
        // echo session id back via untyped field for verification
        echoed_id: req.host_session_id,
      };
      return out as { ok: boolean; sent?: boolean };
    });

    const requests: Promise<BridgeResponse | { error: string }>[] = [];
    for (let i = 0; i < 20; i++) {
      requests.push(sendBridgeMessage(
        { type: 'host_progress', host_session_id: `s${i}`, tool: 'shell' },
        { socketPath, timeoutMs: 5000 },
      ));
    }
    const results = await Promise.all(requests);
    for (let i = 0; i < 20; i++) {
      expect(results[i]).toMatchObject({ ok: true, echoed_id: `s${i}` });
    }
  });

  it('attack: client opens connection and disconnects without sending — server cleans up', async () => {
    const socket = net.createConnection(socketPath);
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.destroy();
    // Wait briefly for server-side cleanup. No expectations except no crash.
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(socketPath)).toBe(true);
  });

  it('attack: client sends data without trailing newline — connection idles until timeout', async () => {
    server = new BridgeServer({ socketPath: socketPath + '.idle', connectionIdleMs: 100 });
    await server.start();
    const socket = net.createConnection(socketPath + '.idle');
    const responsePromise = readSocketResponse(socket);
    socket.write('{"type":"host_stop","host_session_id":"s1"}'); // no newline
    const res = await responsePromise;
    expect(res).toMatchObject({ error: 'parse_error', message: expect.stringContaining('idle') as unknown as string });
  });

  it('attack: large payload (~200KB) round-trips', async () => {
    const big = 'x'.repeat(200_000);
    server.registerHandler('host_prompt_submit', (req) => ({
      continue: true,
      user_message: String((req as BridgeRequest)['prompt']).length.toString(),
    }));
    const res = await sendBridgeMessage(
      { type: 'host_prompt_submit', host_session_id: 's1', prompt: big },
      { socketPath, timeoutMs: 5000 },
    );
    expect(res).toMatchObject({ continue: true, user_message: '200000' });
  });
});

// ── helpers ──

function readSocketResponse(socket: net.Socket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const i = buf.indexOf('\n');
      if (i !== -1) {
        socket.destroy();
        try { resolve(JSON.parse(buf.slice(0, i))); } catch (e) { reject(e); }
      }
    });
    socket.on('error', reject);
    socket.on('end', () => {
      if (buf.trim()) {
        try { resolve(JSON.parse(buf.trim())); } catch (e) { reject(e); }
      }
    });
  });
}
