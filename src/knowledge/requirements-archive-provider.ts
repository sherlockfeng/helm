/**
 * RequirementsArchiveProvider — surfaces past requirement archives the
 * Cursor user-rule writes under `<repo>/requirements/*.md` to subsequent
 * chat sessions.
 *
 * Two surfaces:
 *
 *   - getSessionContext: lightweight markdown index of the most recent N
 *     archives (title + 1-line summary), pushed into additional_context
 *     at session_start. Tells the agent "these past requirements exist;
 *     query them if relevant".
 *
 *   - search: token-overlap ranking across all archives in the dir.
 *     Title hits 3x, heading hits 2x, body hits 1x. Top-K snippets
 *     returned via query_knowledge MCP tool when the agent asks.
 *
 * The "write" side is owned by the Cursor user-rule
 * (`~/.cursor/user-rules/archive-requirement.md`). Helm only reads —
 * archives are git-tracked markdown, no SQLite copy / index.
 *
 * Directory resolution walks up from `ctx.cwd` looking for `requirements/`,
 * stopping at the git root. Naturally handles monorepo: a sub-package's
 * own archive dir wins over a root one when both exist.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type {
  KnowledgeContext,
  KnowledgeProvider,
  KnowledgeProviderHealth,
  KnowledgeSnippet,
} from './types.js';
import { parseArchive, type ParsedArchive } from './archive-parser.js';

export interface RequirementsArchiveProviderOptions {
  /** Directory name to look for; defaults to `requirements`. */
  dirName?: string;
  /** Index entries cap for getSessionContext. Default 10. */
  maxIndexEntries?: number;
  /** Search results cap. Default 5. */
  maxSearchResults?: number;
  /** Body excerpt length per search hit. Default 200 chars. */
  snippetMaxBytes?: number;
  /** Test seam: replace `Date.now()` for deterministic ordering tests. */
  now?: () => Date;
}

interface ArchiveFile {
  path: string;
  basename: string;
  mtimeMs: number;
  content: string;
  parsed: ParsedArchive;
}

const DEFAULT_DIR = 'requirements';
const DEFAULT_INDEX = 10;
const DEFAULT_SEARCH = 5;
const DEFAULT_SNIPPET_BYTES = 200;

/**
 * Walk up from `cwd` looking for `<dirName>/`. Stops at the first hit, OR
 * when reaching a `.git/` containing directory (the repo root) — checks
 * once at the repo root and gives up. Returns null when nothing matched.
 */
export function findArchiveDir(cwd: string, dirName = DEFAULT_DIR): string | null {
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, dirName);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return candidate;
    }
    if (existsSync(join(current, '.git'))) {
      // Reached the repo root; the loop already checked this level above.
      return null;
    }
    const parent = dirname(current);
    if (parent === current) return null; // hit `/`
    current = parent;
  }
}

function loadArchives(archiveDir: string): ArchiveFile[] {
  let entries: string[];
  try { entries = readdirSync(archiveDir); }
  catch { return []; }

  const files: ArchiveFile[] = [];
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const path = join(archiveDir, name);
    let stat: ReturnType<typeof statSync>;
    try { stat = statSync(path); } catch { continue; }
    if (!stat.isFile()) continue;
    let content: string;
    try { content = readFileSync(path, 'utf8'); } catch { continue; }
    files.push({
      path,
      basename: name.slice(0, -3),
      mtimeMs: stat.mtimeMs,
      content,
      parsed: parseArchive(content),
    });
  }
  return files;
}

/**
 * Tokenize for token-overlap scoring. Lowercases and splits on non-word
 * characters. Empty / 1-char tokens are dropped to reduce noise. CJK runs
 * pass through as-is (each ideograph counts as one token); v1 doesn't
 * segment Chinese — substring is good enough for "审批" → "审批" hit.
 */
function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  for (const m of lower.matchAll(/[\p{L}\p{N}_]+/gu)) {
    const t = m[0];
    if (t.length >= 2) tokens.push(t);
  }
  return tokens;
}

/**
 * Score one archive against the query tokens. Title hits 3x, heading hits
 * 2x, body hits 1x. Returns 0 when the archive has no overlap (so caller
 * can drop it from results).
 */
