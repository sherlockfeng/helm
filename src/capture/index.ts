/**
 * Capture orchestrator (Phase 78).
 *
 * Top-level entrypoint called fire-and-forget from the bridge's
 * `host_agent_response` handler. Wraps the splitter → scorer → writer
 * pipeline and reports which candidates landed so the orchestrator can
 * emit the `knowledge_candidate.created` event.
 *
 * Pure data-in/data-out: takes a db handle + the response text + the
 * bound role ids + the embedder. Throws are caught at the call site;
 * the function itself doesn't swallow errors.
 */

import type Database from 'better-sqlite3';
import { splitAgentResponse, kindFromSegment } from './splitter.js';
import { scoreSegment, type CaptureThresholds } from './scorer.js';
import { writeCandidateIfNew } from './candidate-writer.js';
import type { KnowledgeCandidate } from '../storage/types.js';

export { DEFAULT_CAPTURE_THRESHOLDS } from './scorer.js';
export { splitAgentResponse } from './splitter.js';
export { writeCandidateIfNew } from './candidate-writer.js';

export interface CaptureInput {
  db: Database.Database;
  hostSessionId: string;
  roleIds: readonly string[];
  responseText: string;
  embedFn: (text: string) => Promise<Float32Array>;
  /** Optional threshold override — test path only. */
  thresholds?: Partial<CaptureThresholds>;
}

export interface CaptureSweepResult {
  /** Total segments produced by the splitter (post-minSegmentChars filter). */
  segments: number;
  /** Total candidates inserted (across all bound roles). */
  candidatesCreated: number;
  /** Per-role breakdown — `inserted` excludes dedup-skipped rows. */
  byRole: Array<{
    roleId: string;
    inserted: number;
    /** Segments that passed the scorer for this role (qualifies=true). */
    qualified: number;
    /** Segments scanned for this role (always === segments). */
    scanned: number;
    /** Phase 78 reviewer #3: set when this role was dropped mid-sweep
     * because of a race (e.g. user deleted the role between getHostSession
     * and our insert; FK violation surfaces here, not as a thrown error). */
    skippedRoleGone?: boolean;
  }>;
  /** The fully-populated candidate rows that were actually inserted. The
   * caller emits one `knowledge_candidate.created` event per entry. */
  inserted: KnowledgeCandidate[];
}

/**
 * Walk the response, score against each bound role, write qualifying
 * segments to the candidates table. Returns a structured result so the
 * orchestrator can log + emit the right SSE event count.
 *
 * Idempotent for the dedup case — re-calling with the same response
 * for a role with an existing pending row produces `inserted=0`.
 */
export async function captureFromAgentResponse(
  input: CaptureInput,
): Promise<CaptureSweepResult> {
  const { db, hostSessionId, roleIds, responseText, embedFn } = input;
  const now = new Date().toISOString();
  const byRole: CaptureSweepResult['byRole'] = [];
  const inserted: KnowledgeCandidate[] = [];

  const segments = splitAgentResponse(responseText);
  if (segments.length === 0 || roleIds.length === 0) {
    return { segments: 0, candidatesCreated: 0, byRole: [], inserted };
  }

  for (const roleId of roleIds) {
    let qualifiedCount = 0;
    let insertedCount = 0;
    // Reviewer #3: per-role race tolerance. The role binding was sampled
    // synchronously by the orchestrator before this async loop started.
    // If the user deletes the role between then and our insert,
    // writeCandidateIfNew now THROWS the FK violation (previously
    // swallowed silently — see knowledge-candidates.ts comment). Catch
    // it here so one bad role doesn't tank the rest of the sweep.
    let roleGone = false;
    try {
      for (const seg of segments) {
        const score = await scoreSegment({
          db,
          roleId,
          segmentText: seg.text,
          embedFn,
          ...(input.thresholds ? { thresholds: input.thresholds } : {}),
        });
        if (!score.qualifies) continue;
        qualifiedCount += 1;
        const result = writeCandidateIfNew(db, {
          roleId,
          hostSessionId,
          chunkText: seg.text,
          sourceSegmentIndex: seg.index,
          kind: kindFromSegment(seg.kind),
          scoreEntity: score.scoreEntity,
          scoreCosine: score.scoreCosine,
          createdAt: now,
        });
        if (result.inserted) {
          insertedCount += 1;
          inserted.push(result.candidate);
        }
      }
    } catch (err) {
      // FK violation on role_id (most likely "role got deleted under us")
      // → mark the role as gone and skip its remaining segments. Anything
      // else re-throws to the caller — that's a real bug we want to see.
      const code = (err as { code?: string }).code;
      const isFk = code === 'SQLITE_CONSTRAINT_FOREIGNKEY'
        || /FOREIGN KEY constraint failed/i.test((err as Error).message);
      if (!isFk) throw err;
      roleGone = true;
    }
    const entry: CaptureSweepResult['byRole'][number] = {
      roleId,
      inserted: insertedCount,
      qualified: qualifiedCount,
      scanned: segments.length,
    };
    if (roleGone) entry.skippedRoleGone = true;
    byRole.push(entry);
  }

  return {
    segments: segments.length,
    candidatesCreated: inserted.length,
    byRole,
    inserted,
  };
}
