/**
 * Unit tests for the git URL parser + host classifier (PR 5.5a.2).
 *
 *   - parseGitUrl normalizes HTTPS, git+https, and SSH inputs
 *   - branch fragments (#branch=...) round-trip
 *   - `.git` suffix is stripped from repo names
 *   - empty / unknown-shape inputs throw GitUrlError
 *   - classifyHost respects the default allow-list AND user-supplied
 *     extras; wildcard entries cover subdomains
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INTERNAL_HOSTS,
  GitUrlError,
  classifyHost,
  parseGitUrl,
} from '../../../src/knowledge-repo/url.js';

describe('parseGitUrl', () => {
  it('normalizes a bare HTTPS GitHub URL', () => {
    const p = parseGitUrl('https://github.com/org/repo.git');
    expect(p.canonical).toBe('https://github.com/org/repo');
    expect(p.host).toBe('github.com');
    expect(p.owner).toBe('org');
    expect(p.repo).toBe('repo');
    expect(p.ssh).toBe(false);
  });

  it('strips the git+ prefix', () => {
    const p = parseGitUrl('git+https://github.com/org/repo');
    expect(p.canonical).toBe('https://github.com/org/repo');
  });

  it('reads a #branch=... fragment and preserves it in canonical', () => {
    const p = parseGitUrl('https://github.com/org/repo#branch=develop');
    expect(p.branch).toBe('develop');
    expect(p.canonical).toBe('https://github.com/org/repo#branch=develop');
  });

  it('parses SSH-style git@host:owner/repo.git', () => {
    const p = parseGitUrl('git@code.byted.org:tiktok/llm-wiki.git');
    expect(p.host).toBe('code.byted.org');
    expect(p.owner).toBe('tiktok');
    expect(p.repo).toBe('llm-wiki');
    expect(p.ssh).toBe(true);
    expect(p.canonical).toBe('git@code.byted.org:tiktok/llm-wiki.git');
  });

  it('SSH with branch fragment', () => {
    const p = parseGitUrl('git@github.com:org/repo.git#branch=main');
    expect(p.branch).toBe('main');
    expect(p.canonical).toBe('git@github.com:org/repo.git#branch=main');
  });

  it('lowercases the host but preserves the path case', () => {
    const p = parseGitUrl('https://CODE.BYTED.ORG/Tiktok/LLM-Wiki');
    expect(p.host).toBe('code.byted.org');
    expect(p.repo).toBe('LLM-Wiki');
  });

  it('tolerates a trailing slash on the URL path', () => {
    const p = parseGitUrl('https://github.com/org/repo/');
    expect(p.repo).toBe('repo');
  });

  it('throws on empty input', () => {
    expect(() => parseGitUrl('')).toThrow(GitUrlError);
  });

  it('throws on non-git schemes', () => {
    expect(() => parseGitUrl('ftp://example.com/repo')).toThrow(GitUrlError);
  });

  it('throws when the URL has no repo segment', () => {
    expect(() => parseGitUrl('https://github.com/')).toThrow(GitUrlError);
  });
});

describe('classifyHost', () => {
  it('default allow-list includes the documented internal hosts', () => {
    for (const host of DEFAULT_INTERNAL_HOSTS) {
      expect(classifyHost(host)).toBe('internal');
    }
  });

  it('public hosts are NOT internal', () => {
    expect(classifyHost('github.com')).toBe('public');
    expect(classifyHost('gitlab.com')).toBe('public');
    expect(classifyHost('bitbucket.org')).toBe('public');
  });

  it('subdomains of an entry without a wildcard are internal too', () => {
    expect(classifyHost('git.code.byted.org')).toBe('internal');
  });

  it('extraInternalHosts adds user-supplied hosts', () => {
    expect(classifyHost('gitlab.acme.internal')).toBe('public');
    expect(classifyHost('gitlab.acme.internal', { extraInternalHosts: ['gitlab.acme.internal'] }))
      .toBe('internal');
  });

  it('wildcard entries cover the suffix as well as the bare domain', () => {
    const opts = { extraInternalHosts: ['*.bytedance.net'] as const };
    expect(classifyHost('foo.bytedance.net', opts)).toBe('internal');
    expect(classifyHost('bytedance.net', opts)).toBe('internal');
    expect(classifyHost('evil.com', opts)).toBe('public');
  });

  it('classification is case-insensitive', () => {
    expect(classifyHost('Code.Byted.ORG')).toBe('internal');
  });
});
