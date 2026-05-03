import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalRegistry } from '../../../src/approval/registry.js';
import { runMigrations } from '../../../src/storage/migrations.js';
import { upsertHostSession } from '../../../src/storage/repos/host-sessions.js';
import { getApprovalRequest, listPendingRequests } from '../../../src/storage/repos/approval.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedSession(db: BetterSqlite3.Database, id: string): void {
  const now = new Date().toISOString();
  upsertHostSession(db, { id, host: 'cursor', status: 'active', firstSeenAt: now, lastSeenAt: now });
}

let db: BetterSqlite3.Database;
let registry: ApprovalRegistry;

beforeEach(() => {
  db = openDb();
  seedSession(db, 's1');
  registry = new ApprovalRegistry(db, { defaultTimeoutMs: 60_000 });
});

afterEach(() => {
  registry.shutdown();
  db.close();
});

describe('ApprovalRegistry.create', () => {
  it('persists pending row and returns request + settled promise', async () => {
    const { request, settled } = registry.create({
      hostSessionId: 's1', tool: 'Shell', command: 'rm -rf /',
    });
    expect(request.id).toMatch(/^apr_/);
    expect(request.status).toBe('pending');
    expect(getApprovalRequest(db, request.id)?.status).toBe('pending');
    // settled promise still pending — settle to verify pipeline below
    registry.settle(request.id, { permission: 'allow', decidedBy: 'local-ui' });
    await expect(settled).resolves.toMatchObject({ permission: 'allow' });
  });

  it('listPending returns the new entry', () => {
    const a = registry.create({ hostSessionId: 's1', tool: 'Shell', command: 'a' });
    const b = registry.create({ hostSessionId: 's1', tool: 'Shell', command: 'b' });
    const ids = registry.listPending().map((r) => r.id).sort();
    expect(ids).toEqual([a.request.id, b.request.id].sort());
  });

  it('fires onPendingCreated listener with the new request', () => {
    const seen: string[] = [];
    registry.onPendingCreated((req) => seen.push(req.id));
    const a = registry.create({ hostSessionId: 's1', tool: 'Shell', command: 'a' });
    expect(seen).toEqual([a.request.id]);
  });

  it('attack: throwing listener does not block creation', () => {
    const warnings: string[] = [];
    registry = new ApprovalRegistry(db, {
      defaultTimeoutMs: 60_000,
      onWarning: (msg) => warnings.push(msg),
    });
    registry.onPendingCreated(() => { throw new Error('listener boom'); });
    expect(() => registry.create({ hostSessionId: 's1', tool: 'Shell', command: 'a' })).not.toThrow();
    expect(warnings.some((m) => m.includes('listener'))).toBe(true);
  });

  it('attack: create after shutdown throws', () => {
    registry.shutdown();
    expect(() => registry.create({ hostSessionId: 's1', tool: 'Shell', command: 'a' })).toThrow(/shut down/);
  });
});

describe('ApprovalRegistry.settle', () => {
  it('first settle wins, second returns false', async () => {
    const { request, settled } = registry.create({ hostSessionId: 's1', tool: 'Shell', command: 'a' });
    expect(registry.settle(request.id, { permission: 'allow', decidedBy: 'local-ui' })).toBe(true);
    expect(registry.settle(request.id, { permission: 'deny', decidedBy: 'lark' })).toBe(false);
    await expect(settled).resolves.toMatchObject({ permission: 'allow' });
    expect(getApprovalRequest(db, request.id)?.status).toBe('allowed');
  });

  it('settle deny → DB status=denied', async () => {
    const { request, settled } = registry.create({ hostSessionId: 's1', tool: 'Shell', command: 'a' });
    registry.settle(request.id, { permission: 'deny', decidedBy: 'lark', reason: 'risky' });
    const out = await settled;
    expect(out.permission).toBe('deny');
    expect(out.reason).toBe('risky');
    expect(getApprovalRequest(db, request.id)?.status).toBe('denied');
  });

  it('settle timeout → DB status=timeout, returned permission=ask', async () => {
    const { request, settled } = registry.create({ hostSessionId: 's1', tool: 'Shell', command: 'a' });
    registry.settle(request.id, { permission: 'timeout', decidedBy: 'timeout' });
    const out = await settled;
    expect(out.permission).toBe('ask');
    expect(getApprovalRequest(db, request.id)?.status).toBe('timeout');
  });

  it('attack: settle for unknown id returns false and emits warning', () => {
    const warnings: string[] = [];
    registry = new ApprovalRegistry(db, { defaultTimeoutMs: 60_000, onWarning: (m) => warnings.push(m) });
    expect(registry.settle('apr_does_not_exist', { permission: 'allow', decidedBy: 'local-ui' })).toBe(false);
    expect(warnings.some((m) => m.includes('unknown'))).toBe(true);
  });

  it('removes from listPending after settle', () => {
    const a = registry.create({ hostSessionId: 's1', tool: 'Shell', command: 'a' });
    registry.settle(a.request.id, { permission: 'allow', decidedBy: 'policy' });
    expect(registry.listPending()).toHaveLength(0);
  });
});

