/**
 * Helm — Electron main process.
 *
 * Thin shell on top of `createHelmApp`. The orchestrator owns all of the
 * subsystems (bridge, channel, approval, knowledge, HTTP API) so they can be
 * tested headless. This file only does Electron-specific work:
 *   - app.whenReady → boot the orchestrator
 *   - single-instance lock + second-instance focus
 *   - main BrowserWindow
 *   - menubar tray + state subscriptions (§14.1)
 *   - real OS Notification via ElectronNotifier (replaces NoopNotifier)
 *   - graceful shutdown on quit
 *
 * See PROJECT_BLUEPRINT.md §7.3 / §7.4 for the full boot/shutdown sequence.
 */

import { app, BrowserWindow, Notification } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { HelmDB } from '../src/storage/database.js';
import { createLoggerFactory } from '../src/logger/index.js';
import { createHelmApp, type HelmAppHandle } from '../src/app/orchestrator.js';
import { loadHelmConfig } from '../src/config/loader.js';
import { ElectronNotifier } from '../src/channel/local/electron-notifier.js';
import { PATHS } from '../src/constants.js';
import { setupHelmTray, type HelmTrayHandle } from './tray.js';

// CJS 兼容：tsup 输出 cjs，Electron 主进程在 CJS 环境中 __dirname 始终可用
const __projectDir = typeof __dirname !== 'undefined'
  ? __dirname
  : path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let helmApp: HelmAppHandle | null = null;
let helmTray: HelmTrayHandle | null = null;

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    title: 'Helm',
    show: false,
    webPreferences: {
      preload: path.join(__projectDir, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });

  const isDev = process.env['HELM_DEV'] === '1';
  if (isDev) {
    void mainWindow.loadURL('http://localhost:5173');
  } else {
    void mainWindow.loadFile(path.join(__projectDir, '..', '..', 'web', 'dist', 'index.html'));
  }

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

function focusWindow(): void {
  if (!mainWindow) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function navigateRenderer(route: string): void {
  // Use webContents.executeJavaScript to push history; works for both vite
  // dev server and the packaged build because react-router uses BrowserRouter.
  const wc = mainWindow?.webContents;
  if (!wc) return;
  void wc.executeJavaScript(
    `window.history.pushState({}, '', ${JSON.stringify(route)}); window.dispatchEvent(new PopStateEvent('popstate'));`,
  ).catch(() => {/* renderer not ready yet */});
}

async function bootHelm(): Promise<void> {
  const helmDb = new HelmDB();
  const loggers = createLoggerFactory({ rootDir: PATHS.logsDir });
  const configLog = loggers.module('config');
  const { config, loaded } = loadHelmConfig({
    onError: (err, ctx) => configLog.warn('config_load_failed', {
      event: ctx.phase, data: { path: ctx.path, error: err.message },
    }),
  });
  configLog.info('config_loaded', { data: { loaded, path: PATHS.configFile } });

  const notifier = new ElectronNotifier({
    Notification,
    onClick: (payload) => {
      focusWindow();
      if (payload.ref?.kind === 'approval') navigateRenderer('/approvals');
    },
    onError: (err, ctx) => loggers.module('channel.local.notifier').warn('notify_failed', {
      event: ctx.phase, data: { error: err.message },
    }),
  });

  helmApp = createHelmApp({ db: helmDb.sqlite, loggers, config, notifier });
  await helmApp.start();

  // Tray — subscribes to live counts via the EventBus. Because pending /
  // active counts aren't pushed as discrete numbers in AppEvent, we
  // re-derive on every relevant event.
  helmTray = setupHelmTray({
    onOpenDashboard: () => focusWindow(),
    onOpenApprovals: () => { focusWindow(); navigateRenderer('/approvals'); },
    onOpenSettings: () => { focusWindow(); navigateRenderer('/settings'); },
    onQuit: () => app.quit(),
  });

  const activeChatsStmt = helmDb.sqlite.prepare(
    `SELECT COUNT(*) AS n FROM host_sessions WHERE status = 'active'`,
  );

  function refreshTray(): void {
    if (!helmApp || !helmTray) return;
    const row = activeChatsStmt.get() as { n: number } | undefined;
    helmTray.update({
      pendingApprovals: helmApp.approval.listPending().length,
      activeChats: row ? Number(row.n) : 0,
      bridgeHealthy: true, // bridge errors flip this via onError handler below
      larkConnected: helmApp.larkChannel?.isStarted() ?? undefined,
    });
  }

  helmApp.events.on((e) => {
    if (e.type === 'approval.pending'
      || e.type === 'approval.settled'
      || e.type === 'session.started'
      || e.type === 'session.closed'
    ) refreshTray();
  });

  refreshTray();
}

async function shutdownHelm(): Promise<void> {
  if (helmTray) {
    helmTray.destroy();
    helmTray = null;
  }
  if (helmApp) {
    await helmApp.stop();
    helmApp = null;
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) focusWindow();
  });

  app.whenReady().then(async () => {
    await bootHelm();
    createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    // Mac convention: keep app alive in tray when window closes.
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', async (event) => {
    if (helmApp) {
      event.preventDefault();
      await shutdownHelm();
      app.quit();
    }
  });
}
