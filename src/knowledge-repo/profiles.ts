/**
 * Markdown → KnowledgePoint profile adapters (PR 5.5b).
 *
 * Three readers, one normalized output. Each adapter parses a single
 * `.md` file and produces a `ParsedPoint`. The importer doesn't care
 * which adapter ran — it just upserts whatever the parser returns.
 *
 *   - helm-native: frontmatter carries id / kind / aliases / rel
 *   - llm-wiki:    body contains one or more ```concept fences with
 *                  id / aliases / rel; we lift them out
 *   - generic:     body-only Markdown; first h1 becomes the title,
 *                  no aliases or rel
 *
 * Profile selection happens at the repo level (a config field on the
 * subscription); the importer hands one file at a time to the chosen
 * adapter.
 */

import { parseMarkdownWithFrontmatter } from './frontmatter.js';
import type { FrontmatterValue } from './frontmatter.js';

export type KnowledgeRepoProfile = 'helm-native' | 'llm-wiki' | 'generic';

export type ParsedPointKind =
  | 'spec' | 'example' | 'warning' | 'runbook' | 'glossary' | 'other';

export type ParsedPointRelKind = 'includes' | 'correspondsTo' | 'supersedes';

export interface ParsedPoint {
  /** Slug or stable id. Falls back to the file basename when missing. */
  id: string;
  /** Display title; first h1 or frontmatter title. */
  title?: string;
  /** Body text (with concept fences stripped for llm-wiki). */
  body: string;
  kind: ParsedPointKind;
  aliases: string[];
  /** Outbound rel edges (canonical kind names). */
  rel: Array<{ relKind: ParsedPointRelKind; toPointId: string }>;
  /** R-11: round-tripped R-0 publish gate. Missing → 'internal'. */
  visibility?: 'internal' | 'public';
  /** R-11: round-tripped origin metadata blob (inline JSON in frontmatter). */
  source?: Record<string, unknown>;
}

export interface ParseFileInput {
  text: string;
  /** File path within the cloned repo, used as the fallback id. */
  relativePath: string;
  profile: KnowledgeRepoProfile;
}

/** Top-level dispatch. The importer does not care which profile ran. */
export function parsePointFile(input: ParseFileInput): ParsedPoint {
  switch (input.profile) {
    case 'helm-native': return parseHelmNative(input.text, input.relativePath);
    case 'llm-wiki':    return parseLlmWiki(input.text, input.relativePath);
    case 'generic':     return parseGeneric(input.text, input.relativePath);
  }
}

// ── helm-native ────────────────────────────────────────────────────────────

function parseHelmNative(text: string, relativePath: string): ParsedPoint {
  const { data, body } = parseMarkdownWithFrontmatter(text);
  const id = stringValue(data['id']) ?? basenameNoExt(relativePath);
  const kind = parseKind(stringValue(data['kind']));
  const aliases = arrayOfString(data['aliases']);
  const titleFromFrontmatter = stringValue(data['title']);
  const titleFromBody = extractFirstH1(body);
  const point: ParsedPoint = {
    id, body, kind, aliases, rel: parseRelMap(data['rel']),
  };
  const title = titleFromFrontmatter ?? titleFromBody;
  if (title) point.title = title;
  // R-11: round-tripped visibility / source — pulled from frontmatter
  // emitted by the serializer. Missing → caller defaults to 'internal'.
  const vis = stringValue(data['visibility']);
  if (vis === 'internal' || vis === 'public') point.visibility = vis;
  // The subset YAML parser keeps inline `{ ... }` JSON as a raw
  // string. Try to JSON.parse so the round-trip recovers the object
  // shape the serializer emitted; bail silently on malformed input.
  const sourceRaw = data['source'];
  if (typeof sourceRaw === 'string' && sourceRaw.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(sourceRaw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        point.source = parsed as Record<string, unknown>;
      }
    } catch { /* malformed inline JSON — leave source undefined */ }
  } else if (sourceRaw && typeof sourceRaw === 'object' && !Array.isArray(sourceRaw)) {
    point.source = sourceRaw as Record<string, unknown>;
  }
  return point;
}

