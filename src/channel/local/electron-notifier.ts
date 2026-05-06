/**
 * ElectronNotifier — implements Notifier on top of Electron's Notification API.
 *
 * The Electron module is injected as a constructor dep instead of imported
 * directly so this file can be unit-tested in pure Node (where
 * `import 'electron'` would throw). Production wiring lives in
 * `electron/main.ts`:
 *
 *   import { Notification } from 'electron';
 *   new ElectronNotifier({ Notification, onClick: focusApprovals });
 *
 * Click handler:
 *   - When a notification is clicked, `onClick(payload)` runs. The Electron
 *     shell uses this to focus the BrowserWindow + bring it to front.
 *   - Click handler errors are caught per-notification so one bad listener
 *     can't poison subsequent notifications.
 *
 * Compatibility:
 *   - `Notification.isSupported()` is checked at construct time AND each
 *     notify() call (some platforms revoke permissions at runtime). When
 *     unsupported, notify() is a no-op and `wasShown` reports false.
 */

import type { Notifier, NotificationPayload } from './notifier.js';

export interface ElectronNotificationCtor {
  new (opts: ElectronNotificationOptions): ElectronNotificationInstance;
  isSupported(): boolean;
}

export interface ElectronNotificationOptions {
  title: string;
  body: string;
  silent?: boolean;
  /** macOS-only — quiet sound vs default. */
  sound?: string;
}

export interface ElectronNotificationInstance {
  on(event: 'click', listener: () => void): void;
  show(): void;
}

export interface ElectronNotifierOptions {
  Notification: ElectronNotificationCtor;
  /**
   * Invoked when the user clicks the OS notification. Production wiring
   * focuses the BrowserWindow + sends an IPC message so the renderer can
   * navigate to the relevant approval / message.
   */
  onClick?: (payload: NotificationPayload) => void;
  /**
   * Optional logger sink for unexpected paths (Notification ctor throws,
   * click handler throws). Defaults to no-op.
   */
  onError?: (err: Error, ctx: { phase: string }) => void;
  /**
   * macOS only — prepended to the notification title so users can tell
   * helm notifications apart from other apps. Default 'Helm'.
   */
  appName?: string;
}

export class ElectronNotifier implements Notifier {
  private readonly Notification: ElectronNotificationCtor;
  private readonly onClick?: (payload: NotificationPayload) => void;
  private readonly onError: (err: Error, ctx: { phase: string }) => void;

  constructor(options: ElectronNotifierOptions) {
    this.Notification = options.Notification;
    this.onClick = options.onClick;
    this.onError = options.onError ?? (() => {});
  }

  /** Whether OS notifications are currently usable. */
  isSupported(): boolean {
    try {
      return this.Notification.isSupported();
    } catch (err) {
      this.onError(err as Error, { phase: 'isSupported' });
      return false;
    }
  }

  notify(payload: NotificationPayload): void {
    if (!this.isSupported()) return;
    try {
      const n = new this.Notification({
        title: payload.title,
        body: payload.body,
        silent: false,
      });
      n.on('click', () => {
        try { this.onClick?.(payload); }
        catch (err) { this.onError(err as Error, { phase: 'click' }); }
      });
      n.show();
    } catch (err) {
      this.onError(err as Error, { phase: 'show' });
    }
  }
}
