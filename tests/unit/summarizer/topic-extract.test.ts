import { describe, expect, it } from 'vitest';
import { parseTopicPoints } from '../../../src/summarizer/chat-knowledge-extract.js';

/**
 * Unit for the topic-scoped extraction parser (the "把这条 chat 里所有 X 的
 * 知识沉淀进 X" LLM pass). All points route to the one topic, so unlike the
 * general parser there's no topicId/newTopic routing — just title/body/kind.
 */
describe('parseTopicPoints', () => {
  it('parses a plain JSON points array', () => {
    const raw = JSON.stringify({
      points: [
        { title: 'reliability-recovery-500 JSON body', body: '规格…', kind: 'spec' },
        { title: 'recovery-* 响应头', body: '说明…', kind: 'glossary' },
      ],
    });
    const out = parseTopicPoints(raw);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ title: 'reliability-recovery-500 JSON body', body: '规格…', kind: 'spec' });
    expect(out[1]!.kind).toBe('glossary');
  });

  it('unwraps a ```json fenced block and preamble', () => {
    const raw = 'Here you go:\n```json\n{"points":[{"title":"t","body":"b","kind":"runbook"}]}\n```';
    const out = parseTopicPoints(raw);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('runbook');
  });

  it('drops items missing title or body', () => {
    const raw = JSON.stringify({
      points: [
        { title: '', body: 'b', kind: 'spec' },
        { title: 't', body: '', kind: 'spec' },
        { title: 'ok', body: 'b', kind: 'spec' },
      ],
    });
    expect(parseTopicPoints(raw).map((p) => p.title)).toEqual(['ok']);
  });

  it('falls back to "other" for an unknown kind', () => {
    const raw = JSON.stringify({ points: [{ title: 't', body: 'b', kind: 'nonsense' }] });
    expect(parseTopicPoints(raw)[0]!.kind).toBe('other');
  });

  it('returns [] on non-JSON / wrong shape', () => {
    expect(parseTopicPoints('not json at all')).toEqual([]);
    expect(parseTopicPoints('{"nope": 1}')).toEqual([]);
    expect(parseTopicPoints('{"points": "x"}')).toEqual([]);
  });
});
