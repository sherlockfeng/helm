/**
 * cwd-prefix matching helpers shared by every KnowledgeProvider that maps cwd
 * → provider-specific scope. See PROJECT_BLUEPRINT.md §11.5.4.
 */

import { homedir } from 'node:os';

/** Expand a leading `~` (or `~/`) to the user's home directory. */
export function expandTilde(value: string): string {
  if (!value) return value;
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return `${homedir()}/${value.slice(2)}`;
  return value;
}

export interface CwdMapping {
  cwdPrefix: string;
}

/**
 * Returns the most-specific mapping whose `cwdPrefix` is a prefix of `cwd`,
 * or `null` if none match. Tilde-prefixed mappings (`~/proj`) are expanded
 * before comparison. "Most specific" = longest prefix wins.
 */
export function longestPrefixMatch<M extends CwdMapping>(cwd: string, mappings: readonly M[]): M | null {
  if (!cwd) return null;
  const candidates = mappings
    .map((m) => ({ m, expanded: expandTilde(m.cwdPrefix) }))
    .filter(({ expanded }) => expanded && cwd.startsWith(expanded))
    .sort((a, b) => b.expanded.length - a.expanded.length);
  return candidates[0]?.m ?? null;
}
