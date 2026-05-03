import { describe, expect, it } from 'vitest';
import {
  bridgeResponseToDecision,
  eventToBridgeRequest,
  fallbackDecision,
} from '../../../../src/host/cursor/bridge-mapper.js';
import type {
  HostAgentResponseEvent,
  HostPromptSubmitEvent,
  HostSessionStartEvent,
  HostStopEvent,
  HostToolUsePostEvent,
  HostToolUsePreEvent,
} from '../../../../src/host/types.js';

const sessionStart: HostSessionStartEvent = {
  host: 'cursor', kind: 'session_start', hostSessionId: 's1', cwd: '/proj', composerMode: 'agent', raw: null,
};
const promptSubmit: HostPromptSubmitEvent = {
  host: 'cursor', kind: 'prompt_submit', hostSessionId: 's1', cwd: '/proj', prompt: 'hi', raw: null,
};
const agentResp: HostAgentResponseEvent = {
  host: 'cursor', kind: 'agent_response', hostSessionId: 's1', text: 'hello', raw: null,
};
const toolPost: HostToolUsePostEvent = {
  host: 'cursor', kind: 'tool_use_post', hostSessionId: 's1', tool: 'Shell', command: 'ls', phase: 'completed', exitCode: 0, raw: null,
};
const stopEv: HostStopEvent = {
  host: 'cursor', kind: 'stop', hostSessionId: 's1', raw: null,
};
const toolPre: HostToolUsePreEvent = {
  host: 'cursor', kind: 'tool_use_pre', hostSessionId: 's1', hookEventName: 'preToolUse',
  tool: 'Shell', command: 'rm -rf /', payload: { command: 'rm -rf /' }, raw: null,
};

describe('eventToBridgeRequest', () => {
  it('maps session_start → host_session_start with cwd + composer_mode', () => {
    expect(eventToBridgeRequest(sessionStart)).toEqual({
      type: 'host_session_start',
      host_session_id: 's1',
      cwd: '/proj',
      composer_mode: 'agent',
    });
  });

  it('maps prompt_submit', () => {
    expect(eventToBridgeRequest(promptSubmit)).toMatchObject({
      type: 'host_prompt_submit', host_session_id: 's1', prompt: 'hi',
    });
  });

  it('maps agent_response', () => {
    expect(eventToBridgeRequest(agentResp)).toMatchObject({
      type: 'host_agent_response', response_text: 'hello',
    });
  });

  it('maps tool_use_post → host_progress with phase detail', () => {
    expect(eventToBridgeRequest(toolPost)).toMatchObject({
      type: 'host_progress', tool: 'Shell', detail: 'completed (exit 0)',
    });
  });

  it('maps stop', () => {
    expect(eventToBridgeRequest(stopEv)).toEqual({ type: 'host_stop', host_session_id: 's1' });
  });

  it('maps tool_use_pre → host_approval_request', () => {
    expect(eventToBridgeRequest(toolPre)).toMatchObject({
      type: 'host_approval_request', tool: 'Shell', command: 'rm -rf /',
    });
  });
});

describe('bridgeResponseToDecision', () => {
  it('session_start passes additional_context through', () => {
    const d = bridgeResponseToDecision(sessionStart, { additional_context: 'ctx' });
    expect(d).toEqual({ kind: 'session_start', additionalContext: 'ctx' });
  });

  it('prompt_submit defaults continue=true when bridge returns nothing', () => {
    const d = bridgeResponseToDecision(promptSubmit, {});
    expect(d).toMatchObject({ kind: 'prompt_submit', continue: true });
  });

  it('prompt_submit honors continue=false', () => {
    const d = bridgeResponseToDecision(promptSubmit, { continue: false, user_message: 'no' });
    expect(d).toMatchObject({ kind: 'prompt_submit', continue: false, userMessage: 'no' });
  });

  it('tool_use_pre coerces invalid decisions to ask', () => {
    const d = bridgeResponseToDecision(toolPre, { decision: 'bogus' });
    expect(d).toMatchObject({ kind: 'tool_use_pre', permission: 'ask' });
  });

  it('tool_use_pre allow with reason', () => {
    const d = bridgeResponseToDecision(toolPre, { decision: 'allow', reason: 'matches policy' });
    expect(d).toMatchObject({ kind: 'tool_use_pre', permission: 'allow', reason: 'matches policy' });
  });

  it('stop forwards followup_message', () => {
    const d = bridgeResponseToDecision(stopEv, { followup_message: 'do this next' });
    expect(d).toEqual({ kind: 'stop', followupMessage: 'do this next' });
  });

  it('attack: BridgeErrorResponse → fallback decision', () => {
    expect(bridgeResponseToDecision(toolPre, { error: 'no_handler' }))
      .toMatchObject({ kind: 'tool_use_pre', permission: 'ask' });
    expect(bridgeResponseToDecision(promptSubmit, { error: 'parse_error' }))
      .toMatchObject({ kind: 'prompt_submit', continue: true });
  });
});

describe('fallbackDecision', () => {
  it('returns ask for tool_use_pre with reason', () => {
    expect(fallbackDecision(toolPre, 'bridge dead'))
      .toEqual({ kind: 'tool_use_pre', permission: 'ask', reason: 'bridge dead' });
  });

  it('returns continue=true for prompt_submit', () => {
    expect(fallbackDecision(promptSubmit)).toMatchObject({ kind: 'prompt_submit', continue: true });
  });

  it('returns minimal session_start', () => {
    expect(fallbackDecision(sessionStart)).toEqual({ kind: 'session_start' });
  });

  it('returns ok=true for tool_use_post', () => {
    expect(fallbackDecision(toolPost)).toMatchObject({ kind: 'tool_use_post', ok: true });
  });
});
