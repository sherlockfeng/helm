import { describe, expect, it } from 'vitest';
import { unquoteGitPath } from '../../../src/knowledge-repo/git.js';

/**
 * Regression for the CJK-topic "未入索引" bug: git renders non-ASCII path
 * bytes as octal escapes (e.g. 网 = \347\275\221). With core.quotePath=false
 * paths come through clean, but if git still quotes one (genuinely special
 * chars), unquoteGitPath must rebuild the original UTF-8 so it matches the
 * source_file stored in the index.
 */
describe('unquoteGitPath', () => {
  it('decodes octal-escaped CJK back to UTF-8', () => {
    // "og-网关与-decc-打标/og-schema-599.md" as git would octal-quote it.
    const quoted = '"chat-captured/u/og-\\347\\275\\221\\345\\205\\263.md"';
    expect(unquoteGitPath(quoted)).toBe('chat-captured/u/og-网关.md');
  });

  it('round-trips a full Chinese topic dir', () => {
    const real = 'chat-captured/heyunfeng.feng/og-网关与-decc-打标/og-schema-599.md';
    // Re-quote it the way git does (octal-escape every non-ASCII byte).
    const requoted = '"' + [...Buffer.from(real, 'utf8')].map((b) =>
      b < 0x80 ? String.fromCharCode(b) : '\\' + b.toString(8).padStart(3, '0'),
    ).join('') + '"';
    expect(unquoteGitPath(requoted)).toBe(real);
  });

  it('decodes common single-char escapes', () => {
    expect(unquoteGitPath('"a\\tb\\\\c\\"d"')).toBe('a\tb\\c"d');
  });

  it('passes ASCII paths through unchanged', () => {
    expect(unquoteGitPath('"chat-captured/u/stability/foo.md"')).toBe('chat-captured/u/stability/foo.md');
  });
});
