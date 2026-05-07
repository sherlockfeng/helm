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
import { createStderrEcho, resolveStderrEchoLevel } from '../src/logger/stderr-echo.js';
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
      // tsup bundles `electron/preload.ts` as CJS → `dist/electron/preload.cjs`.
      // Until Phase 51 this file pointed at `preload.js` and Electron logged a
      // silent ENOENT — fine for years because nothing in the renderer
      // touched `window.helm`, then immediately fatal once Phase 50 made the
      // renderer rely on the preload-injected `apiBase` for API calls.
      preload: path.join(__projectDir, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });

  const isDev = process.env['HELM_DEV'] === '1';
  if (isDev) {
    void mainWindow.loadURL('http://localhost:5173');
  } else {
    // Phase 50: pass the live HTTP API origin to the renderer via the URL
    // hash so the preload can expose it as `window.helm.apiBase`. Under
    // file://, relative `/api/...` URLs don't resolve to anywhere useful —
    // the renderer needs the explicit `http://127.0.0.1:<port>` origin.
    const port = helmApp?.httpPort();
    const indexHtml = path.join(__projectDir, '..', '..', 'web', 'dist', 'index.html');
    if (port) {
      void mainWindow.loadFile(indexHtml, {
        hash: `apiBase=${encodeURIComponent(`http://127.0.0.1:${port}`)}`,
      });
    } else {
      // Pre-boot edge case — let the renderer fall back to its built-in
      // default port (17317).
      void mainWindow.loadFile(indexHtml);
    }
  }

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // Mirror renderer console + load failures to main stderr so packaging
  // issues (missing assets, preload ENOENT, JS exceptions) surface in
  // `~/.helm/logs/` without anyone manually opening devtools. Cheap in
  // production — only fires on actual log calls. Devtools opens detached
  // when `HELM_DEV_TOOLS=1` so the next renderer regression is one env
  // var away from being inspectable.
  mainWindow.webContents.on('console-message', (_e, _level, message, line, sourceId) => {
    process.stderr.write(`[renderer] ${message} (${sourceId}:${line})\n`);
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    process.stderr.write(`[renderer:did-fail-load] ${code} ${desc} url=${url}\n`);
  });
  if (process.env['HELM_DEV_TOOLS'] === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
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
  // Phase 28 (C4): mirror warn/error (or info+ in HELM_DEV=1) to stderr so
  // `pnpm dev` users don't have to tail ~/.helm/logs/main.log to see what
  // the orchestrator is doing. Returns null when level=off — the LoggerFactory
  // echo callback is optional.
  const stderrEcho = createStderrEcho({ level: resolveStderrEchoLevel() });
  const loggers = createLoggerFactory({
    rootDir: PATHS.logsDir,
    ...(stderrEcho ? { echo: stderrEcho } : {}),
  });
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
    // Phase 46: also catch `approval.decision_received` so the tray badge
    // clears when a decision races (settle returns false because another
    // path already finalized — no follow-up `approval.settled` would fire
    // for this listener otherwise).
    if (e.type === 'approval.pending'
      || e.type === 'approval.settled'
      || e.type === 'approval.decision_received'
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
