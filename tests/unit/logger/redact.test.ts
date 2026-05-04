import { describe, expect, it } from 'vitest';
import { redact } from '../../../src/logger/redact.js';

describe('redact — sensitive keys', () => {
  it('replaces apiKey / token / secret values with mask', () => {
    expect(redact({ apiKey: 'sk-abc12345', token: 'longSecret123' })).toEqual({
      apiKey: 'sk-a***',
      token: 'long***',
    });
  });

  it('mask uses *** when value is shorter than 6 chars', () => {
    expect(redact({ token: 'abc' })).toEqual({ token: '***' });
  });

  it('case-insensitive key matching', () => {
    expect(redact({ APIKEY: 'longvalue' })).toEqual({ APIKEY: 'long***' });
    expect(redact({ Authorization: 'Bearer longvalue' })).toEqual({ Authorization: 'Bear***' });
  });

  it('handles non-string values for sensitive keys', () => {
    expect(redact({ apiKey: 12345, password: ['a', 'b'] })).toEqual({
      apiKey: '***',
      password: '***',
    });
  });
});

describe('redact — token-like values', () => {
  it('masks bearer / sk- / xoxb- patterns even when key name is benign', () => {
    expect(redact({ note: 'Bearer abcdefg12345' })).toEqual({ note: 'Bear***' });
    expect(redact({ note: 'sk-abcdefghijkl' })).toEqual({ note: 'sk-a***' });
  });

  it('leaves short or non-pattern strings alone', () => {
    expect(redact({ note: 'hello world' })).toEqual({ note: 'hello world' });
    expect(redact({ note: 'sk-' })).toEqual({ note: 'sk-' });
  });
});

describe('redact — recursion', () => {
  it('walks nested objects', () => {
    expect(redact({ outer: { inner: { apiKey: 'longvalue123' } } }))
      .toEqual({ outer: { inner: { apiKey: 'long***' } } });
  });

  it('walks arrays', () => {
    expect(redact([{ token: 'longSecret123' }, { other: 'safe' }]))
      .toEqual([{ token: 'long***' }, { other: 'safe' }]);
  });

  it('attack: stops at MAX_DEPTH (no infinite recursion)', () => {
    const a: Record<string, unknown> = {};
    let cur: Record<string, unknown> = a;
    for (let i = 0; i < 20; i++) {
      cur['x'] = {};
      cur = cur['x'] as Record<string, unknown>;
    }
    expect(() => redact(a)).not.toThrow();
  });

  it('null / undefined / primitives pass through', () => {
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
    expect(redact(42)).toBe(42);
    expect(redact('hello')).toBe('hello');
    expect(redact(true)).toBe(true);
  });
});
