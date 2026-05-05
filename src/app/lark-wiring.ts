/**
 * Lark orchestration — connects a LarkChannel instance to the rest of the
 * Helm app:
 *
 *   - Approval decisions:
 *       /allow / /deny      → resolve "latest pending" → registry.settle
 *       /allow! <scope>     → also write an ApprovalPolicy rule
 *
 *   - Inbound messages (intent-tagged by command-parser):
 *       bind          → insert pending_binds + reply with code
 *       unbind        → drop the binding for this thread + reply
 *       disable_wait  → toggle binding.waitEnabled = false + reply
 *       help          → reply with the canonical help text
 *       unknown       → enqueue into channel_message_queue (drained by host_stop)
 *
 * Returns an Unsubscribe-style cleanup so the orchestrator can detach on
 * shutdown without destroying the channel itself.
 */

import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ApprovalDecision, InboundMessage } from '../channel/types.js';
import type { LarkChannel, LarkInboundMetadata } from '../channel/lark/adapter.js';
import { buildHelpText } from '../channel/lark/command-parser.js';
import {
  findBindingForLarkThread,
  pickTargetApprovalId,
  policyInputFromScope,
} from '../channel/lark/binding-resolver.js';
import type { ApprovalPolicyEngine } from '../approval/policy.js';
import type { ApprovalRegistry } from '../approval/registry.js';
import {
  enqueueMessage,
  getChannelBinding,
  insertChannelBinding,
  insertPendingBind,
  listBindingsForSession,
  updateChannelBinding,
} from '../storage/repos/channel-bindings.js';
import { listPendingRequests } from '../storage/repos/approval.js';
import type { Logger } from '../logger/index.js';
import type { EventBus } from '../events/bus.js';
import type { ChannelBinding } from '../storage/types.js';

const PENDING_BIND_TTL_MS = 10 * 60 * 1000;

export interface LarkWiringDeps {
  db: Database.Database;
  channel: LarkChannel;
  registry: ApprovalRegistry;
  policy: ApprovalPolicyEngine;
  events: EventBus;
  log: Logger;
}

export interface LarkWiringHandle {
  detach(): void;
}

function newBindingCode(): string {
  return randomBytes(3).toString('hex').toUpperCase();
}

function newBindingId(): string {
  return `bnd_${randomBytes(8).toString('hex')}`;
}

/**
 * Look up every Lark binding that maps onto a given host_session_id, using
 * a single host_session_id index lookup. The orchestrator uses this when a
 * Cursor-side approval needs to be mirrored into Lark.
 */
function bindingsForSession(db: Database.Database, hostSessionId: string): ChannelBinding[] {
  return listBindingsForSession(db, hostSessionId).filter((b) => b.channel === 'lark');
}

export function attachLarkChannel(deps: LarkWiringDeps): LarkWiringHandle {
  const { db, channel, registry, log } = deps;

  const offDecision = channel.onApprovalDecision((decision) =>
    handleApprovalDecision(deps, decision));

  const offInbound = channel.onInboundMessage((message) =>
    handleInbound(deps, message as InboundMessage & { metadata?: LarkInboundMetadata }));

  // Mirror new Cursor-side approvals into any existing Lark thread. The
  // local-channel push is wired in orchestrator.ts; this listener is the
  // Lark twin.
  const offPending = registry.onPendingCreated((req) => {
    if (!req.hostSessionId) return;
    const bindings = bindingsForSession(db, req.hostSessionId);
    for (const binding of bindings) {
      void channel.sendApprovalRequest(req, binding).catch((err) => {
        log.warn('lark_send_approval_failed', {
          data: { approvalId: req.id, bindingId: binding.id, error: (err as Error).message },
        });
      });
    }
  });

  return {
    detach(): void {
      offDecision();
      offInbound();
      offPending();
    },
  };
}

