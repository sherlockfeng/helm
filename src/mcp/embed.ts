/**
 * Pseudo-embedding function for trainRole / searchKnowledge.
 *
 * NOT a real embedding. Bag-of-codepoints projected into a fixed-dim vector,
 * then L2-normalized. Used as a placeholder so the storage path / cosine
 * similarity / topK selection are all exercised end-to-end without a real
 * embeddings API. A future Phase 13+ will plug in a real embedder
 * (Voyage / OpenAI / local model) for production use.
 *
 * Ported verbatim (function signature + behavior) from relay/src/mcp/server.ts.
 */

const DEFAULT_DIM = 128;

export function makePseudoEmbedFn(dim: number = DEFAULT_DIM): (text: string) => Promise<Float32Array> {
  return async (text: string): Promise<Float32Array> => {
    const vec = new Float32Array(dim);
    for (let i = 0; i < text.length; i++) {
      vec[text.charCodeAt(i) % dim] += 1;
    }
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
    const denom = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) vec[i] /= denom;
    return vec;
  };
}
