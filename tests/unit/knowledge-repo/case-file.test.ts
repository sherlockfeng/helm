/**
 * Pure unit tests for the benchmark-case file format (no sqlite).
 *
 * Covers the round-trip contract (serialize → parse returns the same
 * fields), null rejection of non-case markdown, and tolerance of
 * missing optional arrays (golden / targetRoles default to []).
 */

import { describe, expect, it } from 'vitest';
import {
  parseCaseFile,
  serializeCase,
  type SerializeCaseInput,
} from '../../../src/knowledge-repo/case-file.js';

const SAMPLE: SerializeCaseInput = {
  id: 'og-v5-schema-mismatch',
  name: 'OG v5 schema mismatch',
  question: 'Why does the OG v5 ingest reject the legacy payload?',
  expectedTruth: 'The v5 schema renamed `ts` to `event_time`; the legacy payload still sends `ts`, so validation fails.',
  goldenPointIds: ['point-b', 'point-a'],
  targetRoleIds: ['role-2', 'role-1'],
};

describe('serializeCase / parseCaseFile round-trip', () => {
  it('round-trips all fields with arrays sorted deterministically', () => {
    const text = serializeCase(SAMPLE);
    const parsed = parseCaseFile(text, 'fallback');
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual({
      id: SAMPLE.id,
      name: SAMPLE.name,
      question: SAMPLE.question,
      expectedTruth: SAMPLE.expectedTruth,
      // serializeCase sorts arrays for stable output.
      goldenPointIds: ['point-a', 'point-b'],
      targetRoleIds: ['role-1', 'role-2'],
    });
  });

  it('produces deterministic output (sorted, stable on re-serialize)', () => {
    const text = serializeCase(SAMPLE);
    const reSerialized = serializeCase(parseCaseFile(text, 'fallback')!);
    expect(reSerialized).toBe(text);
  });

  it('contains the benchmark-case fence and prose section headings', () => {
    const text = serializeCase(SAMPLE);
    expect(text).toContain('```benchmark-case');
    expect(text).toContain('## 问题');
    expect(text).toContain('## 期望');
  });
});

describe('parseCaseFile rejection / tolerance', () => {
  it('returns null for a normal concept markdown (no benchmark-case fence)', () => {
    const concept = [
      '# Some concept',
      '',
      '```concept',
      'id: some-concept',
      'aliases: [foo, bar]',
      '```',
      '',
      'Body text here.',
      '',
    ].join('\n');
    expect(parseCaseFile(concept, 'fallback')).toBeNull();
  });

  it('returns null for plain markdown', () => {
    expect(parseCaseFile('# Just a title\n\nSome prose.\n', 'fallback')).toBeNull();
  });

  it('tolerates missing golden / targetRoles (default to [])', () => {
    const text = [
      '# Minimal case',
      '',
      '```benchmark-case',
      'id: minimal-case',
      '```',
      '',
      '## 问题',
      'What happens?',
      '',
      '## 期望',
      'It works.',
      '',
    ].join('\n');
    const parsed = parseCaseFile(text, 'fallback');
    expect(parsed).toEqual({
      id: 'minimal-case',
      name: 'Minimal case',
      question: 'What happens?',
      expectedTruth: 'It works.',
      goldenPointIds: [],
      targetRoleIds: [],
    });
  });

  it('uses the fallback id when the fence omits id', () => {
    const text = [
      '# No id case',
      '',
      '```benchmark-case',
      'golden: [p1]',
      '```',
      '',
      '## 问题',
      'Q?',
      '',
      '## 期望',
      'A.',
      '',
    ].join('\n');
    const parsed = parseCaseFile(text, 'my-fallback-id');
    expect(parsed?.id).toBe('my-fallback-id');
    expect(parsed?.goldenPointIds).toEqual(['p1']);
  });

  it('returns null when a required prose section is missing', () => {
    const text = [
      '# Missing expected',
      '',
      '```benchmark-case',
      'id: missing-expected',
      '```',
      '',
      '## 问题',
      'Only a question, no expected.',
      '',
    ].join('\n');
    expect(parseCaseFile(text, 'fallback')).toBeNull();
  });
});
