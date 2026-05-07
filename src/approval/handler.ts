/**
 * Approval handler — orchestrates the full host_approval_request flow:
 *
 *   1. policy.match → if a stored rule covers this request, return its decision
 *      immediately (incrementing hits as a side effect).
 *   2. Otherwise create a pending row in the registry, await its settlement.
 *      The registry's onPendingCreated event lets channels (LocalChannel UI,
 *      LarkChannel) notify the user; whichever decision arrives first wins.
 *   3. Map the outcome to the bridge response shape ({ decision, reason }).
 *
 * This is the function the bridge's host_approval_request handler should call.
 * It intentionally exposes a small surface so Phase 5 (LocalChannel) can swap
 * in a different registry / policy without touching the bridge wiring.
 */

import type {
  HostApprovalRequestRequest,
  HostApprovalRequestResponse,
} from '../bridge/protocol.js';
import type { ApprovalPolicyEngine } from './policy.js';
import type { ApprovalRegistry } from './registry.js';
import type { PolicyMatchInput } from './types.js';

export interface ApprovalHandlerDeps {
  policy: ApprovalPolicyEngine;
  registry: ApprovalRegistry;
  /**
   * Resolve cwd for this request. The bridge protocol's HostApprovalRequestRequest
   * doesn't carry cwd directly — it lives in the host_session row. Phase 5 will
   * wire in `getHostSession(id).cwd`; in tests we inject a fixed value.
   */
  resolveCwd?: (hostSessionId: string | undefined) => string | undefined;
  /**
   * Phase 46: scope filter. When this returns false, the request is auto-
   * allowed without creating a pending row or pushing to any channel — the
   * user clearly hasn't asked helm to gate this chat. Production wires it
   * to "session has at least one Lark binding"; tests omit (defaults to
   * always-required so existing behavior is unchanged).
   */
  requireApproval?: (hostSessionId: string | undefined) => boolean;
}

export function createApprovalHandler(deps: ApprovalHandlerDeps) {
  const { policy, registry, resolveCwd, requireApproval } = deps;

  return async function handleHostApprovalRequest(
    req: HostApprovalRequestRequest,
  ): Promise<HostApprovalRequestResponse> {
    const cwd = resolveCwd?.(req.host_session_id);
    const matchInput: PolicyMatchInput = {
      tool: req.tool,
      command: req.command,
      cwd,
    };

    // 1. Stored rule fast path. Runs BEFORE the requireApproval gate so
    //    explicit deny rules still apply to chats that aren't bound to any
    //    remote channel — the gate only skips the user-prompt path.
    const policyMatch = policy.match(matchInput);
    if (policyMatch) {
      // Persist a record so the audit trail shows what auto-decided.
      const persisted = registry.create({
        hostSessionId: req.host_session_id,
        tool: req.tool,
        command: req.command,
        cwd,
        payload: req.payload,
      });
      registry.settle(persisted.request.id, {
        permission: policyMatch.permission,
        decidedBy: 'policy',
        reason: `policy rule ${policyMatch.rule.id}`,
      });
      // settle resolves the awaiter synchronously above, so awaiting is cheap.
      const settled = await persisted.settled;
      return {
        decision: settled.permission === 'ask'
          ? 'ask'
          : settled.permission,
        reason: settled.reason,
      };
    }

    // 2. Phase 46: scope gate. helm intercepts every Cursor tool call by
    //    default, but if the user hasn't bound this chat to any remote channel
    //    (Lark thread / etc.), there's nothing to ask — auto-allow without
    //    creating a pending row that nobody will decide on. The Cursor app's
    //    own permission UI is still in front, so this just suppresses helm's
    //    additional layer for the unbound case.
    if (requireApproval && !requireApproval(req.host_session_id)) {
      return {
        decision: 'allow',
        reason: 'no remote channel binding — helm auto-allowed',
      };
    }

    // 3. No rule, gate passed — wait for a channel / UI / timeout.
    const created = registry.create({
      hostSessionId: req.host_session_id,
      tool: req.tool,
      command: req.command,
      cwd,
      payload: req.payload,
    });
    const settled = await created.settled;

    return {
      decision: settled.permission,
      reason: settled.reason,
    };
  };
}
