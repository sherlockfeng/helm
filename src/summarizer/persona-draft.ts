/**
 * Draft an expert "persona" system prompt for a topic from its knowledge.
 *
 * When the user clicks 配置人格 on a pure topic, we shouldn't just flip a flag
 * and leave an expert with an empty prompt — the persona IS the prompt. This
 * reads the topic's name + a sample of its chunks and asks the LLM for a
 * concise 2nd-person "You are the X expert…" prompt, which the user then
 * reviews/edits before saving.
 *
 * Best-effort: any LLM/parse failure returns a minimal template so the user
 * still gets an editable starting point instead of a dead end.
 */
import type Database from 'better-sqlite3';
import type { LlmClient } from './campaign.js';
import { getRole, getChunksForRole } from '../storage/repos/roles.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const MAX_CHUNKS = 12;
const MAX_CHARS = 6000;

export interface DraftPersonaDeps {
  llm: LlmClient;
  model?: string;
}

/** Fallback prompt when no LLM is available or it fails. */
export function fallbackPersona(name: string): string {
  return `你是「${name}」专家。基于已沉淀的知识回答相关问题，给出准确、可操作的答复；不确定时明确说明。`;
}

export async function draftPersona(
  db: Database.Database,
  roleId: string,
  deps: DraftPersonaDeps,
): Promise<string> {
  const role = getRole(db, roleId);
  if (!role) throw new Error(`draftPersona: role not found: ${roleId}`);

  const chunks = getChunksForRole(db, roleId).slice(0, MAX_CHUNKS);
  let knowledge = chunks.map((c) => `- ${c.chunkText.trim()}`).join('\n');
  if (knowledge.length > MAX_CHARS) knowledge = `${knowledge.slice(0, MAX_CHARS)}…`;

  const prompt = [
    `Write a concise SYSTEM PROMPT (a "persona") for a domain expert named "${role.name}".`,
    'The expert will be bound to developer conversations and answer questions',
    'grounded in the knowledge below.',
    '',
    'Knowledge this expert owns:',
    knowledge || '(no knowledge captured yet)',
    '',
    'Rules:',
    '- 2nd person ("You are …"). Self-contained. 3–6 sentences, no preamble.',
    "- Match the knowledge's language (Chinese knowledge → Chinese prompt).",
    '- Describe the domain it covers + how it should answer (accurate, actionable,',
    '  say when unsure). Do NOT restate every fact — the knowledge is injected separately.',
    '- Return ONLY the prompt text, nothing else.',
  ].join('\n');

  try {
    const raw = await deps.llm.generate(prompt, { model: deps.model ?? DEFAULT_MODEL, maxTokens: 600 });
    const text = raw.trim();
    return text.length > 0 ? text : fallbackPersona(role.name);
  } catch {
    return fallbackPersona(role.name);
  }
}
