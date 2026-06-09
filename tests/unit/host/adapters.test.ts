/**
 * Unit tests for the ClaudeCode + Codex host adapters (PR 7-codex).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeHostAdapter } from '../../../src/host/claude-code/adapter.js';
import { CodexHostAdapter } from '../../../src/host/codex/adapter.js';

describe('ClaudeCodeHostAdapter', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'helm-claude-adapter-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('reports hostId="claude-code"', () => {
    expect(new ClaudeCodeHostAdapter().hostId).toBe('claude-code');
  });

  it('install delegates to installClaudeCodeHooks — writes UserPromptSubmit + Stop entries', async () => {
    const settingsPath = join(tmpDir, 'settings.json');
    const r = await new ClaudeCodeHostAdapter({ configPath: settingsPath }).install();
    expect(r.hooksPath).toBe(settingsPath);
    expect(r.events).toContain('UserPromptSubmit');
    expect(r.events).toContain('Stop');
  });

  it('normalize maps a UserPromptSubmit payload to prompt_submit', () => {
    const a = new ClaudeCodeHostAdapter();
    const ev = a.normalize(
      { session_id: 's-1', cwd: '/repo', hook_event_name: 'UserPromptSubmit', prompt: 'hi' },
      'UserPromptSubmit',
    );
    expect(ev.kind).toBe('prompt_submit');
    expect(ev.hostSessionId).toBe('s-1');
    expect(ev.host).toBe('claude-code');
    if (ev.kind === 'prompt_submit') expect(ev.prompt).toBe('hi');
  });

  it('formatResponse emits { context } on session_start with additionalContext', () => {
    const a = new ClaudeCodeHostAdapter();
    const r = a.formatResponse(
      a.normalize({ session_id: 's' }, 'SessionStart'),
      { kind: 'session_start', additionalContext: 'helm context' },
    );
    expect(r).toEqual({ context: 'helm context' });
  });

  it('formatResponse mismatched kinds returns empty object', () => {
    const a = new ClaudeCodeHostAdapter();
    const ev = a.normalize({ session_id: 's' }, 'SessionStart');
    const r = a.formatResponse(
      ev, { kind: 'prompt_submit', continue: true } as never,
    );
    expect(r).toEqual({});
  });

  it('mcpEndpoint reflects the constructor option', () => {
    const a = new ClaudeCodeHostAdapter({ mcpUrl: 'http://127.0.0.1:17317/mcp/sse' });
    expect(a.mcpEndpoint()).toBe('http://127.0.0.1:17317/mcp/sse');
  });
});

describe('CodexHostAdapter', () => {
  it('reports hostId="codex"', () => {
    expect(new CodexHostAdapter().hostId).toBe('codex');
  });

  it('accepts both "prompt_submit" and "prompt" event names', () => {
    const a = new CodexHostAdapter();
    const a1 = a.normalize({ session_id: 's', prompt: 'hi' }, 'prompt_submit');
    const a2 = a.normalize({ session_id: 's', body: 'hi' }, 'prompt');
    expect(a1.kind).toBe('prompt_submit');
    expect(a2.kind).toBe('prompt_submit');
  });

  it('accepts both "agent_response" and "response" event names', () => {
    const a = new CodexHostAdapter();
    const a1 = a.normalize({ session_id: 's', text: 'ok' }, 'agent_response');
    const a2 = a.normalize({ session_id: 's', body: 'ok' }, 'response');
    expect(a1.kind).toBe('agent_response');
    expect(a2.kind).toBe('agent_response');
  });

  it('install returns the hooks path + all event names', async () => {
    const r = await new CodexHostAdapter({ hooksPath: '/tmp/codex.json' })
      .install();
    expect(r.hooksPath).toBe('/tmp/codex.json');
    expect(r.events).toContain('session_start');
    expect(r.events).toContain('prompt_submit');
  });

  it('formatResponse on session_start emits additional_context', () => {
    const a = new CodexHostAdapter();
    const ev = a.normalize({ session_id: 's' }, 'session_start');
    const r = a.formatResponse(ev, { kind: 'session_start', additionalContext: 'ctx' });
    expect(r).toEqual({ additional_context: 'ctx' });
  });

  it('formatResponse on prompt_submit emits continue + user_message', () => {
    const a = new CodexHostAdapter();
    const ev = a.normalize({ session_id: 's', prompt: 'q' }, 'prompt_submit');
    const r = a.formatResponse(ev, { kind: 'prompt_submit', continue: true, userMessage: 'inj' });
    expect(r).toEqual({ continue: true, user_message: 'inj' });
  });

  it('formatResponse on stop emits followup_message when present', () => {
    const a = new CodexHostAdapter();
    const ev = a.normalize({ session_id: 's' }, 'stop');
    const r = a.formatResponse(ev, { kind: 'stop', followupMessage: 'hi' });
    expect(r).toEqual({ followup_message: 'hi' });
  });
});
