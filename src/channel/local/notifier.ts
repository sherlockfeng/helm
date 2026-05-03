/**
 * Notifier — abstraction over OS notifications used by LocalChannel.
 *
 * The production implementation (Electron's Notification API) lands in Phase 8
 * when the Electron main process is wired up. Until then we ship a NoopNotifier
 * (used in headless contexts and tests) and a CallbackNotifier (used by tests
 * to assert what *would* be shown to the user).
 */

import type { ApprovalRequest } from '../../storage/types.js';

export interface NotificationPayload {
  title: string;
  body: string;
  /** Internal id correlating UI clicks to the source approval / message. */
  ref?: { kind: 'approval'; approvalId: string } | { kind: 'message'; messageId: string };
}

export interface Notifier {
  notify(payload: NotificationPayload): void;
}

export class NoopNotifier implements Notifier {
  notify(_payload: NotificationPayload): void {
    // Intentionally empty — used in headless / unit-test contexts where we don't
    // want OS popups. Tests that need to assert notification content should use
    // CallbackNotifier instead.
  }
}

export class CallbackNotifier implements Notifier {
  readonly received: NotificationPayload[] = [];

  constructor(private readonly cb?: (payload: NotificationPayload) => void) {}

  notify(payload: NotificationPayload): void {
    this.received.push(payload);
    this.cb?.(payload);
  }
}

/**
 * Build the user-facing notification text for a pending approval. Centralized so
 * the wording stays consistent between the OS-native popup and the in-app list.
 */
export function approvalToNotification(req: ApprovalRequest): NotificationPayload {
  const tool = req.tool;
  const command = req.command?.trim() ?? '';
  const title = `Helm: approval needed for ${tool}`;
  const body = command
    ? truncate(command, 140)
    : 'Cursor wants to run a tool — review in Helm.';
  return { title, body, ref: { kind: 'approval', approvalId: req.id } };
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + '…';
}
