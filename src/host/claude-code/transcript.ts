/**
 * Recover the assistant's last message from a Claude Code session transcript.
 *
 * Claude Code writes one JSONL line per event into the transcript file
 * pointed at by the hook payload's `transcript_path`. Stop hooks fire AFTER
 * the assistant turn completes, so the most recent assistant message in the
 * file is the response we want.
 *
 * The transcript can be large in long sessions — reading the whole file
 * would be wasteful and slow. We instead read the last N bytes and parse
 * lines from the back, returning the first assistant message we hit. N is
 * generous (1 MB) so a single long response still fits.
 */

import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';

const TAIL_BYTES = 1024 * 1024; // 1 MiB

/**
 * Return the assistant's last response text, or null if the transcript
 * is unreadable / empty / doesn't contain an assistant message yet.
 */
export function readLastAssistantMessage(transcriptPath: string): string | null {
  if (!transcriptPath) return null;
  let size: number;
  try { size = statSync(transcriptPath).size; }
  catch { return null; }
  if (size === 0) return null;

  const start = Math.max(0, size - TAIL_BYTES);
  const length = size - start;
  let buf: Buffer;
  if (start === 0) {
    try { buf = readFileSync(transcriptPath); }
    catch { return null; }
  } else {
    buf = Buffer.alloc(length);
    let fd: number;
    try { fd = openSync(transcriptPath, 'r'); }
    catch { return null; }
    try { readSync(fd, buf, 0, length, start); }
    catch { closeSync(fd); return null; }
    closeSync(fd);
  }

  const lines = buf.toString('utf8').split('\n');
  // If we read mid-line (start > 0), the first line is partial — drop it.
  if (start > 0 && lines.length > 0) lines.shift();

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); }
    catch { continue; }
    const text = extractAssistantText(parsed);
    if (text) return text;
  }
  return null;
}

/**
 * Pull the text content out of an assistant message line. The transcript's
 * exact shape has shifted between Claude Code versions, so accept a few
 * variants:
 *   - { type: 'assistant', message: { content: [{ type: 'text', text: '...' }] } }
 *   - { role: 'assistant', content: '...' }
 *   - { role: 'assistant', content: [{ type: 'text', text: '...' }] }
 */
function extractAssistantText(line: unknown): string | null {
  if (!line || typeof line !== 'object') return null;
  const obj = line as Record<string, unknown>;

  const role = obj['role'] ?? obj['type'];
  if (role !== 'assistant') return null;

  // Wrapped form: { type: 'assistant', message: { content: ... } }
  const message = obj['message'];
  if (message && typeof message === 'object') {
    const text = textFromContent((message as Record<string, unknown>)['content']);
    if (text) return text;
  }

  // Flat form: { role: 'assistant', content: ... }
  return textFromContent(obj['content']);
}

function textFromContent(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') { parts.push(part); continue; }
    if (part && typeof part === 'object') {
      const p = part as Record<string, unknown>;
      if (p['type'] === 'text' && typeof p['text'] === 'string') parts.push(p['text']);
    }
  }
  return parts.length > 0 ? parts.join('') : null;
}
