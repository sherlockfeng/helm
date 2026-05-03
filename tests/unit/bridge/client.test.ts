import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bridgeSocketExists, sendBridgeMessage } from '../../../src/bridge/client.js';

let tmpDir: string;
let socketPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'helm-client-'));
  socketPath = join(tmpDir, 'bridge.sock');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Spin up a tiny echo server that replies with whatever the client sent. */
async function startEchoServer(reply: object | ((req: unknown) => object | Promise<object>)): Promise<net.Server> {
  const server = net.createServer((socket) => {
    let buf = '';
    socket.on('data', async (chunk) => {
      buf += chunk.toString('utf8');
      const i = buf.indexOf('\n');
      if (i === -1) return;
      const line = buf.slice(0, i);
      const req = JSON.parse(line);
      const out = typeof reply === 'function' ? await reply(req) : reply;
      socket.write(JSON.stringify(out) + '\n');
      socket.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return server;
}

describe('client — bridgeSocketExists', () => {
  it('returns false when socket file is missing', () => {
    expect(bridgeSocketExists(socketPath)).toBe(false);
  });

  it('returns true when socket file exists', async () => {
    const server = await startEchoServer({ ok: true });
    try {
      expect(bridgeSocketExists(socketPath)).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('client — sendBridgeMessage', () => {
  it('sends a request and resolves with the response', async () => {
    const server = await startEchoServer({ ok: true, suppressed: false });
    try {
      const res = await sendBridgeMessage(
        { type: 'host_agent_response', host_session_id: 's1', response_text: 'hi' },
        { socketPath, timeoutMs: 5000 },
      );
      expect(res).toEqual({ ok: true, suppressed: false });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('echoes payload back through reply callback', async () => {
    const server = await startEchoServer((req) => {
      const r = req as Record<string, unknown>;
      return { decision: 'allow' as const, reason: r['tool'] as string };
    });
    try {
      const res = await sendBridgeMessage(
        { type: 'host_approval_request', host_session_id: 's1', tool: 'shell' },
        { socketPath, timeoutMs: 5000 },
      );
      expect(res).toEqual({ decision: 'allow', reason: 'shell' });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('attack: missing socket — connection rejects', async () => {
    await expect(
      sendBridgeMessage(
        { type: 'host_stop', host_session_id: 's1' },
        { socketPath, timeoutMs: 1000 },
      ),
    ).rejects.toThrow();
  });

  it('attack: server never replies — client times out', async () => {
    const server = net.createServer((socket) => {
      // Accept connection but never write — let client time out
      socket.on('data', () => { /* drop */ });
    });
    await new Promise<void>((r) => server.listen(socketPath, r));
    try {
      await expect(
        sendBridgeMessage(
          { type: 'host_stop', host_session_id: 's1' },
          { socketPath, timeoutMs: 100 },
        ),
      ).rejects.toThrow(/timeout/i);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('attack: server closes without writing — client rejects', async () => {
    const server = net.createServer((socket) => {
      socket.on('data', () => { socket.end(); });
    });
    await new Promise<void>((r) => server.listen(socketPath, r));
    try {
      await expect(
        sendBridgeMessage(
          { type: 'host_stop', host_session_id: 's1' },
          { socketPath, timeoutMs: 1000 },
        ),
      ).rejects.toThrow();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('attack: server returns malformed JSON — client rejects', async () => {
    const server = net.createServer((socket) => {
      socket.on('data', () => {
        socket.write('not json\n');
        socket.end();
      });
    });
    await new Promise<void>((r) => server.listen(socketPath, r));
    try {
      await expect(
        sendBridgeMessage(
          { type: 'host_stop', host_session_id: 's1' },
          { socketPath, timeoutMs: 1000 },
        ),
      ).rejects.toThrow();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('attack: response delivered without trailing newline (server end-of-stream)', async () => {
    const server = net.createServer((socket) => {
      socket.on('data', () => {
        socket.write(JSON.stringify({ ok: true })); // no newline
        socket.end();
      });
    });
    await new Promise<void>((r) => server.listen(socketPath, r));
    try {
      const res = await sendBridgeMessage(
        { type: 'host_progress', host_session_id: 's1', tool: 'shell' },
        { socketPath, timeoutMs: 1000 },
      );
      expect(res).toEqual({ ok: true });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
