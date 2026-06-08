import { describe, expect, it } from 'vitest';
import { isClaudeHookEvent, normalizeClaudePayload } from '../../../../src/host/claude-code/normalize.js';

describe('isClaudeHookEvent', () => {
  it('accepts the three events helm subscribes to', () => {
    expect(isClaudeHookEvent('UserPromptSubmit')).toBe(true);
    expect(isClaudeHookEvent('Stop')).toBe(true);
    expect(isClaudeHookEvent('SessionStart')).toBe(true);
  });
  it('rejects unknown events', () => {
    expect(isClaudeHookEvent('PreToolUse')).toBe(false);
    expect(isClaudeHookEvent('')).toBe(false);
  });
});

describe('normalizeClaudePayload', () => {
  it('UserPromptSubmit → prompt_submit with prompt + session_id + cwd', () => {
    const ev = normalizeClaudePayload(
      { session_id: 'sess-1', cwd: '/proj', hook_event_name: 'UserPromptSubmit', prompt: 'hello' },
      'UserPromptSubmit',
    );
    expect(ev.kind).toBe('prompt_submit');
    expect(ev.host).toBe('claude-code');
    expect(ev.hostSessionId).toBe('sess-1');
    expect(ev.cwd).toBe('/proj');
    if (ev.kind === 'prompt_submit') expect(ev.prompt).toBe('hello');
  });

  it('Stop → stop with session_id; no prompt fields', () => {
    const ev = normalizeClaudePayload(
      { session_id: 'sess-2', hook_event_name: 'Stop', transcript_path: '/t' },
      'Stop',
    );
    expect(ev.kind).toBe('stop');
    expect(ev.hostSessionId).toBe('sess-2');
  });

  it('reads hook_event_name from payload when explicit arg missing', () => {
    const ev = normalizeClaudePayload({
      session_id: 'sess-3', hook_event_name: 'UserPromptSubmit', prompt: 'p',
    });
    expect(ev.kind).toBe('prompt_submit');
  });

  it('unknown event name defaults to session_start (defensive)', () => {
    const ev = normalizeClaudePayload({ session_id: 'sess-4' }, 'TotallyUnknown');
    expect(ev.kind).toBe('session_start');
  });

  it('missing session_id defaults to "unknown" rather than throwing', () => {
    const ev = normalizeClaudePayload({ hook_event_name: 'Stop' }, 'Stop');
    expect(ev.hostSessionId).toBe('unknown');
  });
});
