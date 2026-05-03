import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CursorHostAdapter } from '../../../../src/host/cursor/adapter.js';
import type { HostToolUsePreEvent } from '../../../../src/host/types.js';

let tmpDir: string;
let hooksPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'helm-adapter-'));
  hooksPath = join(tmpDir, 'hooks.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('CursorHostAdapter', () => {
  it('hostId is "cursor"', () => {
    expect(new CursorHostAdapter().hostId).toBe('cursor');
  });

  it('install + uninstall round-trips', async () => {
    const adapter = new CursorHostAdapter({ hookBinPath: '/abs/helm-hook' });
    const installResult = await adapter.install({ hooksPath });
    expect(installResult.events.length).toBeGreaterThan(0);
    const before = JSON.parse(readFileSync(hooksPath, 'utf8'));
    expect(Object.keys(before.hooks).length).toBeGreaterThan(0);

    await adapter.uninstall({ hooksPath });
    const after = JSON.parse(readFileSync(hooksPath, 'utf8'));
    expect(after.hooks).toEqual({});
  });

  it('normalize delegates to normalizeCursorEvent', () => {
    const adapter = new CursorHostAdapter();
    const event = adapter.normalize({ event: 'sessionStart', session_id: 's1' });
    expect(event.kind).toBe('session_start');
    expect(event.hostSessionId).toBe('s1');
  });

  it('formatResponse — session_start with context', () => {
    const adapter = new CursorHostAdapter();
    const event = adapter.normalize({ event: 'sessionStart', session_id: 's1' });
    expect(adapter.formatResponse(event, { kind: 'session_start', additionalContext: 'ctx' }))
      .toEqual({ additional_context: 'ctx' });
  });

  it('formatResponse — session_start without context returns empty object', () => {
    const adapter = new CursorHostAdapter();
    const event = adapter.normalize({ event: 'sessionStart', session_id: 's1' });
    expect(adapter.formatResponse(event, { kind: 'session_start' })).toEqual({});
  });

  it('formatResponse — prompt_submit forwards continue + user_message', () => {
    const adapter = new CursorHostAdapter();
    const event = adapter.normalize({ event: 'beforeSubmitPrompt', session_id: 's1', prompt: 'hi' });
    expect(adapter.formatResponse(event, { kind: 'prompt_submit', continue: false, userMessage: 'stop' }))
      .toEqual({ continue: false, user_message: 'stop' });
  });

  it('formatResponse — stop forwards followup_message only when set', () => {
    const adapter = new CursorHostAdapter();
    const event = adapter.normalize({ event: 'stop', session_id: 's1' });
    expect(adapter.formatResponse(event, { kind: 'stop', followupMessage: 'do x' }))
      .toEqual({ followup_message: 'do x' });
    expect(adapter.formatResponse(event, { kind: 'stop' })).toEqual({});
  });

  it('formatResponse — approval allow → permission allow + reason in message', () => {
    const adapter = new CursorHostAdapter();
    const event = adapter.normalize({ hook_event_name: 'beforeShellExecution', session_id: 's', command: 'ls' }) as HostToolUsePreEvent;
    const out = adapter.formatResponse(event, { kind: 'tool_use_pre', permission: 'allow', reason: 'policy match' });
    expect(out['permission']).toBe('allow');
    expect(out['agent_message']).toContain('policy match');
  });

  it('formatResponse — approval deny → both user_message + agent_message set', () => {
    const adapter = new CursorHostAdapter();
    const event = adapter.normalize({ hook_event_name: 'preToolUse', session_id: 's', tool_name: 'Write' });
    const out = adapter.formatResponse(event, { kind: 'tool_use_pre', permission: 'deny', reason: 'risky' });
    expect(out['permission']).toBe('deny');
    expect(out['user_message']).toContain('risky');
    expect(out['agent_message']).toContain('risky');
  });

  it('formatResponse — approval ask provides messages', () => {
    const adapter = new CursorHostAdapter();
    const event = adapter.normalize({ hook_event_name: 'preToolUse', session_id: 's', tool_name: 'Write' });
    const out = adapter.formatResponse(event, { kind: 'tool_use_pre', permission: 'ask' });
    expect(out['permission']).toBe('ask');
    expect(out['user_message']).toBeTruthy();
    expect(out['agent_message']).toBeTruthy();
  });

  it('attack: mismatched decision kind → empty object', () => {
    const adapter = new CursorHostAdapter();
    const event = adapter.normalize({ event: 'sessionStart', session_id: 's1' });
    // intentional mismatch via cast
    const out = adapter.formatResponse(event, { kind: 'stop' } as unknown as Parameters<typeof adapter.formatResponse>[1]);
    expect(out).toEqual({});
  });

  it('attack: agent_response / tool_use_post / progress → empty object (Cursor ignores response)', () => {
    const adapter = new CursorHostAdapter();
    const e1 = adapter.normalize({ hook_event_name: 'afterAgentResponse', session_id: 's', text: 't' });
    expect(adapter.formatResponse(e1, { kind: 'agent_response', ok: true })).toEqual({});
    const e2 = adapter.normalize({ hook_event_name: 'afterShellExecution', session_id: 's' });
    expect(adapter.formatResponse(e2, { kind: 'tool_use_post', ok: true })).toEqual({});
  });
});
