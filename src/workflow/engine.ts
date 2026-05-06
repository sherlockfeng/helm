/**
 * WorkflowEngine — orchestrates the campaign → cycle → task → bug feedback loop.
 *
 * Ported from relay/src/workflow/engine.ts. Storage access is now via the
 * function-style repos (storage/repos/campaigns.ts + doc-audit.ts) instead of
 * relay's class-based AgentForgeDB.
 *
 * Phase transitions:
 *   pending → product → dev → test → completed → (next cycle's pending)
 *   product calls create_tasks → status=dev
 *   all dev tasks completed   → status=test
 *   tester calls complete_cycle → status=completed + auto-create next cycle in product
 *   tester calls create_bug_tasks → status reverts to dev
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  getActiveCycle,
  getCampaign,
  getCycle,
  getTask,
  insertCampaign,
  insertCycle,
  insertTask,
  listTasks,
  updateCampaign,
  updateCycle,
  updateTask,
} from '../storage/repos/campaigns.js';
import { getDocAudit } from '../storage/repos/doc-audit.js';
import type { Campaign, Cycle, Screenshot, Task } from '../storage/types.js';
import type {
  BugInput,
  CompleteCycleInput,
  CompleteTaskInput,
  CreateTaskInput,
} from './types.js';

export interface WorkflowEngineOptions {
  /**
   * Returns whether doc-first enforcement is on. Called once per
   * completeTask() invocation so a Settings change takes effect on
   * the next task completion without restarting the engine.
   * Defaults to always-true (matches §12.3 default).
   */
  isDocFirstEnforced?: () => boolean;
}

export class WorkflowEngine {
  private readonly isDocFirstEnforced: () => boolean;

  constructor(private readonly db: Database.Database, options: WorkflowEngineOptions = {}) {
    this.isDocFirstEnforced = options.isDocFirstEnforced ?? (() => true);
  }

  initWorkflow(projectPath: string, title: string, brief?: string): Campaign {
    const now = new Date().toISOString();
    const campaign: Campaign = {
      id: randomUUID(),
      projectPath,
      title,
      brief,
      status: 'active',
      startedAt: now,
    };
    insertCampaign(this.db, campaign);

    const cycle = this.createCycle(campaign.id, 1);
    updateCycle(this.db, cycle.id, { status: 'product', startedAt: now });
    return campaign;
  }

  private createCycle(campaignId: string, cycleNum: number): Cycle {
    const cycle: Cycle = { id: randomUUID(), campaignId, cycleNum, status: 'pending' };
    insertCycle(this.db, cycle);
    return cycle;
  }

  getCycleState(cycleId?: string, campaignId?: string): { cycle: Cycle; tasks: Task[] } | null {
    let cycle: Cycle | undefined;
    if (cycleId) cycle = getCycle(this.db, cycleId);
    else if (campaignId) cycle = getActiveCycle(this.db, campaignId);

    if (!cycle) return null;
    return { cycle, tasks: listTasks(this.db, cycle.id) };
  }

  createTasks(cycleId: string, taskInputs: CreateTaskInput[]): Task[] {
    const cycle = getCycle(this.db, cycleId);
    if (!cycle) throw new Error(`Cycle not found: ${cycleId}`);
    if (cycle.status !== 'product') {
      throw new Error(`Cannot create tasks in cycle status "${cycle.status}" — must be "product"`);
    }

    const now = new Date().toISOString();
    const tasks: Task[] = [];
    for (const input of taskInputs) {
      const task: Task = {
        id: randomUUID(),
        cycleId,
        role: input.role,
        title: input.title,
        description: input.description,
        acceptance: input.acceptance,
        e2eScenarios: input.e2eScenarios,
        status: 'pending',
        createdAt: now,
      };
      insertTask(this.db, task);
      tasks.push(task);
    }

    updateCycle(this.db, cycleId, { status: 'dev' });
    return tasks;
  }

  getTasksForRole(cycleId: string, role: 'dev' | 'test'): Task[] {
    const cycle = getCycle(this.db, cycleId);
    if (!cycle) throw new Error(`Cycle not found: ${cycleId}`);
    return listTasks(this.db, cycleId, role);
  }

