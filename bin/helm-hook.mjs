#!/usr/bin/env node
/**
 * Helm Cursor hook 子进程入口
 * 详见 PROJECT_BLUEPRINT.md §7.2。
 *
 * 由 Cursor 为每个 hook event spawn 一次。极轻 IPC 桥：
 *   stdin (Cursor hook payload)
 *     → bridge UDS request
 *     → stdout (Cursor hook response)
 *
 * Phase 0：尚未实装；fallback 输出兼容 Cursor 期望的 schema。
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const distEntry = join(__dirname, '..', 'dist', 'host', 'cursor', 'hook-entry.js');

if (existsSync(distEntry)) {
  await import(distEntry);
} else {
  // Phase 0 fallback：返回保守的"放行"响应，避免阻塞 Cursor。
  // 一旦实装，hook-entry.ts 会区分 event 类型并调 bridge。
  const event = process.argv.find(a => a.startsWith('--event='))?.slice(8) ?? 'unknown';
  const eventName = process.argv[process.argv.indexOf('--event') + 1] ?? event;

  if (['beforeShellExecution', 'beforeMCPExecution', 'preToolUse'].includes(eventName)) {
    process.stdout.write(JSON.stringify({
      permission: 'ask',
      user_message: 'Helm bridge not running. Please review this Cursor action locally.',
      agent_message: 'Helm fell back to Cursor local approval (binary not built).',
    }));
  } else if (eventName === 'beforeSubmitPrompt') {
    process.stdout.write(JSON.stringify({ continue: true }));
  } else {
    process.stdout.write('{}');
  }
}
