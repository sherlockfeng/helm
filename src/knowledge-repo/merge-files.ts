/**
 * Best-effort move of a topic's chat-captured files when it's merged into
 * another, so files-as-truth points at the merged topic and the next import
 * can't resurrect the old role. Shared by the HTTP merge handler and the
 * merge_role MCP tool so both stay consistent.
 *
 * Best-effort: silently no-ops when the wiki repo / username isn't configured,
 * and routes move errors to `onError` rather than throwing (the DB merge has
 * already succeeded; a failed file move shouldn't fail the merge).
 */
import type Database from 'better-sqlite3';
import { listKnowledgeRepos } from '../storage/repos/knowledge-repo.js';
import type { KnowledgeRepoManager } from './manager.js';

export async function moveCapturedFilesForMergeBestEffort(input: {
  db: Database.Database;
  manager?: KnowledgeRepoManager;
  wikiUsername?: string;
  fromRoleId: string;
  toRoleId: string;
  onError?: (message: string) => void;
}): Promise<void> {
  const { db, manager, wikiUsername, fromRoleId, toRoleId } = input;
  if (!manager || !wikiUsername) return;
  const wikiRepo = listKnowledgeRepos(db, { status: 'active' }).find((r) => r.profile === 'llm-wiki');
  if (!wikiRepo) return;
  try {
    await manager.moveCapturedFilesForMerge({
      repoId: wikiRepo.id, fromRoleId, toRoleId, username: wikiUsername,
    });
  } catch (err) {
    input.onError?.((err as Error).message);
  }
}
