/**
 * E2e — Lark binding handshake (Phase 30 / C2).
 *
 * Drives the two-step bind flow:
 *   1. The user tells the Cursor agent (or the Bindings UI) "bind this chat to
 *      Lark thread X". The orchestrator inserts a `pending_binds` row keyed by
 *      a short code.
 *   2. The user types `/helm bind <code>` in the Lark thread → lark-wiring
 *      consumes the row and inserts a `channel_bindings` row, which surfaces
 *      via SSE so the renderer's Bindings page lights up.
 *
 * The HTTP API exposes `/api/bindings/consume` for the local-UI variant of
 * step 2 (used by tests + by the renderer when the user pastes a code into a
 * dialog). This spec drives the HTTP path end-to-end so we exercise: server
 * router → consumePendingBind orchestration → channel_bindings repo →
 * EventBus emit → SSE listener → response shape.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootE2e, type E2eHarness } from '../_helpers/setup.js';
import { upsertHostSession } from '../../../src/storage/repos/host-sessions.js';
import {
  insertPendingBind,
  listAllChannelBindings,
  listPendingBinds,
} from '../../../src/storage/repos/channel-bindings.js';
import type { AppEvent } from '../../../src/events/bus.js';

let harness: E2eHarness;

beforeEach(async () => {
  harness = await bootE2e({
    seed: (db) => {
      const now = new Date().toISOString();
      upsertHostSession(db, {
        id: 'sess_lark', host: 'cursor', cwd: '/proj',
        status: 'active', firstSeenAt: now, lastSeenAt: now,
      });
    },
  });
});

afterEach(async () => { await harness.shutdown(); });

async function postJson(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${harness.app.httpPort()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

describe('lark-bind-handshake happy', () => {
  it('pending bind → consume via HTTP → channel_bindings row + binding.created SSE', async () => {
    // Step 1: simulate the lark-wiring ingestion path having just inserted a
    // pending_binds row when the agent (or UI) initiated the handshake.
    insertPendingBind(harness.db, {
      code: 'ABC123',
      channel: 'lark',
      externalChat: 'oc_chat_abc',
      externalThread: 'om_thread_xyz',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    expect(listPendingBinds(harness.db)).toHaveLength(1);

    // Capture SSE events before consume so we can assert binding.created fires.
    const seen: AppEvent[] = [];
    const unsub = harness.app.events.on((e) => { seen.push(e); });

    // Step 2: the renderer (or any local UI) consumes the code on the user's behalf.
    const r = await postJson('/api/bindings/consume', {
      code: 'ABC123',
      hostSessionId: 'sess_lark',
    });
    expect(r.status).toBe(200);
    const { binding } = r.body as { binding: { id: string } };
    expect(binding.id).toBeTruthy();

    // The pending_binds row is gone (one-shot); the channel_bindings row exists.
    expect(listPendingBinds(harness.db)).toHaveLength(0);
    const bindings = listAllChannelBindings(harness.db);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.id).toBe(binding.id);
    expect(bindings[0]!.hostSessionId).toBe('sess_lark');
    expect(bindings[0]!.externalChat).toBe('oc_chat_abc');
    expect(bindings[0]!.externalThread).toBe('om_thread_xyz');

    // SSE saw binding.created — the renderer's Bindings page would refresh.
    const created = seen.filter((e) => e.type === 'binding.created');
    expect(created).toHaveLength(1);
    expect((created[0] as Extract<AppEvent, { type: 'binding.created' }>).binding.id).toBe(binding.id);

    unsub();
  });

  it('binding.removed SSE fires when the user unbinds via DELETE', async () => {
    insertPendingBind(harness.db, {
      code: 'XYZ789',
      channel: 'lark',
      externalChat: 'oc_chat_x',
      externalThread: 'om_thread_x',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const consume = await postJson('/api/bindings/consume', {
      code: 'XYZ789', hostSessionId: 'sess_lark',
    });
    const { binding } = consume.body as { binding: { id: string } };

    const seen: AppEvent[] = [];
    const unsub = harness.app.events.on((e) => { seen.push(e); });

    const del = await fetch(
      `http://127.0.0.1:${harness.app.httpPort()}/api/bindings/${encodeURIComponent(binding.id)}`,
      { method: 'DELETE' },
    );
    expect(del.status).toBe(200);
    expect(listAllChannelBindings(harness.db)).toHaveLength(0);
    const removed = seen.filter((e) => e.type === 'binding.removed');
    expect(removed).toHaveLength(1);
    expect((removed[0] as Extract<AppEvent, { type: 'binding.removed' }>).bindingId).toBe(binding.id);

    unsub();
  });
});
