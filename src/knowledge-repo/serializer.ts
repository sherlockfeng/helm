/**
 * KnowledgePoint → Markdown serializer (PR 5.5d).
 *
 * Inverse of the profile readers in profiles.ts. Given a Point + its
 * aliases + rel edges, emit a .md file ready to commit. The
 * serializer is deterministic so round-trips through read → write →
 * read produce stable output (no spurious diffs from key reordering).
 */

import type { KnowledgeChunk } from '../storage/types.js';
import type { KnowledgePointAlias, KnowledgePointRel } from '../storage/types.js';

export type SerializerProfile = 'helm-native' | 'llm-wiki';

export interface SerializePointInput {
  chunk: KnowledgeChunk;
  aliases: readonly KnowledgePointAlias[];
  rel: readonly KnowledgePointRel[];
  profile?: SerializerProfile;
  /** Title override; falls back to chunk.title; falls back to first h1 in body. */
  title?: string;
}

/**
 * Returns the .md file content (frontmatter + body). The caller writes
 * this into the cloned repo at the right path. The serializer does
 * not touch the filesystem.
 */
export function serializePoint(input: SerializePointInput): string {
  const profile = input.profile ?? 'helm-native';
  if (profile === 'llm-wiki') return serializeLlmWiki(input);
  return serializeHelmNative(input);
}

// ── helm-native ────────────────────────────────────────────────────────────

function serializeHelmNative(input: SerializePointInput): string {
  const lines: string[] = ['---'];
  lines.push(`id: ${input.chunk.id}`);
  if (input.chunk.kind && input.chunk.kind !== 'other') {
    lines.push(`kind: ${input.chunk.kind}`);
  }
  // R-11: round-trip visibility so publish → fetch → import preserves
  // the R-0 publish gate. `internal` is the default; emit it only when
  // it was explicitly the chunk's value (we always have it set, but
  // omit when default to keep frontmatter terse).
  if (input.chunk.visibility && input.chunk.visibility !== 'internal') {
    lines.push(`visibility: ${input.chunk.visibility}`);
  }
  // R-11: round-trip source provenance so an imported chunk that came
  // from a particular session / mirror retains that origin through a
  // publish round-trip. Stored as compact inline JSON.
  if (input.chunk.source) {
    lines.push(`source: ${JSON.stringify(input.chunk.source)}`);
  }
  if (input.title) lines.push(`title: ${quoteIfNeeded(input.title)}`);
  if (input.aliases.length > 0) {
    // Stable ordering: alphabetical so unrelated edits don't reshuffle
    // the file.
    const sorted = [...input.aliases].map((a) => a.alias).sort();
    lines.push(`aliases: [${sorted.map(quoteIfNeeded).join(', ')}]`);
  }
  if (input.rel.length > 0) {
    lines.push('rel:');
    // Group by relKind, sort within groups for determinism.
    const groups = new Map<string, string[]>();
    for (const r of input.rel) {
      const g = groups.get(r.relKind) ?? [];
      g.push(r.toPointId);
      groups.set(r.relKind, g);
    }
    for (const relKind of ['includes', 'correspondsTo', 'supersedes'] as const) {
      const ids = groups.get(relKind);
      if (!ids || ids.length === 0) continue;
      const sorted = [...ids].sort();
      lines.push(`  ${relKind}: [${sorted.map(quoteIfNeeded).join(', ')}]`);
    }
  }
  lines.push('---');
  lines.push('');
  lines.push(input.chunk.chunkText.replace(/\s+$/, ''));
  lines.push('');
  return lines.join('\n');
}

// ── llm-wiki ───────────────────────────────────────────────────────────────

function serializeLlmWiki(input: SerializePointInput): string {
  const title = input.title ?? extractFirstH1(input.chunk.chunkText) ?? input.chunk.id;
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push('```concept');
  lines.push(`id: ${input.chunk.id}`);
  if (input.aliases.length > 0) {
    const sorted = [...input.aliases].map((a) => a.alias).sort();
    lines.push(`aliases: [${sorted.map(quoteIfNeeded).join(', ')}]`);
  }
  if (input.rel.length > 0) {
    lines.push('rel:');
    const groups = new Map<string, string[]>();
    for (const r of input.rel) {
      const cnLabel = ({
        includes: '包含',
        correspondsTo: '对应',
        supersedes: '取代',
      } as const)[r.relKind];
      const g = groups.get(cnLabel) ?? [];
      g.push(r.toPointId);
      groups.set(cnLabel, g);
    }
    for (const [label, ids] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const sorted = [...ids].sort();
      lines.push(`  ${label}: [${sorted.map(quoteIfNeeded).join(', ')}]`);
    }
  }
  lines.push('```');
  lines.push('');
  // Strip an existing h1 so we don't double-print.
  const body = stripFirstH1(input.chunk.chunkText).trim();
  if (body.length > 0) {
    lines.push(body);
    lines.push('');
  }
  return lines.join('\n');
}

// ── helpers ────────────────────────────────────────────────────────────────

function quoteIfNeeded(s: string): string {
  // Wrap in quotes when the string contains characters that the
  // parser would otherwise interpret as syntax.
  if (/[\s,\[\]\{\}#:]/.test(s)) return JSON.stringify(s);
  return s;
}

function extractFirstH1(body: string): string | undefined {
  const m = body.match(/^#\s+(.+)$/m);
  return m ? m[1]!.trim() : undefined;
}

function stripFirstH1(body: string): string {
  return body.replace(/^#\s+.+$\n?/m, '');
}
