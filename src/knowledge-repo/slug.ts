/**
 * Human-readable point-id slugs (files-as-truth PR-2).
 *
 * chat-captured/<user>/<role>/<slug>.md uses the chunk id as the file
 * name, so promoted knowledge gets a readable identifier instead of a
 * UUID (`og-v5-schema-mismatch`, not `3f2a…`). ASCII-only by design:
 * the slug doubles as the doc-lsp concept id, and the wiki tooling
 * expects kebab-case ids. Text that yields no usable ASCII (e.g. pure
 * CJK) falls back to the caller-supplied stable id.
 */

const MAX_SLUG_LENGTH = 60;
const MIN_SLUG_LENGTH = 3;

export function slugifyPointId(text: string, fallback: string): string {
  const firstLine = text.split('\n').find((l) => l.trim().length > 0) ?? '';
  const slug = firstLine
    .replace(/^#+\s*/, '')        // strip a leading markdown heading marker
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
  return slug.length >= MIN_SLUG_LENGTH ? slug : fallback;
}
