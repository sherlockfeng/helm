/**
 * PR-γ2: AI 整理 draft generator — prompt assembly + failure semantics.
 * Pure module (fake LlmClient), no DB.
 */

import { describe, expect, it, vi } from 'vitest';
import { draftPromotionDoc } from '../../../src/knowledge/promote-draft.js';

describe('draftPromotionDoc', () => {
  it('feeds fragments + external context to the LLM and returns the trimmed draft', async () => {
    const generate = vi.fn(async (_p: string, _o: { model: string; maxTokens: number }) => '\n## 接入流程\n先注册再打标签。\n');
    const draft = await draftPromotionDoc({
      fragments: ['OG 数据要先注册', 'schema 不匹配回退 v4'],
      domain: 'stability',
      title: 'OG 接入约定',
      externalContext: '【tika】\nOG 平台文档：注册入口在 …',
      llm: { generate },
    });
    expect(draft).toBe('## 接入流程\n先注册再打标签。');
    const prompt = generate.mock.calls[0]![0] as string;
    expect(prompt).toContain('domains/stability/');
    expect(prompt).toContain('OG 接入约定');
    expect(prompt).toContain('〔碎片 1〕');
    expect(prompt).toContain('schema 不匹配回退 v4');
    expect(prompt).toContain('【tika】');
    expect(prompt).toContain('以碎片为准');
  });

  it('omits the reference section when there is no external context', async () => {
    const generate = vi.fn(async (_p: string, _o: { model: string; maxTokens: number }) => 'doc');
    await draftPromotionDoc({ fragments: ['一条碎片'], llm: { generate } });
    const prompt = generate.mock.calls[0]![0] as string;
    expect(prompt).not.toContain('外部知识源检索到的参考资料');
  });

  it('returns null on empty fragments, LLM failure, or blank output', async () => {
    expect(await draftPromotionDoc({ fragments: ['  '], llm: { generate: vi.fn() } }))
      .toBeNull();
    expect(await draftPromotionDoc({
      fragments: ['x'], llm: { generate: vi.fn(async () => { throw new Error('down'); }) },
    })).toBeNull();
    expect(await draftPromotionDoc({
      fragments: ['x'], llm: { generate: vi.fn(async () => '   ') },
    })).toBeNull();
  });

  it('bounds oversized inputs', async () => {
    const generate = vi.fn(async (_p: string, _o: { model: string; maxTokens: number }) => 'ok');
    await draftPromotionDoc({
      fragments: ['A'.repeat(20_000)],
      externalContext: 'B'.repeat(20_000),
      llm: { generate },
    });
    const prompt = generate.mock.calls[0]![0] as string;
    expect(prompt.length).toBeLessThan(16_000);
  });
});
