/**
 * Markdown round-trip for task.md (Phase 67).
 *
 * The on-disk format is the source of truth, so we must be able to write it
 * out and read it back without losing fields the renderer / MCP tools care
 * about. Hand-edits beyond what we serialize fall back to defaults — that's
 * by design (see file-io.ts's parseTask doc).
 */

import { describe, expect, it } from 'vitest';
import { parseTask, serializeTask } from '../../../src/harness/file-io.js';
import type { HarnessTask } from '../../../src/storage/types.js';

function makeTask(overrides: Partial<HarnessTask> = {}): HarnessTask {
  const base: HarnessTask = {
    id: '2026-05-10-rt',
    title: 'Round trip task',
    currentStage: 'implement',
    projectPath: '/tmp/proj',
    hostSessionId: 'hs1',
    intent: {
      background: 'because',
      objective: 'do the thing',
      scopeIn: ['this', 'that'],
      scopeOut: ['the other'],
    },
    structure: {
      entities: ['Foo'],
      relations: ['Foo → Bar'],
      plannedFiles: ['src/foo.ts — owns Foo', 'src/bar.ts — owns Bar'],
    },
    decisions: ['picked option A because Y'],
    risks: ['could be slow'],
    relatedTasks: [{ taskId: '2026-04-01-prior', oneLiner: 'older work', archivePath: '.harness/archive/2026-04-01-prior.md' }],
    stageLog: [
      { at: '2026-05-10T00:00:00.000Z', stage: 'new_feature', message: 'created' },
      { at: '2026-05-10T01:00:00.000Z', stage: 'implement', message: 'transitioned' },
    ],
    implementBaseCommit: 'a'.repeat(40),
    createdAt: '2026-05-10T00:00:00.000Z',
    updatedAt: '2026-05-10T01:00:00.000Z',
  };
  return { ...base, ...overrides };
}

describe('serializeTask + parseTask round-trip', () => {
  it('preserves Intent + Structure + lists across one round trip', () => {
    const original = makeTask();
    const md = serializeTask(original);
    const parsed = parseTask(md, { id: original.id, projectPath: original.projectPath });

    expect(parsed.id).toBe(original.id);
    expect(parsed.title).toBe(original.title);
    expect(parsed.currentStage).toBe(original.currentStage);
    expect(parsed.projectPath).toBe(original.projectPath);
    expect(parsed.hostSessionId).toBe(original.hostSessionId);
    expect(parsed.implementBaseCommit).toBe(original.implementBaseCommit);
    expect(parsed.intent).toEqual(original.intent);
    expect(parsed.structure).toEqual(original.structure);
    expect(parsed.decisions).toEqual(original.decisions);
    expect(parsed.risks).toEqual(original.risks);
    expect(parsed.relatedTasks).toEqual(original.relatedTasks);
    // Stage log: at + stage + message preserved
    expect(parsed.stageLog).toHaveLength(original.stageLog.length);
    expect(parsed.stageLog[0]).toMatchObject({ stage: 'new_feature', message: 'created' });
  });

  it('omitting Intent / Structure produces a parseable but empty doc', () => {
    const t = makeTask();
    delete t.intent; delete t.structure;
    const md = serializeTask(t);
    const parsed = parseTask(md, { id: t.id, projectPath: t.projectPath });
    // serializer writes "_(empty)_" placeholders; parser must not surface them as values
    expect(parsed.intent?.background ?? '').not.toContain('_(empty)_');
    expect(parsed.structure?.entities ?? []).toEqual([]);
  });
});
