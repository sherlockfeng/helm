import { describe, expect, it } from 'vitest';
import { isApprovalHookEvent, isRelayHookEvent, normalizeCursorEvent } from '../../../../src/host/cursor/normalize.js';
import type {
  HostAgentResponseEvent,
  HostPromptSubmitEvent,
  HostSessionStartEvent,
  HostStopEvent,
  HostToolUsePostEvent,
  HostToolUsePreEvent,
} from '../../../../src/host/types.js';

describe('event-type predicates', () => {
  it('isRelayHookEvent recognizes lifecycle + post events', () => {
    expect(isRelayHookEvent('sessionStart')).toBe(true);
    expect(isRelayHookEvent('beforeSubmitPrompt')).toBe(true);
    expect(isRelayHookEvent('afterAgentResponse')).toBe(true);
    expect(isRelayHookEvent('postToolUse')).toBe(true);
    expect(isRelayHookEvent('afterShellExecution')).toBe(true);
    expect(isRelayHookEvent('stop')).toBe(true);
  });

  it('isApprovalHookEvent recognizes approval gates', () => {
    expect(isApprovalHookEvent('beforeShellExecution')).toBe(true);
    expect(isApprovalHookEvent('beforeMCPExecution')).toBe(true);
    expect(isApprovalHookEvent('preToolUse')).toBe(true);
  });

  it('the two sets are disjoint', () => {
    const events = ['sessionStart', 'beforeSubmitPrompt', 'preToolUse', 'beforeShellExecution', 'stop'];
    for (const e of events) {
      expect(isRelayHookEvent(e) && isApprovalHookEvent(e)).toBe(false);
    }
  });

  it('attack: case-insensitive matching', () => {
    expect(isRelayHookEvent('SESSIONSTART')).toBe(true);
    expect(isApprovalHookEvent('PRETOOLUSE')).toBe(true);
  });

  it('attack: unknown events return false in both', () => {
    expect(isRelayHookEvent('foo')).toBe(false);
    expect(isApprovalHookEvent('foo')).toBe(false);
  });
});

