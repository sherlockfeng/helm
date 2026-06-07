/**
 * Markdown frontmatter parser (PR 5.5b).
 *
 * Tiny, dependency-free YAML subset. Helm only needs to round-trip
 * helm-native + llm-wiki frontmatter shapes — flat scalars, string
 * arrays, and one-level nested objects. Anything more elaborate
 * (anchors, multi-doc, complex nested objects) is a sign the user
 * authored something custom, in which case we fall back to "treat
 * the whole file as body" rather than guess.
 *
 * The reason for a hand-rolled parser:
 *   - Helm already runs without `js-yaml`; adding it for the sake of
 *     reading a 4-field frontmatter is overkill
 *   - Bringing in a parser would mean adopting its quirks for the
 *     publish path too; round-tripping through a custom parser keeps
 *     write semantics explicit
 *
 * Strict failures throw FrontmatterParseError; non-strict callers
 * (e.g. the generic importer) catch and proceed with empty data.
 */

export type FrontmatterScalar = string | number | boolean | null;
export type FrontmatterValue =
  | FrontmatterScalar
  | FrontmatterScalar[]
  | Record<string, FrontmatterScalar | FrontmatterScalar[]>;

export class FrontmatterParseError extends Error {
  override readonly name = 'FrontmatterParseError';
}

export interface ParsedMarkdown {
  /** Parsed YAML frontmatter, or {} when none present. */
  data: Record<string, FrontmatterValue>;
  /** Body after the closing `---`, with the leading newline stripped. */
  body: string;
}

const DELIMITER = '---';

/**
 * Split a markdown file into frontmatter + body. The frontmatter block
 * is recognised when the file starts with `---` on a line by itself
 * and is closed by another `---` line. Anything else is body-only.
 */
export function parseMarkdownWithFrontmatter(
  text: string,
  opts: { strict?: boolean } = {},
): ParsedMarkdown {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== DELIMITER) {
    return { data: {}, body: text };
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === DELIMITER) { endIdx = i; break; }
  }
  if (endIdx === -1) {
    if (opts.strict) {
      throw new FrontmatterParseError('frontmatter delimiter opened but never closed');
    }
    return { data: {}, body: text };
  }
  const yamlText = lines.slice(1, endIdx).join('\n');
  const bodyText = lines.slice(endIdx + 1).join('\n').replace(/^\n+/, '');
  let data: Record<string, FrontmatterValue>;
  try {
    data = parseFlatYaml(yamlText);
  } catch (err) {
    if (opts.strict) throw err;
    return { data: {}, body: bodyText };
  }
  return { data, body: bodyText };
}

/**
 * Parse a small YAML subset:
 *
 *   key: scalar          # string / number / bool / null
 *   key: [a, b, c]       # inline flow array of scalars
 *   key:                 # block list of scalars
 *     - item1
 *     - item2
 *   key:                 # nested map (one level only)
 *     sub1: scalar
 *     sub2: [a, b]
 *
 * Comments after `#` are stripped unless the # appears inside quotes.
 * Anything more exotic throws FrontmatterParseError so callers know to
 * fall back.
 */
