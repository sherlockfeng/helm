/**
 * Rule-based entity extraction for helm role knowledge (Phase 76).
 *
 * Goal: pull out the substrings most likely to be "specific things the user
 * will mention by name" — short acronyms (TCE, CSR, MR), camelCase code
 * identifiers, URL host/path segments, file basenames. These feed the
 * entity-match leg of multipath retrieval; their value is letting a query
 * like "tce rollback" hit a chunk via direct substring index, independent
 * of BM25 IDF dynamics or cosine embedding quality.
 *
 * Not LLM-driven (Decision §2). The four-tier extractor here covers ~80%
 * of named-thing references in helm's typical role corpus (Lark docs,
 * runbooks, code-adjacent specs) without an LLM round-trip.
 *
 * The same function runs at TWO call sites — so it MUST be deterministic
 * + side-effect-free:
 *   1. `trainRole` / `updateRole`: chunk text → entities → index
 *   2. `hybridSearch`: query text → entities → look up index
 * Asymmetry between those two would silently corrupt recall.
 */

/**
 * Decision §B priority chain. Tier 1 (whitelist) wins over all length/case
 * rules — so 2-letter known acronyms like `MR` still surface as entities
 * despite the >=3-cap floor below. Add new short acronyms here as we
 * encounter them in helm's actual corpus.
 *
 * Casing notes:
 *   - We match case-insensitively in `KNOWN_HELM_ENTITIES` matching, but
 *     store the canonical (user-facing) form as the entity row.
 *   - The whitelist also covers a few lowercase/mixed cases that wouldn't
 *     otherwise be caught (e.g. "k8s" — lowercase 'k', digit, lowercase 's').
 */
export const KNOWN_HELM_ENTITIES: readonly string[] = [
  // Workflow / tooling shorthands users mention all the time
  'MR', 'PR', 'QA', 'CI', 'CD', 'IDE', 'SDK', 'API', 'CLI',
  // Infra / runtime shorthands
  'K8s', 'S3', 'DB', 'OS', 'VM',
  // helm-specific
  'MCP',
];

/**
 * Result of running the extractor on a piece of text. Each entity is the
 * canonical surface form (case-preserved as found in the text, except
 * whitelist matches which use their canonical case).
 *
 * Deduped within one extraction call. Across chunks, the storage repo's
 * PRIMARY KEY (chunk_id, entity) does the second-level dedup so the same
 * entity in the same chunk doesn't end up with two rows.
 */
export interface ExtractedEntity {
  entity: string;
  /**
   * Tier the entity was matched at — useful for tests and future weight
   * tuning. Not currently persisted; the DB row's `weight` column is the
   * compiled value.
   */
  tier: 'whitelist' | 'caps' | 'camelCase' | 'url' | 'filename';
}

/**
 * Per-chunk safety cap so an adversarial / pathological chunk can't blow
 * up the entity table. 20 entities is generous — a typical 800-char
 * chunk produces 3-8.
 */
const MAX_ENTITIES_PER_CHUNK = 20;

/**
 * The four tier regexes. Order matters: tier 1 runs first and short-
 * circuits whitelist hits before tier 2 applies its >=3 floor.
 */

// Tier 2: 3+ uppercase letters in a row, optionally followed by digits.
// `\b` boundaries + lookbehind ensure we don't grab the middle of a
// camelCase word ("apiURL" should give `URL` here AND `apiURL` from tier 3,
// dedup keeps both — both signals are useful).
const CAPS_ACRONYM_RE = /\b[A-Z]{3,}\d{0,3}\b/g;

// Tier 3: camelCase or PascalCase with >= 2 word segments. Strictly: at
// least one lowercase-to-uppercase transition. Single-word like "Hello"
// doesn't qualify (avoids capturing every prose word).
const CAMEL_CASE_RE = /\b[A-Za-z][a-z]+(?:[A-Z][a-z0-9]+)+\b/g;

// Tier 4: URLs — capture host + last path segment if present. Avoids
// query strings and fragments (those add noise without helping recall).
const URL_RE = /https?:\/\/([^\s/]+)(\/[^\s?#]*)?/g;

// Tier 5: file basenames — letter-led, contains a dot, has a 2-4 char
// extension, no spaces. Strips path + extension before storing.
const FILENAME_RE = /\b([A-Za-z][\w.-]*?)\.([a-zA-Z]{2,4})\b/g;

/**
 * Extract entities from a piece of text. The `filename` parameter is the
 * chunk's `sourceFile` — when present, we add it as an entity directly
 * (tier 5 path) without needing the regex to find it in the body.
 */
export function extractEntities(text: string, filename?: string): ExtractedEntity[] {
  const seen = new Map<string, ExtractedEntity>();

  const add = (raw: string, tier: ExtractedEntity['tier']): void => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    // Case-insensitive dedup key, preserve original casing in the stored
    // value. Whitelist matches override case to the canonical form below.
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    if (seen.size >= MAX_ENTITIES_PER_CHUNK) return;
    seen.set(key, { entity: trimmed, tier });
  };

  // Tier 1 — whitelist, case-insensitive, store canonical casing
  const lowerToCanonical = new Map(
    KNOWN_HELM_ENTITIES.map((e) => [e.toLowerCase(), e] as const),
  );
  // Walk word boundaries case-insensitively. We DON'T use a big regex
  // alternation because that doesn't honor word boundaries for the
  // letters/digits mix in 'K8s'. Manual segmentation is clearer.
  for (const match of text.matchAll(/\b[\w]+\b/g)) {
    const word = match[0];
    const canonical = lowerToCanonical.get(word.toLowerCase());
    if (canonical) add(canonical, 'whitelist');
  }

  // Tier 2 — 3+ caps
  for (const m of text.matchAll(CAPS_ACRONYM_RE)) {
    // Skip if already captured by whitelist (e.g. "API" wins as whitelist)
    if (lowerToCanonical.has(m[0]!.toLowerCase())) continue;
    add(m[0]!, 'caps');
  }

  // Tier 3 — camelCase
  for (const m of text.matchAll(CAMEL_CASE_RE)) {
    add(m[0]!, 'camelCase');
  }

  // Tier 4 — URLs (host + final path segment as separate entities)
  for (const m of text.matchAll(URL_RE)) {
    const host = m[1];
    const path = m[2];
    if (host) add(host, 'url');
    if (path) {
      const lastSeg = path.split('/').filter((s) => s.length > 0).pop();
      if (lastSeg) add(lastSeg, 'url');
    }
  }

  // Tier 5 — filenames found inline + the explicit `filename` argument
  for (const m of text.matchAll(FILENAME_RE)) {
    const base = m[1];
    if (base) add(base, 'filename');
  }
  if (filename) {
    // Strip directory + extension
    const base = filename.split('/').pop()!.replace(/\.[^.]+$/, '');
    if (base) add(base, 'filename');
  }

  return Array.from(seen.values());
}

/**
 * Query-side extractor. Same rules, just typically shorter input. Kept as
 * a thin alias so call sites read clearly ("extract from chunk" vs
 * "extract from query") and a future optimization (different rules at
 * query time, e.g. tighter whitelist) has a single place to diverge.
 */
export function extractEntitiesFromQuery(query: string): string[] {
  return extractEntities(query).map((e) => e.entity);
}
