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
import { startRelayChatSession } from './tools/start-relay-chat-session.js';
import { makePseudoEmbedFn } from './embed.js';
import type { CursorAgentSpawner } from '../spawner/cursor-spawner.js';

import { KnowledgeProviderRegistry } from '../knowledge/types.js';
import { WorkflowEngine } from '../workflow/engine.js';
import { updateDocFirst } from '../workflow/doc-first.js';
import {
  getRole,
  listRoles,
  searchKnowledge,
  seedBuiltinRoles,
  trainRole,
  updateRole,
} from '../roles/library.js';
import {
  confirmCapture,
  startCapture,
  submitAnswers,
  type ConfirmEdits,
} from '../requirements/capture.js';
import { formatRequirementForInjection, recallRequirements } from '../requirements/recall.js';
import { summarizeCampaign, type LlmClient } from '../summarizer/campaign.js';
import { deleteChunkById, getChunksForRole } from '../storage/repos/roles.js';
import { listCampaigns } from '../storage/repos/campaigns.js';
import { getRequirement } from '../storage/repos/requirements.js';
import {
  advanceStage,
  appendStageLog,
  archiveTask,
  createTask,
  getTask as getHarnessTaskCore,
  listTasks as listHarnessTasksCore,
  pushReviewToImplementChat,
  reindexTask,
  searchArchive,
  updateField,
  type UpdateFieldName,
  type UpdateFieldValue,
} from '../harness/library.js';
import { getReview as getHarnessReviewRow, listReviewsForTask } from '../storage/repos/harness.js';
import { runReview, type RunReviewDeps } from '../harness/review-runner.js';
import type { HarnessStage } from '../storage/types.js';

export interface McpServerDeps {
  db: Database.Database;
  knowledge?: KnowledgeProviderRegistry;
  /** LLM client used by summarize_campaign. When absent, the tool errors out. */
  llm?: LlmClient;
  /**
   * Spawner used by start_relay_chat_session (Phase 26). When absent (e.g.
   * cloud mode without CURSOR_API_KEY), the tool errors out so the calling
   * agent gets an actionable message.
   */
  spawner?: CursorAgentSpawner;
  /** Override the embedder used by train_role / search_knowledge (defaults to pseudo). */
  embedFn?: (text: string) => Promise<Float32Array>;
  /** Base directory for update_doc_first relative-path resolution. Defaults to process.cwd(). */
  docFirstBaseDir?: string;
  /**
   * Phase 54: Lark channel for the `send_lark_attachment` MCP tool. When
   * absent (no Lark config / Lark disabled), the tool errors out with an
   * actionable message instead of silently dropping the upload.
   */
  larkChannel?: import('../channel/lark/adapter.js').LarkChannel;
  /**
   * Phase 59: lark-cli runner for the `read_lark_doc` MCP tool. Lets any
   * Cursor agent connected to helm's MCP SSE pull a Lark/Feishu doc into
   * its context — same backing tool the Phase 58 role-trainer uses, just
   * exposed through the MCP surface so non-trainer chats benefit too.
   */
  larkCli?: import('../channel/lark/cli-runner.js').LarkCliRunner;
  /**
   * Phase 67: returns the global Harness conventions text. helm Settings
   * stores the string; the orchestrator wires this getter so reviewer
   * subprocesses always read the latest. When absent, conventions are
   * empty (reviewer is told "no conventions configured").
   */
  harnessConventions?: () => Promise<string> | string;
  /**
   * Phase 67: optional override for the review subprocess runner. Tests
   * substitute a fake (e.g. a deterministic stub) so they don't shell out
   * to `claude`.
   */
  runReviewOverride?: typeof runReview;
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
    description:
      'Create OR full-replace a custom agent role with the given documents. '
      + 'WARNING: if the role already exists, ALL existing knowledge chunks are deleted '
      + 'and replaced with these. For incremental updates (append knowledge / refine the '
      + 'system prompt without wiping), use `update_role` instead.',
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