function scoreArchive(archive: ArchiveFile, queryTokens: readonly string[]): number {
  if (queryTokens.length === 0) return 0;
  const titleTokens = new Set(tokenize(archive.parsed.title));
  const headingsText = [...archive.parsed.sections.keys()].join(' ');
  const headingTokens = new Set(tokenize(headingsText));
  const bodyTokens = tokenize(archive.content);
  const bodyFreq = new Map<string, number>();
  for (const t of bodyTokens) bodyFreq.set(t, (bodyFreq.get(t) ?? 0) + 1);

  let score = 0;
  for (const q of queryTokens) {
    if (titleTokens.has(q)) score += 3;
    if (headingTokens.has(q)) score += 2;
    score += bodyFreq.get(q) ?? 0;
  }
  return score;
}

/**
 * Best matching paragraph from the archive's body — used as the snippet
 * shown alongside title in search results.
 */
function bestSnippet(archive: ArchiveFile, queryTokens: readonly string[], maxBytes: number): string {
  if (queryTokens.length === 0) return '';
  const paragraphs = archive.content.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  let best = '';
  let bestScore = 0;
  for (const para of paragraphs) {
    const tokens = new Set(tokenize(para));
    let score = 0;
    for (const q of queryTokens) if (tokens.has(q)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = para;
    }
  }
  if (!best) return '';
  if (best.length <= maxBytes) return best;
  return best.slice(0, maxBytes - 1) + '…';
}

/**
 * Render a Markdown index of recent archives for getSessionContext.
 *
 *   - 2026-05-04 **slug**: summary
 *
 * Date is parsed from the basename (`YYYY-MM-DD-slug`), falling back to
 * the file's mtime. Items without a parseable title are skipped — they're
 * almost certainly malformed.
 */
function renderIndex(files: readonly ArchiveFile[]): string {
  const lines: string[] = ['## Past requirements in this repo', ''];
  for (const f of files) {
    if (!f.parsed.title) continue;
    const dateMatch = /^(\d{4}-\d{2}-\d{2})-(.+)$/.exec(f.basename);
    const date = dateMatch?.[1] ?? new Date(f.mtimeMs).toISOString().slice(0, 10);
    const slug = dateMatch?.[2] ?? f.basename;
    const summary = f.parsed.summary ? `: ${f.parsed.summary}` : '';
    lines.push(`- ${date} **${slug}**${summary}`);
  }
  return lines.join('\n');
}

export class RequirementsArchiveProvider implements KnowledgeProvider {
  readonly id = 'requirements-archive';
  readonly displayName = 'Requirements Archive';

  private readonly dirName: string;
  private readonly maxIndexEntries: number;
  private readonly maxSearchResults: number;
  private readonly snippetMaxBytes: number;

  constructor(options: RequirementsArchiveProviderOptions = {}) {
    this.dirName = options.dirName ?? DEFAULT_DIR;
    this.maxIndexEntries = options.maxIndexEntries ?? DEFAULT_INDEX;
    this.maxSearchResults = options.maxSearchResults ?? DEFAULT_SEARCH;
    this.snippetMaxBytes = options.snippetMaxBytes ?? DEFAULT_SNIPPET_BYTES;
  }

  canHandle(ctx: KnowledgeContext): boolean {
    if (!ctx.cwd) return false;
    const dir = findArchiveDir(ctx.cwd, this.dirName);
    if (!dir) return false;
    // Empty dir → still canHandle=false; nothing to surface.
    return loadArchives(dir).length > 0;
  }

  async getSessionContext(ctx: KnowledgeContext): Promise<string | null> {
    if (!ctx.cwd) return null;
    const dir = findArchiveDir(ctx.cwd, this.dirName);
    if (!dir) return null;
    const files = loadArchives(dir);
    if (files.length === 0) return null;
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return renderIndex(files.slice(0, this.maxIndexEntries));
  }

  async search(query: string, ctx?: KnowledgeContext): Promise<KnowledgeSnippet[]> {
    if (!ctx?.cwd || !query.trim()) return [];
    const dir = findArchiveDir(ctx.cwd, this.dirName);
    if (!dir) return [];
    const files = loadArchives(dir);
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const scored = files
      .map((f) => ({ file: f, score: scoreArchive(f, queryTokens) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, this.maxSearchResults);

    return scored.map(({ file, score }) => ({
      source: this.id,
      title: file.parsed.title || file.basename,
      body: bestSnippet(file, queryTokens, this.snippetMaxBytes) || file.parsed.summary || '',
      score,
      citation: `requirements:${file.basename}`,
    }));
  }

  async healthcheck(): Promise<KnowledgeProviderHealth> {
    // Health is per-context (a given ctx might have a dir, another might not),
    // so we can't validate without a context. Always healthy at the provider
    // level; canHandle gates per-session.
    return { ok: true, reason: 'requirements/ resolved per-session via cwd walk-up' };
  }
}
