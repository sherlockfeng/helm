/**
 * Helm MCP server.
 *
 * Builds an `McpServer` registered with all helm tools. Phase 6 added the four
 * helm-specific tools (PROJECT_BLUEPRINT.md §13.2); Phase 7 adds the relay-
 * inherited workflow / roles / requirements / summarizer / doc-first tools
 * (§13.1) on top of the same registry.
 *
 * Tools that need an LLM client or embedder receive them via deps so tests can
 * substitute fakes without touching the SDK.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import * as z from 'zod';
import type Database from 'better-sqlite3';

import { getActiveChats } from './tools/get-active-chats.js';
import { bindToRemoteChannel } from './tools/bind-to-remote-channel.js';
import { listKnowledgeProviders } from './tools/list-knowledge-providers.js';
import { queryKnowledge } from './tools/query-knowledge.js';
import { makePseudoEmbedFn } from './embed.js';

import { KnowledgeProviderRegistry } from '../knowledge/types.js';
import { WorkflowEngine } from '../workflow/engine.js';
import { updateDocFirst } from '../workflow/doc-first.js';
import {
  getRole,
  listRoles,
  searchKnowledge,
  seedBuiltinRoles,
  trainRole,
} from '../roles/library.js';
import {
  confirmCapture,
  startCapture,
  submitAnswers,
  type ConfirmEdits,
} from '../requirements/capture.js';
import { formatRequirementForInjection, recallRequirements } from '../requirements/recall.js';
import { summarizeCampaign, type LlmClient } from '../summarizer/campaign.js';
import { getChunksForRole } from '../storage/repos/roles.js';
import { listCampaigns } from '../storage/repos/campaigns.js';
import { getRequirement } from '../storage/repos/requirements.js';

export interface McpServerDeps {
  db: Database.Database;
  knowledge?: KnowledgeProviderRegistry;
  /** LLM client used by summarize_campaign. When absent, the tool errors out. */
  llm?: LlmClient;
  /** Override the embedder used by train_role / search_knowledge (defaults to pseudo). */
  embedFn?: (text: string) => Promise<Float32Array>;
  /** Base directory for update_doc_first relative-path resolution. Defaults to process.cwd(). */
  docFirstBaseDir?: string;
}

export interface McpServerInfo {
  name: string;
  version: string;
}

const DEFAULT_SERVER_INFO: McpServerInfo = { name: 'helm', version: '0.1.0' };

function jsonResult(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function textResult(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text }], isError: true };
}