async function handleApprovalDecision(deps: LarkWiringDeps, decision: ApprovalDecision): Promise<void> {
  const { db, registry, policy, events, log, channel } = deps;
  const source = decision.source ?? {};
  const larkChatId = String(source['larkChatId'] ?? '');
  const larkThreadId = source['larkThreadId'] ? String(source['larkThreadId']) : undefined;
  const larkMessageId = String(source['larkMessageId'] ?? '');

  // Find which host_session this Lark thread is bound to.
  const allBindings = db.prepare(
    `SELECT * FROM channel_bindings WHERE channel = 'lark' AND external_chat = ?`,
  ).all(larkChatId) as unknown[];
  // Going through the typed repo to avoid raw row decoding here.
  const bindingsTyped = (allBindings.map((row) => row as Record<string, unknown>))
    .map((row) => getChannelBinding(db, String(row['id'])))
    .filter((b): b is ChannelBinding => Boolean(b));
  const binding = findBindingForLarkThread(bindingsTyped, larkChatId, larkThreadId);

  if (!binding || !binding.hostSessionId) {
    log.warn('lark_decision_no_binding', { data: { larkChatId, larkThreadId } });
    void replyToLark(channel, larkChatId, larkMessageId, 'No active binding for this thread. Send `@bot bind chat` first.');
    return;
  }

  const pending = listPendingRequests(db, binding.hostSessionId);
  const targetId = pickTargetApprovalId(pending, decision.approvalId);
  if (!targetId) {
    void replyToLark(channel, larkChatId, larkMessageId,
      decision.approvalId
        ? `No pending approval matches \`${decision.approvalId}\`.`
        : 'No pending approval to act on.');
    return;
  }

  // Apply remember-policy first so the rule is in place before we settle.
  const remember = source['remember'] === true;
  const scope = source['scope'] ? String(source['scope']) : undefined;
  if (remember) {
    const input = policyInputFromScope(scope, decision.decision);
    if (input) {
      try {
        const rule = policy.add(input);
        log.info('lark_policy_added', {
          data: { ruleId: rule.id, tool: rule.tool, decision: rule.decision, scope },
        });
      } catch (err) {
        log.warn('lark_policy_add_failed', { data: { error: (err as Error).message, scope } });
      }
    }
  }

  const settled = registry.settle(targetId, {
    permission: decision.decision,
    decidedBy: 'lark',
    reason: scope ? `lark: /${decision.decision}${remember ? '!' : ''} ${scope}` : `lark: /${decision.decision}`,
  });
  if (!settled) {
    log.warn('lark_settle_no_op', { data: { approvalId: targetId } });
    void replyToLark(channel, larkChatId, larkMessageId, 'That approval was already decided.');
    return;
  }

  events.emit({
    type: 'approval.settled',
    approvalId: targetId,
    decision: decision.decision,
    decidedBy: 'lark',
    reason: scope,
  });

  void replyToLark(channel, larkChatId, larkMessageId,
    `✅ \`${decision.decision}\` recorded for \`${targetId}\`${remember ? ` (remembered: \`${scope ?? 'inferred'}\`)` : ''}.`);
}

async function handleInbound(
  deps: LarkWiringDeps,
  message: InboundMessage & { metadata?: LarkInboundMetadata },
): Promise<void> {
  const { db, log, channel, events } = deps;
  const meta = message.metadata;
  if (!meta) return; // shouldn't happen — defensive guard

  const intent = meta.intent;

  if (intent.kind === 'bind') {
    const code = newBindingCode();
    const expiresAt = new Date(Date.now() + PENDING_BIND_TTL_MS).toISOString();
    insertPendingBind(db, {
      code,
      channel: 'lark',
      externalChat: meta.larkChatId,
      externalThread: meta.larkThreadId,
      externalRoot: meta.larkMessageId,
      expiresAt,
    });
    log.info('lark_pending_bind_created', { data: { code, larkChatId: meta.larkChatId } });
    void replyToLark(channel, meta.larkChatId, meta.larkMessageId,
      `Binding code: \`${code}\`\n\nIn the Helm desktop app, open Pending Binds, choose the Cursor chat to mirror here, and click Bind. Code expires in 10 minutes.`);
    return;
  }

  if (intent.kind === 'unbind') {
    const bindings = db.prepare(
      `SELECT id FROM channel_bindings WHERE channel = 'lark' AND external_chat = ? AND (external_thread = ? OR (external_thread IS NULL AND ? IS NULL))`,
    ).all(meta.larkChatId, meta.larkThreadId ?? null, meta.larkThreadId ?? null) as Array<{ id: string }>;

    if (bindings.length === 0) {
      void replyToLark(channel, meta.larkChatId, meta.larkMessageId, 'No binding to remove.');
      return;
    }
    for (const { id } of bindings) {
      db.prepare(`DELETE FROM channel_bindings WHERE id = ?`).run(id);
      events.emit({ type: 'binding.removed', bindingId: id });
    }
    log.info('lark_unbind', { data: { count: bindings.length } });
    void replyToLark(channel, meta.larkChatId, meta.larkMessageId,
      `Removed ${bindings.length} binding${bindings.length > 1 ? 's' : ''}.`);
    return;
  }

  if (intent.kind === 'disable_wait') {
    const bindings = db.prepare(
      `SELECT id FROM channel_bindings WHERE channel = 'lark' AND external_chat = ?`,
    ).all(meta.larkChatId) as Array<{ id: string }>;
    for (const { id } of bindings) {
      updateChannelBinding(db, id, { waitEnabled: false });
    }
    log.info('lark_disable_wait', { data: { count: bindings.length } });
    void replyToLark(channel, meta.larkChatId, meta.larkMessageId,
      `Wait loop disabled for ${bindings.length} binding${bindings.length === 1 ? '' : 's'}.`);
    return;
  }

  if (intent.kind === 'help') {
    void replyToLark(channel, meta.larkChatId, meta.larkMessageId, buildHelpText());
    return;
  }

  // Unknown / non-command message. Enqueue if we have a binding, drop
  // otherwise — silent because random Lark chatter shouldn't pollute logs.
  const allInChat = db.prepare(
    `SELECT id FROM channel_bindings WHERE channel = 'lark' AND external_chat = ?`,
  ).all(meta.larkChatId) as Array<{ id: string }>;
  if (allInChat.length === 0) return;

  const binding = findBindingForLarkThread(
    allInChat.map(({ id }) => getChannelBinding(db, id)).filter((b): b is ChannelBinding => Boolean(b)),
    meta.larkChatId,
    meta.larkThreadId,
  );
  if (!binding) return;

  const messageRowId = enqueueMessage(db, {
    bindingId: binding.id,
    externalId: meta.larkMessageId,
    text: message.text,
    createdAt: new Date().toISOString(),
  });
  events.emit({ type: 'channel.message_enqueued', bindingId: binding.id, messageId: messageRowId });
  log.info('lark_message_enqueued', {
    data: { bindingId: binding.id, externalId: meta.larkMessageId },
  });
}

