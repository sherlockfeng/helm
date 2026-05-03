/**
 * MCP tool: bind_to_remote_channel
 *
 * Lets the agent kick off a binding between a host session (Cursor chat) and a
 * RemoteChannel thread, replacing the manual UI click. Two modes:
 *
 *   - With externalThread → create the binding immediately. Returns bindingId.
 *   - Without externalThread → create a pending_bind code that the user types
 *     into the channel side (e.g. "@bot bind <code>"). Returns pendingCode +
 *     a human-readable instruction the agent can show.
 *
 * Per PROJECT_BLUEPRINT.md §13.2 + §11.2.
 */

import type Database from 'better-sqlite3';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  insertChannelBinding,
  insertPendingBind,
  getBindingByThread,
} from '../../storage/repos/channel-bindings.js';
import { getHostSession } from '../../storage/repos/host-sessions.js';

export interface BindToRemoteChannelInput {
  hostSessionId: string;
  channel: string;
  externalChat?: string;
  externalThread?: string;
  externalRoot?: string;
}

export type BindToRemoteChannelResult =
  | { kind: 'bound'; bindingId: string; reused: boolean }
  | { kind: 'pending'; pendingCode: string; instruction: string; expiresAt: string };

const PENDING_BIND_TTL_MS = 10 * 60 * 1000;

function newBindingCode(): string {
  // 6 hex chars = 16M codes; collision risk for an in-flight code is negligible
  // and the code is single-use anyway.
  return randomBytes(3).toString('hex').toUpperCase();
}

export function bindToRemoteChannel(
  db: Database.Database,
  input: BindToRemoteChannelInput,
): BindToRemoteChannelResult {
  const session = getHostSession(db, input.hostSessionId);
  if (!session) {
    throw new Error(`unknown host_session_id: ${input.hostSessionId}`);
  }

  if (input.externalThread && input.externalChat) {
    // Reuse path — if (channel, chat, thread) already bound, return the existing id.
    const existing = getBindingByThread(db, input.channel, input.externalChat, input.externalThread);
    if (existing) {
      return { kind: 'bound', bindingId: existing.id, reused: true };
    }

    const bindingId = `bnd_${randomUUID()}`;
    insertChannelBinding(db, {
      id: bindingId,
      channel: input.channel,
      hostSessionId: input.hostSessionId,
      externalChat: input.externalChat,
      externalThread: input.externalThread,
      externalRoot: input.externalRoot,
      waitEnabled: true,
      createdAt: new Date().toISOString(),
    });
    return { kind: 'bound', bindingId, reused: false };
  }

  // No thread provided → handshake mode.
  const code = newBindingCode();
  const expiresAt = new Date(Date.now() + PENDING_BIND_TTL_MS).toISOString();
  insertPendingBind(db, {
    code,
    channel: input.channel,
    externalChat: input.externalChat,
    externalThread: input.externalThread,
    externalRoot: input.externalRoot,
    expiresAt,
  });

  const instruction = `Send "@bot bind ${code}" in the ${input.channel} thread you want to mirror this chat to. Code expires in 10 minutes.`;
  return { kind: 'pending', pendingCode: code, instruction, expiresAt };
}
