/**
 * Helm — Electron 主进程入口（Phase 0 stub）
 *
 * Phase 0 仅启动一个空窗口，验证打包链路通。
 * 后续阶段在此挂载：
 * - bridge UDS server 启动 / 关闭
 * - HTTP API 启动
 * - MCP stdio server fork
 * - menubar tray
 * - 单实例锁
 * - HostAdapter / RemoteChannel 注册
 * 详见 PROJECT_BLUEPRINT.md §7.3 / §7.4。
 */

import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// CJS 兼容：tsup 输出 cjs，但保留 ESM-style 路径计算以备改 ESM
const __filename = typeof __dirname === 'undefined'
  ? fileURLToPath(import.meta.url)
  : __filename;
const __projectDir = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;

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

  // Phase 0：先指向 web/dist/index.html 占位
  // 实际开发期会指向 vite dev server (http://localhost:5173)
  const isDev = process.env.HELM_DEV === '1';
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__projectDir, '..', '..', 'web', 'dist', 'index.html'));
  }

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

// 单实例锁
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

  app.whenReady().then(() => {
    createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
