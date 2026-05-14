/**
 * SSE keepalive (Phase 77 sidecar fix).
 *
 * Verifies that the MCP HTTP/SSE transport emits the keepalive comment
 * frame periodically so Chrome / Electron's ~30s idle-connection timeout
 * doesn't drop Cursor's MCP stream. Failure mode this guards against:
 * Cursor silently loses the helm MCP connection and its tool-call cache
 * desyncs ("Tool not found" until the user ⌘R reloads).
 *
 * Approach: open a raw HTTP GET on /mcp/sse, dial the keepalive interval
 * down to ~100ms via the `mcpKeepaliveIntervalMs` test-only override on
 * createHttpApi, then watch the response stream for at least two
 * `: keepalive\n\n` frames within ~500ms. Production interval is 25s;
 * the test must NOT take that long.
 */

import BetterSqlite3 from 'better-sqlite3';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { ApprovalRegistry } from '../../../src/approval/registry.js';
import { createHttpApi, type HttpApiHandle } from '../../../src/api/server.js';
import { createMcpServer } from '../../../src/mcp/server.js';

let db: BetterSqlite3.Database;
let registry: ApprovalRegistry;
let api: HttpApiHandle;

beforeEach(async () => {
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  registry = new ApprovalRegistry(db, { defaultTimeoutMs: 60_000 });
});

afterEach(async () => {
  await api.stop();
  registry.shutdown();
  db.close();
});

/** Open a raw GET on /mcp/sse and return a handle for draining + closing. */
function openRawSseStream(baseUrl: string): Promise<{
  bytes: () => string;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}/mcp/sse`);
    const req = http.request({
      method: 'GET',
      hostname: url.hostname,
      port: Number(url.port),
      path: url.pathname,
      headers: { Accept: 'text/event-stream' },
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { buf += chunk as string; });
      resolve({
        bytes: () => buf,
        close: () => { try { req.destroy(); } catch { /* ignored */ } },
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('SSE keepalive', () => {
  it('emits `: keepalive` comment frames at the configured interval', async () => {
    api = createHttpApi({
      db,
      registry,
      mcpFactory: () => createMcpServer({ db }),
      // Fast keepalive interval so the test completes in under a second.
      mcpKeepaliveIntervalMs: 100,
    });
    await api.start();
    const baseUrl = `http://127.0.0.1:${api.port()}`;

    const stream = await openRawSseStream(baseUrl);
    try {
      // ≥4 ticks of slack at 100ms — guarantees at least two intervals
      // elapsed even on a busy CI machine.
      await sleep(500);
      const captured = stream.bytes();
      const keepaliveMatches = captured.match(/: keepalive\n\n/g) ?? [];
      // The SDK's `endpoint` event is written immediately; keepalive
      // frames start after the connect handshake. Two means the timer
      // actually fires AND survives between ticks (not just an initial
      // greeting we mistook for keepalive).
      expect(keepaliveMatches.length).toBeGreaterThanOrEqual(2);
    } finally {
      stream.close();
    }
  }, 10_000);
});
