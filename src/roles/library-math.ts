/**
 * Pure math helpers for role knowledge retrieval (Phase 76).
 *
 * Lives in its own file to break the cycle between `library.ts` (which
 * owns the high-level `searchKnowledge` flow) and `hybrid-search.ts`
 * (which is imported by `library.ts` AND needs `cosineSimilarity`).
 * Both can pull from this leaf module without forming a loop.
 *
 * No I/O, no async, no DB — just numerics.
 */

/**
 * Standard cosine similarity over Float32Array embeddings. Returns 0 for
 * zero-norm inputs (instead of NaN) so callers don't have to guard.
 * Truncates to the shorter of the two arrays — defensive against
 * dimension-mismatched embeddings (shouldn't happen in production, but
 * an embedder swap mid-DB could otherwise produce silent bad math).
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
