/**
 * update_doc_first — the doc-first audit primitive that gates every dev task.
 *
 * Writes the requested doc to disk (creating parent dirs as needed), records a
 * row in doc_audit_log with a content hash + a fresh token, and returns that
 * token so complete_task can verify the dev wrote a doc before touching code.
 *
 * Extracted from relay/src/mcp/server.ts (inline implementation) so it can be
 * unit-tested without booting the MCP server.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { insertDocAudit } from '../storage/repos/doc-audit.js';

export interface UpdateDocFirstInput {
  filePath: string;
  content: string;
  taskId?: string;
  /** Resolve filePath against this dir when relative. Defaults to process.cwd(). */
  baseDir?: string;
}

export interface UpdateDocFirstResult {
  auditToken: string;
  filePath: string;
  contentHash: string;
}

function resolveTarget(filePath: string, baseDir: string): string {
  return isAbsolute(filePath) ? filePath : resolve(join(baseDir, filePath));
}

export function updateDocFirst(
  db: Database.Database,
  input: UpdateDocFirstInput,
): UpdateDocFirstResult {
  if (!input.filePath || !input.filePath.trim()) {
    throw new Error('updateDocFirst: filePath is required');
  }

  const baseDir = input.baseDir ?? process.cwd();
  const target = resolveTarget(input.filePath, baseDir);

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, input.content, 'utf8');

  const contentHash = createHash('sha256').update(input.content).digest('hex').slice(0, 16);
  const token = randomUUID();
  insertDocAudit(db, {
    token,
    taskId: input.taskId,
    filePath: target,
    contentHash,
    createdAt: new Date().toISOString(),
  });

  return { auditToken: token, filePath: target, contentHash };
}
