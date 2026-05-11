/**
 * parseJsonWithFormatRetry unit tests (Phase 68).
 *
 * Validates the "ask the engine to fix its own output once" pattern that
 * wraps claude summarize/review JSON output. Single retry; thrown
 * `JsonParseAfterRetryError` carries both attempts.
 */

import { describe, expect, it } from 'vitest';
import {
  parseJsonWithFormatRetry,
  stripFences,
  formatPassPrompt,
  JsonParseAfterRetryError,
} from '../../../src/engine/json-retry.js';

describe('stripFences', () => {
  it('strips ```json ... ``` fences', () => {
    expect(stripFences('```json\n{"a": 1}\n```')).toBe('{"a": 1}');
  });

  it('strips plain ``` ... ``` fences', () => {
    expect(stripFences('```\n{"a": 1}\n```')).toBe('{"a": 1}');
  });

  it('leaves un-fenced text untouched (so JSON.parse will still fail on prose)', () => {
    expect(stripFences('Sure! Here is your JSON:\n{"a": 1}')).toBe(
      'Sure! Here is your JSON:\n{"a": 1}',
    );
  });

  it('trims leading/trailing whitespace', () => {
    expect(stripFences('   {"a": 1}   ')).toBe('{"a": 1}');
  });
});

describe('parseJsonWithFormatRetry', () => {
  it('returns the parsed JSON without calling formatPass when first parse succeeds', async () => {
    let formatPassCalls = 0;
    const result = await parseJsonWithFormatRetry({
      raw: '{"x": 42}',
      formatPass: async () => { formatPassCalls++; return ''; },
    });
    expect(result).toEqual({ x: 42 });
    expect(formatPassCalls).toBe(0);
  });

  it('strips fences before first parse', async () => {
    const result = await parseJsonWithFormatRetry({
      raw: '```json\n{"y": "z"}\n```',
      formatPass: async () => '',
    });
    expect(result).toEqual({ y: 'z' });
  });

  it('calls formatPass and parses its output when first parse fails', async () => {
    let formatPassCalls = 0;
    let receivedRaw = '';
    const result = await parseJsonWithFormatRetry({
      raw: 'Here is your JSON:\n{"x": 42}',
      formatPass: async (raw) => {
        formatPassCalls++;
        receivedRaw = raw;
        return '{"x": 42}';
      },
    });
    expect(result).toEqual({ x: 42 });
    expect(formatPassCalls).toBe(1);
    expect(receivedRaw).toContain('Here is your JSON');
  });

  it('throws JsonParseAfterRetryError when BOTH attempts fail', async () => {
    await expect(parseJsonWithFormatRetry({
      raw: 'not json',
      formatPass: async () => 'still not json',
    })).rejects.toBeInstanceOf(JsonParseAfterRetryError);
  });

  it('thrown error preserves both attempts for debugging', async () => {
    try {
      await parseJsonWithFormatRetry({
        raw: 'first attempt prose',
        formatPass: async () => 'second attempt prose',
      });
      throw new Error('expected throw');
    } catch (err) {
      const e = err as JsonParseAfterRetryError;
      expect(e.firstAttempt).toBe('first attempt prose');
      expect(e.secondAttempt).toBe('second attempt prose');
      expect(e.firstError.length).toBeGreaterThan(0);
      expect(e.secondError.length).toBeGreaterThan(0);
    }
  });

  it('formatPass is called ONCE — not retried indefinitely', async () => {
    let calls = 0;
    await expect(parseJsonWithFormatRetry({
      raw: 'bad',
      formatPass: async () => { calls++; return 'still bad'; },
    })).rejects.toBeInstanceOf(JsonParseAfterRetryError);
    expect(calls).toBe(1);
  });
});

describe('formatPassPrompt', () => {
  it('embeds the original response between markers', () => {
    const p = formatPassPrompt('original prose');
    expect(p).toContain('original prose');
    expect(p).toMatch(/--- previous response ---/);
    expect(p).toMatch(/--- end ---/);
  });

  it('instructs the model to return JSON only with no commentary', () => {
    const p = formatPassPrompt('foo');
    expect(p).toMatch(/valid JSON only/i);
    expect(p).toMatch(/no prose, no markdown fences/i);
  });
});
