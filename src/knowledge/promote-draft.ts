/**
 * 知识阶梯 PR-γ2: AI 整理 — turn a pile of personal knowledge fragments
 * into a polished promotion draft, with the external knowledge sources
 * (Tika / custom MCP bridges) as reference context.
 *
 * The Tika positioning from the tiers design: 帮助"生成、完善"
 * chat-captured 里的知识 — this is the "完善" half. The LLM merges the
 * fragments, weaves in confirmed reference material, and flags
 * uncertainty instead of inventing. The user still edits + submits the
 * MR — AI drafts, human decides.
 */

import type { LlmClient } from '../summarizer/campaign.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 2_000;
/** Keep prompts bounded — fragments + reference can both be long. */
const MAX_FRAGMENTS_CHARS = 8_000;
const MAX_CONTEXT_CHARS = 6_000;

export interface DraftPromotionInput {
  /** Selected personal-knowledge fragments (chunk texts). */
  fragments: readonly string[];
  /** Target domain under domains/ — gives the LLM the audience. */
  domain?: string;
  /** User-chosen doc title, when already decided. */
  title?: string;
  /** Merged external-source reference (【source】-prefixed blocks). */
  externalContext?: string;
  llm: LlmClient;
  model?: string;
}

/**
 * Returns the polished markdown body (no top-level title heading — the
 * title stays a separate user-controlled field), or null when the LLM
 * call fails / returns nothing usable. Never throws.
 */
export async function draftPromotionDoc(input: DraftPromotionInput): Promise<string | null> {
  const fragments = input.fragments
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
  if (fragments.length === 0) return null;

  const fragmentBlock = fragments
    .map((f, i) => `〔碎片 ${i + 1}〕\n${f}`)
    .join('\n\n')
    .slice(0, MAX_FRAGMENTS_CHARS);
  const contextBlock = (input.externalContext ?? '').trim().slice(0, MAX_CONTEXT_CHARS);

  const prompt = [
    '你在为团队知识库整理一篇领域知识文档。',
    input.domain ? `目标领域：domains/${input.domain}/。` : '',
    input.title ? `文档标题（已定，不要输出标题行）：${input.title}` : '',
    '',
    '下面是从工作对话中沉淀的个人知识碎片（一手信息，优先级最高）：',
    '',
    fragmentBlock,
    contextBlock
      ? '\n下面是外部知识源检索到的参考资料（用于补全背景与互相印证；与碎片冲突时以碎片为准并标注差异）：\n\n' + contextBlock
      : '',
    '',
    '要求：',
    '1. 合并去重，按主题组织成结构化 markdown（小标题/列表自取），中文。',
    '2. 只陈述碎片与参考资料支持的内容；不确定的明确标注"待确认"。',
    '3. 保留具体细节（命令、阈值、链接、版本号）——它们是知识的价值所在。',
    '4. 只输出文档正文，不要标题行、不要任何解释性前后缀。',
  ].filter((l) => l !== '').join('\n');

  let raw: string;
  try {
    raw = await input.llm.generate(prompt, {
      model: input.model ?? DEFAULT_MODEL,
      maxTokens: MAX_TOKENS,
    });
  } catch {
    return null;
  }
  const draft = raw.trim();
  return draft.length > 0 ? draft : null;
}
