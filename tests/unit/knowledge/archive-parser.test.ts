import { describe, expect, it } from 'vitest';
import { parseArchive } from '../../../src/knowledge/archive-parser.js';

describe('parseArchive — title', () => {
  it('extracts the first H1 as title', () => {
    const r = parseArchive('# My Requirement\n\nbody text');
    expect(r.title).toBe('My Requirement');
  });

  it('subsequent H1 lines are NOT taken as title', () => {
    const r = parseArchive('# First\n\n# Second\n');
    expect(r.title).toBe('First');
  });

  it('attack: no H1 → empty title (no throw)', () => {
    const r = parseArchive('## subheading only\n\ntext');
    expect(r.title).toBe('');
  });

  it('attack: H1 with trailing whitespace is trimmed', () => {
    expect(parseArchive('#   spaced title   \n').title).toBe('spaced title');
  });
});

describe('parseArchive — sections', () => {
  it('captures H2 sections by heading text', () => {
    const md = `# T

## 背景
some background

## 目的
the goal
`;
    const r = parseArchive(md);
    expect(r.sections.get('背景')?.trim()).toBe('some background');
    expect(r.sections.get('目的')?.trim()).toBe('the goal');
  });

  it('H3+ headings stay inside their parent H2 section', () => {
    const md = `# T

## 背景
intro

### sub heading
sub content
`;
    const r = parseArchive(md);
    expect(r.sections.get('背景')).toContain('### sub heading');
    expect(r.sections.get('背景')).toContain('sub content');
  });

  it('attack: H2 with no body produces empty section value', () => {
    const r = parseArchive('# T\n\n## empty\n## next\nthing\n');
    expect(r.sections.get('empty')).toBe('');
    expect(r.sections.get('next')?.trim()).toBe('thing');
  });
});

describe('parseArchive — summary', () => {
  it('uses ## 目的 section content when present', () => {
    const md = `# T

## 背景
not this

## 目的
this is the purpose statement
`;
    expect(parseArchive(md).summary).toBe('this is the purpose statement');
  });

  it('English alias ## Purpose is recognized', () => {
    const md = `# T

## Purpose
goal goes here
`;
    expect(parseArchive(md).summary).toBe('goal goes here');
  });

  it('falls back to first non-heading paragraph after the title', () => {
    const md = `# T

first paragraph here.

## 改动概览
shouldn't be picked
`;
    expect(parseArchive(md).summary).toBe('first paragraph here.');
  });

  it('attack: collapses internal whitespace and truncates beyond 160 chars', () => {
    const longBody = 'a'.repeat(300);
    const md = `# T\n\n## 目的\n${longBody}\n`;
    const r = parseArchive(md);
    expect(r.summary.length).toBeLessThanOrEqual(160);
    expect(r.summary.endsWith('…')).toBe(true);
  });

  it('attack: empty file → no title, no summary, no sections', () => {
    const r = parseArchive('');
    expect(r.title).toBe('');
    expect(r.summary).toBe('');
    expect(r.sections.size).toBe(0);
  });

  it('attack: only headings, no body → empty summary', () => {
    const r = parseArchive('# T\n## 目的\n## 背景\n');
    expect(r.summary).toBe('');
  });
});

describe('parseArchive — line endings', () => {
  it('handles CRLF', () => {
    const r = parseArchive('# T\r\n\r\n## 目的\r\ngoal\r\n');
    expect(r.title).toBe('T');
    expect(r.summary).toBe('goal');
  });
});
