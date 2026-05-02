/**
 * Helm — Electron preload script (Phase 0 stub)
 *
 * 当前 renderer 直接调 127.0.0.1:<port> 的 HTTP API（参见蓝图 §14.3 推荐方案），
 * 因此 preload 只暴露最小化 API（platform 信息）。
 * 后续如需 menubar tray 状态、原生通知等，再在此暴露。
 */

import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('helm', {
  platform: process.platform,
  versions: process.versions,
});