/** §3.1 / §7.2: helm-native rel is a small map of relKind → [pointId, ...]. */
function parseRelMap(raw: FrontmatterValue | undefined): ParsedPoint['rel'] {
  const out: ParsedPoint['rel'] = [];
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [relKind, value] of Object.entries(raw)) {
    if (!isRelKind(relKind)) continue;
    const ids = Array.isArray(value)
      ? value.filter((v): v is string => typeof v === 'string')
      : (typeof value === 'string' ? [value] : []);
    for (const toPointId of ids) out.push({ relKind, toPointId });
  }
  return out;
}

// ── llm-wiki ───────────────────────────────────────────────────────────────
//
// llm-wiki encodes structured concept metadata in fenced blocks:
//
//   ```concept
//   id: my-concept
//   aliases: [synonym1, synonym2]
//   def: short definition
//   rel:
//     包含: [child-a, child-b]
//     对应: [peer]
//   ```
//
// We pull the FIRST concept fence as the point's metadata and treat
// the surrounding markdown (with the fence stripped) as the body.
// llm-wiki uses Chinese labels for rel kinds; we translate.

const LLM_WIKI_REL_TRANSLATIONS: Record<string, ParsedPointRelKind> = {
  '包含': 'includes',
  '对应': 'correspondsTo',
  '取代': 'supersedes',
  // Pass-through for files that already use the canonical names:
  'includes': 'includes',
  'correspondsTo': 'correspondsTo',
  'supersedes': 'supersedes',
};

function parseLlmWiki(text: string, relativePath: string): ParsedPoint {
  const { body: afterFrontmatter } = parseMarkdownWithFrontmatter(text);
  const conceptMatch = afterFrontmatter.match(/```concept\s*\n([\s\S]*?)\n```/);
  if (!conceptMatch) {
    return parseGeneric(text, relativePath);
  }
  // Reparse the concept block as YAML using our subset parser.
  const wrapped = `---\n${conceptMatch[1]}\n---\n`;
  const { data } = parseMarkdownWithFrontmatter(wrapped);
  const id = stringValue(data['id']) ?? basenameNoExt(relativePath);
  const aliases = arrayOfString(data['aliases']);
  const rel = parseLlmWikiRel(data['rel']);
  const body = afterFrontmatter.replace(/```concept\s*\n[\s\S]*?\n```/, '').trim();
  const point: ParsedPoint = {
    id, body, kind: parseKind(stringValue(data['kind'])),
    aliases, rel,
  };
  const title = extractFirstH1(body);
  if (title) point.title = title;
  return point;
}

function parseLlmWikiRel(raw: FrontmatterValue | undefined): ParsedPoint['rel'] {
  const out: ParsedPoint['rel'] = [];
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [label, value] of Object.entries(raw)) {
    const relKind = LLM_WIKI_REL_TRANSLATIONS[label];
    if (!relKind) continue;
    const ids = Array.isArray(value)
      ? value.filter((v): v is string => typeof v === 'string')
      : (typeof value === 'string' ? [value] : []);
    for (const toPointId of ids) out.push({ relKind, toPointId });
  }
  return out;
}

// ── generic ────────────────────────────────────────────────────────────────

function parseGeneric(text: string, relativePath: string): ParsedPoint {
  const { body } = parseMarkdownWithFrontmatter(text);
  const point: ParsedPoint = {
    id: basenameNoExt(relativePath),
    body, kind: 'other', aliases: [], rel: [],
  };
  const title = extractFirstH1(body);
  if (title) point.title = title;
  return point;
}

// ── helpers ────────────────────────────────────────────────────────────────

function isRelKind(s: string): s is ParsedPointRelKind {
  return s === 'includes' || s === 'correspondsTo' || s === 'supersedes';
}

function parseKind(raw: string | undefined): ParsedPointKind {
  switch (raw) {
    case 'spec':
    case 'example':
    case 'warning':
    case 'runbook':
    case 'glossary':
    case 'other':
      return raw;
    default: return 'other';
  }
}

function stringValue(raw: FrontmatterValue | undefined): string | undefined {
  return typeof raw === 'string' ? raw : undefined;
}

function arrayOfString(raw: FrontmatterValue | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string');
}

function basenameNoExt(p: string): string {
  const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  const last = slash >= 0 ? p.slice(slash + 1) : p;
  return last.replace(/\.md$/i, '');
}

function extractFirstH1(body: string): string | undefined {
  const m = body.match(/^#\s+(.+)$/m);
  return m ? m[1]!.trim() : undefined;
}
