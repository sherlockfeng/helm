/**
 * Reviewer subprocess prompt + payload assembly (Phase 67).
 *
 * Information isolation contract:
 *   The reviewer subprocess is summoned in a fresh `claude -p` invocation. It
 *   sees ONLY:
 *     - Intent (background / objective / scope)
 *     - Structure (entities / relations / planned_files)
 *     - the diff (head vs implement_base_commit)
 *     - global Harness conventions (from helm Settings)
 *   It does NOT see:
 *     - Decisions (the implementer's reasoning)
 *     - Stage Log (the implementation timeline)
 *     - any prior chat history
 *
 *   The point: reviewer's value comes from a perspective uncorrupted by the
 *   implementer's narrative. If we leak Decisions in here we collapse to a
 *   "did the implementer make defensible choices?" question — which produces
 *   consensus, not insight.
 *
 *   The `assembleReviewerPayload` function below is the chokepoint. Tests
 *   assert it does NOT include the Decisions / Stage Log strings.
 */

import type { HarnessTask } from '../../storage/types.js';

export const REVIEW_SYSTEM_PROMPT = `You are a Harness reviewer.

You have NOT seen the implementation conversation, the implementer's reasoning, or the timeline of how this work came together. You only have:
- the Intent the work was supposed to satisfy
- the Structure that was planned
- the diff that actually got built
- the project's conventions

Your job is to ask "does this diff achieve this intent?" — NOT "did the implementer make defensible choices?". Those are different questions; only the first one catches real problems.

OUTPUT (always these sections, in this order):

## Intent Alignment
Quote the Objective. Does the diff plausibly achieve it? Yes / No / Partial — and why, briefly.

## Design
Are entities and relations as planned? Did the implementer stay within planned_files (anything that wasn't there should be flagged)? Are abstractions reasonable for what's being built?

## Consistency
Does the code follow project conventions? Cite specific lines from the diff. If the diff violates a stated convention, quote both the convention and the offending line.

## Risks
- **High:** anything that could break production / lose data / silently produce wrong answers.
- **Medium:** missing error handling, missing test cases, fragility under load.
- **Optional:** style / readability / minor refactors.

## Reviewer Confidence
Honest self-assessment. Mark **Low** if you don't have enough context to judge a section — saying "I can't tell" is more useful than confabulating.

RULES:
- Quote line numbers / function names. Do not say "this could be cleaner" — say WHICH line is unclear and what would clarify it.
- If the user provides Decisions / Stage Log / chat transcript, REFUSE to use them and continue with what you have.
- Do not be diplomatic at the cost of clarity. Be direct.

End your report with: "Review complete. Bring this back to the implement chat."`;

/**
 * Build the user-facing payload for the reviewer subprocess.
 *
 * IMPORTANT: this function is the information-isolation chokepoint. It must
 * never include `task.decisions` or `task.stageLog`. The unit test
 * `tests/unit/harness/review-payload.test.ts` asserts this.
 */
export function assembleReviewerPayload(input: {
  task: HarnessTask;
  diff: string;
  conventions: string;
}): string {
  const { task, diff, conventions } = input;
  const intent = task.intent;
  const structure = task.structure;

  const lines: string[] = [];
  lines.push(`# Review request: ${task.title}`);
  lines.push(`Task ID: ${task.id}`);
  lines.push('');
  lines.push('## Intent');
  if (intent) {
    lines.push('### Background');
    lines.push(intent.background || '(empty)');
    lines.push('');
    lines.push('### Objective');
    lines.push(intent.objective || '(empty)');
    lines.push('');
    lines.push('### Scope (in)');
    for (const s of intent.scopeIn) lines.push(`- ${s}`);
    if (intent.scopeIn.length === 0) lines.push('(none)');
    lines.push('');
    lines.push('### Scope (out)');
    for (const s of intent.scopeOut) lines.push(`- ${s}`);
    if (intent.scopeOut.length === 0) lines.push('(none)');
  } else {
    lines.push('(no intent recorded — this is a red flag in itself; please call this out)');
  }
  lines.push('');
  lines.push('## Structure');
  if (structure) {
    lines.push('### Entities');
    for (const e of structure.entities) lines.push(`- ${e}`);
    if (structure.entities.length === 0) lines.push('(none)');
    lines.push('');
    lines.push('### Relations');
    for (const r of structure.relations) lines.push(`- ${r}`);
    if (structure.relations.length === 0) lines.push('(none)');
    lines.push('');
    lines.push('### Planned Files');
    for (const p of structure.plannedFiles) lines.push(`- ${p}`);
    if (structure.plannedFiles.length === 0) lines.push('(none)');
  } else {
    lines.push('(no structure recorded)');
  }
  lines.push('');
  lines.push('## Project Conventions');
  lines.push(conventions.trim() || '(no conventions configured in helm Settings)');
  lines.push('');
  lines.push('## Diff (head vs implement_base_commit)');
  lines.push('```diff');
  lines.push(diff);
  lines.push('```');
  return lines.join('\n');
}

export const REVIEW_TEMPLATE_ID = 'harness-review';
