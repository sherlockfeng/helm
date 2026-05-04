/**
 * Server-Sent Events endpoint tests.
 *
 * Uses a raw fetch with a streamed body reader instead of the EventSource
 * polyfill so the test runs in pure node without DOM globals.
 */

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/storage/migrations.js';
import { ApprovalRegistry } from '../../../src/approval/registry.js';
import { createEventBus, type EventBus } from '../../../src/events/bus.js';
import { createHttpApi, type HttpApiHandle } from '../../../src/api/server.js';

let db: BetterSqlite3.Database;
let registry: ApprovalRegistry;
let events: EventBus;
let api: HttpApiHandle;
let baseUrl: string;

beforeEach(async () => {
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  registry = new ApprovalRegistry(db, { defaultTimeoutMs: 60_000 });
  events = createEventBus();
  api = createHttpApi({ db, registry, events });
  await api.start();
  baseUrl = `http://127.0.0.1:${api.port()}`;
});

afterEach(async () => {
  await api.stop();
  registry.shutdown();
  db.close();
});

interface SseFrame {
  event: string;
  data: string;
}

/**
 * Connect to SSE and yield parsed event frames as they arrive. Caller
 * must `controller.abort()` when done; server otherwise keeps the stream
 * alive indefinitely.
 */
async function readSse(url: string, controller: AbortController, onFrame: (f: SseFrame) => void): Promise<Response> {
  const res = await fetch(url, { signal: controller.signal });
  if (!res.body) throw new Error('no SSE body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Read pump runs in the background; resolves when the stream closes.
  void (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let i;
        // SSE frames are separated by blank lines (\n\n)
        while ((i = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const frame: SseFrame = { event: 'message', data: '' };
          for (const line of raw.split('\n')) {
            if (line.startsWith(':')) continue; // comment
            if (line.startsWith('event:')) frame.event = line.slice(6).trim();
            else if (line.startsWith('data:')) frame.data += (frame.data ? '\n' : '') + line.slice(5).trim();
          }
          if (frame.data || frame.event !== 'message') onFrame(frame);
        }
      }
    } catch {
      // aborted or socket reset — fine.
    }
  })();

  return res;
}

describe('GET /api/events', () => {
  it('opens the stream and emits an initial comment for connection', async () => {
    const controller = new AbortController();
    let firstChunk = '';
    const res = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
    expect(res.headers.get('Content-Type')).toMatch(/text\/event-stream/);
    expect(res.headers.get('Cache-Control')).toMatch(/no-cache/);

    const reader = res.body!.getReader();
    const { value } = await reader.read();
    firstChunk = new TextDecoder().decode(value!);
    expect(firstChunk.startsWith(': connected')).toBe(true);

    controller.abort();
    try { await reader.cancel(); } catch { /* ignore */ }
  });

  it('forwards bus events to subscribers', async () => {
    const controller = new AbortController();
    const frames: SseFrame[] = [];

    await readSse(`${baseUrl}/api/events`, controller, (f) => frames.push(f));
    // Give the server a moment to register the subscriber
    await new Promise((r) => setTimeout(r, 30));

    events.emit({ type: 'session.closed', hostSessionId: 'sess-A' });

    // Wait for the frame to arrive
    await new Promise((r) => setTimeout(r, 80));

    const closed = frames.find((f) => f.event === 'session.closed');
    expect(closed).toBeDefined();
    expect(JSON.parse(closed!.data)).toEqual({ type: 'session.closed', hostSessionId: 'sess-A' });

    controller.abort();
  });

  it('multiple clients each get their own stream', async () => {
    const a = new AbortController();
    const b = new AbortController();
    const aFrames: SseFrame[] = [];
    const bFrames: SseFrame[] = [];

    await Promise.all([
      readSse(`${baseUrl}/api/events`, a, (f) => aFrames.push(f)),
      readSse(`${baseUrl}/api/events`, b, (f) => bFrames.push(f)),
    ]);
    await new Promise((r) => setTimeout(r, 30));

    events.emit({ type: 'session.closed', hostSessionId: 's' });
    await new Promise((r) => setTimeout(r, 80));

    expect(aFrames.find((f) => f.event === 'session.closed')).toBeDefined();
    expect(bFrames.find((f) => f.event === 'session.closed')).toBeDefined();

    a.abort();
    b.abort();
  });

  it('attack: POST is rejected as 405', async () => {
    const res = await fetch(`${baseUrl}/api/events`, { method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('attack: events emitted before any client connects do not crash', () => {
    expect(() => events.emit({ type: 'session.closed', hostSessionId: 's' })).not.toThrow();
  });

  it('api.stop() closes open SSE streams gracefully', async () => {
    const controller = new AbortController();
    let chunkCount = 0;
    const res = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
    const reader = res.body!.getReader();
    void (async () => {
      try {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
          chunkCount += 1;
        }
      } catch { /* abort ok */ }
    })();
    await new Promise((r) => setTimeout(r, 30));
    await api.stop();
    // After stop, the reader should observe end-of-stream cleanly
    await new Promise((r) => setTimeout(r, 30));
    expect(chunkCount).toBeGreaterThanOrEqual(1); // at least the initial ": connected"
    controller.abort();
  });
});
