/**
 * MCP tool: get_active_chats
 *
 * Returns the list of currently-active host sessions so an agent (running in
 * one chat) can discover sibling chats — e.g. "is the design doc author still
 * working in /proj?". Mirrors the cwd, campaign/cycle binding, and lastSeenAt
 * from the host_sessions table.
 *
 * Per PROJECT_BLUEPRINT.md §13.2.
 */

import type Database from 'better-sqlite3';
import { listActiveSessions } from '../../storage/repos/host-sessions.js';

export interface ActiveChatsResult {
  chats: Array<{
    hostSessionId: string;
    host: string;
    cwd?: string;
    campaignId?: string;
    cycleId?: string;
    composerMode?: string;
    lastSeenAt: string;
  }>;
}

export function getActiveChats(db: Database.Database): ActiveChatsResult {
  const sessions = listActiveSessions(db);
  return {
    chats: sessions.map((s) => ({
      hostSessionId: s.id,
      host: s.host,
      cwd: s.cwd,
      campaignId: s.campaignId,
      cycleId: s.cycleId,
      composerMode: s.composerMode,
      lastSeenAt: s.lastSeenAt,
    })),
  };
}
