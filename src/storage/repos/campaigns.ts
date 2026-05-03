import type Database from 'better-sqlite3';
import type { Campaign, Cycle, Screenshot, Task } from '../types.js';

function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw == null || raw === '') return fallback;
  try { return JSON.parse(String(raw)) as T; } catch { return fallback; }
}

function rowToCampaign(row: Record<string, unknown>): Campaign {
  return {
    id: String(row['id']),
    projectPath: String(row['project_path']),
    title: String(row['title']),
    brief: row['brief'] != null ? String(row['brief']) : undefined,
    status: row['status'] as Campaign['status'],
    startedAt: String(row['started_at']),
    completedAt: row['completed_at'] != null ? String(row['completed_at']) : undefined,
    summary: row['summary'] != null ? String(row['summary']) : undefined,
  };
}

function rowToCycle(row: Record<string, unknown>): Cycle {
  return {
    id: String(row['id']),
    campaignId: String(row['campaign_id']),
    cycleNum: Number(row['cycle_num']),
    status: row['status'] as Cycle['status'],
    productBrief: row['product_brief'] != null ? String(row['product_brief']) : undefined,
    screenshots: parseJson<Screenshot[]>(row['screenshots'], []),
    startedAt: row['started_at'] != null ? String(row['started_at']) : undefined,
    completedAt: row['completed_at'] != null ? String(row['completed_at']) : undefined,
  };
}

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: String(row['id']),
    cycleId: String(row['cycle_id']),
    role: row['role'] as Task['role'],
    title: String(row['title']),
    description: row['description'] != null ? String(row['description']) : undefined,
    acceptance: parseJson<string[]>(row['acceptance'], []),
    e2eScenarios: parseJson<string[]>(row['e2e_scenarios'], []),
    status: row['status'] as Task['status'],
    result: row['result'] != null ? String(row['result']) : undefined,
    docAuditToken: row['doc_audit_token'] != null ? String(row['doc_audit_token']) : undefined,
    comments: parseJson<string[]>(row['comments'], []),
    createdAt: String(row['created_at']),
    completedAt: row['completed_at'] != null ? String(row['completed_at']) : undefined,
  };
}

// ── Campaign ───────────────────────────────────────────────────────────────

export function insertCampaign(db: Database.Database, c: Campaign): void {
  db.prepare(`
    INSERT INTO campaigns (id, project_path, title, brief, status, started_at, completed_at, summary)
    VALUES (@id, @project_path, @title, @brief, @status, @started_at, @completed_at, @summary)
  `).run({
    id: c.id, project_path: c.projectPath, title: c.title,
    brief: c.brief ?? null, status: c.status, started_at: c.startedAt,
    completed_at: c.completedAt ?? null, summary: c.summary ?? null,
  });
}

