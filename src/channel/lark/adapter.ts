/**
 * LarkChannel — RemoteChannel implementation backed by `lark-cli`.
 *
 * Per PROJECT_BLUEPRINT.md §11 / §11.2:
 *   - start():    spawn the listener (lark-cli event +subscribe)
 *   - sendMessage:   `lark-cli im +messages-reply --message-id <id> --markdown
 *                    <text> --reply-in-thread --as bot`
 *   - sendApprovalRequest: format markdown + sendMessage(binding)
 *   - createThread:  optional handshake via `lark-cli im +chat-create`;
 *                    Phase 11 wires the full reverse-bind flow
 *
 * Inbound dispatch:
 *   - Listener emits LarkListenerEvent
 *   - LarkChannel parses the message text via command-parser
 *   - approval/deny commands → onApprovalDecision (registry settles)
 *   - everything else (and lifecycle commands) → onInboundMessage with
 *     parsed Intent attached so the orchestrator can branch on it
 */

import type { ApprovalRequest, ChannelBinding } from '../../storage/types.js';
import type {
  ApprovalDecision,
  CreateThreadOpts,
  ExternalThread,
  InboundMessage,
  RemoteChannel,
  SendOpts,
  Unsubscribe,
} from '../types.js';
import type { LarkCliRunner } from './cli-runner.js';
import { createLarkListener, type LarkInboundMessage, type LarkListener } from './listener.js';
import { parseCommand, type CommandIntent } from './command-parser.js';

export interface LarkChannelOptions {
  cli: LarkCliRunner;
  /** Bot name shown in approval-card titles. Default 'Helm'. */
  botName?: string;
  /** Override the listener for tests. */
  listener?: LarkListener;
  /** Notification hook when the listener (re)connects. */
  onListenerStatus?: (status: 'connected' | 'reconnect_scheduled') => void;
  /** Surface fatal listener errors so the orchestrator can log. */
  onListenerError?: (err: Error, where: string) => void;
}

/** Inbound metadata attached to InboundMessage so the orchestrator can branch. */
export interface LarkInboundMetadata extends Record<string, unknown> {
  larkMessageId: string;
  larkChatId: string;
  larkThreadId?: string;
  mentioned: boolean;
  senderId?: string;
  /** Parsed command intent. Always present; orchestrator's bind / unbind /
   *  disable_wait flows key off this. */
  intent: CommandIntent;
}

export class LarkChannel implements RemoteChannel {
  readonly id = 'lark' as const;

  private readonly cli: LarkCliRunner;
  private readonly botName: string;
  private readonly listener: LarkListener;
  private readonly inboundHandlers = new Set<(m: InboundMessage) => void | Promise<void>>();
  private readonly approvalHandlers = new Set<(d: ApprovalDecision) => void | Promise<void>>();
  private unsubscribeListener?: () => void;
  private started = false;

