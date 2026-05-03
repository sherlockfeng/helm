import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteApprovalPolicy, expireStaleRequests, getApprovalPolicy, getApprovalRequest,
  incrementPolicyHits, insertApprovalPolicy, insertApprovalRequest,
  listAllPolicies, listPendingRequests, listPoliciesForTool, settleApprovalRequest,
} from '../../../src/storage/repos/approval.js';
import { runMigrations } from '../../../src/storage/migrations.js';
import type { ApprovalPolicy, ApprovalRequest } from '../../../src/storage/types.js';

function openDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  return { id: 'req1', tool: 'shell', status: 'pending', createdAt: now, expiresAt: future, ...overrides };
}

function makePolicy(overrides: Partial<ApprovalPolicy> = {}): ApprovalPolicy {
  return { id: 'p1', tool: 'shell', toolScope: false, decision: 'allow', hits: 0, createdAt: new Date().toISOString(), ...overrides };
}

describe('approval requests', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); });
  afterEach(() => { db.close(); });

  it('inserts and retrieves a request', () => {
    insertApprovalRequest(db, makeRequest());
    const got = getApprovalRequest(db, 'req1');
    expect(got?.tool).toBe('shell');
    expect(got?.status).toBe('pending');
  });

  it('listPendingRequests returns only pending', () => {
    insertApprovalRequest(db, makeRequest({ id: 'req1' }));
    insertApprovalRequest(db, makeRequest({ id: 'req2', status: 'allowed' }));
    const list = listPendingRequests(db);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('req1');
  });

  it('listPendingRequests filters by hostSessionId', () => {
    // host_sessions must exist for FK constraint
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO host_sessions (id, host, status, first_seen_at, last_seen_at) VALUES ('s1','cursor','active',?,?)`).run(now, now);
    db.prepare(`INSERT INTO host_sessions (id, host, status, first_seen_at, last_seen_at) VALUES ('s2','cursor','active',?,?)`).run(now, now);
    insertApprovalRequest(db, makeRequest({ id: 'req1', hostSessionId: 's1' }));
    insertApprovalRequest(db, makeRequest({ id: 'req2', hostSessionId: 's2' }));
    expect(listPendingRequests(db, 's1')).toHaveLength(1);
  });

  it('settleApprovalRequest updates status and decidedAt', () => {
    insertApprovalRequest(db, makeRequest());
    settleApprovalRequest(db, 'req1', { status: 'allowed', decidedBy: 'local-ui' });
    const got = getApprovalRequest(db, 'req1');
    expect(got?.status).toBe('allowed');
    expect(got?.decidedBy).toBe('local-ui');
    expect(got?.decidedAt).toBeTruthy();
  });

  it('serializes and deserializes payload JSON', () => {
    const payload = { cmd: 'rm -rf /', args: ['-f'] };
    insertApprovalRequest(db, makeRequest({ payload }));
    expect(getApprovalRequest(db, 'req1')?.payload).toEqual(payload);
  });

  it('expireStaleRequests marks timed-out requests', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    insertApprovalRequest(db, makeRequest({ id: 'stale', expiresAt: past }));
    insertApprovalRequest(db, makeRequest({ id: 'fresh' }));
    const expired = expireStaleRequests(db);
    expect(expired).toBe(1);
    expect(getApprovalRequest(db, 'stale')?.status).toBe('timeout');
    expect(getApprovalRequest(db, 'fresh')?.status).toBe('pending');
  });

  it('attack: duplicate request id throws', () => {
    insertApprovalRequest(db, makeRequest());
    expect(() => insertApprovalRequest(db, makeRequest())).toThrow();
  });

  it('attack: settling non-existent request is a no-op', () => {
    expect(() => settleApprovalRequest(db, 'ghost', { status: 'allowed', decidedBy: 'local-ui' })).not.toThrow();
  });
});

describe('approval policies', () => {
  let db: BetterSqlite3.Database;
  beforeEach(() => { db = openDb(); });
  afterEach(() => { db.close(); });

  it('inserts and retrieves a policy', () => {
    insertApprovalPolicy(db, makePolicy());
    const got = getApprovalPolicy(db, 'p1');
    expect(got?.tool).toBe('shell');
    expect(got?.decision).toBe('allow');
  });

  it('listPoliciesForTool returns only matching', () => {
    insertApprovalPolicy(db, makePolicy({ id: 'p1', tool: 'shell' }));
    insertApprovalPolicy(db, makePolicy({ id: 'p2', tool: 'mcp' }));
    expect(listPoliciesForTool(db, 'shell')).toHaveLength(1);
    expect(listAllPolicies(db)).toHaveLength(2);
  });

  it('incrementPolicyHits increments and updates lastUsedAt', () => {
    insertApprovalPolicy(db, makePolicy());
    incrementPolicyHits(db, 'p1');
    incrementPolicyHits(db, 'p1');
    const got = getApprovalPolicy(db, 'p1');
    expect(got?.hits).toBe(2);
    expect(got?.lastUsedAt).toBeTruthy();
  });

  it('deleteApprovalPolicy removes the policy', () => {
    insertApprovalPolicy(db, makePolicy());
    deleteApprovalPolicy(db, 'p1');
    expect(getApprovalPolicy(db, 'p1')).toBeUndefined();
  });

  it('attack: commandPrefix and pathPrefix stored and retrieved correctly', () => {
    insertApprovalPolicy(db, makePolicy({ commandPrefix: 'git ', pathPrefix: '/src' }));
    const got = getApprovalPolicy(db, 'p1');
    expect(got?.commandPrefix).toBe('git ');
    expect(got?.pathPrefix).toBe('/src');
  });
});
