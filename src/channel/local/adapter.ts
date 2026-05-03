/**
 * LocalChannel — RemoteChannel implementation for the desktop UI.
 *
 * Per PROJECT_BLUEPRINT.md §11.1:
 *   - sendApprovalRequest → OS notification + emit "pending" so the UI list refreshes
 *   - sendMessage → emit "outbound-message" so the chat detail panel can stream it
 *   - createThread → no-op; binding's external thread is the host_session_id
 *   - onInboundMessage / onApprovalDecision → fed by the UI calling pushInbound /
 *     pushApprovalDecision (the HTTP API in Phase 8 will be the actual caller)
 *
 * LocalChannel is always-on. It never makes a network call; the "remote" is just
 * the local Electron renderer.
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
import { approvalToNotification, type Notifier, NoopNotifier } from './notifier.js';

export interface LocalChannelOptions {
  notifier?: Notifier;
  /**
   * Called when the channel mirrors a chat message to the local UI. The HTTP
   * API / WebSocket bridge in Phase 8 hooks this up; for now it's a stub so the
   * orchestrator can pass it in.
   */
  onOutboundMessage?: (msg: { binding: ChannelBinding; text: string; opts?: SendOpts }) => void;
  /** Called when a new approval is pushed; UI poll/refresh hook. */
  onApprovalPushed?: (req: ApprovalRequest) => void;
}

export class LocalChannel implements RemoteChannel {
  readonly id = 'local' as const;

  private readonly notifier: Notifier;
  private readonly onOutboundMessage?: LocalChannelOptions['onOutboundMessage'];
  private readonly onApprovalPushed?: LocalChannelOptions['onApprovalPushed'];

  private readonly inboundHandlers = new Set<(m: InboundMessage) => void | Promise<void>>();
  private readonly approvalDecisionHandlers = new Set<(d: ApprovalDecision) => void | Promise<void>>();
  private started = false;

  constructor(options: LocalChannelOptions = {}) {
    this.notifier = options.notifier ?? new NoopNotifier();
    this.onOutboundMessage = options.onOutboundMessage;
    this.onApprovalPushed = options.onApprovalPushed;
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
    this.inboundHandlers.clear();
    this.approvalDecisionHandlers.clear();
  }

  isStarted(): boolean {
    return this.started;
  }

  async sendApprovalRequest(req: ApprovalRequest, _binding?: ChannelBinding): Promise<void> {
    this.ensureStarted();
    this.notifier.notify(approvalToNotification(req));
    this.onApprovalPushed?.(req);
  }

  async sendMessage(binding: ChannelBinding, text: string, opts: SendOpts = {}): Promise<void> {
    this.ensureStarted();
    this.onOutboundMessage?.({ binding, text, opts });
  }

  async createThread(opts: CreateThreadOpts): Promise<ExternalThread> {
    // LocalChannel doesn't have real threads; the binding piggybacks on the
    // host_session_id so the ChannelBinding row is unique per session.
    return {
      channel: this.id,
      externalChat: opts.externalChat ?? `local:${opts.hostSessionId}`,
      externalThread: opts.hostSessionId,
    };
  }

  onInboundMessage(handler: (m: InboundMessage) => void | Promise<void>): Unsubscribe {
    this.inboundHandlers.add(handler);
    return () => { this.inboundHandlers.delete(handler); };
  }

  onApprovalDecision(handler: (d: ApprovalDecision) => void | Promise<void>): Unsubscribe {
    this.approvalDecisionHandlers.add(handler);
    return () => { this.approvalDecisionHandlers.delete(handler); };
  }

  /**
   * Called by the UI (via HTTP API in Phase 8) when the user types a message in
   * a Cursor chat detail panel. Fans out to all onInboundMessage subscribers,
   * which in production will route the text into the channel_message_queue or
   * directly to the bridge's channel_inbound_message handler.
   */
  pushInboundMessage(message: InboundMessage): Promise<void[]> {
    return Promise.all(
      [...this.inboundHandlers].map(async (h) => {
        try { await h(message); }
        catch (err) {
          // Listener errors must not stop other listeners or block the UI thread.
          this.warn('inbound listener threw', err);
        }
      }),
    );
  }

  /**
   * Called by the UI when the user clicks allow / deny on a pending approval.
   * Fans out to all onApprovalDecision subscribers (in production, the
   * ApprovalRegistry settle adapter that the orchestrator wires up).
   */
  pushApprovalDecision(decision: Omit<ApprovalDecision, 'channel'>): Promise<void[]> {
    const fullDecision: ApprovalDecision = { channel: this.id, ...decision };
    return Promise.all(
      [...this.approvalDecisionHandlers].map(async (h) => {
        try { await h(fullDecision); }
        catch (err) {
          this.warn('approval decision listener threw', err);
        }
      }),
    );
  }

  private ensureStarted(): void {
    if (!this.started) throw new Error('LocalChannel: start() must be called before use');
  }

  private warn(_msg: string, _err: unknown): void {
    // Phase 8's logger plugs in here; kept silent in unit tests on purpose.
  }
}
