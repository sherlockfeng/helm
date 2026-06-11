/**
 * Lazy title refresh for claude-code sessions.
 *
 * PR #136 syncs claude's session title (the TUI sidebar name) into
 * helm on every Stop hook. Gap: renaming an IDLE chat never fires a
 * hook — claude code has no rename event — so the new name sits in
 * the transcript until the user happens to send another message.
 *
 * This helper closes the gap from the read side: when the renderer
 * opens a conversation's detail, we tail the transcript for the
 * latest `custom-title` and update `display_name` if it moved.
 * Best-effort by design — any miss (no transcript, unreadable, not a
 * claude session) leaves the row untouched.
 */

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { getHostSession, setHostSessionDisplayName } from '../../storage/repos/host-sessions.js';
import { readLatestCustomTitle } from './transcript.js';

const DEFAULT_PROJECTS_ROOT = join(homedir(), '.claude', 'projects');

/**
 * Locate the session's transcript under ~/.claude/projects. Claude
 * encodes the project cwd into the directory name with a lossy
 * non-alphanumeric → '-' scheme, so rather than reimplementing the
 * encoder (and chasing its edge cases across claude versions), scan
 * the project dirs for `<sessionId>.jsonl`. The dir count is small
 * (one per project the user has opened claude in).
 */
export function findTranscriptPath(
  sessionId: string,
  projectsRoot: string = DEFAULT_PROJECTS_ROOT,
): string | null {
  let dirs: string[];
  try {
    dirs = readdirSync(projectsRoot);
  } catch {
    return null;
  }
  const filename = `${sessionId}.jsonl`;
  for (const dir of dirs) {
    const candidate = join(projectsRoot, dir, filename);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Refresh one session's display_name from its transcript. Returns
 * true when the row was updated. No-ops (false) for non-claude
 * sessions, missing transcripts, absent titles, or unchanged values.
 */
export function refreshClaudeSessionTitle(
  db: Database.Database,
  hostSessionId: string,
  projectsRoot?: string,
): boolean {
  const session = getHostSession(db, hostSessionId);
  if (!session || session.host !== 'claude-code') return false;

  const transcriptPath = findTranscriptPath(hostSessionId, projectsRoot);
  if (!transcriptPath) return false;

  const title = readLatestCustomTitle(transcriptPath);
  if (!title || title === session.displayName) return false;

  setHostSessionDisplayName(db, hostSessionId, title);
  return true;
}
