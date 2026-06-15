import { describe, expect, it } from 'vitest';
import { parseBackfillCases } from '../../../src/summarizer/benchmark-backfill.js';

const VALID = new Set(['p1', 'p2', 'p3']);

describe('parseBackfillCases', () => {
  it('parses a valid bare JSON object', () => {
    const raw = JSON.stringify({
      cases: [
        {
          name: 'dc-failover',
          question: 'MY DC 挂了怎么切？',
          expectedTruth: 'MY 在 SG region，failover 到 SG1。',
          goldenPointIds: ['p1', 'p2'],
        },
      ],
    });
    expect(parseBackfillCases(raw, VALID)).toEqual([
      {
        name: 'dc-failover',
        question: 'MY DC 挂了怎么切？',
        expectedTruth: 'MY 在 SG region，failover 到 SG1。',
        goldenPointIds: ['p1', 'p2'],
      },
    ]);
  });

  it('parses fenced ```json blocks with surrounding prose', () => {
    const raw = [
      'Sure, here are the cases:',
      '```json',
      JSON.stringify({
        cases: [
          { name: 'a', question: 'q?', expectedTruth: 't', goldenPointIds: ['p3'] },
        ],
      }),
      '```',
      'Hope that helps!',
    ].join('\n');
    expect(parseBackfillCases(raw, VALID)).toEqual([
      { name: 'a', question: 'q?', expectedTruth: 't', goldenPointIds: ['p3'] },
    ]);
  });

  it('filters out unknown goldenPointIds, keeping known ones', () => {
    const raw = JSON.stringify({
      cases: [
        { name: 'a', question: 'q?', expectedTruth: 't', goldenPointIds: ['p1', 'nope', 'p2'] },
      ],
    });
    expect(parseBackfillCases(raw, VALID)[0]!.goldenPointIds).toEqual(['p1', 'p2']);
  });

  it('allows an empty goldenPointIds list (all ids unknown / none given)', () => {
    const raw = JSON.stringify({
      cases: [
        { name: 'a', question: 'q?', expectedTruth: 't', goldenPointIds: ['nope'] },
        { name: 'b', question: 'q2?', expectedTruth: 't2' },
      ],
    });
    const out = parseBackfillCases(raw, VALID);
    expect(out).toHaveLength(2);
    expect(out[0]!.goldenPointIds).toEqual([]);
    expect(out[1]!.goldenPointIds).toEqual([]);
  });

  it('drops incomplete cases (missing name/question/expectedTruth)', () => {
    const raw = JSON.stringify({
      cases: [
        { question: 'q?', expectedTruth: 't' },                 // no name
        { name: 'a', expectedTruth: 't' },                      // no question
        { name: 'a', question: 'q?' },                          // no expectedTruth
        { name: '  ', question: 'q?', expectedTruth: 't' },     // blank name
        { name: 'ok', question: 'q?', expectedTruth: 't' },     // valid
      ],
    });
    const out = parseBackfillCases(raw, VALID);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe('ok');
  });

  it('returns [] for non-JSON input', () => {
    expect(parseBackfillCases('not json at all', VALID)).toEqual([]);
    expect(parseBackfillCases('', VALID)).toEqual([]);
    expect(parseBackfillCases('{ broken', VALID)).toEqual([]);
  });

  it('returns [] when cases is missing or not an array', () => {
    expect(parseBackfillCases(JSON.stringify({ foo: 1 }), VALID)).toEqual([]);
    expect(parseBackfillCases(JSON.stringify({ cases: 'x' }), VALID)).toEqual([]);
  });
});
