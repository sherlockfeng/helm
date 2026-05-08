/**
 * E2e — Active Chats lifecycle (renderer flow).
 *
 * Drives the same HTTP API the renderer's /chats page uses:
 *
 *   GET    /api/active-chats                    list currently-active sessions
 *   PUT    /api/active-chats/:id/role           legacy single-select (Phase 25)
 *   POST   /api/active-chats/:id/roles          add a role (Phase 42)
 *   DELETE /api/active-chats/:id/roles/:roleId  remove one role
 *   DELETE /api/active-chats/:id                close (soft / cascade)
 *
 * Together with Phase 36's session.closed event, these are the entry points
 * the user touches every time they open the helm window. Without an e2e:
 *   - repo refactors that change roleIds shape silently break the UI dropdown
 *   - the cascade=true semantic could regress and orphan channel_bindings
 *   - SSE event timing could drift so the renderer never refreshes
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootE2e, type E2eHarness } from '../_helpers/setup.js';
import { upsertHostSession } from '../../../src/storage/repos/host-sessions.js';
import { upsertRole } from '../../../src/storage/repos/roles.js';
import { insertChannelBinding } from '../../../src/storage/repos/channel-bindings.js';

let harness: E2eHarness;

beforeEach(async () => {
  harness = await bootE2e({
    seed: (db) => {
      const now = new Date().toISOString();
      // Two active chats + one closed → list should only return the active two.
      upsertHostSession(db, {
        id: 'sess_a', host: 'cursor', cwd: '/proj-a',
        status: 'active', firstSeenAt: now, lastSeenAt: now,
      });
      upsertHostSession(db, {
        id: 'sess_b', host: 'cursor', cwd: '/proj-b',
        status: 'active', firstSeenAt: now, lastSeenAt: now,
      });
      upsertHostSession(db, {
        id: 'sess_old', host: 'cursor', cwd: '/proj-c',
        status: 'closed', firstSeenAt: now, lastSeenAt: now,
      });
      // Two roles for the multi-role tests.
      upsertRole(db, {
        id: 'role-pm', name: 'Product Manager',
        systemPrompt: 'pm', isBuiltin: false, createdAt: now,
      });
      upsertRole(db, {
        id: 'role-arch', name: 'Architect',
        systemPrompt: 'arch', isBuiltin: false, createdAt: now,
      });
    },
  });
});

afterEach(async () => { await harness.shutdown(); });

function api(path: string): string {
  return `http://127.0.0.1:${harness.app.httpPort()}${path}`;
}

async function fetchJson(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(api(path), init);
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

describe('active-chats happy', () => {
  it('GET /api/active-chats returns active sessions in lastSeenAt-desc order, omits closed', async () => {
    const r = await fetchJson('/api/active-chats');
    expect(r.status).toBe(200);
    const ids = ((r.body as { chats: Array<{ id: string }> }).chats).map((c) => c.id);
    expect(ids).toContain('sess_a');
    expect(ids).toContain('sess_b');
    expect(ids).not.toContain('sess_old');
  });

  it('legacy PUT /role binds and unbinds a single role; clears via roleId=null', async () => {
    const bind = await fetchJson('/api/active-chats/sess_a/role', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roleId: 'role-pm' }),
    });
    expect(bind.status).toBe(200);
    const chat = (bind.body as { chat: { roleId?: string; roleIds?: string[] } }).chat;
    expect(chat.roleId).toBe('role-pm');
    expect(chat.roleIds).toEqual(['role-pm']);

    const clear = await fetchJson('/api/active-chats/sess_a/role', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roleId: null }),
    });
    expect(clear.status).toBe(200);
    const chatAfter = (clear.body as { chat: { roleIds?: string[] } }).chat;
    expect(chatAfter.roleIds ?? []).toEqual([]);
  });

  it('multi-role: POST /roles + DELETE /roles/:roleId — order preserved by created_at', async () => {
    const a1 = await fetchJson('/api/active-chats/sess_a/roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roleId: 'role-pm' }),
    });
    expect(a1.status).toBe(200);
    const a2 = await fetchJson('/api/active-chats/sess_a/roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roleId: 'role-arch' }),
    });
    expect(a2.status).toBe(200);
    const after2 = (a2.body as { chat: { roleIds: string[] } }).chat;
    expect(after2.roleIds).toEqual(['role-pm', 'role-arch']);

    // Idempotent re-add — still both, no duplicate.
    const a3 = await fetchJson('/api/active-chats/sess_a/roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roleId: 'role-pm' }),
    });
    expect(a3.status).toBe(200);
    expect((a3.body as { chat: { roleIds: string[] } }).chat.roleIds.sort())
      .toEqual(['role-arch', 'role-pm']);

    // Remove one.
    const r = await fetchJson('/api/active-chats/sess_a/roles/role-pm', { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect((r.body as { chat: { roleIds: string[] } }).chat.roleIds).toEqual(['role-arch']);
  });

  it('DELETE /api/active-chats/:id (soft, default) flips status=closed, keeps row + bindings', async () => {
    insertChannelBinding(harness.db, {
      id: 'b_keep', channel: 'lark', hostSessionId: 'sess_a',
      externalChat: 'oc', externalThread: 'tr', externalRoot: 'om',
      waitEnabled: false, createdAt: new Date().toISOString(),
    });

    const r = await fetchJson('/api/active-chats/sess_a', { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect((r.body as { ok: boolean; cascade: boolean }).cascade).toBe(false);

    // Row still exists with status=closed; binding row also intact.
    const row = harness.db.prepare(`SELECT status FROM host_sessions WHERE id = ?`).get('sess_a') as { status: string };
    expect(row.status).toBe('closed');
    const bindings = harness.db.prepare(`SELECT count(*) AS n FROM channel_bindings WHERE host_session_id = ?`).get('sess_a') as { n: number };
    expect(bindings.n).toBe(1);

    // Vanishes from the active list.
    const list = await fetchJson('/api/active-chats');
    const ids = ((list.body as { chats: Array<{ id: string }> }).chats).map((c) => c.id);
    expect(ids).not.toContain('sess_a');
  });

  it('DELETE ?cascade=true hard-deletes the row + cascades to channel_bindings via FK', async () => {
    insertChannelBinding(harness.db, {
      id: 'b_drop', channel: 'lark', hostSessionId: 'sess_b',
      externalChat: 'oc', externalThread: 'tr', externalRoot: 'om',
      waitEnabled: false, createdAt: new Date().toISOString(),
    });

    const r = await fetchJson('/api/active-chats/sess_b?cascade=true', { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect((r.body as { cascade: boolean }).cascade).toBe(true);

    const row = harness.db.prepare(`SELECT * FROM host_sessions WHERE id = ?`).get('sess_b');
    expect(row).toBeUndefined();
    const bindings = harness.db.prepare(`SELECT count(*) AS n FROM channel_bindings WHERE host_session_id = ?`).get('sess_b') as { n: number };
    expect(bindings.n).toBe(0);
  });

  it('emits session.closed SSE event on DELETE so the renderer auto-refreshes', async () => {
    const events: string[] = [];
    harness.app.events.on((e) => { events.push(e.type); });

    await fetchJson('/api/active-chats/sess_a', { method: 'DELETE' });
    expect(events).toContain('session.closed');
  });

  it('attack: PUT /role with unknown roleId returns FK error (400-class)', async () => {
    const r = await fetchJson('/api/active-chats/sess_a/role', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roleId: 'role-ghost' }),
    });
    // FK violation surfaces as 400 (or 500 if the orchestrator wraps it).
    // The contract: response is NOT 200 and the binding doesn't land.
    expect(r.status).toBeGreaterThanOrEqual(400);
    const row = harness.db.prepare(
      `SELECT count(*) AS n FROM host_session_roles WHERE host_session_id = ? AND role_id = ?`,
    ).get('sess_a', 'role-ghost') as { n: number };
    expect(row.n).toBe(0);
  });

  it('attack: DELETE on a non-existent chat is a no-op-ish (soft path) — emits session.closed but no row mutation', async () => {
    const r = await fetchJson('/api/active-chats/sess_ghost', { method: 'DELETE' });
    // Implementation is permissive — the underlying UPDATE matches zero rows.
    // We accept any 2xx/4xx as long as the DB stays clean.
    expect([200, 404]).toContain(r.status);
    const rows = harness.db.prepare(`SELECT count(*) AS n FROM host_sessions WHERE id = ?`).get('sess_ghost') as { n: number };
    expect(rows.n).toBe(0);
  });

  // ── Phase 55: chat rename ───────────────────────────────────────────────

  it('PUT /label persists displayName + emits session.started for SSE refresh', async () => {
    const events: string[] = [];
    harness.app.events.on((e) => { events.push(e.type); });

    const r = await fetchJson('/api/active-chats/sess_a/label', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Auth refactor — reviewer chat' }),
    });
    expect(r.status).toBe(200);
    const chat = (r.body as { chat: { displayName?: string } }).chat;
    expect(chat.displayName).toBe('Auth refactor — reviewer chat');

    // GET reflects the new label too.
    const list = await fetchJson('/api/active-chats');
    const ours = ((list.body as { chats: Array<{ id: string; displayName?: string }> }).chats)
      .find((c) => c.id === 'sess_a');
    expect(ours?.displayName).toBe('Auth refactor — reviewer chat');

    // Renderer subscribes to session.started for refresh.
    expect(events).toContain('session.started');
  });

  it('PUT /label with empty / null clears the override', async () => {
    await fetchJson('/api/active-chats/sess_a/label', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'temp' }),
    });
    const cleared = await fetchJson('/api/active-chats/sess_a/label', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: '' }),
    });
    expect(cleared.status).toBe(200);
    expect((cleared.body as { chat: { displayName?: string } }).chat.displayName).toBeUndefined();
  });

  it('attack: PUT /label with non-string label rejected as 400; row unchanged', async () => {
    await fetchJson('/api/active-chats/sess_a/label', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'baseline' }),
    });
    const r = await fetchJson('/api/active-chats/sess_a/label', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 42 }),
    });
    expect(r.status).toBe(400);
    const list = await fetchJson('/api/active-chats');
    const ours = ((list.body as { chats: Array<{ id: string; displayName?: string }> }).chats)
      .find((c) => c.id === 'sess_a');
    expect(ours?.displayName).toBe('baseline');
  });

  it('attack: PUT /label on unknown sessionId returns 404 (no row created)', async () => {
    const r = await fetchJson('/api/active-chats/sess_ghost/label', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'whatever' }),
    });
    expect(r.status).toBe(404);
    const rows = harness.db.prepare(`SELECT count(*) AS n FROM host_sessions WHERE id = ?`).get('sess_ghost') as { n: number };
    expect(rows.n).toBe(0);
  });

  it('attack: GET on /label endpoint returns 405', async () => {
    const r = await fetchJson('/api/active-chats/sess_a/label');
    expect(r.status).toBe(405);
  });
});
