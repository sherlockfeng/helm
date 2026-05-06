/**
 * Pure markdown parser for `requirements/YYYY-MM-DD-slug.md` archives.
 *
 * Extracts the title (first H1), a one-line summary (preferred from
 * `## 目的` section, fallback to first non-heading paragraph), and a
 * section map. Used by RequirementsArchiveProvider to build the
 * sessionStart index and to score search hits.
 *
 * Defensive: malformed markdown never throws; missing fields surface
 * as empty strings / empty maps so callers can decide whether to skip.
 */

export interface ParsedArchive {
  title: string;
  summary: string;
  /** Heading text (without leading `#`) → body text under that heading. */
  sections: Map<string, string>;
}

/**
 * Section heading aliases that should populate the summary when present.
 * Order matters: first match wins. The Cursor user-rule template uses
 * `## 目的` (Chinese) by default; English alias `## Purpose` accepted too.
 */
const SUMMARY_HEADINGS = ['目的', 'Purpose', '目标', '概述', 'Overview', 'Summary'];

/** Trim + collapse internal whitespace runs to single spaces. */
function normalizeOneLine(value: string, maxLength = 160): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= maxLength ? flat : flat.slice(0, maxLength - 1) + '…';
}

export function parseArchive(content: string): ParsedArchive {
  const lines = content.split(/\r?\n/);
  const sections = new Map<string, string>();

  let title = '';
  let firstParagraph: string[] = [];
  let firstParagraphCollected = false;

  let currentHeading: string | null = null;
  let currentBody: string[] = [];

  function flushSection(): void {
    if (currentHeading !== null) {
      sections.set(currentHeading, currentBody.join('\n').trim());
    }
    currentHeading = null;
    currentBody = [];
  }

  for (const line of lines) {
    const h1 = /^#\s+(.+?)\s*$/.exec(line);
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    const anyHeading = /^#{1,6}\s+/.test(line);

    if (h1 && !title) {
      // First H1 wins for the title; subsequent H1s are treated as body.
      title = h1[1]!.trim();
      flushSection();
      continue;
    }

    if (h2) {
      flushSection();
      currentHeading = h2[1]!.trim();
      continue;
    }

    if (anyHeading) {
      // Lower-level headings (H3+) belong to the current H2 section's body.
      currentBody.push(line);
      continue;
    }

    if (currentHeading !== null) {
      currentBody.push(line);
    }

    // Track the first non-heading paragraph after the title for fallback summary.
    if (!firstParagraphCollected && title) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        if (firstParagraph.length > 0) firstParagraphCollected = true;
      } else if (!anyHeading) {
        firstParagraph.push(trimmed);
      }
    }
  }
  flushSection();

  // Pick summary: prefer a known summary section, else fall back to the
  // first paragraph after the title.
  let summary = '';
  for (const heading of SUMMARY_HEADINGS) {
    const body = sections.get(heading);
    if (body && body.trim()) {
      summary = normalizeOneLine(body);
      break;
    }
  }
  if (!summary && firstParagraph.length > 0) {
    summary = normalizeOneLine(firstParagraph.join(' '));
  }

  return { title, summary, sections };
}
