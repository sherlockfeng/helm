/**
 * Unit tests for the profile adapters (PR 5.5b.2).
 */

import { describe, expect, it } from 'vitest';
import { parsePointFile } from '../../../src/knowledge-repo/profiles.js';

describe('helm-native profile', () => {
  it('reads id / kind / aliases / rel from frontmatter', () => {
    const p = parsePointFile({
      profile: 'helm-native',
      relativePath: 'dr/overview.md',
      text: [
        '---',
        'id: dr-overview',
        'kind: spec',
        'aliases: [DR, 容灾, 全链路容灾]',
        'rel:',
        '  includes: [cdn-dr, multi-idc-dr]',
        '  correspondsTo: [dr-adoption]',
        '---', '',
        '# 容灾 One Pager',
        '',
        'Body content.',
      ].join('\n'),
    });
    expect(p.id).toBe('dr-overview');
    expect(p.title).toBe('容灾 One Pager');
    expect(p.kind).toBe('spec');
    expect(p.aliases).toEqual(['DR', '容灾', '全链路容灾']);
    expect(p.rel).toEqual([
      { relKind: 'includes', toPointId: 'cdn-dr' },
      { relKind: 'includes', toPointId: 'multi-idc-dr' },
      { relKind: 'correspondsTo', toPointId: 'dr-adoption' },
    ]);
  });

  it('falls back to the file basename for id and "other" for kind', () => {
    const p = parsePointFile({
      profile: 'helm-native',
      relativePath: 'sub/path/my-point.md',
      text: 'just body, no frontmatter',
    });
    expect(p.id).toBe('my-point');
    expect(p.kind).toBe('other');
    expect(p.aliases).toEqual([]);
    expect(p.rel).toEqual([]);
  });

  it('coerces an unknown kind back to "other"', () => {
    const p = parsePointFile({
      profile: 'helm-native', relativePath: 'x.md',
      text: '---\nkind: not-a-real-kind\n---\n',
    });
    expect(p.kind).toBe('other');
  });
});

describe('llm-wiki profile', () => {
  it('lifts metadata out of a ```concept fence and strips the fence from body', () => {
    const text = [
      '---',
      'doc-id: dr-overview',
      '---', '',
      '# 容灾方案',
      '',
      '```concept',
      'id: dr-overview',
      'aliases: [容灾, DR]',
      'rel:',
      '  包含: [cdn-dr, multi-idc-dr]',
      '  对应: dr-runbook',
      '```',
      '',
      '正文段落。',
    ].join('\n');
    const p = parsePointFile({ profile: 'llm-wiki', relativePath: 'wiki/dr-overview.md', text });
    expect(p.id).toBe('dr-overview');
    expect(p.aliases.sort()).toEqual(['DR', '容灾']);
    expect(p.rel).toEqual([
      { relKind: 'includes', toPointId: 'cdn-dr' },
      { relKind: 'includes', toPointId: 'multi-idc-dr' },
      { relKind: 'correspondsTo', toPointId: 'dr-runbook' },
    ]);
    expect(p.body).not.toContain('```concept');
    expect(p.body).toContain('正文段落');
  });

  it('falls back to generic parsing when no concept fence is present', () => {
    const p = parsePointFile({
      profile: 'llm-wiki',
      relativePath: 'wiki/free-form.md',
      text: '# Just a doc\n\nbody',
    });
    expect(p.id).toBe('free-form');
    expect(p.title).toBe('Just a doc');
    expect(p.aliases).toEqual([]);
    expect(p.rel).toEqual([]);
  });
});

describe('generic profile', () => {
  it('uses the file basename as id and the first h1 as title', () => {
    const p = parsePointFile({
      profile: 'generic',
      relativePath: 'foo/bar/runbook.md',
      text: '# Rollback runbook\n\n1. step\n2. step',
    });
    expect(p.id).toBe('runbook');
    expect(p.title).toBe('Rollback runbook');
    expect(p.body).toContain('1. step');
  });
});
