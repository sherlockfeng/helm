/**
 * Roles library — built-in seeding + custom-role training + RAG search.
 *
 * Ported from relay/src/roles/library.ts. The only structural change is that
 * we use the function-style storage repos (storage/repos/roles.ts) instead of
 * relay's class-based AgentForgeDB methods.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  deleteChunksForRole,
  getChunksForRole,
  getRole as getRoleRow,
  insertChunk,
  listRoles as listRoleRows,
  upsertRole,
} from '../storage/repos/roles.js';
import type { Role, KnowledgeChunk } from '../storage/types.js';
import { PRODUCT_SYSTEM_PROMPT } from './builtin/product.js';
import { DEVELOPER_SYSTEM_PROMPT } from './builtin/developer.js';
import { TESTER_SYSTEM_PROMPT } from './builtin/tester.js';

const BUILTIN_ROLES: Omit<Role, 'createdAt'>[] = [
  { id: 'product', name: 'Product Agent', systemPrompt: PRODUCT_SYSTEM_PROMPT, docPath: 'docs/roles/product.md', isBuiltin: true },
  { id: 'developer', name: 'Developer Agent', systemPrompt: DEVELOPER_SYSTEM_PROMPT, docPath: 'docs/roles/developer.md', isBuiltin: true },
  { id: 'tester', name: 'Test Agent', systemPrompt: TESTER_SYSTEM_PROMPT, docPath: 'docs/roles/tester.md', isBuiltin: true },
];

export function seedBuiltinRoles(db: Database.Database): void {
  const now = new Date().toISOString();
  for (const r of BUILTIN_ROLES) {
    upsertRole(db, { ...r, createdAt: now });
  }
}

export function getRole(db: Database.Database, roleId: string): Role {
  const role = getRoleRow(db, roleId);
  if (!role) throw new Error(`Role not found: ${roleId}`);
  return role;
}

export function listRoles(db: Database.Database): Role[] {
  return listRoleRows(db);
}

export interface TrainRoleInput {
  roleId: string;
  name: string;
  documents: Array<{ filename: string; content: string }>;
  baseSystemPrompt?: string;
  embedFn: (text: string) => Promise<Float32Array>;
}

export async function trainRole(db: Database.Database, input: TrainRoleInput): Promise<Role> {
  const now = new Date().toISOString();
  const existing = getRoleRow(db, input.roleId);

  const systemPrompt = input.baseSystemPrompt
    ?? existing?.systemPrompt
    ?? `You are a specialized expert agent with deep knowledge of ${input.name}. Use your knowledge base to answer questions and assist with tasks related to this domain.`;

  upsertRole(db, {
    id: input.roleId,
    name: input.name,
    systemPrompt,
    isBuiltin: false,
    createdAt: now,
  });

  deleteChunksForRole(db, input.roleId);

  for (const doc of input.documents) {
    const chunks = chunkDocument(doc.content, doc.filename);
    for (const chunk of chunks) {
      const embedding = await input.embedFn(chunk.text);
      const row: KnowledgeChunk = {
        id: randomUUID(),
        roleId: input.roleId,
        sourceFile: doc.filename,
        chunkText: chunk.text,
        embedding,
        createdAt: now,
      };
      insertChunk(db, row);
    }
  }

  const refreshed = getRoleRow(db, input.roleId);
  if (!refreshed) throw new Error(`trainRole: role disappeared after upsert: ${input.roleId}`);
  return refreshed;
}

export interface KnowledgeSearchResult {
  chunkText: string;
  sourceFile?: string;
  score: number;
}

export async function searchKnowledge(
  db: Database.Database,
  roleId: string,
  query: string,
  embedFn: (text: string) => Promise<Float32Array>,
  topK = 5,
): Promise<KnowledgeSearchResult[]> {
  const chunks = getChunksForRole(db, roleId);
  if (chunks.length === 0) return [];

  const queryVec = await embedFn(query);
  return chunks
    .filter((c) => c.embedding != null)
    .map((c) => ({
      chunkText: c.chunkText,
      sourceFile: c.sourceFile,
      score: cosineSimilarity(queryVec, c.embedding!),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export function chunkDocument(content: string, filename: string): Array<{ text: string }> {
  const CHUNK_SIZE = 800;
  const OVERLAP = 100;
  const lines = content.split('\n');
  const chunks: Array<{ text: string }> = [];
  let buffer: string[] = [];
  let bufLen = 0;

  for (const line of lines) {
    buffer.push(line);
    bufLen += line.length + 1;
    if (bufLen >= CHUNK_SIZE) {
      chunks.push({ text: `[${filename}]\n${buffer.join('\n')}` });
      const overlapLines: string[] = [];
      let overlapLen = 0;
      for (let i = buffer.length - 1; i >= 0 && overlapLen < OVERLAP; i--) {
        overlapLines.unshift(buffer[i]!);
        overlapLen += buffer[i]!.length + 1;
      }
      buffer = overlapLines;
      bufLen = overlapLen;
    }
  }
  if (buffer.length > 0) {
    chunks.push({ text: `[${filename}]\n${buffer.join('\n')}` });
  }
  return chunks;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
