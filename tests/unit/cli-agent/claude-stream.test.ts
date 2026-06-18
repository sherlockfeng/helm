import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAgent, parseStreamJsonDelta } from '../../../src/cli-agent/claude.js';

/** Minimal fake `claude` child: emits one stream-json result line, then closes 0. */
function makeStubSpawn() {
  const spawns: { bin: string; args: readonly string[]; options: unknown }[] = [];
  const spawn = (bin: string, args: readonly string[], options: unknown) => {
    spawns.push({ bin, args, options });
    // Streams need setEncoding() — the runner calls it before subscribing.
    const makeStream = () => Object.assign(new EventEmitter(), { setEncoding() {} });
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter; stderr: EventEmitter; kill: () => void;
    };
    child.stdout = makeStream();
    child.stderr = makeStream();
    child.kill = () => {};
    // Resolve on the next tick so the caller can attach listeners first.
    queueMicrotask(() => {
      child.stdout.emit('data', JSON.stringify({ type: 'result', result: 'ok' }) + '\n');
      child.emit('close', 0);
    });
    return child;
  };
  return { spawn, spawns };
}

/**
 * The in-app assistant streams via `claude --output-format stream-json
 * --include-partial-messages`. Token deltas arrive as
 * stream_event → content_block_delta → text_delta. parseStreamJsonDelta
 * pulls those out and ignores everything else (init / tool_use / message
 * envelopes / result), so the endpoint forwards only assistant text.
 */
describe('parseStreamJsonDelta', () => {
  it('extracts the text from a content_block_delta stream_event', () => {
    const obj = {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
    };
    expect(parseStreamJsonDelta(obj)).toBe(' world');
  });

  it('ignores non-text-delta events', () => {
    expect(parseStreamJsonDelta({ type: 'system', subtype: 'init' })).toBeNull();
    expect(parseStreamJsonDelta({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } })).toBeNull();
    expect(parseStreamJsonDelta({ type: 'result', result: 'done' })).toBeNull();
    expect(parseStreamJsonDelta({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'search_knowledge' } },
    })).toBeNull();
    expect(parseStreamJsonDelta({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } },
    })).toBeNull();
  });

  it('is null-safe on garbage', () => {
    expect(parseStreamJsonDelta(null)).toBeNull();
    expect(parseStreamJsonDelta('nope')).toBeNull();
    expect(parseStreamJsonDelta({})).toBeNull();
  });
});

describe('ClaudeCodeAgent — streamConversation args', () => {
  it('disables the user personal skills so they can\'t leak into the assistant', async () => {
    const stub = makeStubSpawn();
    const agent = new ClaudeCodeAgent({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spawn: stub.spawn as any,
    });

    const result = await agent.streamConversation([{ role: 'user', content: 'merge or split?' }]);
    expect(result.text).toBe('ok');

    expect(stub.spawns).toHaveLength(1);
    const { args } = stub.spawns[0]!;
    expect(args).toContain('--disable-slash-commands');
    expect(args).toContain('--allowedTools');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__helm');
    // The transcript must remain the last (positional) arg.
    expect(args[args.length - 1]).toBe('merge or split?');

    agent.dispose();
  });
});
