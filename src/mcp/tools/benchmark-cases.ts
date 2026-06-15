/**
 * MCP tool implementations for managing benchmark/eval cases (closing the
 * "MCP can't manage cases" gap).
 *
 * A benchmark case = a realistic question + the expected-truth answer +
 * optional golden knowledge-point ids, scoped to a topic (knowledge
 * collection / role) as its target.
 *
 * DESIGN: cases created or edited via MCP stay `status='proposed'` and are
 * file-less. They only become files (under the topic's `cases/` dir) once the
 * user CONFIRMS them via the existing HTTP/UI confirm path. So these tools
 * touch the DB only — no file writes, no LLM. Confirmed cases are file-backed
 * and must be edited via the UI/file, never patched here.
 */

import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

import { getCase, insertCase, updateCase } from '../../storage/repos/benchmark.js';

/** Truncate a question to a sensible default case name (~60 chars). */
function defaultNameFromQuestion(question: string): string {
  const trimmed = question.trim();
  return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
}

function questionHash(question: string): string {
  return createHash('sha256').update(question).digest('hex').slice(0, 32);
}

export function proposeBenchmarkCase(
  db: Database.Database,
  input: {
    topicId: string;
    question: string;
    expectedTruth: string;
    name?: string;
    goldenPointIds?: string[];
  },
): { caseId: string; status: string } {
  const id = randomUUID();
  insertCase(db, {
    id,
    name: input.name ?? defaultNameFromQuestion(input.question),
    question: input.question,
    expectedTruth: input.expectedTruth,
    goldenPointIds: input.goldenPointIds ?? [],
    targetRoleIds: [input.topicId],
    proposedSource: 'manual',
    status: 'proposed',
    proposedQuestionHash: questionHash(input.question),
  });
  return { caseId: id, status: 'proposed' };
}

export function updateBenchmarkCase(
  db: Database.Database,
  input: {
    caseId: string;
    name?: string;
    question?: string;
    expectedTruth?: string;
    goldenPointIds?: string[];
  },
): { caseId: string; updated: boolean; message?: string } {
  const existing = getCase(db, input.caseId);
  if (!existing) {
    return { caseId: input.caseId, updated: false, message: 'case not found' };
  }
  if (existing.status !== 'proposed') {
    return {
      caseId: input.caseId,
      updated: false,
      message:
        '已确认的 case 请在 UI/文件里改（confirmed cases are file-backed; edit via UI/file)',
    };
  }
  updateCase(db, input.caseId, {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.question !== undefined ? { question: input.question } : {}),
    ...(input.expectedTruth !== undefined ? { expectedTruth: input.expectedTruth } : {}),
    ...(input.goldenPointIds !== undefined ? { goldenPointIds: input.goldenPointIds } : {}),
  });
  return { caseId: input.caseId, updated: true };
}
