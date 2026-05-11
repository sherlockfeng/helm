/**
 * Build the additional_context block that helm injects into a Cursor chat
 * bound to a Harness task (Phase 67).
 *
 * Layout:
 *   - one-line stage banner (so the agent immediately knows which mode it's in)
 *   - the stage's hard-rules system prompt
 *   - a path pointer to .harness/tasks/<id>/task.md (the durable memory)
 *
 * We deliberately do NOT inline the entire task.md content. Reasons:
 *   - it's already on disk; the agent's read tool can grab it on demand
 *   - inlining grows session-context payload past helm's 32 KB safety cap
 *     once Decisions / Stage Log accumulate
 *   - reading task.md fresh each time avoids stale-by-injection bugs when
 *     the user updates Intent mid-implement
 */

import type { HarnessTask } from '../storage/types.js';
import { NEW_FEATURE_SYSTEM_PROMPT, NEW_FEATURE_TEMPLATE_ID } from './templates/new-feature.js';
import { IMPLEMENT_SYSTEM_PROMPT, IMPLEMENT_TEMPLATE_ID } from './templates/implement.js';
import { taskFilePath } from './file-io.js';

export function assembleHarnessSessionContext(task: HarnessTask): string {
  const stagePrompt = stagePromptFor(task);
  if (!stagePrompt) return '';
  const taskMdPath = taskFilePath(task.projectPath, task.id);
  const lines: string[] = [];
  lines.push('────────────────────────────────────────');
  lines.push(`HARNESS · ${task.currentStage.toUpperCase()} · task=${task.id}`);
  lines.push('────────────────────────────────────────');
  lines.push('');
  lines.push(stagePrompt);
  lines.push('');
  lines.push(`Durable memory: read \`${taskMdPath}\` at the start of every substantive turn — that file is your truth, this chat is scratchpad.`);
  return lines.join('\n');
}

function stagePromptFor(task: HarnessTask): string | null {
  switch (task.currentStage) {
    case 'new_feature': return NEW_FEATURE_SYSTEM_PROMPT;
    case 'implement': return IMPLEMENT_SYSTEM_PROMPT;
    case 'archived': return null; // archived tasks don't need an active prompt
    default: {
      const _exhaustive: never = task.currentStage;
      void _exhaustive;
      return null;
    }
  }
}

export const TEMPLATE_IDS = {
  newFeature: NEW_FEATURE_TEMPLATE_ID,
  implement: IMPLEMENT_TEMPLATE_ID,
} as const;