  completeTask(taskId: string, input: CompleteTaskInput): Task {
    const task = getTask(this.db, taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    // §12.3 doc-first toggle. When `enforce` is off (config flag), dev tasks
    // can complete without a docAuditToken. Token, if supplied, is still
    // validated against the audit log so a stale token doesn't slip through.
    const docFirstEnforced = this.isDocFirstEnforced();
    if (task.role === 'dev' && docFirstEnforced && !input.docAuditToken) {
      throw new Error('Developer tasks require a docAuditToken from update_doc_first()');
    }

    if (input.docAuditToken) {
      const audit = getDocAudit(this.db, input.docAuditToken);
      if (!audit) throw new Error(`Invalid docAuditToken: ${input.docAuditToken}`);
    }

    const now = new Date().toISOString();
    updateTask(this.db, taskId, {
      status: 'completed',
      result: input.result,
      docAuditToken: input.docAuditToken,
      completedAt: now,
    });

    // Check whether all dev tasks for this cycle are now completed → advance to test.
    const cycle = getCycle(this.db, task.cycleId)!;
    if (cycle.status === 'dev') {
      const remaining = listTasks(this.db, task.cycleId, 'dev')
        .filter((t) => t.id !== taskId && t.status !== 'completed');
      if (remaining.length === 0) {
        updateCycle(this.db, cycle.id, { status: 'test' });
      }
    }

    return getTask(this.db, taskId)!;
  }

  addTaskComment(taskId: string, comment: string): Task {
    const task = getTask(this.db, taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const comments = [...(task.comments ?? []), comment];
    updateTask(this.db, taskId, { comments });
    return getTask(this.db, taskId)!;
  }

  createBugTasks(cycleId: string, bugs: BugInput[]): Task[] {
    const cycle = getCycle(this.db, cycleId);
    if (!cycle) throw new Error(`Cycle not found: ${cycleId}`);

    const now = new Date().toISOString();
    const tasks: Task[] = [];
    for (const bug of bugs) {
      const description = [
        bug.description,
        bug.expected ? `Expected: ${bug.expected}` : null,
        bug.actual ? `Actual: ${bug.actual}` : null,
        bug.screenshotDescription ? `Screenshot: ${bug.screenshotDescription}` : null,
      ].filter(Boolean).join('\n');

      const task: Task = {
        id: randomUUID(),
        cycleId,
        role: 'dev',
        title: `[BUG] ${bug.title}`,
        description: description || undefined,
        acceptance: bug.expected ? [bug.expected] : undefined,
        status: 'pending',
        createdAt: now,
      };
      insertTask(this.db, task);
      tasks.push(task);
    }

    // Bug fixes always send the cycle back to dev phase.
    updateCycle(this.db, cycleId, { status: 'dev' });
    return tasks;
  }

  addProductFeedback(cycleId: string, feedback: string): void {
    const cycle = getCycle(this.db, cycleId);
    if (!cycle) throw new Error(`Cycle not found: ${cycleId}`);
    const existing = cycle.productBrief ?? '';
    updateCycle(this.db, cycleId, {
      productBrief: existing
        ? `${existing}\n\n## Test Feedback\n${feedback}`
        : `## Test Feedback\n${feedback}`,
    });
  }

  completeCycle(cycleId: string, input: CompleteCycleInput): Cycle {
    const cycle = getCycle(this.db, cycleId);
    if (!cycle) throw new Error(`Cycle not found: ${cycleId}`);
    if (cycle.status !== 'test') {
      throw new Error(`Cannot complete cycle in status "${cycle.status}" — must be "test"`);
    }

    const now = new Date().toISOString();
    const screenshots = input.screenshots ?? [];
    updateCycle(this.db, cycleId, { status: 'completed', screenshots, completedAt: now });

    // Auto-start the next cycle so the loop keeps moving.
    const campaign = getCampaign(this.db, cycle.campaignId)!;
    if (campaign.status === 'active') {
      const next = this.createCycle(campaign.id, cycle.cycleNum + 1);
      updateCycle(this.db, next.id, { status: 'product', startedAt: now });
    }

    return getCycle(this.db, cycleId)!;
  }

  captureScreenshot(cycleId: string, filePath: string, description: string): void {
    const cycle = getCycle(this.db, cycleId);
    if (!cycle) throw new Error(`Cycle not found: ${cycleId}`);
    const screenshots: Screenshot[] = [
      ...(cycle.screenshots ?? []),
      { filePath, description, capturedAt: new Date().toISOString() },
    ];
    updateCycle(this.db, cycleId, { screenshots });
  }

  completeCampaign(campaignId: string, summary?: string): Campaign {
    const campaign = getCampaign(this.db, campaignId);
    if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);
    updateCampaign(this.db, campaignId, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      summary,
    });
    return getCampaign(this.db, campaignId)!;
  }
}
