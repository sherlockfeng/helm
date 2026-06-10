import { describe, expect, it } from 'vitest';
import { parseCurationResponse } from '../../../src/summarizer/curation.js';

describe('parseCurationResponse', () => {
  it('parses a clean JSON object with both arrays', () => {
    const raw = JSON.stringify({
      updates: [{
        targetChunkId: 'chunk-42',
        kind: 'spec',
        gist: 'v5 schema 取代 v4',
        proposedText: '所有 body 必须 JSON',
      }],
      newPoints: [{
        kind: 'decision',
        gist: '选 BAM IDL Load 而非 v6 draft',
        chunkText: '理由：上线时间紧；BAM 已经在线上',
      }],
    });
    const parsed = parseCurationResponse(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.updates).toHaveLength(1);
    expect(parsed!.updates[0]!.targetChunkId).toBe('chunk-42');
    expect(parsed!.updates[0]!.kind).toBe('spec');
    expect(parsed!.newPoints).toHaveLength(1);
    expect(parsed!.newPoints[0]!.kind).toBe('decision');
  });

  it('strips ```json fences and surrounding prose', () => {
    const raw = `Sure, here's the report:\n\`\`\`json\n${JSON.stringify({
      updates: [], newPoints: [{ kind: 'warning', gist: 'g', chunkText: 'c' }],
    })}\n\`\`\`\nLet me know if you need more.`;
    const parsed = parseCurationResponse(raw);
    expect(parsed!.newPoints).toHaveLength(1);
  });

  it('falls back to brace-scan when no fence is present', () => {
    const raw = `Output below.\n${JSON.stringify({
      updates: [], newPoints: [{ kind: 'spec', gist: 'g', chunkText: 'c' }],
    })}\nThanks.`;
    expect(parseCurationResponse(raw)?.newPoints).toHaveLength(1);
  });

  it('returns valid empty report when both arrays are empty', () => {
    const parsed = parseCurationResponse('{"updates":[],"newPoints":[]}');
    expect(parsed).toEqual({ updates: [], newPoints: [] });
  });

  it('returns null on un-parseable input', () => {
    expect(parseCurationResponse('I have no idea what this is')).toBeNull();
    expect(parseCurationResponse('not even close to json')).toBeNull();
  });

  it('drops update entries missing required fields', () => {
    const raw = JSON.stringify({
      updates: [
        { kind: 'spec', gist: 'g', proposedText: 'p' }, // missing targetChunkId
        { targetChunkId: 'c1', kind: 'bogus', gist: 'g', proposedText: 'p' }, // invalid kind
        { targetChunkId: 'c2', kind: 'spec', gist: '', proposedText: 'p' }, // empty gist
        { targetChunkId: 'c3', kind: 'spec', gist: 'g', proposedText: 'p' }, // valid
      ],
      newPoints: [],
    });
    const parsed = parseCurationResponse(raw);
    expect(parsed!.updates).toHaveLength(1);
    expect(parsed!.updates[0]!.targetChunkId).toBe('c3');
  });

  it('accepts new chat-kind variants (decision / open_question / workaround)', () => {
    const raw = JSON.stringify({
      updates: [],
      newPoints: [
        { kind: 'decision',      gist: 'g', chunkText: 'c1' },
        { kind: 'open_question', gist: 'g', chunkText: 'c2' },
        { kind: 'workaround',    gist: 'g', chunkText: 'c3' },
      ],
    });
    const parsed = parseCurationResponse(raw);
    expect(parsed!.newPoints.map((n) => n.kind))
      .toEqual(['decision', 'open_question', 'workaround']);
  });

  it('normalizes hyphenated kinds (open-question → open_question)', () => {
    const raw = JSON.stringify({
      updates: [], newPoints: [{ kind: 'open-question', gist: 'g', chunkText: 'c' }],
    });
    expect(parseCurationResponse(raw)!.newPoints[0]!.kind).toBe('open_question');
  });

  it('caps gist at 200 chars', () => {
    const longGist = 'x'.repeat(500);
    const raw = JSON.stringify({
      updates: [],
      newPoints: [{ kind: 'spec', gist: longGist, chunkText: 'c' }],
    });
    expect(parseCurationResponse(raw)!.newPoints[0]!.gist.length).toBe(200);
  });
});
