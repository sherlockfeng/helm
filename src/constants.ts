/**
 * Helm — 全局常量
 * 详见 PROJECT_BLUEPRINT.md §6（本地文件布局）。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

// Phase 52: HELM_HOME env var lets e2e tests (and any CI runner) point a
// fresh Electron launch at a disposable directory so it doesn't fight the
// developer's running Helm for the SQLite WAL / bridge socket / lock.
export const HELM_HOME = process.env['HELM_HOME']
  ? process.env['HELM_HOME']
  : join(homedir(), '.helm');

export const PATHS = {
  configFile: join(HELM_HOME, 'config.json'),
  database: join(HELM_HOME, 'data.db'),
  bridgeSocket: join(HELM_HOME, 'bridge.sock'),
  logsDir: join(HELM_HOME, 'logs'),
  sessionLogsDir: join(HELM_HOME, 'logs', 'sessions'),
  archiveDir: join(HELM_HOME, 'logs', 'archive'),
  screenshotsDir: join(HELM_HOME, 'screenshots'),
  cursorHooks: join(homedir(), '.cursor', 'hooks.json'),
};

export const HOOK_MARKER = 'helm-hook' as const;

export const DEFAULT_TIMEOUTS = {
  bridgeMs: 30_000,
  approvalMs: 24 * 60 * 60 * 1000, // 24h
  waitPollMs: 10 * 60 * 1000,       // 10min
  knowledgeCanHandleTotalMs: 200,
  knowledgeGetContextMs: 5_000,
} as const;

export const SESSION_CONTEXT_MAX_BYTES = 8_192;
