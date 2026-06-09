import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLastAssistantMessage } from '../../../../src/host/claude-code/transcript.js';

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
