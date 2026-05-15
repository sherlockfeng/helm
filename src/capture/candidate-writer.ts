/**
 * Candidate writer (Phase 78).
 *
 * Thin wrapper around `insertCandidateIfNew` that computes the dedup
 * hash + assembles the full row from the scorer's output. Kept as its
 * own file so the orchestrator stays free of plumbing — and so tests
 * can hammer the hash + dedup path without touching scorer logic.
 */

import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { insertCandidateIfNew } from '../storage/repos/knowledge-candidates.js';
import type { KnowledgeCandidate, KnowledgeChunkKind } from '../storage/types.js';

export interface WriteCandidateInput {
  roleId: string;
  hostSessionId?: string;
  chunkText: string;
  sourceSegmentIndex: number;
  kind: KnowledgeChunkKind;
  scoreEntity: number;
  scoreCosine: number;
  createdAt: string;
}

export interface WriteCandidateResult {
  /** The fully-populated candidate row (whether inserted or not). */
  candidate: KnowledgeCandidate;
  /** True when a row was written; false when the dedup gate skipped it. */
  inserted: boolean;
}

/**
 * Build the row, run the dedup-aware insert. Hash is sha256 of the EXACT
 * chunk_text we'd persist (no normalization) so a one-character edit
 * counts as a different candidate.
 *
 * The unique index covers (role_id, text_hash) WHERE status IN
 * ('pending', 'rejected'). So:
 *   - same segment, role currently has a PENDING candidate → skip
 *   - same segment, role previously REJECTED that text → skip
 *     (Decision §8: reject is terminal; the writer won't re-surface)
 *   - same segment, role previously ACCEPTED that text → insert is
 *     allowed; if the accepted chunk was later deleted, the user might
 *     want to be reminded
 */
export function writeCandidateIfNew(
  db: Database.Database,
  input: WriteCandidateInput,
): WriteCandidateResult {
  const textHash = createHash('sha256').update(input.chunkText).digest('hex');
  const candidate: KnowledgeCandidate = {
    id: randomUUID(),
    roleId: input.roleId,
    chunkText: input.chunkText,
    sourceSegmentIndex: input.sourceSegmentIndex,
    kind: input.kind,
    scoreEntity: input.scoreEntity,
    scoreCosine: input.scoreCosine,
    textHash,
    status: 'pending',
    createdAt: input.createdAt,
  };
  if (input.hostSessionId !== undefined) candidate.hostSessionId = input.hostSessionId;
  const inserted = insertCandidateIfNew(db, candidate);
  return { candidate, inserted };
}
