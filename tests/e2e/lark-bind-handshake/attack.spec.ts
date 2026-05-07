/**
 * E2e attacks for lark-bind-handshake.
 *
 * Verifies the consume endpoint refuses bad input and stale codes without
 * leaving partial state behind.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootE2e, type E2eHarness } from '../_helpers/setup.js';
import { upsertHostSession } from '../../../src/storage/repos/host-sessions.js';
import {
  insertPendingBind,
  listAllChannelBindings,
  listPendingBinds,
} from '../../../src/storage/repos/channel-bindings.js';

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

async function postJson(path: string, body: unknown, opts?: { rawBody?: string }): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${harness.app.httpPort()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: opts?.rawBody ?? JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

describe('lark-bind-handshake attacks', () => {
  it('attack: unknown code → 404, no binding created', async () => {
    const r = await postJson('/api/bindings/consume', {
      code: 'NEVER-INSERTED', hostSessionId: 'sess_lark',
    });
    expect(r.status).toBe(404);
    expect(listAllChannelBindings(harness.db)).toHaveLength(0);
  });

  it('attack: expired code is rejected as 404 (cleanup happens lazily)', async () => {
    insertPendingBind(harness.db, {
      code: 'STALE',
      channel: 'lark',
      externalChat: 'oc_x',
      externalThread: 'om_x',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const r = await postJson('/api/bindings/consume', {
      code: 'STALE', hostSessionId: 'sess_lark',
    });
    expect(r.status).toBe(404);
    // No binding row — even though pending_binds row physically still exists
    // until purged, the consume gate refused it.
    expect(listAllChannelBindings(harness.db)).toHaveLength(0);
  });

  it('attack: malformed JSON body → 400', async () => {
    const r = await postJson('/api/bindings/consume', {}, { rawBody: '{not json' });
    expect(r.status).toBe(400);
  });

  it('attack: missing required fields → 400 (no half-bound binding)', async () => {
    const noCode = await postJson('/api/bindings/consume', { hostSessionId: 'sess_lark' });
    expect(noCode.status).toBe(400);
    const noSess = await postJson('/api/bindings/consume', { code: 'whatever' });
    expect(noSess.status).toBe(400);
    expect(listAllChannelBindings(harness.db)).toHaveLength(0);
    expect(listPendingBinds(harness.db)).toHaveLength(0);
  });
});
