/**
 * Helm — Electron main process.
 *
 * Thin shell on top of `createHelmApp`. The orchestrator owns all of the
 * subsystems (bridge, channel, approval, knowledge, HTTP API) so they can be
 * tested headless. This file only does Electron-specific work:
 *   - app.whenReady → boot the orchestrator
 *   - single-instance lock + second-instance focus
 *   - main BrowserWindow (renderer side; Phase 9 builds out the UI)
 *   - graceful shutdown on quit
 *
 * Menubar tray + status icon are deferred to Phase 9 alongside the renderer.
 *
 * See PROJECT_BLUEPRINT.md §7.3 / §7.4 for the full boot/shutdown sequence.
 */

import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { HelmDB } from '../src/storage/database.js';
import { createLoggerFactory } from '../src/logger/index.js';
import { createHelmApp, type HelmAppHandle } from '../src/app/orchestrator.js';
import { PATHS } from '../src/constants.js';

// CJS 兼容：tsup 输出 cjs，Electron 主进程在 CJS 环境中 __dirname 始终可用
const __projectDir = typeof __dirname !== 'undefined'
  ? __dirname
  : path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let helmApp: HelmAppHandle | null = null;

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

async function bootHelm(): Promise<void> {
  const helmDb = new HelmDB();
  const loggers = createLoggerFactory({ rootDir: PATHS.logsDir });
  helmApp = createHelmApp({ db: helmDb.sqlite, loggers });
  await helmApp.start();
}

async function shutdownHelm(): Promise<void> {
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
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    await bootHelm();
    createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
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
