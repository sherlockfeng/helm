/**
 * RemoteChannel abstraction — see PROJECT_BLUEPRINT.md §11.
 *
 * A RemoteChannel mirrors approval requests / chat messages between the local
 * app and a remote surface (Lark for production, the local desktop UI for
 * LocalChannel which never leaves the host). Channels emit user decisions back
 * via onApprovalDecision so the caller can call ApprovalRegistry.settle.
 */

import type { ApprovalRequest, ChannelBinding } from '../storage/types.js';

export type ChannelId = 'local' | 'lark' | string;

export interface SendOpts {
  /** Optional reply-to message id, used by Lark to thread replies. */
  inReplyTo?: string;
  /** Mark the outbound message as a system / progress vs a user-facing reply. */
  kind?: 'progress' | 'reply' | 'notice';
}

/**
 * Phase 54: outbound attachment (image / file) descriptor.
 *
 * The local file path is uploaded to the remote channel directly — Lark's
 * `lark-cli im +messages-reply --image <localPath>` accepts a path and
 * handles the upload + image_key dance internally. `caption` lets the agent
 * pair the asset with a one-line description so reviewers know what they're
 * looking at without opening the image. Both image and (generic) file are
 * supported; channels that can't upload binary content surface an error
 * rather than silently dropping the attachment.
 */
export interface OutboundAttachment {
  /** Absolute path on the helm host. The channel reads + uploads it. */
  filePath: string;
  /** "image" mime-bucket → `--image`; "file" → `--file`. */
  kind: 'image' | 'file';
  /** Optional one-line description posted alongside the asset. */
  caption?: string;
}

export interface CreateThreadOpts {
  hostSessionId: string;
  title?: string;
  externalChat?: string;
  /** When true, reuse an existing thread rather than creating fresh. */
  reuse?: boolean;
}

export interface ExternalThread {
  channel: ChannelId;
  externalChat?: string;
  externalThread?: string;
  externalRoot?: string;
}

export interface InboundMessage {
  channel: ChannelId;
  binding?: ChannelBinding;
  /** Original message id from the remote system (e.g. Lark's om_*). */
  externalId?: string;
  text: string;
  /** Wall-clock timestamp the message arrived from the remote source. */
  receivedAt: string;
}

export interface ApprovalDecision {
  channel: ChannelId;
  approvalId: string;
  decision: 'allow' | 'deny';
  reason?: string;
  /** Free-form metadata: which user, which message id, etc. */
  source?: Record<string, unknown>;
}

export type Unsubscribe = () => void;

export interface RemoteChannel {
  readonly id: ChannelId;
  start(): Promise<void>;
  stop(): Promise<void>;

  /** Push a pending approval to the user via this channel. */
  sendApprovalRequest(req: ApprovalRequest, binding?: ChannelBinding): Promise<void>;

  /** Mirror an outbound chat message to the channel-side thread. */
  sendMessage(binding: ChannelBinding, text: string, opts?: SendOpts): Promise<void>;

  /**
   * Phase 54: post a binary attachment (image / file) into the bound thread.
   * Optional — channels that can't carry binary content (LocalChannel) omit
   * it and the caller is expected to feature-detect via `typeof channel.sendAttachment`.
   * When supplied, the implementation MUST upload the file at `attachment.filePath`
   * and post it; missing files / network failures throw.
   */
  sendAttachment?(
    binding: ChannelBinding,
    attachment: OutboundAttachment,
    opts?: SendOpts,
  ): Promise<void>;

  /** Mark a remote message as received (best-effort; default no-op). */
  ackMessage?(binding: ChannelBinding, externalId: string): Promise<void>;

  /** Create or reuse a thread for the given binding. */
  createThread?(opts: CreateThreadOpts): Promise<ExternalThread>;

  /** Subscribe to user input arriving from the channel side. */
  onInboundMessage(handler: (m: InboundMessage) => void | Promise<void>): Unsubscribe;

  /** Subscribe to user decisions on pending approvals. */
  onApprovalDecision(handler: (d: ApprovalDecision) => void | Promise<void>): Unsubscribe;
}