  constructor(options: LarkChannelOptions) {
    this.cli = options.cli;
    this.botName = options.botName ?? 'Helm';
    this.listener = options.listener ?? createLarkListener({
      cli: options.cli,
      onError: options.onListenerError,
      onConnected: () => options.onListenerStatus?.('connected'),
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.unsubscribeListener = this.listener.onEvent((event) => {
      if (event.kind === 'message') this.handleInbound(event);
      // card_action handling lands in Phase 11 alongside the interactive
      // approval card. For now we ignore card events in this adapter.
    });
    this.listener.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.unsubscribeListener?.();
    this.unsubscribeListener = undefined;
    await this.listener.stop();
    this.inboundHandlers.clear();
    this.approvalHandlers.clear();
    this.started = false;
  }

  isStarted(): boolean { return this.started; }

  async sendApprovalRequest(req: ApprovalRequest, binding?: ChannelBinding): Promise<void> {
    if (!binding) {
      // Without a binding we don't know which thread to post in; the orchestrator
      // is expected to filter LarkChannel emissions to sessions with a Lark
      // binding. Still — log defensively rather than throw, observability matters.
      throw new Error('LarkChannel.sendApprovalRequest requires a binding');
    }
    const text = renderApprovalMarkdown(req, this.botName);
    await this.sendMessage(binding, text, { kind: 'notice' });
  }

  async sendMessage(binding: ChannelBinding, text: string, opts: SendOpts = {}): Promise<void> {
    if (binding.channel !== this.id) {
      throw new Error(`LarkChannel.sendMessage: binding is for channel "${binding.channel}", not lark`);
    }
    const replyTo = opts.inReplyTo ?? binding.externalThread ?? binding.externalRoot;
    if (!replyTo) {
      throw new Error('LarkChannel.sendMessage requires either opts.inReplyTo or a binding with externalThread / externalRoot');
    }
    const args = [
      'im', '+messages-reply',
      '--message-id', replyTo,
      '--markdown', text,
      '--reply-in-thread',
      '--as', 'bot',
    ];
    const result = await this.cli.run(args, { timeoutMs: 30_000 });
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      throw new Error(`lark-cli messages-reply failed (code=${result.exitCode}): ${detail || '(no output)'}`);
    }
  }

  async createThread(opts: CreateThreadOpts): Promise<ExternalThread> {
    // Phase 10 implements the minimal reuse path: if the caller supplied an
    // externalChat, we trust it and seed a binding without creating a new
    // chat. Full `lark-cli im +chat-create` flow lands in Phase 11 where
    // the renderer's "Mirror to Lark → Create new" UI calls in.
    if (!opts.externalChat) {
      throw new Error('LarkChannel.createThread requires opts.externalChat for Phase 10 (reverse-bind UI lands in Phase 11).');
    }
    return {
      channel: this.id,
      externalChat: opts.externalChat,
      externalThread: opts.hostSessionId,
    };
  }

  onInboundMessage(handler: (m: InboundMessage) => void | Promise<void>): Unsubscribe {
    this.inboundHandlers.add(handler);
    return () => { this.inboundHandlers.delete(handler); };
  }

  onApprovalDecision(handler: (d: ApprovalDecision) => void | Promise<void>): Unsubscribe {
    this.approvalHandlers.add(handler);
    return () => { this.approvalHandlers.delete(handler); };
  }

  // ── internal ───────────────────────────────────────────────────────────

  private handleInbound(event: LarkInboundMessage): void {
    const intent = parseCommand({ text: event.text, mentioned: event.mentioned });

    if (intent.kind === 'approval') {
      const decision: ApprovalDecision = {
        channel: this.id,
        approvalId: intent.targetId ?? '', // empty = "latest pending"; orchestrator resolves
        decision: intent.decision,
        ...(intent.scope ? { reason: intent.remember ? `remember: ${intent.scope}` : intent.scope } : {}),
        source: {
          larkMessageId: event.messageId,
          larkChatId: event.chatId,
          ...(event.threadId ? { larkThreadId: event.threadId } : {}),
          ...(event.senderId ? { senderId: event.senderId } : {}),
          remember: intent.remember,
          ...(intent.scope ? { scope: intent.scope } : {}),
        },
      };
      this.fanOutApproval(decision);
      return;
    }

    // Inbound message — bind / unbind / disable_wait / help / unknown all
    // route to onInboundMessage with intent attached.
    const inbound: InboundMessage = {
      channel: this.id,
      externalId: event.messageId,
      text: event.text,
      receivedAt: event.receivedAt,
    };
    const metadata: LarkInboundMetadata = {
      larkMessageId: event.messageId,
      larkChatId: event.chatId,
      larkThreadId: event.threadId,
      mentioned: event.mentioned,
      senderId: event.senderId,
      intent,
    };
    // Stash metadata on the InboundMessage via a side channel — RemoteChannel's
    // typed surface doesn't carry channel-specific fields, but consumers can
    // read it off the fan-out helper below by passing both.
    this.fanOutInbound(inbound, metadata);
  }

  private fanOutInbound(message: InboundMessage, metadata: LarkInboundMetadata): void {
    const enriched: InboundMessage & { metadata: LarkInboundMetadata } = { ...message, metadata };
    for (const h of [...this.inboundHandlers]) {
      try {
        const result = h(enriched);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch(() => { /* per-handler isolation */ });
        }
      } catch { /* per-handler isolation */ }
    }
  }

  private fanOutApproval(decision: ApprovalDecision): void {
    for (const h of [...this.approvalHandlers]) {
      try {
        const result = h(decision);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch(() => { /* per-handler isolation */ });
        }
      } catch { /* per-handler isolation */ }
    }
  }
}

function renderApprovalMarkdown(req: ApprovalRequest, botName: string): string {
  const lines = [
    `**${botName} — approval requested**`,
    '',
    `Tool: \`${req.tool}\``,
  ];
  if (req.command) {
    lines.push('', '```', req.command, '```');
  }
  lines.push(
    '',
    `Reply with \`/allow\` or \`/deny\`. Add \`!\` to remember. Pending id: \`${req.id}\`.`,
  );
  return lines.join('\n');
}
