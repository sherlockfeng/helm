/**
 * Cross-cycle campaign summarizer.
 *
 * Builds a structured prompt from every cycle's product brief / dev work / test
 * results / screenshots, asks Anthropic to synthesize, parses the response into
 * { why, keyDecisions, cycles[], overallPath }, and persists it onto the
 * Campaign row.
 *
 * Ported from relay/src/summarizer/campaign.ts. The LLM client is now passed in
 * as a dependency (instead of `new Anthropic()` inline) so tests can supply a
 * fake without monkey-patching the SDK.
 */

import type Database from 'better-sqlite3';
import {
  getCampaign,
  listCycles,
  listTasks,
  updateCampaign,
} from '../storage/repos/campaigns.js';

export interface CycleSummary {
  cycleNum: number;
  productBrief?: string;
  devWork: string[];
  testResults: string;
  screenshots: Array<{ description: string }>;
}

export interface CampaignSummary {
  why: string;
  cycles: CycleSummary[];
  keyDecisions: string[];
  overallPath: string;
}

/**
 * Minimal contract the summarizer needs from an LLM client. Anthropic SDK's
 * `messages.create` shape, narrowed to the fields we actually consume.
 */
export interface LlmClient {
  generate(prompt: string, options: { model: string; maxTokens: number }): Promise<string>;
}

export interface SummarizerDeps {
  llm: LlmClient;
  /** Defaults to "claude-sonnet-4-6". */
  model?: string;
  /** Defaults to 2048. */
  maxTokens?: number;
}

export async function summarizeCampaign(
  db: Database.Database,
  campaignId: string,
  deps: SummarizerDeps,
): Promise<CampaignSummary> {
  const campaign = getCampaign(db, campaignId);
  if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);

  const cycles = listCycles(db, campaignId);
  const cycleSummaries: CycleSummary[] = [];

  for (const cycle of cycles) {
    const tasks = listTasks(db, cycle.id);
    const devWork = tasks
      .filter((t) => t.role === 'dev' && t.result)
      .map((t) => `${t.title}: ${t.result}`);

    const testTasks = tasks.filter((t) => t.role === 'test');
    const passed = testTasks.filter((t) => t.status === 'completed').length;
    const failed = testTasks.filter((t) => t.status === 'failed').length;
    const testResults = `${passed}/${testTasks.length} test tasks passed${failed > 0 ? `, ${failed} failed` : ''}`;

    cycleSummaries.push({
      cycleNum: cycle.cycleNum,
      productBrief: cycle.productBrief,
      devWork,
      testResults,
      screenshots: (cycle.screenshots ?? []).map((s) => ({ description: s.description })),
    });
  }

  const prompt = buildSummarizationPrompt(campaign.title, campaign.brief, cycleSummaries);
  const raw = await deps.llm.generate(prompt, {
    model: deps.model ?? 'claude-sonnet-4-6',
    maxTokens: deps.maxTokens ?? 2048,
  });
  const parsed = parseSummaryResponse(raw, cycleSummaries);

  updateCampaign(db, campaignId, {
    status: 'completed',
    completedAt: new Date().toISOString(),
    summary: JSON.stringify(parsed, null, 2),
  });
  return parsed;
}

export function buildSummarizationPrompt(
  title: string,
  brief: string | undefined,
  cycles: CycleSummary[],
): string {
  const cycleText = cycles
    .map((c) => {
      const lines = [`### Cycle ${c.cycleNum}`];
      if (c.productBrief) lines.push(`Product Analysis: ${c.productBrief}`);
      if (c.devWork.length) lines.push(`Dev Work:\n${c.devWork.map((d) => `- ${d}`).join('\n')}`);
      lines.push(`Test Results: ${c.testResults}`);
      if (c.screenshots.length) {
        lines.push(`Screenshots: ${c.screenshots.map((s) => s.description).join('; ')}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');

  return `You are summarizing a multi-day software development campaign.

Campaign: ${title}
Initial Brief: ${brief ?? '(no brief provided)'}

${cycleText}

Please write a structured summary with the following sections:

## Why
Explain the original motivation and how it evolved across cycles. Why was this work done?

## Key Decisions
List 3-7 key decisions made across all cycles (product decisions, technical choices, pivots).

## What Was Built
Summarize the development work cycle by cycle. What changed?

## Overall Path
Describe the journey from the initial brief to the final state. What was the arc of this work?

Write concisely. Focus on the reasoning and evolution, not just facts.`;
}

export function parseSummaryResponse(raw: string, cycles: CycleSummary[]): CampaignSummary {
  const whyMatch = raw.match(/## Why\n([\s\S]*?)(?=\n## |$)/);
  const decisionsMatch = raw.match(/## Key Decisions\n([\s\S]*?)(?=\n## |$)/);
  const pathMatch = raw.match(/## Overall Path\n([\s\S]*?)(?=\n## |$)/);

  const parseList = (text: string): string[] =>
    text.split('\n')
      .map((l) => l.replace(/^(\d+[.)]\s*|[-*•]\s*)/, '').trim())
      .filter(Boolean);

  return {
    why: whyMatch?.[1]?.trim() ?? raw.slice(0, 500),
    keyDecisions: decisionsMatch ? parseList(decisionsMatch[1]!) : [],
    cycles,
    overallPath: pathMatch?.[1]?.trim() ?? '',
  };
}
