/**
 * Pure helpers shared by the Lark wiring layer. No DB / channel imports —
 * everything operates on already-fetched rows + the user's typed input.
 */

import type { ApprovalRequest, ChannelBinding } from '../../storage/types.js';
import type { AddPolicyInput } from '../../approval/policy.js';

/** Tool keywords that should map to a `toolScope=true` rule when used bare. */
const TOOL_KEYWORDS: Record<string, string> = {
  shell: 'Shell',
  bash: 'Bash',
  write: 'Write',
  edit: 'Edit',
  delete: 'Delete',
  applypatch: 'ApplyPatch',
  multiedit: 'MultiEdit',
};

/**
 * Pick the latest pending approval for a host session — used when a Lark
 * /allow / /deny arrives without an explicit approval id (the user just
 * typed "/allow").
 *
 * Pending list is expected to be ordered newest-first by the caller.
 */
export function pickTargetApprovalId(
  pending: readonly ApprovalRequest[],
  explicitId: string | undefined,
): string | null {
  if (explicitId && explicitId.trim().length > 0) {
    const match = pending.find((p) => p.id === explicitId.trim());
    return match ? match.id : null;
  }
  if (pending.length === 0) return null;
  // Newest first → take last by createdAt; defensive sort.
  const sorted = [...pending].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return sorted[0]!.id;
}

/**
 * Translate the user-typed scope from `/allow! <scope>` into an
 * AddPolicyInput. Returns null when scope is unparseable.
 *
 * Mapping rules (mirrors agent2lark help text §11.2):
 *   - "mcp__server__tool"        → tool=scope, toolScope=true
 *   - bare tool keyword          → tool=ProperCase, toolScope=true
 *                                  (shell/bash/write/edit/delete/applypatch/multiedit)
 *   - "<tool keyword> <prefix>"  → tool=ProperCase, commandPrefix=prefix
 *   - anything else              → tool=Shell, commandPrefix=scope
 *
 * Decision (allow|deny) is supplied by the caller from the parsed intent.
 */
export function policyInputFromScope(
  scope: string | undefined,
  decision: 'allow' | 'deny',
): AddPolicyInput | null {
  if (!scope) return null;
  const trimmed = scope.trim();
  if (!trimmed) return null;

  if (/^mcp__[\w.-]+/.test(trimmed)) {
    return { tool: trimmed, decision, toolScope: true };
  }

  const lower = trimmed.toLowerCase();
  const tokens = lower.split(/\s+/);
  const firstTool = TOOL_KEYWORDS[tokens[0] ?? ''];

  if (firstTool && tokens.length === 1) {
    return { tool: firstTool, decision, toolScope: true };
  }
  if (firstTool && tokens.length > 1) {
    return { tool: firstTool, decision, commandPrefix: tokens.slice(1).join(' ') };
  }

  // Anything else: assume Shell command prefix. Mirrors agent2lark's
  // `/allow pnpm!` → "all `pnpm ...` Shell commands".
  return { tool: 'Shell', decision, commandPrefix: trimmed };
}

/**
 * Resolve which channel_bindings a given Lark inbound message refers to.
 *
 * Uses (channel, externalChat, externalThread) as the key. The threadId
 * may legitimately be undefined (DMs without thread context); when so we
 * fall back to (channel, externalChat) match.
 */
export function findBindingForLarkThread(
  bindings: readonly ChannelBinding[],
  larkChatId: string,
  larkThreadId: string | undefined,
): ChannelBinding | null {
  if (larkThreadId) {
    const exact = bindings.find((b) =>
      b.channel === 'lark'
      && b.externalChat === larkChatId
      && b.externalThread === larkThreadId);
    if (exact) return exact;
  }
  // Fallback: any lark binding for that chat where thread is unset.
  const fallback = bindings.find((b) =>
    b.channel === 'lark'
    && b.externalChat === larkChatId
    && !b.externalThread);
  return fallback ?? null;
}
