/**
 * Agent-response splitter (Phase 78).
 *
 * Pins:
 *   - blank-line boundary produces N paragraphs
 *   - fenced code blocks are atomic (one segment, never split by inner blank lines)
 *   - paragraphs shorter than minSegmentChars are dropped (default 80)
 *   - code blocks bypass the length floor (a 10-line snippet of short lines still qualifies)
 *   - kind labels: 'paragraph' for prose, 'code' for fences
 *   - index is 0-based and contiguous over the OUTPUT (not the raw text)
 *   - empty / whitespace-only input → []
 *   - unterminated fence is treated as a paragraph (degraded fallback, never lose text)
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIN_SEGMENT_CHARS,
  kindFromSegment,
  splitAgentResponse,
} from '../../../src/capture/splitter.js';

describe('splitAgentResponse — paragraphs', () => {
  it('splits on blank lines, drops paragraphs below minSegmentChars', () => {
    // Two paragraphs separated by a blank line. First is short (< 80 chars),
    // second is long enough to qualify.
    const longPara = 'A'.repeat(DEFAULT_MIN_SEGMENT_CHARS + 5);
    const text = `Short.\n\n${longPara}`;
    const segs = splitAgentResponse(text);
    expect(segs.length).toBe(1);
    expect(segs[0]!.text).toBe(longPara);
    expect(segs[0]!.kind).toBe('paragraph');
    expect(segs[0]!.index).toBe(0);
  });

  it('two qualifying paragraphs both surface with sequential indexes', () => {
    const p1 = 'A'.repeat(DEFAULT_MIN_SEGMENT_CHARS + 5);
    const p2 = 'B'.repeat(DEFAULT_MIN_SEGMENT_CHARS + 5);
    const segs = splitAgentResponse(`${p1}\n\n${p2}`);
    expect(segs.length).toBe(2);
    expect(segs[0]!.index).toBe(0);
    expect(segs[1]!.index).toBe(1);
    expect(segs[0]!.text).toBe(p1);
    expect(segs[1]!.text).toBe(p2);
  });
});

describe('splitAgentResponse — fenced code blocks', () => {
  it('keeps the entire code block as one segment', () => {
    const text = '```js\nconst x = 1;\nconst y = 2;\n\nconst z = 3;\n```';
    const segs = splitAgentResponse(text);
    expect(segs.length).toBe(1);
    expect(segs[0]!.kind).toBe('code');
    // Inner blank line did NOT split the block.
    expect(segs[0]!.text).toContain('const z = 3');
  });

  it('code blocks bypass the minSegmentChars floor', () => {
    // 4-line snippet, well under the 80-char prose threshold.
    const text = '```\na\nb\nc\nd\n```';
    const segs = splitAgentResponse(text);
    expect(segs.length).toBe(1);
    expect(segs[0]!.kind).toBe('code');
  });

  it('prose around a fence is split independently', () => {
    const longPara = 'L'.repeat(DEFAULT_MIN_SEGMENT_CHARS + 5);
    const text = `${longPara}\n\n\`\`\`\nrun(); something;\n\`\`\`\n\n${longPara}`;
    const segs = splitAgentResponse(text);
    expect(segs.length).toBe(3);
    expect(segs[0]!.kind).toBe('paragraph');
    expect(segs[1]!.kind).toBe('code');
    expect(segs[2]!.kind).toBe('paragraph');
  });

  it('unterminated fence is recovered as a paragraph (no text loss)', () => {
    const longBody = 'X'.repeat(DEFAULT_MIN_SEGMENT_CHARS + 5);
    const text = `\`\`\`\n${longBody}\n(file truncated)`;
    const segs = splitAgentResponse(text);
    // Reverts to paragraph; length floor still applies.
    expect(segs.length).toBeGreaterThanOrEqual(1);
    expect(segs[0]!.text).toContain(longBody.slice(0, 20));
  });
});

describe('splitAgentResponse — edge cases', () => {
  it('empty input returns []', () => {
    expect(splitAgentResponse('')).toEqual([]);
    expect(splitAgentResponse('   \n\n  ')).toEqual([]);
  });

  it('respects custom minSegmentChars', () => {
    const segs = splitAgentResponse('one\n\ntwo three four', { minSegmentChars: 5 });
    // "one" is 3 chars → drops; "two three four" is 14 → keeps.
    expect(segs.map((s) => s.text)).toEqual(['two three four']);
  });
});

describe('kindFromSegment', () => {
  it('maps code → example, paragraph → other', () => {
    expect(kindFromSegment('code')).toBe('example');
    expect(kindFromSegment('paragraph')).toBe('other');
  });
});
