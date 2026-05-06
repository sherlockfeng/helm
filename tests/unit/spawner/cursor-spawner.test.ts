/**
 * Unit tests for CursorAgentSpawner (Phase 26 / C3).
 *
 * The Cursor SDK is mocked end-to-end via the `agentFactory` test seam — no
 * real Cursor process is started, no network calls made.
 */

import { describe, expect, it, vi } from 'vitest';
import { Agent } from '@cursor/sdk';
import type { Run, SDKAgent } from '@cursor/sdk';
import { CursorAgentSpawner, createCursorAgentSpawner } from '../../../src/spawner/cursor-spawner.js';

type AgentFactory = typeof Agent.create;

interface FakeAgentOptions {
  agentId?: string;
  send?: SDKAgent['send'];
}

function makeFakeAgent({ agentId = 'agent_fake_1', send }: FakeAgentOptions = {}): SDKAgent {
  return {
    agentId,
    model: { id: 'auto' },
    send: send ?? (async (): Promise<Run> => ({
      id: 'run_initial',
      agentId,
      result: undefined,
      model: undefined,
      durationMs: undefined,
      git: undefined,
      supports: () => false,
      unsupportedReason: () => 'fake',
      stream: async function* () { /* no-op */ },
      conversation: async () => [],
      wait: async () => ({ status: 'finished' as const, result: undefined }),
      cancel: async () => undefined,
      get status() { return { lifecycle: 'finished' as const }; },
      onDidChangeStatus: () => () => undefined,
    } as unknown as Run)),
    close: () => undefined,
    reload: async () => undefined,
    [Symbol.asyncDispose]: async () => undefined,
    listArtifacts: async () => [],
    downloadArtifact: async () => Buffer.from(''),
  } as SDKAgent;
}

describe('CursorAgentSpawner', () => {
  it('spawns a local agent without a prompt — returns agentId only', async () => {
    const factory = vi.fn<AgentFactory>(async () => makeFakeAgent({ agentId: 'a1' }));
    const spawner = new CursorAgentSpawner({ agentFactory: factory });
    const result = await spawner.spawn({ projectPath: '/proj' });

    expect(result.agentId).toBe('a1');
    expect(result.modelId).toBe('auto');
    expect(result.projectPath).toBe('/proj');
    expect(result.initialRunId).toBeUndefined();
    expect(factory).toHaveBeenCalledTimes(1);
    const opts = factory.mock.calls[0]![0]!;
    expect(opts.local?.cwd).toBe('/proj');
    expect(opts.apiKey).toBeUndefined();
    expect(opts.model).toEqual({ id: 'auto' });
  });

  it('passes through name + modelId override', async () => {
    const factory = vi.fn<AgentFactory>(async () => makeFakeAgent({ agentId: 'a2' }));
    const spawner = new CursorAgentSpawner({ agentFactory: factory, modelId: 'auto' });
    await spawner.spawn({ projectPath: '/p', name: 'tester', modelId: 'composer-2' });
    const opts = factory.mock.calls[0]![0]!;
    expect(opts.name).toBe('tester');
    expect(opts.model).toEqual({ id: 'composer-2' });
  });

  it('sends an initial prompt when provided and surfaces the run id', async () => {
    const send = vi.fn(async (_msg: string) => ({ id: 'run_42' } as unknown as Run));
    const factory = vi.fn<AgentFactory>(async () => makeFakeAgent({ agentId: 'a3', send }));
    const spawner = new CursorAgentSpawner({ agentFactory: factory });
    const result = await spawner.spawn({ projectPath: '/p', prompt: 'do the thing' });

    expect(send).toHaveBeenCalledWith('do the thing');
    expect(result.initialRunId).toBe('run_42');
  });

  it('whitespace-only prompt is treated as no prompt — no send call', async () => {
    const send = vi.fn();
    const factory = vi.fn<AgentFactory>(async () => makeFakeAgent({ send }));
    const spawner = new CursorAgentSpawner({ agentFactory: factory });
    const result = await spawner.spawn({ projectPath: '/p', prompt: '   ' });
    expect(send).not.toHaveBeenCalled();
    expect(result.initialRunId).toBeUndefined();
  });

  it('cloud mode requires an API key — constructor throws otherwise', () => {
    const env = { ...process.env };
    delete env.CURSOR_API_KEY;
    const original = process.env.CURSOR_API_KEY;
    delete process.env.CURSOR_API_KEY;
    try {
      expect(() => new CursorAgentSpawner({ mode: 'cloud' })).toThrow(/cloud mode requires an API key/);
    } finally {
      if (original !== undefined) process.env.CURSOR_API_KEY = original;
    }
  });

  it('cloud mode with apiKey passes it on Agent.create', async () => {
    const factory = vi.fn<AgentFactory>(async () => makeFakeAgent({ agentId: 'cloud-1' }));
    const spawner = new CursorAgentSpawner({
      mode: 'cloud',
      apiKey: 'sk-test',
      agentFactory: factory,
    });
    await spawner.spawn({ projectPath: '/p' });
    const opts = factory.mock.calls[0]![0]!;
    expect(opts.apiKey).toBe('sk-test');
    // local should NOT be set when in cloud mode
    expect(opts.local).toBeUndefined();
  });

  it('cloud mode falls back to CURSOR_API_KEY env var', async () => {
    const factory = vi.fn<AgentFactory>(async () => makeFakeAgent({ agentId: 'cloud-2' }));
    const original = process.env.CURSOR_API_KEY;
    process.env.CURSOR_API_KEY = 'sk-from-env';
    try {
      const spawner = new CursorAgentSpawner({ mode: 'cloud', agentFactory: factory });
      await spawner.spawn({ projectPath: '/p' });
      const opts = factory.mock.calls[0]![0]!;
      expect(opts.apiKey).toBe('sk-from-env');
    } finally {
      if (original === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = original;
    }
  });

  it('attack: empty projectPath rejects before factory is called', async () => {
    const factory = vi.fn<AgentFactory>();
    const spawner = new CursorAgentSpawner({ agentFactory: factory });
    await expect(spawner.spawn({ projectPath: '' })).rejects.toThrow(/projectPath/);
    await expect(spawner.spawn({ projectPath: '   ' })).rejects.toThrow(/projectPath/);
    expect(factory).not.toHaveBeenCalled();
  });

  it('attack: factory rejection bubbles up unmodified', async () => {
    const factory = vi.fn<AgentFactory>(async () => {
      throw new Error('cursor agent platform unavailable');
    });
    const spawner = new CursorAgentSpawner({ agentFactory: factory });
    await expect(spawner.spawn({ projectPath: '/p' })).rejects.toThrow(/cursor agent platform/);
  });

  it('attack: send() rejection bubbles up — no orphaned partial result', async () => {
    const send = vi.fn(async () => { throw new Error('busy'); });
    const factory = vi.fn<AgentFactory>(async () => makeFakeAgent({ send }));
    const spawner = new CursorAgentSpawner({ agentFactory: factory });
    await expect(spawner.spawn({ projectPath: '/p', prompt: 'hi' })).rejects.toThrow(/busy/);
  });

  it('createCursorAgentSpawner factory: local mode never throws on missing key', () => {
    expect(() => createCursorAgentSpawner({ mode: 'local' })).not.toThrow();
  });
});
