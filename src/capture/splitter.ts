/**
 * Agent-response splitter (Phase 78).
 *
 * Splits an agent's reply into semantically meaningful segments BEFORE
 * the scorer kicks in. Two boundary signals:
 *
 *   1. Fenced code blocks (```...```) — entire block becomes ONE segment
 *      regardless of internal blank lines. Code is rarely paraphrasable
 *      so we always keep it intact; the kind heuristic also reads this
 *      and labels code blocks `'example'`.
 *   2. Blank lines (\\n\\n+) — the standard "paragraph" boundary.
 *
 * Why split at all: a single agent turn often interleaves chatter
 * ("got it, let me check…") with the actual knowledge nugget ("X happens
 * when Y…"). Per-segment scoring lets the scorer surface only the
 * knowledge-bearing parts; the rest is dropped at the threshold.
 *
 * `minSegmentChars` filter (default 80) drops short segments — they're
 * almost always conversational, never role knowledge. Code blocks bypass
 * this filter (a 20-line snippet with very short lines still qualifies).
 */

export type SegmentKind = 'paragraph' | 'code';

export interface AgentResponseSegment {
  /** 0-based index within the response. Persisted on the candidate row. */
  index: number;
  text: string;
  kind: SegmentKind;
}

export interface SplitOptions {
  /** Drop paragraphs whose trimmed length is < this. Code blocks bypass. Default 80. */
  minSegmentChars?: number;
}

/** Default applied when caller omits SplitOptions. Exported for tests. */
export const DEFAULT_MIN_SEGMENT_CHARS = 80;

/**
 * Returns segments in original order. Empty responses → empty array.
 */
export function splitAgentResponse(
  text: string,
  opts: SplitOptions = {},
): AgentResponseSegment[] {
  const minChars = opts.minSegmentChars ?? DEFAULT_MIN_SEGMENT_CHARS;
  if (!text || !text.trim()) return [];

  // Pass 1: peel out fenced code blocks. We walk the text linearly, tracking
  // whether we're inside ``` ``` markers. Anything inside is a single code
  // segment; anything outside goes into a "prose" buffer that pass 2 splits
  // by blank lines.
  type RawChunk = { text: string; kind: SegmentKind };
  const raw: RawChunk[] = [];
  let buf = '';
  let inCode = false;
  let codeBuf = '';
  const lines = text.split('\n');
  for (const line of lines) {
    const isFence = /^\s*```/.test(line);
    if (isFence) {
      if (inCode) {
        // closing fence — flush code block (include both fences)
        codeBuf += line;
        raw.push({ text: codeBuf, kind: 'code' });
        codeBuf = '';
        inCode = false;
      } else {
        // opening fence — flush any pending prose
        if (buf.length > 0) { raw.push({ text: buf, kind: 'paragraph' }); buf = ''; }
        inCode = true;
        codeBuf = line + '\n';
      }
      continue;
    }
    if (inCode) {
      codeBuf += line + '\n';
    } else {
      buf += line + '\n';
    }
  }
  // Tail flushes — handle unterminated code block as prose (degraded but
  // never lose text).
  if (inCode && codeBuf.length > 0) {
    raw.push({ text: codeBuf, kind: 'paragraph' });
  }
  if (buf.length > 0) {
    raw.push({ text: buf, kind: 'paragraph' });
  }

  // Pass 2: split each paragraph chunk on blank-line boundaries.
  const out: AgentResponseSegment[] = [];
  for (const chunk of raw) {
    if (chunk.kind === 'code') {
      const trimmed = chunk.text.trim();
      if (trimmed.length > 0) {
        out.push({ index: out.length, text: trimmed, kind: 'code' });
      }
      continue;
    }
    // Split paragraphs on \n\n+
    for (const p of chunk.text.split(/\n{2,}/)) {
      const t = p.trim();
      if (t.length < minChars) continue;
      out.push({ index: out.length, text: t, kind: 'paragraph' });
    }
  }
  return out;
}

/**
 * Heuristic kind mapping for candidate persistence. Decision §11 — keep
 * conservative: code blocks → `'example'`, everything else → `'other'`.
 * User can change in the Edit-then-Accept modal.
 */
export function kindFromSegment(kind: SegmentKind): 'example' | 'other' {
  return kind === 'code' ? 'example' : 'other';
}
