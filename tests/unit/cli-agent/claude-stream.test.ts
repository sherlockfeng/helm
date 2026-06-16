import { describe, expect, it } from 'vitest';
import { parseStreamJsonDelta } from '../../../src/cli-agent/claude.js';

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
