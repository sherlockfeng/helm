/**
 * Helm tool guide constant + wrapper helper (Phase 71).
 *
 * Pure unit-level checks — the orchestrator integration is covered by
 * `tests/e2e/helm-tool-guide-injection/happy.spec.ts`. We only need to
 * pin that:
 *   - the guide text references each of the major MCP tool namespaces
 *     (so the agent has signal to reach for them rather than CLI lookups)
 *   - the version constant is an integer ≥ 1 (DB column expects INTEGER)
 *   - the prompt-injection wrapper produces the well-known marker block
 *     shape the host_prompt_submit handler relies on
 */

import { describe, expect, it } from 'vitest';
import {
  HELM_TOOL_GUIDE,
  HELM_TOOL_GUIDE_VERSION,
  wrapToolGuideForPromptInjection,
} from '../../../src/app/helm-tool-guide.js';

describe('HELM_TOOL_GUIDE constant', () => {
  it('states helm is a desktop GUI, not a CLI', () => {
    // This is the core anti-confusion message — the lead reason the
    // guide exists. If a copy-edit weakens it, the test fails on purpose.
    expect(HELM_TOOL_GUIDE).toMatch(/desktop GUI/i);
    expect(HELM_TOOL_GUIDE).toMatch(/NOT a CLI/i);
    expect(HELM_TOOL_GUIDE).toMatch(/no.*`helm`.*binary/i);
  });

  it('names every major MCP tool namespace so the agent can route requests', () => {
    // Each line is a category the agent might be asked about. If we add
    // a tool family later (e.g. cycle / requirements), bump this list AND
    // update HELM_TOOL_GUIDE_VERSION so existing chats receive the new
    // text via the prompt-submit fallback.
    for (const tool of [
      'list_roles', 'update_role', 'train_role', 'search_knowledge',
      'harness_create_task', 'harness_advance_stage', 'harness_run_review',
      'harness_search_archive',
      'bind_to_remote_channel', 'get_active_chats',
      'read_lark_doc',
      'query_knowledge',
    ]) {
      expect(HELM_TOOL_GUIDE).toContain(tool);
    }
  });

  it('keeps the guide under ~1200 chars so it fits next to role + Harness context', () => {
    // Budget guard — the additional_context budget at sessionStart is
    // shared with much larger blocks (role chunks, Harness Intent dump).
    // Drift above ~1200 chars and we start eating user context window for
    // metadata. Soft cap, lifted only with explicit conversation.
    expect(HELM_TOOL_GUIDE.length).toBeLessThan(1200);
  });
});

describe('HELM_TOOL_GUIDE_VERSION', () => {
  it('is a positive integer (sqlite column is INTEGER)', () => {
    expect(Number.isInteger(HELM_TOOL_GUIDE_VERSION)).toBe(true);
    expect(HELM_TOOL_GUIDE_VERSION).toBeGreaterThan(0);
  });
});

describe('wrapToolGuideForPromptInjection', () => {
  it('wraps the guide in <helm:tool-guide> markers identical in shape to <helm:role-context>', () => {
    const block = wrapToolGuideForPromptInjection();
    expect(block.startsWith('<helm:tool-guide>')).toBe(true);
    expect(block.trimEnd().endsWith('</helm:tool-guide>')).toBe(true);
    expect(block).toContain('system context for the agent, not user input');
    expect(block).toContain(HELM_TOOL_GUIDE);
  });

  it('embeds an ISO timestamp comment so debugging shows when the inject happened', () => {
    const block = wrapToolGuideForPromptInjection();
    expect(block).toMatch(/helm injected \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
