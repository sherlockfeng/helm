/**
 * Approval policy engine.
 *
 * Rules persist in the `approval_policies` SQLite table (see storage/repos/approval.ts).
 * This module owns the *matching* logic: given an incoming approval request,
 * find the most specific allow/deny rule, increment its hits counter, and return
 * the decision to the handler.
 *
 * Match precedence (most-specific wins):
 *   1. tool name must equal exactly
 *   2. mcp__* tools with toolScope=true match unconditionally
 *   3. pathPrefix: command (when an absolute path) or cwd starts with the prefix
 *   4. commandPrefix: command starts with the prefix; empty prefix only matches empty command
 *   5. ranking by max(pathPrefix.length, commandPrefix.length)
 *
 * Ported from agent2lark-cursor/src/approval-policy.js with persistence delegated
 * to the SQLite repo so the registry, UI, and Lark adapter all see the same data.
 */

import type Database from 'better-sqlite3';
import path from 'node:path';
import {
  incrementPolicyHits,
  insertApprovalPolicy,
  listAllPolicies,
  listPoliciesForTool,
  deleteApprovalPolicy,
} from '../storage/repos/approval.js';
import type { ApprovalPolicy as ApprovalPolicyRow } from '../storage/types.js';
import type { PolicyMatch, PolicyMatchInput } from './types.js';

function ensureTrailingSlash(value: string): string {
  if (!value) return '';
  return value.endsWith('/') ? value : `${value}/`;
}

function isAbsolutePathLike(value: string): boolean {
  const head = value.split(/\s+/, 1)[0] ?? '';
  return path.isAbsolute(head);
}

function ruleMatches(rule: ApprovalPolicyRow, input: PolicyMatchInput): boolean {
  if (rule.tool !== input.tool) return false;
  if (rule.toolScope) return true;

  const command = input.command ?? '';
  const cwd = input.cwd ?? '';

  if (rule.pathPrefix) {
    const normalized = ensureTrailingSlash(rule.pathPrefix);
    if (isAbsolutePathLike(command)) {
      return command.startsWith(normalized);
    }
    return ensureTrailingSlash(cwd).startsWith(normalized);
  }

  if (rule.commandPrefix) {
    return command.startsWith(rule.commandPrefix);
  }

  // Empty-prefix rule: only matches when the incoming command is empty too.
  // Otherwise a stale broad rule could silently auto-approve everything.
  return command.trim().length === 0;
}

function rank(rule: ApprovalPolicyRow): number {
  // toolScope rules are most specific (mcp__ exact tool match — hard to be more
  // specific than that). Otherwise prefer the longer prefix.
  if (rule.toolScope) return Number.MAX_SAFE_INTEGER;
  return Math.max((rule.pathPrefix ?? '').length, (rule.commandPrefix ?? '').length);
}

export interface AddPolicyInput {
  tool: string;
  decision: 'allow' | 'deny';
  commandPrefix?: string;
  pathPrefix?: string;
  toolScope?: boolean;
}

let policyIdCounter = 0;
function newPolicyId(): string {
  policyIdCounter += 1;
  // Random + counter to keep ordering stable in tests while still avoiding collisions.
  return `pol_${Date.now().toString(36)}_${policyIdCounter.toString(36)}`;
}

export class ApprovalPolicyEngine {
  constructor(private readonly db: Database.Database) {}

  /**
   * Match the input against all stored rules; return the most specific
   * matching rule + its decision, or null when no rule applies. Hits counter
   * for the winning rule is incremented as a side effect.
   */
  match(input: PolicyMatchInput): PolicyMatch | null {
    const candidates = listPoliciesForTool(this.db, input.tool)
      .filter((rule) => ruleMatches(rule, input));
    if (candidates.length === 0) return null;

    candidates.sort((a, b) => rank(b) - rank(a));
    const winner = candidates[0]!;
    incrementPolicyHits(this.db, winner.id);
    return { rule: winner, permission: winner.decision };
  }

  add(input: AddPolicyInput): ApprovalPolicyRow {
    if (!input.tool) throw new Error('ApprovalPolicyEngine.add requires tool');
    if (input.decision !== 'allow' && input.decision !== 'deny') {
      throw new Error(`ApprovalPolicyEngine.add requires decision allow|deny, got ${String(input.decision)}`);
    }
    const row: ApprovalPolicyRow = {
      id: newPolicyId(),
      tool: input.tool,
      commandPrefix: input.commandPrefix ?? undefined,
      pathPrefix: input.pathPrefix ?? undefined,
      toolScope: Boolean(input.toolScope),
      decision: input.decision,
      hits: 0,
      createdAt: new Date().toISOString(),
    };
    insertApprovalPolicy(this.db, row);
    return row;
  }

  remove(id: string): void {
    deleteApprovalPolicy(this.db, id);
  }

  list(): ApprovalPolicyRow[] {
    return listAllPolicies(this.db);
  }
}
