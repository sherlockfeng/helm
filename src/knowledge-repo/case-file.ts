/**
 * Benchmark-case file format (files-as-truth, benchmark milestone).
 *
 * A benchmark case lives co-located with knowledge as a `.md` file in a
 * `cases/` subdir, so it rides the same MR flow as knowledge points.
 * The format mirrors the llm-wiki concept style — `# title` headline
 * plus a fenced metadata block — but uses a ```benchmark-case fence and
 * adds two prose sections (问题 / 期望) for the human-authored fields:
 *
 *   # <case name>
 *
 *   ```benchmark-case
 *   id: <case-id>
 *   golden: [<pointId>, ...]
 *   targetRoles: [<roleId>, ...]
 *   ```
 *
 *   ## 问题
 *   <question text>
 *
 *   ## 期望
 *   <expected_truth text>
 *
 * serializeCase is deterministic (arrays sorted) so a read → write →
 * read round-trip produces stable output with no spurious diffs.
 */

import { parseMarkdownWithFrontmatter } from './frontmatter.js';

const QUESTION_HEADING = '问题';
const EXPECTED_HEADING = '期望';

export interface SerializeCaseInput {
  id: string;
  name: string;
  question: string;
  expectedTruth: string;
  goldenPointIds: string[];
  targetRoleIds: string[];
}

export interface ParsedCaseFile {
  id: string;
  name: string;
  question: string;
  expectedTruth: string;
  goldenPointIds: string[];
  targetRoleIds: string[];
}

export function serializeCase(input: SerializeCaseInput): string {
  const golden = [...input.goldenPointIds].sort();
  const targetRoles = [...input.targetRoleIds].sort();
  const lines: string[] = [];
  lines.push(`# ${input.name.trim()}`);
  lines.push('');
  lines.push('```benchmark-case');
  lines.push(`id: ${input.id}`);
  lines.push(`golden: [${golden.map(quoteIfNeeded).join(', ')}]`);
  lines.push(`targetRoles: [${targetRoles.map(quoteIfNeeded).join(', ')}]`);
  lines.push('```');
  lines.push('');
  lines.push(`## ${QUESTION_HEADING}`);
  lines.push(input.question.trim());
  lines.push('');
  lines.push(`## ${EXPECTED_HEADING}`);
  lines.push(input.expectedTruth.trim());
  lines.push('');
  return lines.join('\n');
}

/**
 * Parse a benchmark-case `.md` file. Returns null when the text is not
 * a benchmark-case file (no ```benchmark-case fence) or when a required
 * field (id / name / question / expectedTruth) is missing — the caller
 * treats null as "this is not a case, skip it".
 *
 * `fallbackId` is used as the id when the fence omits one (mirrors the
 * point-file fallback-id convention).
 */
export function parseCaseFile(text: string, fallbackId: string): ParsedCaseFile | null {
  const { body } = parseMarkdownWithFrontmatter(text);
  const fenceMatch = body.match(/```benchmark-case\s*\n([\s\S]*?)\n```/);
  if (!fenceMatch) return null;

  // Reparse the fence body via the shared subset-YAML parser (same
  // approach profiles.ts uses for the ```concept fence).
  const wrapped = `---\n${fenceMatch[1]}\n---\n`;
  const { data } = parseMarkdownWithFrontmatter(wrapped);
  const id = stringValue(data['id']) ?? fallbackId;
  const goldenPointIds = arrayOfString(data['golden']);
  const targetRoleIds = arrayOfString(data['targetRoles']);

  const name = extractFirstH1(body);
  const question = extractSection(body, QUESTION_HEADING);
  const expectedTruth = extractSection(body, EXPECTED_HEADING);

  if (!id || !name || !question || !expectedTruth) return null;

  return { id, name, question, expectedTruth, goldenPointIds, targetRoleIds };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function quoteIfNeeded(s: string): string {
  if (/[\s,\[\]\{\}#:]/.test(s)) return JSON.stringify(s);
  return s;
}

function extractFirstH1(body: string): string | null {
  const m = body.match(/^#\s+(.+)$/m);
  return m ? m[1]!.trim() : null;
}

function stringValue(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function arrayOfString(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string');
}

/**
 * Pull the prose under a `## <heading>` up to the next heading (any
 * level) or EOF. Returns null when the heading is absent or empty.
 */
function extractSection(body: string, heading: string): string | null {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startRe = new RegExp(`^##\\s+${escaped}\\s*$`, 'm');
  const startMatch = startRe.exec(body);
  if (!startMatch) return null;
  const afterStart = body.slice(startMatch.index + startMatch[0].length);
  // Section runs to the next heading (any level) or EOF.
  const nextHeading = afterStart.match(/^#{1,6}\s+/m);
  const sectionText = nextHeading
    ? afterStart.slice(0, nextHeading.index)
    : afterStart;
  const trimmed = sectionText.trim();
  return trimmed.length > 0 ? trimmed : null;
}
