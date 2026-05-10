/**
 * Disk I/O for the on-disk Harness scaffold (Phase 67).
 *
 * .harness/ layout:
 *   .harness/
 *   ├── templates/
 *   │   └── task.md                         (one-time scaffold; not touched after)
 *   ├── tasks/
 *   │   └── <task_id>/
 *   │       └── task.md                     (live; updated every substantive turn)
 *   └── archive/
 *       └── <task_id>.md                    (frozen at archive time)
 *
 * The markdown files are the SOURCE OF TRUTH. helm DB rows are an index for
 * fast queries (search archives by entity/file/project). Sync direction is
 * file → DB on every helm-side write; the renderer / MCP tools always write
 * the file first, then mirror to DB in the same call so the two stay paired.
 *
 * Markdown round-trip: we use simple section-header parsing (`## Intent`,
 * `## Structure`, etc.) to read/write. Not a general markdown parser — the
 * template is fixed enough that a rule-based extractor is more robust than
 * pulling in a markdown library and trying to map AST nodes back to fields.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  HarnessArchiveCard,
  HarnessIntent,
  HarnessRelatedTask,
  HarnessStageLogEntry,
  HarnessStructure,
  HarnessTask,
} from '../storage/types.js';

// ── path helpers ───────────────────────────────────────────────────────────

export function taskFilePath(projectPath: string, taskId: string): string {
  return join(projectPath, '.harness', 'tasks', taskId, 'task.md');
}

export function archiveFilePath(projectPath: string, taskId: string): string {
  return join(projectPath, '.harness', 'archive', `${taskId}.md`);
}

/** ".harness/archive/<task_id>.md" — what we store in the DB pointer column. */
export function archiveRelativePointer(taskId: string): string {
  return join('.harness', 'archive', `${taskId}.md`);
}

// ── markdown serialization ─────────────────────────────────────────────────

function bullets(items: string[]): string {
  if (items.length === 0) return '_(none)_';
  return items.map((i) => `- ${i}`).join('\n');
}

