/**
 * Unit tests for slugifyPointId (files-as-truth PR-2).
 */

import { describe, expect, it } from 'vitest';
import { slugifyPointId } from '../../../src/knowledge-repo/slug.js';

describe('slugifyPointId', () => {
  it('kebab-cases the first non-empty line', () => {
    expect(slugifyPointId('OG v5 Schema Mismatch\nmore detail', 'fb'))
      .toBe('og-v5-schema-mismatch');
  });

  it('strips a leading markdown heading marker', () => {
    expect(slugifyPointId('## Failover via gateway-handler', 'fb'))
      .toBe('failover-via-gateway-handler');
  });

  it('skips leading blank lines', () => {
    expect(slugifyPointId('\n\n  \nCDN runbook', 'fb')).toBe('cdn-runbook');
  });

  it('caps length at 60 without a trailing dash', () => {
    const long = 'a'.repeat(59) + ' bcd efg';
    const slug = slugifyPointId(long, 'fb');
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('falls back for pure-CJK text (no usable ASCII)', () => {
    expect(slugifyPointId('容灾预案的核心结论', 'capture-12ab34cd'))
      .toBe('capture-12ab34cd');
  });

  it('falls back when the slug would be too short', () => {
    expect(slugifyPointId('OG', 'fb-id')).toBe('fb-id');
  });

  it('collapses punctuation runs into single dashes', () => {
    expect(slugifyPointId('qps.argos -> gateway (v2)!', 'fb'))
      .toBe('qps-argos-gateway-v2');
  });
});
