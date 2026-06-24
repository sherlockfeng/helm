/**
 * Files-as-truth backfill helper.
 *
 * Knowledge can enter helm two ways:
 *   1. Chat-accept / 沉淀 → writeCapturedPoint writes chat-captured/<user>/<role>/
 *      <chunkId>.md immediately (files-as-truth).
 *   2. MCP train_role / update_role (created from a coding agent) → chunks go
 *      straight into the SQLite index with source_file set to a bare document
 *      name, and NO file is written.
 *
 * Path 2 leaves the chunk file-less, so it never shows in personal-tier sync
 * (which reads `git status` of chat-captured/) and would be lost if the index
 * were rebuilt from files. This helper closes that gap: it materializes any
 * chunk that has NO backing file in the clone. Chunks that already have a real
 * file — chat-captured ones (already materialized) AND imported team-tier ones
 * (source_file points at a tracked domains/… file) — are skipped, so it never
 * re-captures team knowledge as personal files. Idempotent.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { getChunksForRole } from '../storage/repos/roles.js';

/** Minimal manager surface (so tests can fake it without git). */
export interface CapturedPointWriter {
  writeCapturedPoint(input: {
    repoId: string;
    chunkId: string;
    username: string;
  }): Promise<{ relPath: string }>;
}

export async function captureUnbackedRoleChunks(opts: {
  db: Database.Database;
  manager: CapturedPointWriter;
  repoId: string;
  /** Clone working dir — used to check whether a chunk's source_file exists. */
  repoLocalPath: string;
  username: string;
  roleId: string;
  onError?: (chunkId: string, message: string) => void;
}): Promise<number> {
  let written = 0;
  for (const chunk of getChunksForRole(opts.db, opts.roleId)) {
    // Already backed by a real file (chat-captured OR an imported team-tier
    // doc) → leave it alone.
    if (chunk.sourceFile && existsSync(join(opts.repoLocalPath, chunk.sourceFile))) {
      continue;
    }
    try {
      await opts.manager.writeCapturedPoint({
        repoId: opts.repoId,
        chunkId: chunk.id,
        username: opts.username,
      });
      written += 1;
    } catch (err) {
      opts.onError?.(chunk.id, (err as Error).message);
    }
  }
  return written;
}