  server.registerTool('update_role', {
    description:
      'Incrementally update an existing helm role WITHOUT wiping its existing knowledge. '
      + 'Use this when the user says e.g. "add this new TCE rollback runbook to the TCE 专家 role" '
      + 'or "fix the system prompt to mention X". `appendDocuments` chunks new docs and INSERTs '
      + 'alongside existing chunks; `baseSystemPrompt` / `name` overwrite those single fields. '
      + 'Pass at least one of {appendDocuments, baseSystemPrompt, name}. Errors when roleId '
      + 'is unknown — for new roles, use `train_role`. '
      + '\n\n'
      + 'CONFLICT FLOW (Phase 66): when `appendDocuments` is provided, helm first compares '
      + 'each new chunk against existing chunks via cosine similarity. If any pair scores ≥ 0.85, '
      + 'the tool returns `{ status: "conflicts", conflicts: [...] }` WITHOUT writing anything. '
      + 'Each conflict carries `existingChunkId`, `existingChunkText`, `newChunkText`, and `similarity`. '
      + 'You MUST surface these to the user and let them decide per conflict: '
      + '(a) keep both — re-call this tool with `force: true`; '
      + '(b) replace the old version — call `delete_role_chunk` with each `existingChunkId` '
      + 'the user wants to drop, then re-call this tool with `force: true`. '
      + 'No conflicts → tool writes immediately and returns `{ status: "applied", ... }`.',
    inputSchema: {
      roleId: z.string(),
      name: z.string().optional(),
      baseSystemPrompt: z.string().optional(),
      appendDocuments: z
        .array(z.object({ filename: z.string(), content: z.string() }))
        .optional(),
      force: z.boolean().optional().describe(
        'Skip conflict detection and append unconditionally. Pass true only after the '
        + 'user has reviewed any conflicts surfaced by a prior call.',
      ),
    },
  }, async ({ roleId, name, baseSystemPrompt, appendDocuments, force }) => {
    try {
      const result = await updateRole(deps.db, {
        roleId,
        ...(name !== undefined ? { name } : {}),
        ...(baseSystemPrompt !== undefined ? { baseSystemPrompt } : {}),
        ...(appendDocuments !== undefined ? { appendDocuments } : {}),
        ...(force !== undefined ? { force } : {}),
        embedFn,
      });
      if (result.status === 'conflicts') {
        return jsonResult({
          status: 'conflicts',
          roleId,
          conflicts: result.conflicts,
          nextStep:
            'Show each conflict to the user. For each, ask "keep both" (re-call '
            + 'update_role with force=true) or "replace old" (delete_role_chunk on '
            + 'existingChunkId, then update_role with force=true).',
        });
      }
      return jsonResult({
        status: 'applied',
        roleId: result.role.id,
        name: result.role.name,
        chunksAdded: result.chunksAdded,
        totalChunks: getChunksForRole(deps.db, result.role.id).length,
      });
    } catch (err) {
      return errorResult((err as Error).message);
    }
  });

