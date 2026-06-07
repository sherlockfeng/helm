/**
 * Unit tests for the curated seed list (PR 5.5e).
 */

import { describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_REPO_SEEDS,
  findSeedById,
} from '../../../src/knowledge-repo/seeds.js';

describe('KNOWLEDGE_REPO_SEEDS', () => {
  it('every seed has the required shape', () => {
    for (const s of KNOWLEDGE_REPO_SEEDS) {
      expect(s.id).toMatch(/^[a-z0-9-]+$/);
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.url).toMatch(/^(https?:\/\/|git@)/);
      expect(s.branch.length).toBeGreaterThan(0);
      expect(['helm-native', 'llm-wiki', 'generic']).toContain(s.profile);
    }
  });

  it('ids are unique across the catalogue', () => {
    const ids = KNOWLEDGE_REPO_SEEDS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('findSeedById returns the matching entry', () => {
    if (KNOWLEDGE_REPO_SEEDS.length === 0) return;
    const id = KNOWLEDGE_REPO_SEEDS[0]!.id;
    expect(findSeedById(id)?.id).toBe(id);
  });

  it('findSeedById returns undefined for an unknown id', () => {
    expect(findSeedById('definitely-not-a-real-seed')).toBeUndefined();
  });
});
