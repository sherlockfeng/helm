/**
 * Stdin/stdout helpers for the hook subprocess.
 *
 * Kept separate from hook-entry so the entry's logic can be unit-tested by
 * injecting in-memory streams instead of touching real file descriptors.
 */

import type { Readable, Writable } from 'node:stream';

export async function readStdin(stream: Readable = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string | Uint8Array));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function parseJsonObject(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

export function writeJson(value: unknown, stream: Writable = process.stdout): void {
  stream.write(JSON.stringify(value) + '\n');
}