export function serializeTask(t: HarnessTask): string {
  const intent = t.intent;
  const structure = t.structure;
  const lines: string[] = [];
  lines.push(`# ${t.title}`);
  lines.push('');
  lines.push('| field           | value |');
  lines.push('| --------------- | ----- |');
  lines.push(`| task_id         | ${t.id} |`);
  lines.push(`| current_stage   | ${t.currentStage} |`);
  lines.push(`| created_at      | ${t.createdAt} |`);
  lines.push(`| project_path    | ${t.projectPath} |`);
  lines.push(`| host_session_id | ${t.hostSessionId ?? '(unbound)'} |`);
  if (t.implementBaseCommit) lines.push(`| implement_base_commit | ${t.implementBaseCommit} |`);
  lines.push('');
  lines.push('## Intent');
  lines.push('');
  lines.push('### Background');
  lines.push(intent?.background ?? '_(empty)_');
  lines.push('');
  lines.push('### Objective');
  lines.push(intent?.objective ?? '_(empty)_');
  lines.push('');
  lines.push('### Scope');
  lines.push('**In:**');
  lines.push(bullets(intent?.scopeIn ?? []));
  lines.push('');
  lines.push('**Out:**');
  lines.push(bullets(intent?.scopeOut ?? []));
  lines.push('');
  lines.push('## Structure');
  lines.push('');
  lines.push('### Entities');
  lines.push(bullets(structure?.entities ?? []));
  lines.push('');
  lines.push('### Relations');
  lines.push(bullets(structure?.relations ?? []));
  lines.push('');
  lines.push('### Planned Files');
  lines.push(bullets(structure?.plannedFiles ?? []));
  lines.push('');
  lines.push('## Decisions');
  lines.push('');
  lines.push(bullets(t.decisions));
  lines.push('');
  lines.push('## Risks');
  lines.push('');
  lines.push(bullets(t.risks));
  lines.push('');
  lines.push('## Related Tasks');
  lines.push('');
  if (t.relatedTasks.length === 0) {
    lines.push('_(none)_');
  } else {
    for (const rt of t.relatedTasks) {
      lines.push(`- **${rt.taskId}** — ${rt.oneLiner} (\`${rt.archivePath}\`)`);
    }
  }
  lines.push('');
  lines.push('## Stage Log');
  lines.push('');
  if (t.stageLog.length === 0) {
    lines.push('_(none)_');
  } else {
    for (const entry of t.stageLog) {
      lines.push(`- **${entry.at}** [${entry.stage}] — ${entry.message}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Best-effort parse of a serialized task.md file back into a HarnessTask.
 *
 * This deliberately accepts only files we wrote ourselves — it's a round-trip
 * facility, not a freeform markdown parser. If the user hand-edits the file,
 * fields we can't recognize fall back to defaults; we never throw mid-parse.
 *
 * The reverse direction (DB row → markdown) is the canonical path; this
 * parser exists so users CAN hand-edit task.md and then a `reindex` button /
 * tool re-loads it.
 */
export function parseTask(content: string, fallback: { id: string; projectPath: string }): HarnessTask {
  const sections = splitSections(content);

  const headerTable = parseHeaderTable(content);
  const id = headerTable['task_id'] ?? fallback.id;
  const title = parseTitle(content) ?? id;
  const currentStage = (headerTable['current_stage'] as HarnessTask['currentStage']) ?? 'new_feature';
  const projectPath = headerTable['project_path'] ?? fallback.projectPath;
  const hostSessionIdRaw = headerTable['host_session_id'];
  const hostSessionId = hostSessionIdRaw && hostSessionIdRaw !== '(unbound)' ? hostSessionIdRaw : undefined;
  const implementBaseCommit = headerTable['implement_base_commit'];
  const createdAt = headerTable['created_at'] ?? new Date().toISOString();

  const intent: HarnessIntent | undefined = (() => {
    const block = sections['Intent'];
    if (!block) return undefined;
    const sub = splitSubsections(block);
    const background = stripPlaceholder((sub['Background'] ?? '').trim());
    const objective = stripPlaceholder((sub['Objective'] ?? '').trim());
    return {
      background,
      objective,
      scopeIn: parseScope(sub['Scope'] ?? '', 'In'),
      scopeOut: parseScope(sub['Scope'] ?? '', 'Out'),
    };
  })();

  const structure: HarnessStructure | undefined = (() => {
    const block = sections['Structure'];
    if (!block) return undefined;
    const sub = splitSubsections(block);
    return {
      entities: parseBullets(sub['Entities'] ?? ''),
      relations: parseBullets(sub['Relations'] ?? ''),
      plannedFiles: parseBullets(sub['Planned Files'] ?? ''),
    };
  })();

  const decisions = parseBullets(sections['Decisions'] ?? '');
  const risks = parseBullets(sections['Risks'] ?? '');
  const relatedTasks = parseRelatedTasks(sections['Related Tasks'] ?? '');
  const stageLog = parseStageLog(sections['Stage Log'] ?? '');

  const task: HarnessTask = {
    id,
    title,
    currentStage,
    projectPath,
    decisions,
    risks,
    relatedTasks,
    stageLog,
    createdAt,
    updatedAt: new Date().toISOString(),
  };
  if (hostSessionId) task.hostSessionId = hostSessionId;
  if (intent) task.intent = intent;
  if (structure) task.structure = structure;
  if (implementBaseCommit && implementBaseCommit !== '(unbound)') {
    task.implementBaseCommit = implementBaseCommit;
  }
  return task;
}

/**
 * Split a markdown body by `## Heading` lines. Returns map from heading text →
 * the body of that section (lines below the heading, until the next H2 / EOF).
 */
function splitSections(content: string): Record<string, string> {
  const map: Record<string, string> = {};
  const lines = content.split('\n');
  let current: string | null = null;
  let buf: string[] = [];
  for (const line of lines) {
    const m = line.match(/^##\s+(.+)$/);
    if (m && !line.startsWith('### ')) {
      if (current) map[current] = buf.join('\n');
      current = m[1]!.trim();
      buf = [];
    } else if (current) {
      buf.push(line);
    }
  }
  if (current) map[current] = buf.join('\n');
  return map;
}

function splitSubsections(block: string): Record<string, string> {
  const map: Record<string, string> = {};
  const lines = block.split('\n');
  let current: string | null = null;
  let buf: string[] = [];
  for (const line of lines) {
    const m = line.match(/^###\s+(.+)$/);
    if (m) {
      if (current) map[current] = buf.join('\n');
      current = m[1]!.trim();
      buf = [];
    } else if (current) {
      buf.push(line);
    }
  }
  if (current) map[current] = buf.join('\n');
  return map;
}

function parseTitle(content: string): string | undefined {
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1]!.trim() : undefined;
}

function parseHeaderTable(content: string): Record<string, string> {
  // Look for the first `| field | value |` table block.
  const m = content.match(/\|\s*field\s*\|[\s\S]+?\n\n/);
  if (!m) return {};
  const block = m[0];
  const out: Record<string, string> = {};
  for (const row of block.split('\n')) {
    const cells = row.split('|').map((c) => c.trim()).filter((c) => c.length > 0);
    if (cells.length !== 2) continue;
    if (cells[0] === 'field' || cells[0]!.startsWith('-')) continue;
    out[cells[0]!] = cells[1]!;
  }
  return out;
}

/** Map serializer placeholders back to empty strings on parse. */
function stripPlaceholder(s: string): string {
  return s === '_(empty)_' || s === '_(none)_' ? '' : s;
}

function parseBullets(block: string): string[] {
  const out: string[] = [];
  for (const line of block.split('\n')) {
    const m = line.match(/^[-*]\s+(.+)$/);
    if (!m) continue;
    const v = m[1]!.trim();
    if (v === '_(none)_') continue;
    out.push(v);
  }
  return out;
}

function parseScope(block: string, kind: 'In' | 'Out'): string[] {
  // Look for **In:** / **Out:** marker; collect bullets until next bold marker
  // or end of block.
  const lines = block.split('\n');
  let collecting = false;
  const out: string[] = [];
  for (const line of lines) {
    const marker = line.match(/^\*\*(In|Out)[:：]?\*\*/);
    if (marker) {
      collecting = marker[1] === kind;
      continue;
    }
    if (!collecting) continue;
    const bm = line.match(/^[-*]\s+(.+)$/);
    if (bm) {
      const v = bm[1]!.trim();
      if (v !== '_(none)_') out.push(v);
    } else if (line.match(/^\*\*[^*]+\*\*/)) {
      collecting = false;
    }
  }
  return out;
}

function parseRelatedTasks(block: string): HarnessRelatedTask[] {
  const out: HarnessRelatedTask[] = [];
  for (const line of block.split('\n')) {
    // - **<id>** — <one-liner> (`<archive_path>`)
    const m = line.match(/^[-*]\s+\*\*(\S+)\*\*\s+—\s+(.+?)\s+\(`(.+?)`\)$/);
    if (!m) continue;
    out.push({ taskId: m[1]!, oneLiner: m[2]!, archivePath: m[3]! });
  }
  return out;
}

function parseStageLog(block: string): HarnessStageLogEntry[] {
  const out: HarnessStageLogEntry[] = [];
  for (const line of block.split('\n')) {
    // - **<at>** [<stage>] — <message>
    const m = line.match(/^[-*]\s+\*\*([^*]+)\*\*\s+\[([^\]]+)\]\s+—\s+(.+)$/);
    if (!m) continue;
    out.push({
      at: m[1]!.trim(),
      stage: m[2]!.trim() as HarnessStageLogEntry['stage'],
      message: m[3]!.trim(),
    });
  }
  return out;
}

// ── archive serialization ──────────────────────────────────────────────────

export function serializeArchive(c: HarnessArchiveCard): string {
  const lines: string[] = [];
  lines.push(`# Archive — ${c.taskId}`);
  lines.push('');
  lines.push(`> ${c.oneLiner}`);
  lines.push('');
  lines.push('| field            | value |');
  lines.push('| ---------------- | ----- |');
  lines.push(`| task_id          | ${c.taskId} |`);
  lines.push(`| project_path     | ${c.projectPath} |`);
  lines.push(`| archived_at      | ${c.archivedAt} |`);
  lines.push(`| full_doc_pointer | ${c.fullDocPointer} |`);
  lines.push('');
  lines.push('## Entities'); lines.push(bullets(c.entities)); lines.push('');
  lines.push('## Files Touched'); lines.push(bullets(c.filesTouched)); lines.push('');
  lines.push('## Modules'); lines.push(bullets(c.modules)); lines.push('');
  lines.push('## Patterns'); lines.push(bullets(c.patterns)); lines.push('');
  lines.push('## Downstream'); lines.push(bullets(c.downstream)); lines.push('');
  lines.push('## Rules Applied'); lines.push(bullets(c.rulesApplied)); lines.push('');
  return lines.join('\n');
}

// ── filesystem write/read ──────────────────────────────────────────────────

export function writeTaskFile(t: HarnessTask): void {
  const path = taskFilePath(t.projectPath, t.id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeTask(t), 'utf8');
}

export function readTaskFile(projectPath: string, taskId: string): HarnessTask | undefined {
  const path = taskFilePath(projectPath, taskId);
  if (!existsSync(path)) return undefined;
  const content = readFileSync(path, 'utf8');
  return parseTask(content, { id: taskId, projectPath });
}

export function writeArchiveFile(c: HarnessArchiveCard): void {
  const path = archiveFilePath(c.projectPath, c.taskId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeArchive(c), 'utf8');
}
