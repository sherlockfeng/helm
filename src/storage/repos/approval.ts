import type Database from 'better-sqlite3';
import type { ApprovalPolicy, ApprovalRequest } from '../types.js';

function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw == null || raw === '') return fallback;
  try { return JSON.parse(String(raw)) as T; } catch { return fallback; }
}

function rowToRequest(row: Record<string, unknown>): ApprovalRequest {
  return {
    id: String(row['id']),
    hostSessionId: row['host_session_id'] != null ? String(row['host_session_id']) : undefined,
    bindingId: row['binding_id'] != null ? String(row['binding_id']) : undefined,
    tool: String(row['tool']),
    command: row['command'] != null ? String(row['command']) : undefined,
    payload: parseJson<Record<string, unknown>>(row['payload'], {}),
    status: row['status'] as ApprovalRequest['status'],
    decidedBy: row['decided_by'] != null ? (row['decided_by'] as ApprovalRequest['decidedBy']) : undefined,
    reason: row['reason'] != null ? String(row['reason']) : undefined,
    createdAt: String(row['created_at']),
    decidedAt: row['decided_at'] != null ? String(row['decided_at']) : undefined,
    expiresAt: String(row['expires_at']),
  };
}

function rowToPolicy(row: Record<string, unknown>): ApprovalPolicy {
  return {
    id: String(row['id']),
    tool: String(row['tool']),
    commandPrefix: row['command_prefix'] != null ? String(row['command_prefix']) : undefined,
    pathPrefix: row['path_prefix'] != null ? String(row['path_prefix']) : undefined,
    toolScope: Boolean(row['tool_scope']),
    decision: row['decision'] as ApprovalPolicy['decision'],
    hits: Number(row['hits']),
    createdAt: String(row['created_at']),
    lastUsedAt: row['last_used_at'] != null ? String(row['last_used_at']) : undefined,
  };
}

// ── ApprovalRequest ────────────────────────────────────────────────────────

export function insertApprovalRequest(db: Database.Database, r: ApprovalRequest): void {
  db.prepare(`
    INSERT INTO approval_requests (id, host_session_id, binding_id, tool, command, payload, status, decided_by, reason, created_at, decided_at, expires_at)
    VALUES (@id, @host_session_id, @binding_id, @tool, @command, @payload, @status, @decided_by, @reason, @created_at, @decided_at, @expires_at)
  `).run({
    id: r.id, host_session_id: r.hostSessionId ?? null, binding_id: r.bindingId ?? null,
    tool: r.tool, command: r.command ?? null,
    payload: r.payload ? JSON.stringify(r.payload) : null,
    status: r.status, decided_by: r.decidedBy ?? null, reason: r.reason ?? null,
    created_at: r.createdAt, decided_at: r.decidedAt ?? null, expires_at: r.expiresAt,
  });
}

export function getApprovalRequest(db: Database.Database, id: string): ApprovalRequest | undefined {
  const row = db.prepare(`SELECT * FROM approval_requests WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToRequest(row) : undefined;
}

export function listPendingRequests(db: Database.Database, hostSessionId?: string): ApprovalRequest[] {
  if (hostSessionId) {
    return (db.prepare(
      `SELECT * FROM approval_requests WHERE status = 'pending' AND host_session_id = ? ORDER BY created_at ASC`,
    ).all(hostSessionId) as Record<string, unknown>[]).map(rowToRequest);
  }
  return (db.prepare(
    `SELECT * FROM approval_requests WHERE status = 'pending' ORDER BY created_at ASC`,
  ).all() as Record<string, unknown>[]).map(rowToRequest);
}

export function settleApprovalRequest(
  db: Database.Database,
  id: string,
  decision: { status: 'allowed' | 'denied' | 'timeout'; decidedBy: ApprovalRequest['decidedBy']; reason?: string },
): void {
  db.prepare(`
    UPDATE approval_requests SET status = ?, decided_by = ?, reason = ?, decided_at = ? WHERE id = ?
  `).run(decision.status, decision.decidedBy ?? null, decision.reason ?? null, new Date().toISOString(), id);
}

export function expireStaleRequests(db: Database.Database): number {
  const result = db.prepare(`
    UPDATE approval_requests SET status = 'timeout', decided_by = 'timeout', decided_at = ?
    WHERE status = 'pending' AND expires_at <= ?
  `).run(new Date().toISOString(), new Date().toISOString());
  return result.changes;
}

// ── ApprovalPolicy ─────────────────────────────────────────────────────────

export function insertApprovalPolicy(db: Database.Database, p: ApprovalPolicy): void {
  db.prepare(`
    INSERT INTO approval_policies (id, tool, command_prefix, path_prefix, tool_scope, decision, hits, created_at, last_used_at)
    VALUES (@id, @tool, @command_prefix, @path_prefix, @tool_scope, @decision, @hits, @created_at, @last_used_at)
  `).run({
    id: p.id, tool: p.tool, command_prefix: p.commandPrefix ?? null, path_prefix: p.pathPrefix ?? null,
    tool_scope: p.toolScope ? 1 : 0, decision: p.decision, hits: p.hits,
    created_at: p.createdAt, last_used_at: p.lastUsedAt ?? null,
  });
}

export function getApprovalPolicy(db: Database.Database, id: string): ApprovalPolicy | undefined {
  const row = db.prepare(`SELECT * FROM approval_policies WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToPolicy(row) : undefined;
}

export function listPoliciesForTool(db: Database.Database, tool: string): ApprovalPolicy[] {
  return (db.prepare(`SELECT * FROM approval_policies WHERE tool = ? ORDER BY created_at ASC`).all(tool) as Record<string, unknown>[]).map(rowToPolicy);
}

export function listAllPolicies(db: Database.Database): ApprovalPolicy[] {
  return (db.prepare(`SELECT * FROM approval_policies ORDER BY tool ASC, created_at ASC`).all() as Record<string, unknown>[]).map(rowToPolicy);
}

export function incrementPolicyHits(db: Database.Database, id: string): void {
  db.prepare(`UPDATE approval_policies SET hits = hits + 1, last_used_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
}

export function deleteApprovalPolicy(db: Database.Database, id: string): void {
  db.prepare(`DELETE FROM approval_policies WHERE id = ?`).run(id);
}
