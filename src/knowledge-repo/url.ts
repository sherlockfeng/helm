/**
 * Git URL parsing + host classification (PR 5.5a / design §7.4).
 *
 * Two shapes need to round-trip cleanly:
 *
 *   1. HTTPS / git+https:
 *      https://github.com/org/repo.git
 *      https://github.com/org/repo
 *      git+https://github.com/org/repo.git#branch=main
 *      https://code.byted.org/tiktok/llm-wiki.git
 *
 *   2. SSH:
 *      git@github.com:org/repo.git
 *      git@code.byted.org:tiktok/llm-wiki.git
 *
 * The renderer normalizes to the canonical form before storing so the
 * `UNIQUE(url)` constraint on knowledge_repo means "one subscription
 * per repo regardless of how the user typed it".
 */

export interface ParsedGitUrl {
  /** Normalized canonical form used as the storage key. */
  canonical: string;
  /** Hostname (lowercased). Drives §7.4 classification. */
  host: string;
  /** Owner / org segment, if any (GitHub-style two-segment path). */
  owner?: string;
  /** Repo name, with `.git` stripped. */
  repo: string;
  /** Branch from the `#branch=...` fragment, if present. */
  branch?: string;
  /** Was this an SSH-style URL? */
  ssh: boolean;
}

export class GitUrlError extends Error {
  override readonly name = 'GitUrlError';
}

/**
 * Parse a git URL into its components. Throws GitUrlError on shapes
 * we don't recognize so the caller (subscribe endpoint) can return
 * 400 instead of writing a garbage row.
 */
export function parseGitUrl(raw: string): ParsedGitUrl {
  const input = raw.trim();
  if (!input) throw new GitUrlError('git URL is empty');

  // Pull off a `#branch=...` fragment first; the rest of the parser
  // works on the stripped URL so the same path logic handles both
  // bare and fragmented inputs.
  let branch: string | undefined;
  let withoutFragment = input;
  const fragmentIdx = input.indexOf('#');
  if (fragmentIdx >= 0) {
    const fragment = input.slice(fragmentIdx + 1);
    withoutFragment = input.slice(0, fragmentIdx);
    const m = fragment.match(/^branch=(.+)$/);
    if (m) branch = m[1];
  }

  // SSH: git@host:owner/repo[.git]
  // SSH canonical preserves `.git` because that's the shape "Clone
  // with SSH" buttons hand out. We accept both forms in user input
  // but round-trip exactly what was typed so SSH-style entries don't
  // get re-normalized between sessions.
  const sshMatch = withoutFragment.match(/^([^@]+)@([^:]+):(.+)$/);
  if (sshMatch) {
    const userPart = sshMatch[1]!;
    const host = sshMatch[2]!.toLowerCase();
    const pathPart = sshMatch[3]!;
    const { owner, repo } = splitPath(pathPart);
    return {
      canonical: `${userPart}@${host}:${pathPart}${branch ? `#branch=${branch}` : ''}`,
      host, owner, repo,
      ...(branch ? { branch } : {}),
      ssh: true,
    };
  }

  // HTTPS / git+https. Strip the `git+` prefix; URL constructor takes
  // it from there. We tolerate trailing slashes.
  const stripped = withoutFragment.replace(/^git\+/, '');
  let parsed: URL;
  try {
    parsed = new URL(stripped);
  } catch {
    throw new GitUrlError(`not a valid git URL: ${raw}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new GitUrlError(`unsupported git URL scheme ${parsed.protocol}; use https or ssh (git@host:...)`);
  }
  const host = parsed.hostname.toLowerCase();
  // Strip the leading slash, then any trailing slash too — both forms
  // are common in user input.
  const pathPart = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  const { owner, repo } = splitPath(pathPart);
  // Canonical form drops the `git+` prefix and trailing `.git` so all
  // callers compute the same UNIQUE key regardless of typed shape.
  const canonicalPath = pathPart.replace(/\.git$/, '');
  const canonical = `https://${host}/${canonicalPath}${branch ? `#branch=${branch}` : ''}`;
  return {
    canonical, host, owner, repo,
    ...(branch ? { branch } : {}),
    ssh: false,
  };
}

function splitPath(pathPart: string): { owner?: string; repo: string } {
  // Drop `.git` if present.
  const trimmed = pathPart.replace(/\.git$/, '');
  const segments = trimmed.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) throw new GitUrlError(`git URL has no repo segment`);
  if (segments.length === 1) return { repo: segments[0]! };
  return { owner: segments[segments.length - 2], repo: segments[segments.length - 1]! };
}

// ── Host classification (R-0) ──────────────────────────────────────────────

/**
 * Default internal allow-list. Users can extend in helm config under
 * `publish.internalHosts`; the union becomes the classifier's input.
 *
 * Intentionally short — adding hosts via config is the supported
 * extension point, not editing this constant.
 */
export const DEFAULT_INTERNAL_HOSTS: readonly string[] = [
  'code.byted.org',
  'git.byted.com',
];

export interface ClassifyOptions {
  /** Extra hostnames the user has marked internal. Case-insensitive. */
  extraInternalHosts?: readonly string[];
}

/**
 * `internal` when the host (or any parent domain) is in the allow-list;
 * `public` otherwise. The "or parent domain" rule lets `*.bytedance.net`
 * style entries cover subdomain hosts without listing each one.
 */
export function classifyHost(
  host: string,
  opts: ClassifyOptions = {},
): 'internal' | 'public' {
  const haystack = new Set<string>(
    [...DEFAULT_INTERNAL_HOSTS, ...(opts.extraInternalHosts ?? [])]
      .map((h) => h.toLowerCase()),
  );
  const target = host.toLowerCase();
  for (const entry of haystack) {
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1); // ".bytedance.net"
      if (target === suffix.slice(1) || target.endsWith(suffix)) return 'internal';
      continue;
    }
    if (target === entry || target.endsWith(`.${entry}`)) return 'internal';
  }
  return 'public';
}
