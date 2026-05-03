import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalPolicyEngine } from '../../../src/approval/policy.js';
import { ApprovalRegistry } from '../../../src/approval/registry.js';
import { createApprovalHandler } from '../../../src/approval/handler.js';
import { runMigrations } from '../../../src/storage/migrations.js';
import { upsertHostSession } from '../../../src/storage/repos/host-sessions.js';
import { getApprovalPolicy, getApprovalRequest } from '../../../src/storage/repos/approval.js';
import type { HostApprovalRequestRequest } from '../../../src/bridge/protocol.js';

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

function makeRequest(overrides: Partial<HostApprovalRequestRequest> = {}): HostApprovalRequestRequest {
  return {
    type: 'host_approval_request',
    host_session_id: 's1',
    tool: 'Shell',
    command: 'rm -rf /',
    payload: { command: 'rm -rf /' },
    ...overrides,
  };
}

let db: BetterSqlite3.Database;
let policy: ApprovalPolicyEngine;
let registry: ApprovalRegistry;
let handle: ReturnType<typeof createApprovalHandler>;

beforeEach(() => {
  db = openDb();
  seedSession(db, 's1');
  policy = new ApprovalPolicyEngine(db);
  registry = new ApprovalRegistry(db, { defaultTimeoutMs: 60_000 });
  handle = createApprovalHandler({
    policy,
    registry,
    resolveCwd: () => '/proj',
  });
});

afterEach(() => {
  registry.shutdown();
  db.close();
});

describe('handler — policy fast path', () => {
  it('matched allow rule returns decision=allow + reason references rule id', async () => {
    const rule = policy.add({ tool: 'Shell', commandPrefix: 'pnpm', decision: 'allow' });
    const res = await handle(makeRequest({ tool: 'Shell', command: 'pnpm test' }));
    expect(res.decision).toBe('allow');
    expect(String(res.reason)).toContain(rule.id);
    expect(getApprovalPolicy(db, rule.id)?.hits).toBe(1);
  });

  it('matched deny rule returns decision=deny', async () => {
    policy.add({ tool: 'Shell', commandPrefix: 'rm', decision: 'deny' });
    const res = await handle(makeRequest({ tool: 'Shell', command: 'rm -rf /' }));
    expect(res.decision).toBe('deny');
  });

  it('policy decision still creates an audit row in approval_requests', async () => {
    policy.add({ tool: 'Shell', commandPrefix: 'pnpm', decision: 'allow' });
    await handle(makeRequest({ tool: 'Shell', command: 'pnpm install' }));
    const rows = db.prepare(`SELECT * FROM approval_requests`).all() as { decided_by: string; status: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decided_by).toBe('policy');
    expect(rows[0]?.status).toBe('allowed');
  });

  it('uses resolveCwd when matching path-based rules', async () => {
    policy.add({ tool: 'Write', pathPrefix: '/proj', decision: 'allow' });
    const res = await handle(makeRequest({ tool: 'Write', command: 'src/foo.ts' }));
    expect(res.decision).toBe('allow');
  });

  it('falls back to pending when path rule does not cover the cwd', async () => {
    policy.add({ tool: 'Write', pathPrefix: '/other', decision: 'allow' });
    const promise = handle(makeRequest({ tool: 'Write', command: 'src/foo.ts' }));
    // resolveCwd returns /proj which doesn't start with /other → no policy match
    const pending = registry.listPending();
    expect(pending).toHaveLength(1);
    registry.settle(pending[0]!.id, { permission: 'allow', decidedBy: 'local-ui' });
    expect((await promise).decision).toBe('allow');
  });
});

describe('handler — pending path (no policy match)', () => {
  it('returns the channel decision when settled allow', async () => {
    const promise = handle(makeRequest());
    // Wait a tick for create→registry path to register pending
    await Promise.resolve();
    const pending = registry.listPending();
    expect(pending).toHaveLength(1);
    registry.settle(pending[0]!.id, { permission: 'allow', decidedBy: 'local-ui', reason: 'user clicked allow' });
    const res = await promise;
    expect(res.decision).toBe('allow');
    expect(res.reason).toBe('user clicked allow');
  });

  it('timeout maps to decision=ask', async () => {
    const req = makeRequest({});
    // Override default timeout for fast test
    registry.shutdown();
    registry = new ApprovalRegistry(db, { defaultTimeoutMs: 30 });
    handle = createApprovalHandler({ policy, registry, resolveCwd: () => '/proj' });

    const res = await handle(req);
    expect(res.decision).toBe('ask');
  });

  it('persists pending row reachable via getApprovalRequest until settled', async () => {
    const promise = handle(makeRequest());
    await Promise.resolve();
    const [pending] = registry.listPending();
    expect(getApprovalRequest(db, pending!.id)?.status).toBe('pending');
    registry.settle(pending!.id, { permission: 'deny', decidedBy: 'lark' });
    await promise;
    expect(getApprovalRequest(db, pending!.id)?.status).toBe('denied');
  });
});

describe('handler — concurrency / attack', () => {
  it('parallel host_approval_request calls produce independent pending rows', async () => {
    const p1 = handle(makeRequest({ command: 'a' }));
    const p2 = handle(makeRequest({ command: 'b' }));
    await Promise.resolve();
    const pending = registry.listPending();
    expect(pending).toHaveLength(2);
    registry.settle(pending[0]!.id, { permission: 'allow', decidedBy: 'local-ui' });
    registry.settle(pending[1]!.id, { permission: 'deny', decidedBy: 'lark' });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect([r1.decision, r2.decision].sort()).toEqual(['allow', 'deny']);
  });

  it('attack: handler still works when resolveCwd is not provided (no path rules will match without cwd)', async () => {
    handle = createApprovalHandler({ policy, registry });
    policy.add({ tool: 'Write', pathPrefix: '/proj', decision: 'allow' });
    const promise = handle(makeRequest({ tool: 'Write', command: 'src/foo.ts' }));
    await Promise.resolve();
    expect(registry.listPending()).toHaveLength(1);
    registry.settle(registry.listPending()[0]!.id, { permission: 'allow', decidedBy: 'local-ui' });
    expect((await promise).decision).toBe('allow');
  });

  it('attack: registry shutdown mid-flight settles awaiting handler as ask', async () => {
    const promise = handle(makeRequest());
    await Promise.resolve();
    registry.shutdown('shutdown');
    const res = await promise;
    expect(res.decision).toBe('ask');
  });
});
