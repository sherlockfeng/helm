import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readLastAssistantMessage,
  readLatestCustomTitle,
} from '../../../../src/host/claude-code/transcript.js';

let dir: string;
let p: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'helm-transcript-')); p = join(dir, 't.jsonl'); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('readLastAssistantMessage', () => {
  it('returns the last assistant message in flat string form', () => {
    writeFileSync(p, [
      JSON.stringify({ role: 'user', content: 'hi' }),
      JSON.stringify({ role: 'assistant', content: 'first' }),
      JSON.stringify({ role: 'user', content: 'more' }),
      JSON.stringify({ role: 'assistant', content: 'second' }),
    ].join('\n') + '\n');
    expect(readLastAssistantMessage(p)).toBe('second');
  });

  it('parses claude-code wrapped form with message.content array', () => {
    writeFileSync(p, JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'wrapped reply' }] },
    }) + '\n');
    expect(readLastAssistantMessage(p)).toBe('wrapped reply');
  });

  it('parses flat-array content blocks and joins text parts', () => {
    writeFileSync(p, JSON.stringify({
      role: 'assistant',
      content: [
        { type: 'text', text: 'part1 ' },
        { type: 'tool_use', name: 'Edit', input: {} },
        { type: 'text', text: 'part2' },
      ],
    }) + '\n');
    expect(readLastAssistantMessage(p)).toBe('part1 part2');
  });

  it('returns null for an empty transcript', () => {
    writeFileSync(p, '');
    expect(readLastAssistantMessage(p)).toBeNull();
  });

  it('returns null for a missing file (no throw)', () => {
    expect(readLastAssistantMessage(join(dir, 'nope.jsonl'))).toBeNull();
  });

  it('skips malformed JSON lines without crashing', () => {
    writeFileSync(p, [
      'not json',
      JSON.stringify({ role: 'assistant', content: 'good' }),
      'also not json',
    ].join('\n') + '\n');
    expect(readLastAssistantMessage(p)).toBe('good');
  });

  it('ignores non-assistant lines', () => {
    writeFileSync(p, JSON.stringify({ role: 'user', content: 'only user' }) + '\n');
    expect(readLastAssistantMessage(p)).toBeNull();
  });
});

describe('readLatestCustomTitle', () => {
  it('returns the title from a single custom-title row', () => {
    writeFileSync(p, JSON.stringify({
      type: 'custom-title', customTitle: 'helm', sessionId: 's1',
    }) + '\n');
    expect(readLatestCustomTitle(p)).toBe('helm');
  });

  it('returns the LAST title when several rows are appended (rename history)', () => {
    writeFileSync(p, [
      JSON.stringify({ type: 'custom-title', customTitle: 'first-title', sessionId: 's1' }),
      JSON.stringify({ role: 'user', content: 'hi' }),
      JSON.stringify({ type: 'custom-title', customTitle: 'better-title', sessionId: 's1' }),
      JSON.stringify({ role: 'assistant', content: 'ok' }),
      JSON.stringify({ type: 'custom-title', customTitle: 'final-title', sessionId: 's1' }),
    ].join('\n') + '\n');
    expect(readLatestCustomTitle(p)).toBe('final-title');
  });

  it('returns null when no custom-title row is present', () => {
    writeFileSync(p, [
      JSON.stringify({ role: 'user', content: 'hi' }),
      JSON.stringify({ role: 'assistant', content: 'ok' }),
    ].join('\n') + '\n');
    expect(readLatestCustomTitle(p)).toBeNull();
  });

  it('returns null for empty / missing transcript', () => {
    writeFileSync(p, '');
    expect(readLatestCustomTitle(p)).toBeNull();
    expect(readLatestCustomTitle(join(dir, 'nope.jsonl'))).toBeNull();
  });

  it('trims whitespace and rejects whitespace-only titles', () => {
    writeFileSync(p, [
      JSON.stringify({ type: 'custom-title', customTitle: '  spaced  ', sessionId: 's' }),
      JSON.stringify({ type: 'custom-title', customTitle: '   ', sessionId: 's' }),
    ].join('\n') + '\n');
    // Most recent wins, but whitespace-only is rejected so the prior real
    // title surfaces.
    expect(readLatestCustomTitle(p)).toBe('spaced');
  });

  it('tolerates malformed JSON on lines that happen to contain the keyword', () => {
    writeFileSync(p, [
      'not json containing "custom-title"',
      JSON.stringify({ type: 'custom-title', customTitle: 'real', sessionId: 's' }),
    ].join('\n') + '\n');
    expect(readLatestCustomTitle(p)).toBe('real');
  });
});