export function getCampaign(db: Database.Database, id: string): Campaign | undefined {
  const row = db.prepare(`SELECT * FROM campaigns WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToCampaign(row) : undefined;
}

export function listCampaigns(db: Database.Database): Campaign[] {
  return (db.prepare(`SELECT * FROM campaigns ORDER BY started_at DESC`).all() as Record<string, unknown>[]).map(rowToCampaign);
}

export function updateCampaign(
  db: Database.Database,
  id: string,
  patch: Partial<Pick<Campaign, 'status' | 'completedAt' | 'summary'>>,
): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
  if (patch.completedAt !== undefined) { sets.push('completed_at = ?'); params.push(patch.completedAt); }
  if (patch.summary !== undefined) { sets.push('summary = ?'); params.push(patch.summary); }
  if (sets.length === 0) return;
  params.push(id);
  db.prepare(`UPDATE campaigns SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

// ── Cycle ──────────────────────────────────────────────────────────────────

export function insertCycle(db: Database.Database, c: Cycle): void {
  db.prepare(`
    INSERT INTO cycles (id, campaign_id, cycle_num, status, product_brief, screenshots, started_at, completed_at)
    VALUES (@id, @campaign_id, @cycle_num, @status, @product_brief, @screenshots, @started_at, @completed_at)
  `).run({
    id: c.id, campaign_id: c.campaignId, cycle_num: c.cycleNum, status: c.status,
    product_brief: c.productBrief ?? null,
    screenshots: c.screenshots ? JSON.stringify(c.screenshots) : null,
    started_at: c.startedAt ?? null, completed_at: c.completedAt ?? null,
  });
}

export function getCycle(db: Database.Database, id: string): Cycle | undefined {
  const row = db.prepare(`SELECT * FROM cycles WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToCycle(row) : undefined;
}

export function getActiveCycle(db: Database.Database, campaignId: string): Cycle | undefined {
  const row = db.prepare(
    `SELECT * FROM cycles WHERE campaign_id = ? AND status != 'completed' ORDER BY cycle_num DESC LIMIT 1`,
  ).get(campaignId) as Record<string, unknown> | undefined;
  return row ? rowToCycle(row) : undefined;
}

export function listCycles(db: Database.Database, campaignId: string): Cycle[] {
  return (db.prepare(`SELECT * FROM cycles WHERE campaign_id = ? ORDER BY cycle_num ASC`).all(campaignId) as Record<string, unknown>[]).map(rowToCycle);
}

export function updateCycle(
  db: Database.Database,
  id: string,
  patch: Partial<Pick<Cycle, 'status' | 'productBrief' | 'screenshots' | 'startedAt' | 'completedAt'>>,
): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
  if (patch.productBrief !== undefined) { sets.push('product_brief = ?'); params.push(patch.productBrief); }
  if (patch.screenshots !== undefined) { sets.push('screenshots = ?'); params.push(JSON.stringify(patch.screenshots)); }
  if (patch.startedAt !== undefined) { sets.push('started_at = ?'); params.push(patch.startedAt); }
  if (patch.completedAt !== undefined) { sets.push('completed_at = ?'); params.push(patch.completedAt); }
  if (sets.length === 0) return;
  params.push(id);
  db.prepare(`UPDATE cycles SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

// ── Task ───────────────────────────────────────────────────────────────────

export function insertTask(db: Database.Database, t: Task): void {
  db.prepare(`
    INSERT INTO tasks (id, cycle_id, role, title, description, acceptance, e2e_scenarios,
      status, result, doc_audit_token, comments, created_at, completed_at)
    VALUES (@id, @cycle_id, @role, @title, @description, @acceptance, @e2e_scenarios,
      @status, @result, @doc_audit_token, @comments, @created_at, @completed_at)
  `).run({
    id: t.id, cycle_id: t.cycleId, role: t.role, title: t.title,
    description: t.description ?? null,
    acceptance: t.acceptance ? JSON.stringify(t.acceptance) : null,
    e2e_scenarios: t.e2eScenarios ? JSON.stringify(t.e2eScenarios) : null,
    status: t.status, result: t.result ?? null,
    doc_audit_token: t.docAuditToken ?? null,
    comments: t.comments ? JSON.stringify(t.comments) : null,
    created_at: t.createdAt, completed_at: t.completedAt ?? null,
  });
}

export function getTask(db: Database.Database, id: string): Task | undefined {
  const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToTask(row) : undefined;
}

export function listTasks(db: Database.Database, cycleId: string, role?: Task['role']): Task[] {
  if (role) {
    return (db.prepare(`SELECT * FROM tasks WHERE cycle_id = ? AND role = ? ORDER BY created_at ASC`).all(cycleId, role) as Record<string, unknown>[]).map(rowToTask);
  }
  return (db.prepare(`SELECT * FROM tasks WHERE cycle_id = ? ORDER BY created_at ASC`).all(cycleId) as Record<string, unknown>[]).map(rowToTask);
}

export function updateTask(
  db: Database.Database,
  id: string,
  patch: Partial<Pick<Task, 'status' | 'result' | 'docAuditToken' | 'comments' | 'completedAt'>>,
): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
  if (patch.result !== undefined) { sets.push('result = ?'); params.push(patch.result); }
  if (patch.docAuditToken !== undefined) { sets.push('doc_audit_token = ?'); params.push(patch.docAuditToken); }
  if (patch.comments !== undefined) { sets.push('comments = ?'); params.push(JSON.stringify(patch.comments)); }
  if (patch.completedAt !== undefined) { sets.push('completed_at = ?'); params.push(patch.completedAt); }
  if (sets.length === 0) return;
  params.push(id);
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}
