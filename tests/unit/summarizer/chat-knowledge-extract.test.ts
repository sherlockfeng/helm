import { describe, expect, it } from 'vitest';
import { parsePoints } from '../../../src/summarizer/chat-knowledge-extract.js';
import { topicIdFromName } from '../../../src/storage/repos/chat-knowledge.js';

describe('topicIdFromName', () => {
  it('keeps CJK and avoids the ASCII-only collapse', () => {
    expect(topicIdFromName('helm 采集架构', 'fb')).toBe('helm-采集架构');
    expect(topicIdFromName('知识分层', 'fb')).toBe('知识分层');
    expect(topicIdFromName('OG 接入', 'fb')).toBe('og-接入');
  });
  it('strips punctuation/slashes and dedupes dashes', () => {
    expect(topicIdFromName('  Foo / Bar!! ', 'fb')).toBe('foo-bar');
  });
  it('falls back when no usable letters/digits', () => {
    expect(topicIdFromName('!!! ', 'fb')).toBe('fb');
  });
});

const TOPICS = new Set(['stability', 'goofy-expert']);

describe('parsePoints', () => {
  it('routes to an existing topic id when valid', () => {
    const raw = JSON.stringify({ points: [
      { title: 'DR runbook step', body: 'do X then Y', kind: 'runbook', topicId: 'stability', newTopic: null },
    ] });
    const out = parsePoints(raw, TOPICS);
    expect(out).toEqual([
      { title: 'DR runbook step', body: 'do X then Y', kind: 'runbook', suggestedRoleId: 'stability', suggestedTopicName: null },
    ]);
  });

  it('falls back to newTopic when topicId is unknown/missing', () => {
    const raw = JSON.stringify({ points: [
      { title: 'OG tagging', body: 'tag with og', kind: 'spec', topicId: 'nonexistent', newTopic: 'OG 接入' },
    ] });
    const out = parsePoints(raw, TOPICS);
    expect(out[0]).toMatchObject({ suggestedRoleId: null, suggestedTopicName: 'OG 接入' });
  });

  it('defaults kind to other and skips items missing title/body', () => {
    const raw = JSON.stringify({ points: [
      { title: 'has title', body: 'has body', kind: 'bogus', topicId: null, newTopic: 'X' },
      { title: '', body: 'no title', kind: 'spec' },
      { title: 'no body', body: '', kind: 'spec' },
    ] });
    const out = parsePoints(raw, TOPICS);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('other');
  });

  it('tolerates ```json fences and surrounding prose', () => {
    const raw = 'Here you go:\n```json\n{"points":[{"title":"t","body":"b","kind":"glossary","topicId":"goofy-expert"}]}\n```\ndone';
    const out = parsePoints(raw, TOPICS);
    expect(out).toHaveLength(1);
    expect(out[0]!.suggestedRoleId).toBe('goofy-expert');
  });

  it('returns [] on non-JSON or missing points array', () => {
    expect(parsePoints('no json here', TOPICS)).toEqual([]);
    expect(parsePoints(JSON.stringify({ nope: 1 }), TOPICS)).toEqual([]);
  });
});