function parseFlatYaml(yamlText: string): Record<string, FrontmatterValue> {
  const out: Record<string, FrontmatterValue> = {};
  const lines = yamlText.split('\n');

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i]!;
    if (raw.trim().length === 0 || raw.trimStart().startsWith('#')) {
      i++; continue;
    }
    // Top-level entries have NO leading whitespace.
    if (raw.startsWith(' ') || raw.startsWith('\t')) {
      throw new FrontmatterParseError(`unexpected indent at line ${i + 1}: ${raw}`);
    }
    const colonIdx = raw.indexOf(':');
    if (colonIdx === -1) {
      throw new FrontmatterParseError(`expected key: value at line ${i + 1}: ${raw}`);
    }
    const key = raw.slice(0, colonIdx).trim();
    const rest = raw.slice(colonIdx + 1).trim();

    if (rest.length > 0) {
      // Scalar or inline array on the same line.
      if (rest.startsWith('[') && rest.endsWith(']')) {
        out[key] = parseInlineArray(rest);
      } else {
        out[key] = parseScalar(stripInlineComment(rest));
      }
      i++; continue;
    }

    // Empty value → block list or nested map starting on next line.
    const next = lines[i + 1];
    if (next == null) { out[key] = ''; i++; continue; }
    const nextIndent = leadingSpaces(next);
    if (nextIndent === 0) { out[key] = ''; i++; continue; }

    if (next.trim().startsWith('- ') || next.trim() === '-') {
      // Block list of scalars.
      const items: FrontmatterScalar[] = [];
      i++;
      while (i < lines.length && leadingSpaces(lines[i]!) >= nextIndent &&
             lines[i]!.trim().startsWith('-')) {
        const itemValue = lines[i]!.trim().slice(1).trim();
        items.push(parseScalar(stripInlineComment(itemValue)));
        i++;
      }
      out[key] = items;
      continue;
    }

    // Nested map (one level deep).
    const obj: Record<string, FrontmatterScalar | FrontmatterScalar[]> = {};
    i++;
    while (i < lines.length && leadingSpaces(lines[i]!) >= nextIndent
           && !lines[i]!.startsWith('-') && lines[i]!.trim().length > 0) {
      const sub = lines[i]!.trim();
      const subColon = sub.indexOf(':');
      if (subColon === -1) {
        throw new FrontmatterParseError(
          `expected sub-key: value at line ${i + 1}: ${lines[i]}`,
        );
      }
      const subKey = sub.slice(0, subColon).trim();
      const subRest = sub.slice(subColon + 1).trim();
      if (subRest.startsWith('[') && subRest.endsWith(']')) {
        obj[subKey] = parseInlineArray(subRest);
      } else {
        obj[subKey] = parseScalar(stripInlineComment(subRest));
      }
      i++;
    }
    out[key] = obj;
  }
  return out;
}

function leadingSpaces(s: string): number {
  let n = 0;
  while (n < s.length && (s[n] === ' ' || s[n] === '\t')) n++;
  return n;
}

function stripInlineComment(s: string): string {
  // Strip ` # comment` only when the # is preceded by whitespace and
  // not inside quotes. Helps a parser that doesn't track quote state.
  let inSingle = false, inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === '#' && !inSingle && !inDouble && i > 0 && /\s/.test(s[i - 1]!)) {
      return s.slice(0, i).trim();
    }
  }
  return s.trim();
}

function parseInlineArray(input: string): FrontmatterScalar[] {
  const inner = input.slice(1, -1).trim();
  if (inner.length === 0) return [];
  // Quote-aware split on commas.
  const parts: string[] = [];
  let buf = '';
  let inSingle = false, inDouble = false;
  for (const c of inner) {
    if (c === "'" && !inDouble) { inSingle = !inSingle; buf += c; continue; }
    if (c === '"' && !inSingle) { inDouble = !inDouble; buf += c; continue; }
    if (c === ',' && !inSingle && !inDouble) { parts.push(buf); buf = ''; continue; }
    buf += c;
  }
  if (buf.length > 0) parts.push(buf);
  return parts.map((p) => parseScalar(p.trim()));
}

function parseScalar(raw: string): FrontmatterScalar {
  if (raw.length === 0) return '';
  if (raw === '~' || raw === 'null' || raw === 'Null' || raw === 'NULL') return null;
  if (raw === 'true' || raw === 'True' || raw === 'TRUE') return true;
  if (raw === 'false' || raw === 'False' || raw === 'FALSE') return false;
  // Quoted string
  if ((raw.startsWith('"') && raw.endsWith('"'))
      || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  // Number (int or float; tolerant of leading sign)
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);
  return raw;
}
