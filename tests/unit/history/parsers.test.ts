import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanClaudeCodeHistory, parseClaudeTranscript } from '../../../src/history/claude-code.js';
import { scanCodexHistory, parseCodexRollout } from '../../../src/history/codex.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'helm-hist-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('claude-code history parser', () => {
  it('extracts prompt/response turns, skips meta/sidechain/tool noise', () => {
    const lines = [
      { type: 'custom-title', customTitle: 'X', sessionId: 's1' },
      { type: 'user', isMeta: true, message: { content: 'ignored meta' }, timestamp: '2026-01-01T00:00:00Z', cwd: '/p' },
      { type: 'user', message: { content: '<system-reminder>noise</system-reminder>real question' }, timestamp: '2026-01-01T00:00:01Z', cwd: '/p' },
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'the answer' }] }, timestamp: '2026-01-01T00:00:02Z' },
      { type: 'user', isSidechain: true, message: { content: 'subagent' }, timestamp: '2026-01-01T00:00:03Z' },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'output' }] }, timestamp: '2026-01-01T00:00:04Z' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] }, timestamp: '2026-01-01T00:00:05Z' },
    ].map((o) => JSON.stringify(o)).join('\n');
    const { session } = parseClaudeTranscript(writeJsonl('s1.jsonl', lines), 's1');
    expect(session).not.toBeNull();
    expect(session!.host).toBe('claude-code');
    expect(session!.cwd).toBe('/p');
    expect(session!.turns).toEqual([
      { kind: 'prompt', text: 'real question', createdAt: '2026-01-01T00:00:01Z' },
      { kind: 'response', text: 'the answer', createdAt: '2026-01-01T00:00:02Z' },
    ]);
    expect(session!.firstPrompt).toBe('real question');
  });

  it('scanClaudeCodeHistory walks project dirs and ids by filename', () => {
    const projects = join(dir, 'projects');
    const proj = join(projects, '-Users-x-proj');
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, 'abc-123.jsonl'),
      JSON.stringify({ type: 'user', message: { content: 'hi' }, timestamp: '2026-01-01T00:00:00Z' }) + '\n'
      + JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'yo' }] }, timestamp: '2026-01-01T00:00:01Z' }));
    const out = scanClaudeCodeHistory(projects);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('abc-123');
    expect(out[0]!.turns.map((t) => t.kind)).toEqual(['prompt', 'response']);
  });

  it('returns null for a transcript with no real turns', () => {
    const lines = JSON.stringify({ type: 'custom-title', customTitle: 'X' });
    expect(parseClaudeTranscript(writeJsonl('empty.jsonl', lines), 'e').session).toBeNull();
  });

  function writeJsonl(name: string, content: string): string {
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
  }
});

describe('codex history parser', () => {
  it('reads session_meta + message items, strips env noise', () => {
    const lines = [
      { timestamp: '2026-02-01T00:00:00Z', type: 'session_meta', payload: { id: 'cdx1', cwd: '/work' } },
      { timestamp: '2026-02-01T00:00:01Z', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'instructions' }] } },
      { timestamp: '2026-02-01T00:00:02Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context><cwd>/work</cwd></environment_context>do the thing' }] } },
      { timestamp: '2026-02-01T00:00:03Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } },
      { timestamp: '2026-02-01T00:00:04Z', type: 'response_item', payload: { type: 'function_call', name: 'shell' } },
    ].map((o) => JSON.stringify(o)).join('\n');
    const p = join(dir, 'rollout-2026-02-01T00-00-00-cdx1.jsonl');
    writeFileSync(p, lines);
    const s = parseCodexRollout(p, 'fallback');
    expect(s).not.toBeNull();
    expect(s!.id).toBe('cdx1');
    expect(s!.cwd).toBe('/work');
    expect(s!.turns).toEqual([
      { kind: 'prompt', text: 'do the thing', createdAt: '2026-02-01T00:00:02Z' },
      { kind: 'response', text: 'done', createdAt: '2026-02-01T00:00:03Z' },
    ]);
  });

  it('scanCodexHistory recurses and dedupes by id', () => {
    const a = join(dir, 'sessions', '2026', '02', '01');
    mkdirSync(a, { recursive: true });
    writeFileSync(join(a, 'rollout-2026-02-01T00-00-00-dup.jsonl'),
      JSON.stringify({ type: 'session_meta', payload: { id: 'dup' }, timestamp: '2026-02-01T00:00:00Z' }) + '\n'
      + JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] }, timestamp: '2026-02-01T00:00:01Z' }) + '\n'
      + JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a' }] }, timestamp: '2026-02-01T00:00:02Z' }));
    const out = scanCodexHistory([join(dir, 'sessions')]);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('dup');
  });
});