describe('normalizeCursorEvent — happy path mappings', () => {
  it('sessionStart', () => {
    const r = normalizeCursorEvent({
      hook_event_name: 'sessionStart',
      session_id: 's1',
      cwd: '/proj',
      composer_mode: 'agent',
    });
    expect(r.unknown).toBe(false);
    const ev = r.event as HostSessionStartEvent;
    expect(ev.kind).toBe('session_start');
    expect(ev.hostSessionId).toBe('s1');
    expect(ev.cwd).toBe('/proj');
    expect(ev.composerMode).toBe('agent');
    expect(ev.host).toBe('cursor');
  });

  it('beforeSubmitPrompt', () => {
    const r = normalizeCursorEvent({ event: 'beforeSubmitPrompt', sessionId: 's1', prompt: 'hi' });
    const ev = r.event as HostPromptSubmitEvent;
    expect(ev.kind).toBe('prompt_submit');
    expect(ev.prompt).toBe('hi');
  });

  it('afterAgentResponse', () => {
    const r = normalizeCursorEvent({ type: 'afterAgentResponse', session_id: 's1', text: 'hello' });
    const ev = r.event as HostAgentResponseEvent;
    expect(ev.kind).toBe('agent_response');
    expect(ev.text).toBe('hello');
  });

  it('stop', () => {
    const r = normalizeCursorEvent({ hook_event_name: 'stop', session_id: 's1', loop_count: 3, status: 'done' });
    const ev = r.event as HostStopEvent;
    expect(ev.kind).toBe('stop');
    expect(ev.loopCount).toBe(3);
    expect(ev.status).toBe('done');
  });

  it('afterShellExecution success', () => {
    const r = normalizeCursorEvent({
      hook_event_name: 'afterShellExecution',
      session_id: 's1', command: 'ls', exit_code: 0, duration_ms: 12,
    });
    const ev = r.event as HostToolUsePostEvent;
    expect(ev.kind).toBe('tool_use_post');
    expect(ev.tool).toBe('Shell');
    expect(ev.command).toBe('ls');
    expect(ev.phase).toBe('completed');
    expect(ev.exitCode).toBe(0);
    expect(ev.durationMs).toBe(12);
  });

  it('afterShellExecution non-zero exit → failed', () => {
    const r = normalizeCursorEvent({
      hook_event_name: 'afterShellExecution', session_id: 's1', exit_code: 1,
    });
    const ev = r.event as HostToolUsePostEvent;
    expect(ev.phase).toBe('failed');
  });

  it('postToolUse generic', () => {
    const r = normalizeCursorEvent({
      hook_event_name: 'postToolUse',
      session_id: 's1',
      tool_name: 'Write',
      tool_input: { file_path: '/proj/foo.ts' },
    });
    const ev = r.event as HostToolUsePostEvent;
    expect(ev.tool).toBe('Write');
    expect(ev.command).toBe('/proj/foo.ts');
    expect(ev.phase).toBe('completed');
  });

  it('postToolUseFailure', () => {
    const r = normalizeCursorEvent({
      hook_event_name: 'postToolUseFailure',
      session_id: 's1', tool_name: 'Write',
    });
    expect((r.event as HostToolUsePostEvent).phase).toBe('failed');
  });

  it('beforeShellExecution → tool_use_pre', () => {
    const r = normalizeCursorEvent({
      hook_event_name: 'beforeShellExecution', session_id: 's1', command: 'rm -rf /tmp',
    });
    const ev = r.event as HostToolUsePreEvent;
    expect(ev.kind).toBe('tool_use_pre');
    expect(ev.tool).toBe('Shell');
    expect(ev.command).toBe('rm -rf /tmp');
    expect(ev.hookEventName).toBe('beforeShellExecution');
  });

  it('beforeMCPExecution → tool_use_pre with mcp__ prefix', () => {
    const r = normalizeCursorEvent({
      hook_event_name: 'beforeMCPExecution', session_id: 's1',
      server: 'svc', toolName: 'do_thing',
      arguments: { x: 1 },
    });
    const ev = r.event as HostToolUsePreEvent;
    expect(ev.tool).toBe('mcp__svc__do_thing');
    expect(ev.command).toBe(JSON.stringify({ x: 1 }));
  });

  it('preToolUse generic → tool_use_pre', () => {
    const r = normalizeCursorEvent({
      hook_event_name: 'preToolUse', session_id: 's1', tool_name: 'Write',
      tool_input: { path: '/proj/x.ts' },
    });
    const ev = r.event as HostToolUsePreEvent;
    expect(ev.tool).toBe('Write');
    expect(ev.command).toBe('/proj/x.ts');
  });

  it('preToolUse with MCP: prefix → mcp__ normalization', () => {
    const r = normalizeCursorEvent({
      hook_event_name: 'preToolUse', session_id: 's1',
      tool_name: 'MCP:server tool',
    });
    const ev = r.event as HostToolUsePreEvent;
    expect(ev.tool.startsWith('mcp__')).toBe(true);
  });
});