describe('ApprovalRegistry — timeout', () => {
  it('auto-settles as timeout when expiresAt elapses', async () => {
    const { request, settled } = registry.create({
      hostSessionId: 's1', tool: 'Shell', command: 'a',
      expiresAt: new Date(Date.now() + 30).toISOString(),
    });
    const result = await settled;
    expect(result.permission).toBe('ask');
    expect(result.decidedBy).toBe('timeout');
    expect(getApprovalRequest(db, request.id)?.status).toBe('timeout');
  });

  it('explicit settle before timeout cancels the timer', async () => {
    const { request, settled } = registry.create({
      hostSessionId: 's1', tool: 'Shell', command: 'a',
      expiresAt: new Date(Date.now() + 50).toISOString(),
    });
    registry.settle(request.id, { permission: 'allow', decidedBy: 'local-ui' });
    const result = await settled;
    expect(result.permission).toBe('allow');
    // Wait past the original expiry — registry must not double-settle
    await new Promise((r) => setTimeout(r, 80));
    expect(getApprovalRequest(db, request.id)?.status).toBe('allowed');
  });

  it('shutdown settles all in-flight pendings as timeout', async () => {
    const a = registry.create({ hostSessionId: 's1', tool: 'Shell', command: 'a' });
    const b = registry.create({ hostSessionId: 's1', tool: 'Shell', command: 'b' });
    registry.shutdown('app stopping');
    const [ra, rb] = await Promise.all([a.settled, b.settled]);
    expect(ra.permission).toBe('ask');
    expect(rb.permission).toBe('ask');
    expect(ra.decidedBy).toBe('timeout');
  });
});

describe('ApprovalRegistry.reloadFromDatabase', () => {
  it('restores pending rows from the DB into the in-memory map', () => {
    const a = registry.create({ hostSessionId: 's1', tool: 'Shell', command: 'a' });
    expect(a).toBeDefined();
    expect(registry.listPending()).toHaveLength(1);

    // New registry instance (simulates app restart). DB still has the pending row.
    const r2 = new ApprovalRegistry(db, { defaultTimeoutMs: 60_000 });
    expect(r2.listPending()).toHaveLength(0);
    const restored = r2.reloadFromDatabase();
    expect(restored).toBe(1);
    expect(r2.listPending()).toHaveLength(1);

    // listPendingRequests still sees the row
    expect(listPendingRequests(db)).toHaveLength(1);
    r2.shutdown();
  });

  it('attack: reload after shutdown throws', () => {
    registry.shutdown();
    expect(() => registry.reloadFromDatabase()).toThrow(/shutdown/);
  });

  it('reload is idempotent: restoring already-loaded rows is a no-op', () => {
    registry.create({ hostSessionId: 's1', tool: 'Shell', command: 'a' });
    expect(registry.reloadFromDatabase()).toBe(0);
  });
});

describe('ApprovalRegistry.get + listeners', () => {
  it('get returns DB row even after settle', () => {
    const a = registry.create({ hostSessionId: 's1', tool: 'Shell', command: 'a' });
    registry.settle(a.request.id, { permission: 'allow', decidedBy: 'local-ui' });
    expect(registry.get(a.request.id)?.status).toBe('allowed');
  });

  it('unsubscribe stops further listener calls', () => {
    const seen: string[] = [];
    const unsub = registry.onPendingCreated((req) => seen.push(req.id));
    registry.create({ hostSessionId: 's1', tool: 'Shell', command: 'a' });
    unsub();
    registry.create({ hostSessionId: 's1', tool: 'Shell', command: 'b' });
    expect(seen).toHaveLength(1);
  });
});
