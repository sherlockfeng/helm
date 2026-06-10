/**
 * Path B (PR-C): create a new role from a chat's content.
 *
 * Given a list of unknown entities from a chat, pulls the assistant
 * responses (and prompts) that mention any of them, and uses those
 * passages as seed knowledge documents for a freshly-trained role.
 *
 * The orchestrator wires this with the same embedFn LocalRolesProvider
 * uses, so the resulting chunks line up with the rest of the role
 * search infrastructure.
 */

import type Database from 'better-sqlite3';
import { listHostEvents } from '../storage/repos/host-event-log.js';

const SEED_CHAR_BUDGET = 8_000;
const MAX_SEED_DOCS = 5;

/**
 * Extract the assistant responses + user prompts that mention any of
 * the given entities. Used as seed documents for a fresh role.
 *
 * The result is a small list of `{ filename, content }` pairs the
 * caller hands to trainRole(). Filenames are synthetic but stable for
 * the chat ("chat-<sid>-turn-<n>") so the user sees provenance.
 */
export function pickSeedDocsForUnknownEntities(
  db: Database.Database,
  hostSessionId: string,
  entities: readonly string[],
): Array<{ filename: string; content: string }> {
  if (entities.length === 0) return [];
  const lowerSet = new Set(entities.map((e) => e.toLowerCase()));
  const events = listHostEvents(db, hostSessionId, { limit: 500 });
  if (events.length === 0) return [];

  const docs: Array<{ filename: string; content: string }> = [];
  let budget = SEED_CHAR_BUDGET;
  let turnIndex = 0;

  for (const ev of events) {
    if (docs.length >= MAX_SEED_DOCS) break;
    if (budget <= 0) break;
    if (ev.kind !== 'response' && ev.kind !== 'prompt') continue;
    const text = typeof ev.payload['text'] === 'string'
      ? (ev.payload['text'] as string)
      : '';
    if (!text) continue;
    turnIndex += 1;
    if (!mentionsAny(text, lowerSet)) continue;

    const trimmed = text.length > budget ? `${text.slice(0, budget)}…` : text;
    budget -= trimmed.length;
    docs.push({
      filename: `chat-${hostSessionId.slice(0, 8)}-turn-${turnIndex}-${ev.kind}.md`,
      content: trimmed,
    });
  }
  return docs;
}

function mentionsAny(text: string, lowerSet: ReadonlySet<string>): boolean {
  const lower = text.toLowerCase();
  for (const needle of lowerSet) {
    if (lower.includes(needle)) return true;
  }
  return false;
}

/**
 * Suggest a role id + name from the most-frequent unknown entity.
 * Falls back to the chat's session id prefix when entities is empty.
 *
 * Examples:
 *   ['OG', 'BAM', 'DECC']        → { id: 'og-expert',    name: 'OG 专家' }
 *   ['snake_case_thing']         → { id: 'snake-case-thing-expert', name: 'snake_case_thing 专家' }
 */
export function suggestRoleNameFromEntities(
  entities: readonly string[],
): { id: string; name: string } | null {
  if (entities.length === 0) return null;
  const top = entities[0]!;
  const id = `${slug(top)}-expert`;
  const name = `${top} 专家`;
  return { id, name };
}

function slug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'unknown';
}