describe('normalizeCursorEvent — field-name aliases', () => {
  it('accepts session_id / sessionId / conversation_id / threadId', () => {
    expect(normalizeCursorEvent({ event: 'sessionStart', session_id: 'a' }).event.hostSessionId).toBe('a');
    expect(normalizeCursorEvent({ event: 'sessionStart', sessionId: 'b' }).event.hostSessionId).toBe('b');
    expect(normalizeCursorEvent({ event: 'sessionStart', conversation_id: 'c' }).event.hostSessionId).toBe('c');
    expect(normalizeCursorEvent({ event: 'sessionStart', threadId: 'd' }).event.hostSessionId).toBe('d');
  });

  it('accepts cwd / working_directory / workspace_path', () => {
    expect(normalizeCursorEvent({ event: 'sessionStart', session_id: 's', cwd: '/a' }).event.cwd).toBe('/a');
    expect(normalizeCursorEvent({ event: 'sessionStart', session_id: 's', workingDirectory: '/b' }).event.cwd).toBe('/b');
    expect(normalizeCursorEvent({ event: 'sessionStart', session_id: 's', workspace_path: '/c' }).event.cwd).toBe('/c');
  });

  it('prompt aliases', () => {
    expect((normalizeCursorEvent({ event: 'beforeSubmitPrompt', session_id: 's', message: 'a' }).event as HostPromptSubmitEvent).prompt).toBe('a');
    expect((normalizeCursorEvent({ event: 'beforeSubmitPrompt', session_id: 's', text: 'b' }).event as HostPromptSubmitEvent).prompt).toBe('b');
  });
});

describe('normalizeCursorEvent — attacks', () => {
  it('attack: empty input still produces a typed event', () => {
    const r = normalizeCursorEvent({});
    expect(r.unknown).toBe(true);
    expect(r.event.host).toBe('cursor');
  });

  it('attack: non-object raw input is treated as empty', () => {
    expect(() => normalizeCursorEvent('garbage')).not.toThrow();
    expect(normalizeCursorEvent('garbage').unknown).toBe(true);
    expect(normalizeCursorEvent(null).unknown).toBe(true);
    expect(normalizeCursorEvent(42).unknown).toBe(true);
    expect(normalizeCursorEvent(['arr']).unknown).toBe(true);
  });

  it('attack: unknown event name → unknown=true with synthesized session_start', () => {
    const r = normalizeCursorEvent({ event: 'totallyUnknown', session_id: 's1' });
    expect(r.unknown).toBe(true);
    expect(r.event.kind).toBe('session_start');
    expect(r.event.hostSessionId).toBe('s1');
  });

  it('attack: explicit event arg overrides payload event', () => {
    const r = normalizeCursorEvent({ event: 'sessionStart', session_id: 's1' }, 'beforeSubmitPrompt');
    expect(r.event.kind).toBe('prompt_submit');
  });

  it('attack: malformed exit_code is dropped silently', () => {
    const r = normalizeCursorEvent({ hook_event_name: 'afterShellExecution', session_id: 's', exit_code: 'not-a-number' });
    expect((r.event as HostToolUsePostEvent).exitCode).toBeUndefined();
  });

  it('attack: negative duration is dropped', () => {
    const r = normalizeCursorEvent({ hook_event_name: 'afterShellExecution', session_id: 's', duration_ms: -1 });
    expect((r.event as HostToolUsePostEvent).durationMs).toBeUndefined();
  });

  it('attack: nested tool_input.command is honored for shell', () => {
    const r = normalizeCursorEvent({
      hook_event_name: 'beforeShellExecution', session_id: 's1',
      tool_input: { command: 'echo hi' },
    });
    expect((r.event as HostToolUsePreEvent).command).toBe('echo hi');
  });

  it('attack: ApplyPatch payload extracts file path from patch text', () => {
    const r = normalizeCursorEvent({
      hook_event_name: 'preToolUse', session_id: 's',
      tool_name: 'ApplyPatch',
      tool_input: { patch: '*** Update File: src/foo.ts\n+ hello' },
    });
    expect((r.event as HostToolUsePreEvent).command).toBe('src/foo.ts');
  });

  it('attack: MultiEdit edits[] yields first file path', () => {
    const r = normalizeCursorEvent({
      hook_event_name: 'preToolUse', session_id: 's',
      tool_name: 'MultiEdit',
      tool_input: { edits: [{ file_path: '/proj/a.ts' }, { file_path: '/proj/b.ts' }] },
    });
    expect((r.event as HostToolUsePreEvent).command).toBe('/proj/a.ts');
  });
});
