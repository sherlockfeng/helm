import type Database from 'better-sqlite3';
import { listRequirements } from '../storage/repos/requirements.js';
import type { Requirement } from '../storage/types.js';

export function recallRequirements(db: Database.Database, query?: string): Requirement[] {
  return listRequirements(db, query);
}

/**
 * Render a saved Requirement as markdown suitable for injection into a Cursor
 * chat's additional_context. Truncates the original chat context at 800 chars
 * to keep injection size predictable.
 */
export function formatRequirementForInjection(req: Requirement): string {
  const lines: string[] = [
    `# 需求：${req.name}`,
    `> 状态：${req.status === 'confirmed' ? '已确认' : '草稿'} | 创建于 ${req.createdAt.slice(0, 10)}`,
    '',
  ];

  if (req.purpose) lines.push(`## 目的\n${req.purpose}`, '');
  if (req.summary) lines.push(`## 摘要\n${req.summary}`, '');

  if (req.changes && req.changes.length > 0) {
    lines.push('## 主要改动');
    req.changes.forEach((c) => lines.push(`- ${c}`));
    lines.push('');
  }

  if (req.relatedDocs && req.relatedDocs.length > 0) {
    lines.push('## 相关文档');
    req.relatedDocs.forEach((d) => lines.push(`- ${d}`));
    lines.push('');
  }

  if (req.tags && req.tags.length > 0) {
    lines.push(`## 标签\n${req.tags.map((t) => `\`${t}\``).join(' ')}`);
  }

  const pendingTodos = (req.todos ?? []).filter((t) => !t.done);
  if (pendingTodos.length > 0) {
    lines.push(`## 待办事项 (${pendingTodos.length} 条未完成)`);
    pendingTodos.forEach((t) => lines.push(`- [ ] ${t.text}`));
    lines.push('');
  }

  if (req.context) {
    const truncated = req.context.length > 800
      ? `${req.context.slice(0, 800)}…（已截断）`
      : req.context;
    lines.push('', `## 原始 Chat 上下文\n${truncated}`);
  }

  return lines.join('\n');
}
