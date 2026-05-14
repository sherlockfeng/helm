/**
 * Entity extractor — rule-based 4-tier extraction (Phase 76).
 *
 * Pins each tier independently so a future "I added a regex" change has
 * to either preserve current behavior or update a specific case.
 */

import { describe, expect, it } from 'vitest';
import {
  extractEntities,
  extractEntitiesFromQuery,
  KNOWN_HELM_ENTITIES,
} from '../../../src/roles/entity-extract.js';

function entitySet(text: string, filename?: string): Set<string> {
  return new Set(extractEntities(text, filename).map((e) => e.entity));
}

describe('extractEntities — tier 1 (whitelist)', () => {
  it('matches 2-letter acronyms in the whitelist (MR, PR, QA) which would fail tier 2 length floor', () => {
    const e = entitySet('Reviewer asked: open an MR, also tag QA on the PR.');
    expect(e.has('MR')).toBe(true);
    expect(e.has('QA')).toBe(true);
    expect(e.has('PR')).toBe(true);
  });

  it('is case-insensitive — `mr` is still treated as MR (canonical case stored)', () => {
    const out = extractEntities('please open mr to fix this');
    const mr = out.find((e) => e.entity.toUpperCase() === 'MR');
    expect(mr).toBeDefined();
    expect(mr!.entity).toBe('MR'); // canonical
    expect(mr!.tier).toBe('whitelist');
  });

  it('K8s with mixed digit+lowercase survives whitelist (would fail caps regex)', () => {
    expect(entitySet('deploying to K8s next week').has('K8s')).toBe(true);
  });

  it('whitelist constant exports the documented short acronyms', () => {
    for (const e of ['MR', 'PR', 'QA', 'MCP', 'K8s']) {
      expect(KNOWN_HELM_ENTITIES).toContain(e);
    }
  });
});

describe('extractEntities — tier 2 (>= 3 caps)', () => {
  it('captures TCE, CSR, RBAC', () => {
    const e = entitySet('CSR fallback runbook for TCE — RBAC must allow scale-down');
    expect(e.has('CSR')).toBe(true);
    expect(e.has('TCE')).toBe(true);
    expect(e.has('RBAC')).toBe(true);
  });

  it('does NOT capture 2-letter acronyms not in whitelist', () => {
    expect(entitySet('NB this is some IT thing').has('IT')).toBe(false);
    expect(entitySet('AT this rate it works').has('AT')).toBe(false);
  });

  it('captures trailing digits (HTTP2, GPT4 — treated as one token)', () => {
    expect(entitySet('migrate to HTTP2 over GPT4 batch').has('HTTP2')).toBe(true);
    expect(entitySet('migrate to HTTP2 over GPT4 batch').has('GPT4')).toBe(true);
  });
});

describe('extractEntities — tier 3 (camelCase)', () => {
  it('captures camelCase identifiers with >= 2 segments', () => {
    const e = entitySet('the getCycleState function calls fetchUserById internally');
    expect(e.has('getCycleState')).toBe(true);
    expect(e.has('fetchUserById')).toBe(true);
  });

  it('captures PascalCase types', () => {
    expect(entitySet('class ResponseHandler implements BaseService').has('ResponseHandler')).toBe(true);
    expect(entitySet('class ResponseHandler implements BaseService').has('BaseService')).toBe(true);
  });

  it('does NOT capture single-word capitalized names like "Hello" or "World"', () => {
    expect(entitySet('Hello World, this is some prose').has('Hello')).toBe(false);
    expect(entitySet('Hello World, this is some prose').has('World')).toBe(false);
  });
});

describe('extractEntities — tier 4 (URL)', () => {
  it('captures host AND last path segment', () => {
    const e = entitySet('see https://bytedance.us.larkoffice.com/docx/Nd2CdKlYyojunFxP6ltuc7RysRg');
    expect(e.has('bytedance.us.larkoffice.com')).toBe(true);
    expect(e.has('Nd2CdKlYyojunFxP6ltuc7RysRg')).toBe(true);
  });

  it('strips query string and fragment', () => {
    const e = entitySet('go to https://example.com/path/thing?utm=1#section');
    expect(e.has('example.com')).toBe(true);
    expect(e.has('thing')).toBe(true);
    // Doesn't capture utm=1 or #section
    expect(Array.from(e).some((s) => s.includes('utm'))).toBe(false);
  });

  it('http and https both work', () => {
    expect(entitySet('see http://localhost:3000/health').has('localhost:3000')).toBe(true);
  });
});

describe('extractEntities — tier 5 (filenames)', () => {
  it('captures inline filenames in text', () => {
    expect(entitySet('open rollback-runbook.md for details').has('rollback-runbook')).toBe(true);
  });

  it('explicit `filename` arg adds the basename without extension', () => {
    const out = extractEntities('content here', 'docs/runbooks/csr-fallback.md');
    expect(out.find((e) => e.entity === 'csr-fallback')).toBeDefined();
  });

  it('strips path AND extension from filename arg', () => {
    const out = extractEntities('x', '/abs/path/to/spec.v2.md');
    const f = out.find((e) => e.tier === 'filename');
    expect(f?.entity).toBe('spec.v2');
  });
});

describe('extractEntities — edge / hardening', () => {
  it('deterministic — same input → same output (order may vary, set equality is what matters)', () => {
    const a = entitySet('CSR fallback / getCycleState / https://x.com/foo');
    const b = entitySet('CSR fallback / getCycleState / https://x.com/foo');
    expect(a).toEqual(b);
  });

  it('caps at MAX_ENTITIES_PER_CHUNK (20) — explosive inputs don\'t blow up the table', () => {
    // Construct ~50 distinct caps acronyms.
    const text = Array.from({ length: 50 }, (_, i) => `TST${i}`).join(' ');
    const out = extractEntities(text);
    expect(out.length).toBeLessThanOrEqual(20);
  });

  it('dedups across tiers — `API` hits whitelist + caps but only one row returned', () => {
    const out = extractEntities('API design for the public API');
    const apiHits = out.filter((e) => e.entity === 'API');
    expect(apiHits.length).toBe(1);
    expect(apiHits[0]!.tier).toBe('whitelist');
  });

  it('empty input returns empty array', () => {
    expect(extractEntities('')).toEqual([]);
    expect(extractEntities('   \n\n   ')).toEqual([]);
  });

  it('extractEntitiesFromQuery returns string array (convenience wrapper)', () => {
    const out = extractEntitiesFromQuery('TCE rollback runbook getCycleState');
    expect(Array.isArray(out)).toBe(true);
    expect(out).toContain('TCE');
    expect(out).toContain('getCycleState');
  });
});
