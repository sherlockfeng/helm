/**
 * Curated KnowledgeRepo seeds (PR 5.5e).
 *
 * Pre-baked subscription URLs the renderer surfaces as one-click
 * options on the Sources page. The list intentionally stays short —
 * we want a handful of well-known sources, not a marketplace.
 * Adding a seed = list-it-here; the renderer iterates this array.
 */

export interface KnowledgeRepoSeed {
  /** Stable id, matches the renderer button key. */
  id: string;
  /** Friendly label for the button. */
  label: string;
  /** One-liner explaining what it is. */
  description: string;
  /** Git URL the manager will subscribe to when the user clicks. */
  url: string;
  /** Default branch — typically 'main'. */
  branch: string;
  /** Profile to use when importing — most seeds are llm-wiki shape. */
  profile: 'helm-native' | 'llm-wiki' | 'generic';
}

export const KNOWLEDGE_REPO_SEEDS: readonly KnowledgeRepoSeed[] = [
  {
    id: 'llm-wiki',
    label: 'TikTok Web infra wiki',
    description:
      'Disaster-recovery / stability / deployment / monitoring knowledge for'
      + ' TikTok Web frontend infra. Includes 3 ready DR benchmark cases.',
    url: 'https://code.byted.org/tiktok/llm-wiki.git',
    // Verified against the real repo: HEAD is `master`. Earlier 'main'
    // was an assumption that broke `Subscribe llm-wiki` at clone time.
    branch: 'master',
    profile: 'llm-wiki',
  },
];

export function findSeedById(id: string): KnowledgeRepoSeed | undefined {
  return KNOWLEDGE_REPO_SEEDS.find((s) => s.id === id);
}