/**
 * Best-effort reply to a Lark inbound message. Errors are logged but never
 * thrown — the user might have torn down the bot's permission, the network
 * may be flaky, etc.; none of those should fail the inbound handler chain.
 */
async function replyToLark(
  channel: LarkChannel,
  larkChatId: string,
  larkMessageId: string,
  text: string,
): Promise<void> {
  // Reuse the synthetic binding shape sendMessage expects. We only have the
  // chat / message id from the inbound metadata, so fabricate a minimal binding.
  try {
    await channel.sendMessage(
      {
        id: `__transient_${larkMessageId}`,
        channel: 'lark',
        hostSessionId: '',
        externalChat: larkChatId,
        externalThread: larkMessageId,
        waitEnabled: false,
        createdAt: new Date().toISOString(),
      },
      text,
      { kind: 'reply' },
    );
  } catch {
    // Logged at higher level via channel.options.onListenerError; nothing else
    // to do here.
  }
}

/**
 * Install a binding from a pending_binds row. Used by the desktop UI's "Bind"
 * button (HTTP API in Phase 8 already exposes the pending list; the click
 * handler will call into here once the renderer ships a binding manager).
 *
 * Exported so the same logic powers MCP `bind_to_remote_channel` and the
 * future renderer flow without duplicating insert/event-emit code.
 */
export function consumePendingBind(
  db: Database.Database,
  events: EventBus,
  code: string,
  hostSessionId: string,
): ChannelBinding | null {
  const row = db.prepare(
    `SELECT * FROM pending_binds WHERE code = ? AND expires_at > ?`,
  ).get(code, new Date().toISOString()) as Record<string, unknown> | undefined;
  if (!row) return null;

  const id = newBindingId();
  insertChannelBinding(db, {
    id,
    channel: String(row['channel']),
    hostSessionId,
    externalChat: row['external_chat'] != null ? String(row['external_chat']) : undefined,
    externalThread: row['external_thread'] != null ? String(row['external_thread']) : undefined,
    externalRoot: row['external_root'] != null ? String(row['external_root']) : undefined,
    waitEnabled: true,
    createdAt: new Date().toISOString(),
  });
  db.prepare(`DELETE FROM pending_binds WHERE code = ?`).run(code);

  const created = getChannelBinding(db, id);
  if (created) events.emit({ type: 'binding.created', binding: created });
  return created ?? null;
}