export function createMcpServer(
  deps: McpServerDeps,
  info: McpServerInfo = DEFAULT_SERVER_INFO,
): McpServer {
  const server = new McpServer(info);
  const knowledge = deps.knowledge ?? new KnowledgeProviderRegistry();
  const embedFn = deps.embedFn ?? makePseudoEmbedFn();
  const engine = new WorkflowEngine(deps.db);

  // Seed built-in roles eagerly so list_roles is never empty after a fresh boot.
  seedBuiltinRoles(deps.db);

  // ── Helm-specific tools (Phase 6) ───────────────────────────────────────

  server.registerTool('get_active_chats', {
    description: 'List all currently-active Cursor chats so the agent can discover sibling sessions.',
    inputSchema: {},
  }, async () => jsonResult(getActiveChats(deps.db)));

  server.registerTool('bind_to_remote_channel', {
    description:
      'Bind a host session to a remote channel thread. Provide externalThread+externalChat to bind immediately, '
      + 'or omit them to receive a pendingCode the user types into the channel.',
    inputSchema: {
      hostSessionId: z.string(),
      channel: z.string(),
      externalChat: z.string().optional(),
      externalThread: z.string().optional(),
      externalRoot: z.string().optional(),
    },
  }, async (input) => jsonResult(bindToRemoteChannel(deps.db, input)));

  server.registerTool('list_knowledge_providers', {
    description: 'List all KnowledgeProviders the agent can query, with their current healthcheck status.',
    inputSchema: {},
  }, async () => jsonResult(await listKnowledgeProviders(knowledge)));

  server.registerTool('query_knowledge', {
    description:
      'Search registered KnowledgeProviders. Aggregates and ranks snippets by score. '
      + 'When hostSessionId+cwd are provided, providers can use canHandle to scope themselves.',
    inputSchema: {
      query: z.string(),
      hostSessionId: z.string().optional(),
      cwd: z.string().optional(),
      filePath: z.string().optional(),
      providers: z.array(z.string()).optional(),
    },
  }, async (input) => jsonResult(await queryKnowledge(knowledge, input)));

  // ── Workflow (Phase 7) ──────────────────────────────────────────────────

  server.registerTool('init_workflow', {
    description: 'Start a new vibe coding campaign for a project. Creates the first cycle in product phase.',
    inputSchema: {
      projectPath: z.string(),
      title: z.string(),
      brief: z.string().optional(),
    },
  }, async ({ projectPath, title, brief }) => {
    const campaign = engine.initWorkflow(projectPath, title, brief);
    return jsonResult({
      campaignId: campaign.id, title: campaign.title, status: campaign.status,
      message: 'Workflow initialized. Product agent: call get_cycle_state() then create_tasks().',
    });
  });

  server.registerTool('get_cycle_state', {
    description: 'Get the current cycle state: status, tasks, and screenshots from the previous cycle.',
    inputSchema: { cycleId: z.string().optional(), campaignId: z.string().optional() },
  }, async ({ cycleId, campaignId }) => {
    const state = engine.getCycleState(cycleId, campaignId);
    if (!state) return textResult('No active cycle found.');
    return jsonResult(state);
  });

  server.registerTool('create_tasks', {
    description: 'Product agent: split the cycle into a structured list of dev + test tasks.',
    inputSchema: {
      cycleId: z.string(),
      tasks: z.array(z.object({
        role: z.enum(['dev', 'test']),
        title: z.string(),
        description: z.string().optional(),
        acceptance: z.array(z.string()).optional(),
        e2eScenarios: z.array(z.string()).optional(),
      })).min(1),
    },
  }, async ({ cycleId, tasks }) => {
    const created = engine.createTasks(cycleId, tasks);
    return jsonResult({ tasks: created.map((t) => ({ id: t.id, role: t.role, title: t.title })) });
  });

  server.registerTool('get_my_tasks', {
    description: 'Get pending/in-progress tasks for the calling role in a cycle.',
    inputSchema: { cycleId: z.string(), role: z.enum(['dev', 'test']) },
  }, async ({ cycleId, role }) => jsonResult(engine.getTasksForRole(cycleId, role)));

  server.registerTool('complete_task', {
    description: 'Mark a task completed. Dev tasks require a docAuditToken from update_doc_first().',
    inputSchema: {
      taskId: z.string(),
      result: z.string(),
      docAuditToken: z.string().optional(),
    },
  }, async ({ taskId, result, docAuditToken }) => {
    const task = engine.completeTask(taskId, { result, docAuditToken });
    return jsonResult({ id: task.id, status: task.status, result: task.result });
  });

  server.registerTool('add_task_comment', {
    description: 'Append a free-form comment to a task (questions, blockers, status notes).',
    inputSchema: { taskId: z.string(), comment: z.string() },
  }, async ({ taskId, comment }) => {
    const task = engine.addTaskComment(taskId, comment);
    return jsonResult({ id: task.id, comments: task.comments });
  });

  server.registerTool('create_bug_tasks', {
    description: 'Tester: file new bug tasks against the current cycle. Reverts cycle to dev phase.',
    inputSchema: {
      cycleId: z.string(),
      bugs: z.array(z.object({
        title: z.string(),
        description: z.string().optional(),
        expected: z.string().optional(),
        actual: z.string().optional(),
        screenshotDescription: z.string().optional(),
      })).min(1),
    },
  }, async ({ cycleId, bugs }) => {
    const tasks = engine.createBugTasks(cycleId, bugs);
    return jsonResult({ tasks: tasks.map((t) => ({ id: t.id, title: t.title })) });
  });

  server.registerTool('add_product_feedback', {
    description: 'Tester: surface design / UX feedback that becomes part of the next cycle product brief.',
    inputSchema: { cycleId: z.string(), feedback: z.string() },
  }, async ({ cycleId, feedback }) => {
    engine.addProductFeedback(cycleId, feedback);
    return textResult('Feedback recorded for the next product cycle.');
  });

  server.registerTool('complete_cycle', {
    description: 'Tester: mark the cycle complete. Auto-creates the next cycle in product phase.',
    inputSchema: {
      cycleId: z.string(),
      passRate: z.number().min(0).max(100).optional(),
      failedTests: z.array(z.string()).optional(),
      screenshots: z.array(z.object({
        filePath: z.string(),
        description: z.string(),
      })).optional(),
    },
  }, async ({ cycleId, passRate, failedTests, screenshots }) => {
    const cycle = engine.completeCycle(cycleId, {
      passRate, failedTests,
      screenshots: screenshots?.map((s) => ({ ...s, capturedAt: new Date().toISOString() })),
    });
    return jsonResult({ completedCycleId: cycle.id, cycleNum: cycle.cycleNum, nextCycle: cycle.cycleNum + 1 });
  });

  // ── Doc-first (Phase 7) ─────────────────────────────────────────────────

  server.registerTool('update_doc_first', {
    description: 'MANDATORY before any code change: write the doc and get back an auditToken for complete_task().',
    inputSchema: {
      filePath: z.string(),
      content: z.string(),
      taskId: z.string().optional(),
    },
  }, async ({ filePath, content, taskId }) => {
    try {
      const result = updateDocFirst(deps.db, {
        filePath, content, taskId, baseDir: deps.docFirstBaseDir,
      });
      return jsonResult({
        auditToken: result.auditToken,
        filePath: result.filePath,
        message: 'Doc written. Pass auditToken to complete_task().',
      });
    } catch (err) {
      return errorResult(`Failed to write doc: ${(err as Error).message}`);
    }
  });

  // ── Roles (Phase 7) ─────────────────────────────────────────────────────

  server.registerTool('list_roles', {
    description: 'List all available agent roles.',
    inputSchema: {},
  }, async () => {
    const roles = listRoles(deps.db);
    return jsonResult(roles.map((r) => ({
      id: r.id, name: r.name, isBuiltin: r.isBuiltin, docPath: r.docPath,
    })));
  });

  server.registerTool('get_role', {
    description: 'Get the full details and system prompt of an agent role.',
    inputSchema: { roleId: z.string() },
  }, async ({ roleId }) => jsonResult(getRole(deps.db, roleId)));

  server.registerTool('train_role', {
    description: 'Create or retrain a custom agent role by indexing documents into a knowledge base.',
    inputSchema: {
      roleId: z.string(),
      name: z.string(),
      documents: z.array(z.object({ filename: z.string(), content: z.string() })).min(1),
      baseSystemPrompt: z.string().optional(),
    },
  }, async ({ roleId, name, documents, baseSystemPrompt }) => {
    const role = await trainRole(deps.db, { roleId, name, documents, baseSystemPrompt, embedFn });
    return jsonResult({
      roleId: role.id, name: role.name,
      chunksIndexed: getChunksForRole(deps.db, role.id).length,
    });
  });

  server.registerTool('search_knowledge', {
    description: "RAG search against a role's knowledge base.",
    inputSchema: {
      roleId: z.string(),
      query: z.string(),
      topK: z.number().min(1).max(20).optional(),
    },
  }, async ({ roleId, query, topK }) => {
    const results = await searchKnowledge(deps.db, roleId, query, embedFn, topK ?? 5);
    return jsonResult(results);
  });

  // ── Requirements (Phase 7) ──────────────────────────────────────────────

  server.registerTool('capture_requirement', {
    description: `Capture / update a requirement from a chat session. Multi-turn:
1. action="start" + chatContext + name → returns clarifying questions
2. action="answer" + sessionId + answers → returns draft
3. action="confirm" + sessionId + optional edits → saves`,
    inputSchema: {
      action: z.enum(['start', 'answer', 'confirm']),
      name: z.string().optional(),
      chatContext: z.string().optional(),
      requirementId: z.string().optional(),
      sessionId: z.string().optional(),
      answers: z.record(z.string(), z.string()).optional(),
      edits: z.object({
        name: z.string().optional(),
        purpose: z.string().optional(),
        summary: z.string().optional(),
        relatedDocs: z.array(z.string()).optional(),
        changes: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
      }).optional(),
    },
  }, async ({ action, name, chatContext, requirementId, sessionId, answers, edits }) => {
    if (action === 'start') {
      if (!chatContext) return errorResult('chatContext is required for action=start');
      if (!name && !requirementId) return errorResult('name or requirementId is required for action=start');
      const result = startCapture(deps.db, chatContext, name ?? '', requirementId);
      return jsonResult({
        sessionId: result.sessionId,
        isUpdate: result.isUpdate,
        ...(result.existing ? { existing: { name: result.existing.name, purpose: result.existing.purpose, tags: result.existing.tags } } : {}),
        nextStep: 'Call capture_requirement(action="answer", sessionId, answers={...}).',
        questions: result.questions,
      });
    }

    if (action === 'answer') {
      if (!sessionId || !answers) return errorResult('sessionId and answers are required for action=answer');
      const result = submitAnswers(deps.db, sessionId, answers);
      return jsonResult({
        phase: result.phase,
        draft: result.draft,
        nextStep: 'Review draft. Call capture_requirement(action="confirm", sessionId, edits={...}).',
      });
    }

    if (action === 'confirm') {
      if (!sessionId) return errorResult('sessionId is required for action=confirm');
      const req = confirmCapture(deps.db, sessionId, edits as ConfirmEdits | undefined);
      return jsonResult({ requirementId: req.id, name: req.name, status: req.status });
    }

    return errorResult('Unknown action');
  });

  server.registerTool('recall_requirement', {
    description: 'Recall a saved requirement. Without args returns a list. id or name returns the formatted full context.',
    inputSchema: {
      id: z.string().optional(),
      name: z.string().optional(),
    },
  }, async ({ id, name }) => {
    if (id) {
      const req = getRequirement(deps.db, id);
      if (!req) return errorResult(`Requirement not found: ${id}`);
      return textResult(formatRequirementForInjection(req));
    }
    const list = recallRequirements(deps.db, name);
    if (list.length === 0) {
      return textResult(name ? `No requirements matching "${name}".` : 'No requirements saved yet.');
    }
    if (name && list.length === 1) {
      return textResult(formatRequirementForInjection(list[0]!));
    }
    return jsonResult(list.map((r) => ({
      id: r.id, name: r.name, status: r.status, updatedAt: r.updatedAt,
    })));
  });

  // ── Summarizer (Phase 7) ────────────────────────────────────────────────

  server.registerTool('list_campaigns', {
    description: 'List all campaigns.',
    inputSchema: {},
  }, async () => {
    return jsonResult(listCampaigns(deps.db).map((c) => ({
      id: c.id, title: c.title, status: c.status,
      brief: c.brief?.slice(0, 200), startedAt: c.startedAt,
    })));
  });

  server.registerTool('summarize_campaign', {
    description: 'Generate a cross-cycle campaign summary: why, key decisions, what was built, overall arc.',
    inputSchema: { campaignId: z.string() },
  }, async ({ campaignId }) => {
    if (!deps.llm) {
      return errorResult('summarize_campaign requires an LLM client; configure llm in McpServerDeps.');
    }
    const summary = await summarizeCampaign(deps.db, campaignId, { llm: deps.llm });
    return jsonResult(summary);
  });

  return server;
}

/** Connect the MCP server over stdio. Tests use InMemoryTransport instead. */
export async function startMcpServer(
  deps: McpServerDeps,
  transport: Transport = new StdioServerTransport(),
  info: McpServerInfo = DEFAULT_SERVER_INFO,
): Promise<{ server: McpServer; transport: Transport }> {
  const server = createMcpServer(deps, info);
  await server.connect(transport);
  return { server, transport };
}
