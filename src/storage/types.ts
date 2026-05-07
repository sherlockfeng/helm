// ── Relay-origin tables ────────────────────────────────────────────────────

export interface Campaign {
  id: string;
  projectPath: string;
  title: string;
  brief?: string;
  status: 'active' | 'completed';
  startedAt: string;
  completedAt?: string;
  summary?: string;
}

export interface Screenshot {
  filePath: string;
  description: string;
  capturedAt: string;
}

export interface Cycle {
  id: string;
  campaignId: string;
  cycleNum: number;
  status: 'pending' | 'product' | 'dev' | 'test' | 'completed';
  productBrief?: string;
  screenshots?: Screenshot[];
  startedAt?: string;
  completedAt?: string;
}

export interface Task {
  id: string;
  cycleId: string;
  role: 'dev' | 'test';
  title: string;
  description?: string;
  acceptance?: string[];
  e2eScenarios?: string[];
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  result?: string;
  docAuditToken?: string;
  comments?: string[];
  createdAt: string;
  completedAt?: string;
}

export interface Role {
  id: string;
  name: string;
  systemPrompt: string;
  docPath?: string;
  isBuiltin: boolean;
  createdAt: string;
}

export interface KnowledgeChunk {
  id: string;
  roleId: string;
  sourceFile?: string;
  chunkText: string;
  embedding?: Float32Array;
  createdAt: string;
}

export interface AgentSession {
  provider: string;
  roleId: string;
  sessionId: string;
  externalId: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocAuditEntry {
  token: string;
  taskId?: string;
  filePath: string;
  contentHash: string;
  createdAt: string;
}

export interface RequirementTodo {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
}

export interface Requirement {
  id: string;
  name: string;
  purpose?: string;
  context: string;
  summary?: string;
  relatedDocs?: string[];
  changes?: string[];
  tags?: string[];
  todos?: RequirementTodo[];
  projectPath?: string;
  status: 'draft' | 'confirmed';
  createdAt: string;
  updatedAt: string;
}

export interface CaptureSession {
  id: string;
  requirementId?: string;
  phase: 'questioning' | 'confirming' | 'done';
  answers: Record<string, string>;
  draft?: Partial<Requirement>;
  createdAt: string;
  updatedAt: string;
}

// ── Helm-new tables ────────────────────────────────────────────────────────

export interface HostSession {
  id: string;
  host: 'cursor' | string;
  cwd?: string;
  composerMode?: string;
  campaignId?: string;
  cycleId?: string;
  /** Phase 25: optional role binding; LocalRolesProvider injects this role's
   * system prompt + chunks at sessionStart. */
  roleId?: string;
  /** Phase 32: first user prompt seen on this session. Captured by the
   * host_prompt_submit handler on the first message and never overwritten,
   * so the UI has a stable human-readable label per chat. */
  firstPrompt?: string;
  status: 'active' | 'closed';
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ChannelBinding {
  id: string;
  channel: 'lark' | 'local' | string;
  hostSessionId: string;
  externalChat?: string;
  externalThread?: string;
  externalRoot?: string;
  waitEnabled: boolean;
  metadata?: Record<string, unknown>;
  /** Phase 36: free-form user annotation captured from the bind command
   * (e.g. "dr" in `@bot dr bind chat`). Surfaces in the Bindings UI so the
   * user can match a binding back to their own mental tag. */
  label?: string;
  createdAt: string;
}

export interface ChannelMessageQueueItem {
  id: number;
  bindingId: string;
  externalId?: string;
  text: string;
  createdAt: string;
  consumedAt?: string;
}

export interface PendingBind {
  code: string;
  channel: string;
  externalChat?: string;
  externalThread?: string;
  externalRoot?: string;
  /** Phase 36: user-supplied annotation from the bind command, carried
   * forward to channel_bindings.label on consume. */
  label?: string;
  expiresAt: string;
}

export interface ApprovalRequest {
  id: string;
  hostSessionId?: string;
  bindingId?: string;
  tool: string;
  command?: string;
  payload?: Record<string, unknown>;
  status: 'pending' | 'allowed' | 'denied' | 'timeout';
  decidedBy?: 'local-ui' | 'lark' | 'policy' | 'timeout';
  reason?: string;
  createdAt: string;
  decidedAt?: string;
  expiresAt: string;
}

export interface ApprovalPolicy {
  id: string;
  tool: string;
  commandPrefix?: string;
  pathPrefix?: string;
  toolScope: boolean;
  decision: 'allow' | 'deny';
  hits: number;
  createdAt: string;
  lastUsedAt?: string;
}

export interface HostEventLogEntry {
  id: number;
  hostSessionId: string;
  kind: 'prompt' | 'response' | 'tool_use' | 'tool_result' | 'progress';
  payload: Record<string, unknown>;
  createdAt: string;
}
