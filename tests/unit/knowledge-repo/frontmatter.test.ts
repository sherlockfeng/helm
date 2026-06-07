/**
 * Unit tests for the YAML-subset frontmatter parser (PR 5.5b.1).
 */

import { describe, expect, it } from 'vitest';
import {
  FrontmatterParseError,
  parseMarkdownWithFrontmatter,
} from '../../../src/knowledge-repo/frontmatter.js';

describe('parseMarkdownWithFrontmatter', () => {
  it('returns body-only when there is no leading delimiter', () => {
    const r = parseMarkdownWithFrontmatter('# title\n\nbody');
    expect(r.data).toEqual({});
    expect(r.body).toBe('# title\n\nbody');
  });

  it('parses a basic scalar block', () => {
    const r = parseMarkdownWithFrontmatter([
      '---',
      'id: dr-overview',
      'kind: spec',
      'truthy: true',
      'count: 42',
      '---',
      '',
      '# Body title',
    ].join('\n'));
    expect(r.data).toEqual({ id: 'dr-overview', kind: 'spec', truthy: true, count: 42 });
    expect(r.body).toBe('# Body title');
  });

  it('parses an inline flow array', () => {
    const r = parseMarkdownWithFrontmatter([
      '---', 'aliases: [TCC, 灰度发布, gray-release]', '---', '',
    ].join('\n'));
    expect(r.data['aliases']).toEqual(['TCC', '灰度发布', 'gray-release']);
  });

  it('parses a block list of scalars', () => {
    const r = parseMarkdownWithFrontmatter([
      '---',
      'aliases:',
      '  - alpha',
      '  - beta',
      '  - gamma',
      '---', '',
    ].join('\n'));
    expect(r.data['aliases']).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('parses a nested map one level deep', () => {
    const r = parseMarkdownWithFrontmatter([
      '---',
      'rel:',
      '  includes: [child-a, child-b]',
      '  correspondsTo: peer-id',
      '---', '',
    ].join('\n'));
    expect(r.data['rel']).toEqual({
      includes: ['child-a', 'child-b'],
      correspondsTo: 'peer-id',
    });
  });

  it('respects quoted strings around values with #', () => {
    const r = parseMarkdownWithFrontmatter([
      '---',
      'note: "value with # not a comment"',
      'short: trailing # comment is stripped',
      '---', '',
    ].join('\n'));
    expect(r.data['note']).toBe('value with # not a comment');
    expect(r.data['short']).toBe('trailing');
  });

  it('returns body when frontmatter is opened but never closed (non-strict)', () => {
    const text = '---\nid: x\n\nbody without delimiter';
    const r = parseMarkdownWithFrontmatter(text);
    expect(r.data).toEqual({});
    expect(r.body).toBe(text);
  });

  it('throws in strict mode when the closing delimiter is missing', () => {
    expect(() => parseMarkdownWithFrontmatter(
      '---\nid: x\n\nbody without delimiter', { strict: true },
    )).toThrowError(FrontmatterParseError);
  });

  it('preserves an h1 title in the body', () => {
    const r = parseMarkdownWithFrontmatter('---\nid: x\n---\n\n# Hello world\n\npara');
    expect(r.body).toBe('# Hello world\n\npara');
  });
});
