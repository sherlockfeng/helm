/**
 * Unit tests for the publish serializer (PR 5.5d.1).
 */

import { describe, expect, it } from 'vitest';
import { serializePoint } from '../../../src/knowledge-repo/serializer.js';
import type { KnowledgeChunk } from '../../../src/storage/types.js';

function chunk(overrides: Partial<KnowledgeChunk> = {}): KnowledgeChunk {
  return {
    id: 'p-1', roleId: 'r-1', chunkText: 'Body text.',
    kind: 'spec', createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('serializePoint helm-native', () => {
  it('emits frontmatter with id / kind / aliases / rel in alphabetical groups', () => {
    const out = serializePoint({
      chunk: chunk({ id: 'dr-overview', kind: 'spec', chunkText: '# 容灾\n\nBody.' }),
      aliases: [
        { pointId: 'dr-overview', alias: 'DR', source: 'manual', createdAt: 0 },
        { pointId: 'dr-overview', alias: '容灾', source: 'manual', createdAt: 0 },
      ],
      rel: [
        { fromPointId: 'dr-overview', toPointId: 'cdn-dr', relKind: 'includes', createdAt: 0 },
        { fromPointId: 'dr-overview', toPointId: 'dr-runbook', relKind: 'correspondsTo', createdAt: 0 },
      ],
      title: '容灾 One Pager',
    });
    expect(out).toContain('id: dr-overview');
    expect(out).toContain('kind: spec');
    expect(out).toContain('title: "容灾 One Pager"');
    expect(out).toContain('aliases: [DR, 容灾]');
    expect(out).toContain('  includes: [cdn-dr]');
    expect(out).toContain('  correspondsTo: [dr-runbook]');
    expect(out).toContain('Body.');
  });

  it('omits empty fields and the rel block when nothing to write', () => {
    const out = serializePoint({
      chunk: chunk({ kind: 'other' }),
      aliases: [],
      rel: [],
    });
    expect(out).not.toContain('aliases');
    expect(out).not.toContain('rel');
    expect(out).not.toContain('kind:');
  });

  it('R-11: emits visibility frontmatter only when non-default (public)', () => {
    const outDefault = serializePoint({
      chunk: chunk({ visibility: 'internal' }),
      aliases: [], rel: [],
    });
    expect(outDefault).not.toContain('visibility:');

    const outPublic = serializePoint({
      chunk: chunk({ visibility: 'public' }),
      aliases: [], rel: [],
    });
    expect(outPublic).toContain('visibility: public');
  });

  it('R-11: emits source as compact JSON when provided', () => {
    const out = serializePoint({
      chunk: chunk({
        source: { kind: 'conversation', ref: 'sess-42' },
      }),
      aliases: [], rel: [],
    });
    expect(out).toContain('source: {"kind":"conversation","ref":"sess-42"}');
  });

  it('is deterministic — same input twice yields identical output', () => {
    const input = {
      chunk: chunk({ id: 'p', chunkText: 'body' }),
      aliases: [
        { pointId: 'p', alias: 'b', source: 'manual' as const, createdAt: 0 },
        { pointId: 'p', alias: 'a', source: 'manual' as const, createdAt: 0 },
      ],
      rel: [],
    };
    expect(serializePoint(input)).toBe(serializePoint(input));
  });

  it('round-trips with the helm-native reader', async () => {
    const { parsePointFile } = await import('../../../src/knowledge-repo/profiles.js');
    const out = serializePoint({
      chunk: chunk({
        id: 'rt-1', kind: 'runbook', chunkText: '# Rollback\n\n1. step\n2. step',
      }),
      aliases: [
        { pointId: 'rt-1', alias: 'reset', source: 'manual', createdAt: 0 },
      ],
      rel: [
        { fromPointId: 'rt-1', toPointId: 'cleanup', relKind: 'correspondsTo', createdAt: 0 },
      ],
    });
    const parsed = parsePointFile({
      profile: 'helm-native', relativePath: 'rt-1.md', text: out,
    });
    expect(parsed.id).toBe('rt-1');
    expect(parsed.kind).toBe('runbook');
    expect(parsed.aliases).toEqual(['reset']);
    expect(parsed.rel).toEqual([{ relKind: 'correspondsTo', toPointId: 'cleanup' }]);
  });
});

describe('serializePoint llm-wiki', () => {
  it('emits an h1 + concept fence with Chinese rel labels', () => {
    const out = serializePoint({
      profile: 'llm-wiki',
      chunk: chunk({ id: 'cdn-dr', chunkText: 'inside paragraph' }),
      aliases: [
        { pointId: 'cdn-dr', alias: 'CDN', source: 'manual', createdAt: 0 },
      ],
      rel: [
        { fromPointId: 'cdn-dr', toPointId: 'origin-dr', relKind: 'includes', createdAt: 0 },
        { fromPointId: 'cdn-dr', toPointId: 'dr-overview', relKind: 'correspondsTo', createdAt: 0 },
      ],
      title: 'CDN DR',
    });
    expect(out).toContain('# CDN DR');
    expect(out).toContain('```concept');
    expect(out).toContain('id: cdn-dr');
    expect(out).toContain('  包含: [origin-dr]');
    expect(out).toContain('  对应: [dr-overview]');
    expect(out).toContain('inside paragraph');
  });

  it('strips an existing h1 to avoid doubling the title', () => {
    const out = serializePoint({
      profile: 'llm-wiki',
      chunk: chunk({ id: 'x', chunkText: '# Title in body\n\nbody' }),
      aliases: [], rel: [],
      title: 'Title in body',
    });
    expect(out.match(/# Title in body/g)?.length).toBe(1);
  });
});
