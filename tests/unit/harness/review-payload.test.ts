/**
 * Information-isolation contract test (Phase 67).
 *
 * `assembleReviewerPayload` is the chokepoint that decides what the reviewer
 * subprocess sees. It MUST NOT include the task's Decisions or Stage Log —
 * the whole value of the reviewer is offering a perspective uncorrupted by
 * the implementer's narrative. If a future refactor accidentally leaks
 * either, this test fails loudly.
 */

import { describe, expect, it } from 'vitest';
import { assembleReviewerPayload } from '../../../src/harness/templates/review.js';
import type { HarnessTask } from '../../../src/storage/types.js';

const POISON_DECISION = 'PICKED OPTION A — DO NOT LEAK THIS';
const POISON_STAGELOG = 'STAGE LOG ENTRY — REVIEWER MUST NOT SEE';

function fixture(): HarnessTask {
  return {
    id: 't1',
    title: 'Test task',
    currentStage: 'implement',
    projectPath: '/p',
    intent: {
      background: 'bg',
      objective: 'obj',
      scopeIn: ['in1'],
      scopeOut: ['out1'],
    },
    structure: {
      entities: ['E1'],
      relations: ['E1 → E2'],
      plannedFiles: ['src/foo.ts'],
    },
    decisions: [POISON_DECISION],
    risks: [],
    relatedTasks: [],
    stageLog: [{ at: '2026-05-10T00:00:00Z', stage: 'implement', message: POISON_STAGELOG }],
    createdAt: '2026-05-10T00:00:00Z',
    updatedAt: '2026-05-10T00:00:00Z',
  };
}

describe('assembleReviewerPayload — information isolation', () => {
  it('does NOT include Decisions text', () => {
    const payload = assembleReviewerPayload({
      task: fixture(),
      diff: '+ const x = 1;',
      conventions: 'use const',
    });
    expect(payload).not.toContain(POISON_DECISION);
  });

  it('does NOT include Stage Log entries', () => {
    const payload = assembleReviewerPayload({
      task: fixture(),
      diff: '+ const x = 1;',
      conventions: 'use const',
    });
    expect(payload).not.toContain(POISON_STAGELOG);
  });

  it('DOES include Intent, Structure, diff, conventions', () => {
    const payload = assembleReviewerPayload({
      task: fixture(),
      diff: '+ const x = 1;',
      conventions: 'use const',
    });
    expect(payload).toContain('bg');
    expect(payload).toContain('obj');
    expect(payload).toContain('in1');
    expect(payload).toContain('E1 → E2');
    expect(payload).toContain('src/foo.ts');
    expect(payload).toContain('use const');
    expect(payload).toContain('const x = 1');
  });
});
