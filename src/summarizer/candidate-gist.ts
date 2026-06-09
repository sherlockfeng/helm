/**
 * Candidate gist + kind classifier.
 *
 * The Conversations detail pane renders pending candidates as
 * `<emoji> <gist>` headlines instead of the raw 2-line excerpt. This
 * module turns a chunkText into:
 *
 *   {
 *     kind: 'spec' | 'example' | 'warning' | 'runbook' | 'glossary' | 'other',
 *     gist: 'one-line headline summarising the takeaway',
 *   }
 *
 * Reuses the existing `KnowledgeChunkKind` taxonomy rather than
 * inventing a parallel one — these labels also drive the kind chips
 * elsewhere in helm (Library, Review) so the classification is
 * consistent across surfaces.
 *
 * The generator is best-effort: any LLM failure / unparseable output
 * leaves the row unchanged (renderer falls back to raw chunkText).
 */

import type Database from 'better-sqlite3';
import type { LlmClient } from './campaign.js';
import { KNOWLEDGE_CHUNK_KINDS, type KnowledgeChunkKind } from '../storage/types.js';
import { getCandidateById, setCandidateGist } from '../storage/repos/knowledge-candidates.js';

const DEFAULT_MAX_TOKENS = 200;
const DEFAULT_MODEL = 'claude-sonnet-4-6';

const KIND_SET: ReadonlySet<KnowledgeChunkKind> = new Set(KNOWLEDGE_CHUNK_KINDS);

export interface CandidateGistDeps {
  llm: LlmClient;
  model?: string;
  maxTokens?: number;
}

/**
 * Read the candidate, generate gist + kind, persist. Returns the
 * result on success, null on any skip / failure (the candidate row is
 * left untouched).
 */
export async function generateCandidateGist(
  db: Database.Database,
  candidateId: string,
  deps: CandidateGistDeps,
): Promise<{ kind: KnowledgeChunkKind; gist: string } | null> {
  const candidate = getCandidateById(db, candidateId);
  if (!candidate) return null;

  const prompt = buildPrompt(candidate.chunkText);
  let raw: string;
  try {
    raw = await deps.llm.generate(prompt, {
      model: deps.model ?? DEFAULT_MODEL,
      maxTokens: deps.maxTokens ?? DEFAULT_MAX_TOKENS,
    });
  } catch {
    return null;
  }

  const parsed = parseGistResponse(raw);
  if (!parsed) return null;
  setCandidateGist(db, candidateId, parsed.gist, parsed.kind);
  return parsed;
}

function buildPrompt(chunkText: string): string {
  return [
    'Classify this knowledge passage and write a one-line headline for it.',
    '',
    'Allowed kinds (pick one):',
    '  spec      — design rule, project convention, decision, architectural fact',
    '  example   — code snippet, command, concrete how-to-do-X recipe',
    '  warning   — gotcha, pitfall, "don\'t do X because Y"',
    '  runbook   — multi-step procedure for solving a recurring problem',
    '  glossary  — definition of a term, project entity, name',
    '  other     — none of the above fits',
    '',
    'Format — emit exactly two lines, no preamble:',
    '  kind: <one of the six above>',
    '  gist: <one-line headline in the same language as the passage, ≤100 chars>',
    '',
    'Passage:',
    '---',
    chunkText.length > 4_000 ? `${chunkText.slice(0, 4_000)}…[truncated]` : chunkText,
    '---',
  ].join('\n');
}

/**
 * Parse the two-line `kind:` / `gist:` response. Tolerant of stray
 * surrounding text — finds the two labelled lines anywhere. Returns
 * null when either line is missing or the kind isn't in the allowed
 * taxonomy.
 */
export function parseGistResponse(raw: string): { kind: KnowledgeChunkKind; gist: string } | null {
  const lines = raw.split('\n').map((l) => l.trim());
  let kind: KnowledgeChunkKind | null = null;
  let gist: string | null = null;
  for (const line of lines) {
    const kindMatch = line.match(/^kind\s*[:：]\s*(.+)$/i);
    if (kindMatch) {
      const k = kindMatch[1]!.trim().toLowerCase();
      if (KIND_SET.has(k as KnowledgeChunkKind)) kind = k as KnowledgeChunkKind;
      continue;
    }
    const gistMatch = line.match(/^gist\s*[:：]\s*(.+)$/i);
    if (gistMatch) gist = gistMatch[1]!.trim();
  }
  if (!kind || !gist) return null;
  return { kind, gist: gist.slice(0, 200) };
}
