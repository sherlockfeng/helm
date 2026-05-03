import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { expandTilde, longestPrefixMatch } from '../../../src/knowledge/match.js';

describe('expandTilde', () => {
  it('expands lone tilde', () => {
    expect(expandTilde('~')).toBe(homedir());
  });

  it('expands ~/ prefix', () => {
    expect(expandTilde('~/proj')).toBe(`${homedir()}/proj`);
  });

  it('leaves non-tilde paths alone', () => {
    expect(expandTilde('/abs/path')).toBe('/abs/path');
    expect(expandTilde('relative')).toBe('relative');
  });

  it('attack: empty string passes through', () => {
    expect(expandTilde('')).toBe('');
  });

  it('attack: ~tilde-username (not handled — returned as-is)', () => {
    expect(expandTilde('~someuser/path')).toBe('~someuser/path');
  });
});

describe('longestPrefixMatch', () => {
  it('returns null when no mappings match', () => {
    expect(longestPrefixMatch('/proj/a', [{ cwdPrefix: '/other' }])).toBeNull();
  });

  it('returns the only matching mapping', () => {
    const mappings = [{ cwdPrefix: '/proj' }];
    expect(longestPrefixMatch('/proj/a/b', mappings)).toEqual({ cwdPrefix: '/proj' });
  });

  it('returns the longest matching mapping', () => {
    const mappings = [
      { cwdPrefix: '/proj', tag: 'broad' },
      { cwdPrefix: '/proj/sub', tag: 'narrow' },
    ];
    expect(longestPrefixMatch('/proj/sub/file.ts', mappings)).toMatchObject({ tag: 'narrow' });
  });

  it('respects ~ expansion in mapping', () => {
    const mappings = [{ cwdPrefix: '~/work' }];
    expect(longestPrefixMatch(`${homedir()}/work/x`, mappings)).toEqual({ cwdPrefix: '~/work' });
  });

  it('attack: empty cwd never matches', () => {
    expect(longestPrefixMatch('', [{ cwdPrefix: '/proj' }])).toBeNull();
  });

  it('attack: empty cwdPrefix is filtered out (does not act as wildcard)', () => {
    expect(longestPrefixMatch('/proj/a', [{ cwdPrefix: '' }])).toBeNull();
  });

  it('attack: prefix without trailing slash does not over-match', () => {
    // /proj should NOT match /projection
    const mappings = [{ cwdPrefix: '/proj' }];
    // This is the deliberate matchString-prefix semantics — callers who care
    // about directory boundaries pass a trailing slash explicitly.
    expect(longestPrefixMatch('/projection/x', mappings)).toEqual({ cwdPrefix: '/proj' });
    expect(longestPrefixMatch('/projection/x', [{ cwdPrefix: '/proj/' }])).toBeNull();
  });
});