  server.registerTool('delete_role_chunk', {
    description:
      'Phase 66: delete a single knowledge chunk from a role by id. The id comes '
      + 'from a prior `update_role` conflict report (each conflict carries '
      + '`existingChunkId`). Use this only when the user has explicitly chosen to '
      + 'replace the old version with the incoming one — after deleting, re-call '
      + '`update_role` with `force: true` to land the new chunks.',
    inputSchema: {
      chunkId: z.string(),
    },
  }, async ({ chunkId }) => {
    const removed = deleteChunkById(deps.db, chunkId);
    return jsonResult({ chunkId, removed });
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

  // ── Spawner (Phase 26) ──────────────────────────────────────────────────

  server.registerTool('start_relay_chat_session', {
    description:
      'Spawn a fresh Cursor agent against a project directory. Returns the new '
      + 'agentId so the caller (or the user via Active Chats) can address it. '
      + 'When `prompt` is provided, the agent starts working immediately; '
      + 'otherwise it stays idle and the caller messages it later via the SDK.',
    inputSchema: {
      projectPath: z.string(),
      prompt: z.string().optional(),
      name: z.string().optional(),
      modelId: z.string().optional(),
    },
  }, async ({ projectPath, prompt, name, modelId }) => {
    if (!deps.spawner) {
      return errorResult(
        'start_relay_chat_session requires a Cursor spawner. In cloud mode '
        + 'this means CURSOR_API_KEY is missing; in local mode the Cursor '
        + 'app must be installed and signed in.',
      );
    }
    try {
      const result = await startRelayChatSession(deps.spawner, {
        projectPath, prompt, name, modelId,
      });
      return jsonResult(result);
    } catch (err) {
      return errorResult(`Failed to spawn agent: ${(err as Error).message}`);
    }
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

  // ── Lark attachments (Phase 54) ─────────────────────────────────────────

  server.registerTool('send_lark_attachment', {
    description:
      'Post a local image or file to the Lark thread bound to the given chat. '
      + 'Uses the chat\'s active Lark binding — fail with an actionable error if the chat '
      + 'isn\'t bound. Image messages with a caption send the caption as a leading text reply '
      + 'so reviewers see context before opening the asset.',
    inputSchema: {
      hostSessionId: z.string().describe('The Cursor chat that owns the Lark binding.'),
      filePath: z.string().describe('Absolute path on the helm host to the asset to upload.'),
      kind: z.enum(['image', 'file']).default('image'),
      caption: z.string().optional().describe('Optional one-line description posted alongside the asset.'),
    },
  }, async ({ hostSessionId, filePath, kind, caption }) => {
    if (!deps.larkChannel) {
      return errorResult(
        'send_lark_attachment requires Lark to be configured + started. '
        + 'Enable lark in `~/.helm/config.json` and bind the chat to a Lark thread first.',
      );
    }
    // Look up the chat's active Lark binding. Same lookup the orchestrator's
    // requireApproval gate uses, so behavior is consistent: chats without a
    // Lark binding can't post.
    const { listBindingsForSession } = await import('../storage/repos/channel-bindings.js');
    const bindings = listBindingsForSession(deps.db, hostSessionId)
      .filter((b) => b.channel === 'lark');
    if (bindings.length === 0) {
      return errorResult(
        `No Lark binding for hostSessionId=${hostSessionId}. Bind via @bot bind first.`,
      );
    }
    const binding = bindings[0]!;
    try {
      await deps.larkChannel.sendAttachment(
        binding,
        { filePath, kind, ...(caption ? { caption } : {}) },
      );
      return jsonResult({
        ok: true,
        bindingId: binding.id,
        kind,
        filePath,
        captionSent: Boolean(caption),
      });
    } catch (err) {
      return errorResult(`Failed to upload ${kind} to Lark: ${(err as Error).message}`);
    }
  });

  // ── Lark doc reader (Phase 59) ──────────────────────────────────────────

  server.registerTool('read_lark_doc', {
    description:
      'Read the content of a Lark / Feishu document. Accepts a full URL '
      + '(wiki or docx) or a bare doc token. Returns markdown — long docs '
      + 'are truncated at 16KB. Use this when the user references a Lark '
      + 'doc and you need its content to inform your reply.',
    inputSchema: {
      url_or_token: z.string().describe(
        'Full URL like https://your-org.feishu.cn/wiki/xxxx or '
        + 'https://your-org.feishu.cn/docx/xxxx, or a bare token.',
      ),
    },
  }, async ({ url_or_token }) => {
    if (!deps.larkCli) {
      return errorResult(
        'read_lark_doc requires lark-cli to be configured. Set lark.cliCommand in helm Settings.',
      );
    }
    try {
      // Phase 60b: inlined here (used to live in src/llm/tools/lark-doc.ts).
      // Same shell args + truncation semantics as before, just no longer
      // wrapped in the deleted ToolDef abstraction.
      const args = [
        'docs', '+fetch',
        '--api-version', 'v2',
        '--doc', url_or_token,
        '--doc-format', 'markdown',
      ];
      const result = await deps.larkCli.run(args, { timeoutMs: 30_000 });
      if (result.exitCode !== 0) {
        const detail = (result.stderr || result.stdout).trim();
        return errorResult(
          `lark-cli docs +fetch failed (code=${result.exitCode}): ${detail || '(no output)'}`,
        );
      }
      const MAX = 16 * 1024;
      const body = result.stdout.length > MAX
        ? result.stdout.slice(0, MAX) + `\n\n…[truncated, doc was ${result.stdout.length} bytes]`
        : result.stdout;
      return textResult(body);
    } catch (err) {
      return errorResult(`read_lark_doc failed: ${(err as Error).message}`);
    }
  });

  // ── Harness toolchain (Phase 67) ────────────────────────────────────────
  //
  // These ten tools drive the on-disk Harness workflow scaffold. Source of
  // truth lives in `.harness/` files in the user's project; helm's DB is
  // the index. Stages are forward-monotonic — `harness_advance_stage`
  // refuses to go backwards.
  //
  // The reviewer chokepoint is `harness_run_review`, which spawns a fresh
  // claude subprocess with Intent + Structure + diff + global conventions
  // ONLY. Decisions / Stage Log are deliberately excluded (information
  // isolation). See assembleReviewerPayload in templates/review.ts.

  server.registerTool('harness_create_task', {
    description:
      'Create a new Harness task. Creates `.harness/tasks/<taskId>/task.md` on disk + a DB index row, '
      + 'and runs an exact-match archive lookup over the intent text to populate Related Tasks. '
      + 'Returns the new task plus any related archive cards found.',
    inputSchema: {
      taskId: z.string().describe('YYYY-MM-DD-<kebab-slug> format. Caller computes it.'),
      title: z.string(),
      projectPath: z.string().describe('Absolute path to the user\'s project root.'),
      hostSessionId: z.string().optional().describe('Cursor host session this task is bound to (optional at create-time).'),
      intent: z.object({
        background: z.string().optional(),
        objective: z.string().optional(),
        scopeIn: z.array(z.string()).optional(),
        scopeOut: z.array(z.string()).optional(),
      }).optional(),
    },
  }, async ({ taskId, title, projectPath, hostSessionId, intent }) => {
    try {
      const intentInput = intent
        ? {
            ...(intent.background !== undefined ? { background: intent.background } : {}),
            ...(intent.objective !== undefined ? { objective: intent.objective } : {}),
            ...(intent.scopeIn !== undefined ? { scopeIn: intent.scopeIn } : {}),
            ...(intent.scopeOut !== undefined ? { scopeOut: intent.scopeOut } : {}),
          }
        : undefined;
      const result = createTask(deps.db, {
        taskId, title, projectPath,
        ...(hostSessionId ? { hostSessionId } : {}),
        ...(intentInput ? { intent: intentInput } : {}),
      });
      return jsonResult({
        taskId: result.task.id,
        currentStage: result.task.currentStage,
        relatedFound: result.relatedFound,
        message: result.relatedFound.length
          ? `Created. Found ${result.relatedFound.length} related archive(s) — surfaced in task.md → Related Tasks.`
          : 'Created. No related archives.',
      });
    } catch (err) {
      return errorResult((err as Error).message);
    }
  });

  server.registerTool('harness_get_task', {
    description: 'Read the full Harness task state (Intent / Structure / Decisions / Risks / Stage Log).',
    inputSchema: { taskId: z.string() },
  }, async ({ taskId }) => {
    try { return jsonResult(getHarnessTaskCore(deps.db, taskId)); }
    catch (err) { return errorResult((err as Error).message); }
  });

  server.registerTool('harness_list_tasks', {
    description: 'List Harness tasks. Filter by projectPath when provided; returns most-recently-created first.',
    inputSchema: { projectPath: z.string().optional() },
  }, async ({ projectPath }) => {
    return jsonResult(listHarnessTasksCore(deps.db, projectPath ? { projectPath } : {}));
  });

  server.registerTool('harness_update_field', {
    description:
      'Update a single section of task.md: title, intent, structure, decisions, risks, planned_files, host_session_id, related_tasks. '
      + 'For intent/structure, partial updates merge with existing values. For list-typed fields, value REPLACES the whole list — '
      + 'callers wanting to append should read first then submit the appended list.',
    inputSchema: {
      taskId: z.string(),
      field: z.enum([
        'title', 'intent', 'structure', 'decisions', 'risks',
        'planned_files', 'host_session_id', 'related_tasks',
      ]),
      // value is intentionally untyped (z.unknown) — the library's applyFieldUpdate
      // does the per-field validation. Surfacing all per-field shapes here would
      // bloat the schema without adding safety.
      value: z.unknown(),
    },
  }, async ({ taskId, field, value }) => {
    try {
      const updated = updateField(
        deps.db, taskId,
        field as UpdateFieldName,
        value as UpdateFieldValue,
      );
      return jsonResult({ taskId: updated.id, field, currentStage: updated.currentStage });
    } catch (err) {
      return errorResult((err as Error).message);
    }
  });

  server.registerTool('harness_append_stage_log', {
    description: 'Append a one-line entry to the task\'s Stage Log. Use after every substantive turn.',
    inputSchema: { taskId: z.string(), message: z.string() },
  }, async ({ taskId, message }) => {
    try {
      const updated = appendStageLog(deps.db, taskId, message);
      return jsonResult({ taskId: updated.id, entries: updated.stageLog.length });
    } catch (err) {
      return errorResult((err as Error).message);
    }
  });

  server.registerTool('harness_advance_stage', {
    description:
      'Advance the Harness task forward one stage. Forward-only; refuses any backwards move. '
      + 'When transitioning to "implement", `implementBaseCommit` is REQUIRED (caller passes the current git HEAD). '
      + 'Allowed transitions: new_feature → implement → archived.',
    inputSchema: {
      taskId: z.string(),
      toStage: z.enum(['implement', 'archived']),
      implementBaseCommit: z.string().optional().describe('Required for toStage="implement". The current git HEAD SHA at the user\'s project root.'),
      message: z.string().optional(),
    },
  }, async ({ taskId, toStage, implementBaseCommit, message }) => {
    try {
      const updated = advanceStage(deps.db, {
        taskId,
        toStage: toStage as HarnessStage,
        ...(implementBaseCommit ? { implementBaseCommit } : {}),
        ...(message ? { message } : {}),
      });
      return jsonResult({
        taskId: updated.id,
        currentStage: updated.currentStage,
        implementBaseCommit: updated.implementBaseCommit,
      });
    } catch (err) {
      return errorResult((err as Error).message);
    }
  });

  server.registerTool('harness_run_review', {
    description:
      'Spawn a fresh `claude -p` reviewer subprocess for the task. The reviewer sees Intent + Structure + diff + global conventions ONLY '
      + '(Decisions and Stage Log are deliberately excluded — information isolation contract). '
      + 'Returns the review row with status + reportText. Diff = HEAD vs implement_base_commit recorded when the task entered implement.',
    inputSchema: { taskId: z.string() },
  }, async ({ taskId }) => {
    try {
      const reviewDeps: RunReviewDeps = {
        db: deps.db,
        ...(deps.harnessConventions
          ? { getConventions: async () => String(await deps.harnessConventions!()) }
          : {}),
      };
      const review = await (deps.runReviewOverride ?? runReview)(reviewDeps, { taskId });
      return jsonResult({
        reviewId: review.id,
        status: review.status,
        reportText: review.reportText,
        baseCommit: review.baseCommit,
        headCommit: review.headCommit,
        error: review.error,
      });
    } catch (err) {
      return errorResult((err as Error).message);
    }
  });

  server.registerTool('harness_push_review_to_implement', {
    description:
      'Push a completed review report into the implement chat\'s queue. The report lands in the agent\'s context the next time it stops to think (host_stop long-poll). Idempotent: pushing the same review twice enqueues two copies.',
    inputSchema: {
      taskId: z.string(),
      reviewId: z.string(),
    },
  }, async ({ taskId, reviewId }) => {
    try {
      const result = pushReviewToImplementChat(deps.db, { taskId, reviewId });
      return jsonResult(result);
    } catch (err) {
      return errorResult((err as Error).message);
    }
  });

  server.registerTool('harness_get_review_report', {
    description: 'Fetch a previously-spawned review by id. Returns the report text + status.',
    inputSchema: { reviewId: z.string() },
  }, async ({ reviewId }) => {
    const r = getHarnessReviewRow(deps.db, reviewId);
    if (!r) return errorResult(`Review not found: ${reviewId}`);
    return jsonResult(r);
  });

  server.registerTool('harness_list_reviews', {
    description: 'List all review attempts for a task, newest first.',
    inputSchema: { taskId: z.string() },
  }, async ({ taskId }) => {
    return jsonResult(listReviewsForTask(deps.db, taskId));
  });

  server.registerTool('harness_archive', {
    description:
      'Archive a Harness task: writes `.harness/archive/<taskId>.md` and inserts the structured index row. '
      + 'Archive cards exist for exact-match retrieval — fill entities / files_touched / modules thoughtfully so future tasks find this one. '
      + 'Idempotent: re-archiving regenerates the card from the latest input.',
    inputSchema: {
      taskId: z.string(),
      oneLiner: z.string(),
      entities: z.array(z.string()).optional(),
      filesTouched: z.array(z.string()).optional(),
      modules: z.array(z.string()).optional(),
      patterns: z.array(z.string()).optional(),
      downstream: z.array(z.string()).optional(),
      rulesApplied: z.array(z.string()).optional(),
    },
  }, async ({ taskId, oneLiner, entities, filesTouched, modules, patterns, downstream, rulesApplied }) => {
    try {
      const result = archiveTask(deps.db, {
        taskId, oneLiner,
        ...(entities !== undefined ? { entities } : {}),
        ...(filesTouched !== undefined ? { filesTouched } : {}),
        ...(modules !== undefined ? { modules } : {}),
        ...(patterns !== undefined ? { patterns } : {}),
        ...(downstream !== undefined ? { downstream } : {}),
        ...(rulesApplied !== undefined ? { rulesApplied } : {}),
      });
      return jsonResult({
        taskId: result.task.id,
        currentStage: result.task.currentStage,
        archiveCard: result.card,
      });
    } catch (err) {
      return errorResult((err as Error).message);
    }
  });

  server.registerTool('harness_search_archive', {
    description:
      'Token-based exact-match retrieval over Harness archive cards. ANY of the supplied tokens '
      + 'matching ANY of {one_liner, entities, files_touched, modules, patterns, downstream, rules_applied} '
      + 'counts as a hit. Optionally scope to a single project_path. Returns a list of cards, most recent first.',
    inputSchema: {
      tokens: z.array(z.string()).min(1),
      projectPath: z.string().optional(),
      limit: z.number().min(1).max(50).optional(),
    },
  }, async ({ tokens, projectPath, limit }) => {
    return jsonResult(searchArchive(deps.db, {
      tokens,
      ...(projectPath ? { projectPath } : {}),
      ...(limit !== undefined ? { limit } : {}),
    }));
  });

  server.registerTool('harness_reindex_task', {
    description:
      'Re-read `.harness/tasks/<taskId>/task.md` from disk and update helm\'s DB index. '
      + 'Use after the user hand-edits task.md outside helm\'s tools. Returns null when the file is missing.',
    inputSchema: {
      taskId: z.string(),
      projectPath: z.string(),
    },
  }, async ({ taskId, projectPath }) => {
    const t = reindexTask(deps.db, projectPath, taskId);
    if (!t) return errorResult(`task.md not found at ${projectPath}/.harness/tasks/${taskId}/task.md`);
    return jsonResult({ taskId: t.id, currentStage: t.currentStage });
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
