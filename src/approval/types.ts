import type { ApprovalPolicy as ApprovalPolicyRow, ApprovalRequest } from '../storage/types.js';

/** Input shape when creating a new pending approval. */
export interface PendingApprovalInput {
  hostSessionId?: string;
  bindingId?: string;
  tool: string;
  command?: string;
  /** Defaults to cwd from the host event. Used by policy match for path-prefix rules. */
  cwd?: string;
  payload?: Record<string, unknown>;
  /** Override expiry; defaults to registry's default timeout. */
  expiresAt?: string;
}

/** What a settler (channel UI / Lark / timeout / policy) tells the registry. */
export type DecidedBy = NonNullable<ApprovalRequest['decidedBy']>;

export interface SettleInput {
  permission: 'allow' | 'deny' | 'timeout';
  reason?: string;
  decidedBy: DecidedBy;
}

/** A settled approval, returned to the bridge handler. */
export interface SettledApproval {
  id: string;
  permission: 'allow' | 'deny' | 'ask';
  reason?: string;
  decidedBy: DecidedBy;
}

/** Result of policy.match — populated when a rule auto-decides. */
export interface PolicyMatch {
  rule: ApprovalPolicyRow;
  permission: 'allow' | 'deny';
}

/** Inputs to a policy match — small superset of PendingApprovalInput's matchable fields. */
export interface PolicyMatchInput {
  tool: string;
  command?: string;
  cwd?: string;
}
