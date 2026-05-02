# `helm` 项目蓝图（草稿 v0.1）

> 本文档是一个新项目的从零实现蓝图。它合并了两个前身项目：
> - `agent2lark-cursor`（飞书 ↔ Cursor IDE chat 的中继 + 远程审批）
> - `relay`（MCP-first 多 Agent 编排：campaign / cycle / 角色 / 知识 / 需求）
>
> 新项目的目标是：成为一个 **macOS 桌面 app（Electron）**，作为本机的 "Cursor Chat 管家"，承担观测、远程协作、知识沉淀、审批护栏四项核心职责。
>
> 项目名待定（候选：`cockpit` / `pier` / `mantle` / `cocoon`）。本文中 `helm` 为占位符，后续全局替换。

---

## 1. 产品定义

`helm` 是一个 macOS 桌面 app，常驻 menubar，作为 Cursor IDE 的本地"管家进程"。它通过 Cursor public hooks 旁观所有 Cursor chat 的生命周期事件，并在此之上提供：

1. **远程协作通道**：把当前 chat 镜像到 Lark thread，让用户离开电脑后通过手机（飞书 app）继续对话、审批工具调用、跟进任务进度。
2. **本地审批护栏**：拦截 Cursor 高风险工具（Shell / Write / MCP 等）执行前的请求，桌面通知 + Lark 双通道审批。
3. **知识 / 需求沉淀**：用户主动把某段 chat 沉淀为可复用的"专家角色知识"或"需求记忆"，由 app UI 引导走完结构化捕获流程。
4. **多 Agent 工作流编排**：保留 relay 现有的 campaign → cycle → product/dev/test 任务模型和 doc-first 强制审计能力，但 hook 介入后许多步骤从"求 Agent 自觉调 MCP"升级为"hook 自动触发 + 不可绕过"。
5. **MCP 服务端**：继续以 stdio MCP server 的形式被 Cursor / Claude Code / 其他 MCP client 调用，提供查询、训练、编排等 Agent 主动调用的能力。

### 1.1 代码来源

新项目从空仓库起，但大量代码可直接从前身项目**复制**过来作为起点（无需保持运行时兼容、无需迁移用户数据）：

| 前身代码 | 在 `helm` 中的去向 |
|---|---|
| `agent2lark-cursor/src/bridge-server.js` | → `src/bridge/server.ts`（TS 化 + 重命名消息类型） |
| `agent2lark-cursor/src/bridge-client.js` | → `src/bridge/client.ts` |
| `agent2lark-cursor/src/normalize.js` + `hook.js` | → `src/host/cursor/{normalize,hook-entry}.ts` |
| `agent2lark-cursor/src/installer.js` | → `src/host/cursor/installer.ts` |
| `agent2lark-cursor/src/lark-*.js` | → `src/channel/lark/*.ts` |
| `agent2lark-cursor/src/approval-policy.js` | → `src/approval/policy.ts`（落 SQLite） |
| `agent2lark-cursor/src/thinking-heartbeat.js` | → `src/heartbeat.ts` |
| `relay/src/storage/database.ts` | → `src/storage/database.ts`（扩展 schema） |
| `relay/src/workflow/engine.ts` | → `src/workflow/engine.ts`（基本不变） |
| `relay/src/roles/library.ts` + builtin/* | → `src/roles/library.ts` + `src/roles/builtin/*` |
| `relay/src/requirements/*` | → `src/requirements/*` |
| `relay/src/spawner/index.ts` | → `src/spawner/index.ts` |
| `relay/src/summarizer/campaign.ts` | → `src/summarizer/campaign.ts` |
| `relay/src/mcp/server.ts` | → `src/mcp/server.ts`（增 2 个新 tool） |
| `relay/web/src/*` | → `web/src/*`（迁原页面 + 新增 Chats/Approvals/Campaigns） |

不复用：

- `agent2lark-cursor/src/relay-supervisor.js`（被 Electron 主进程取代）
- `agent2lark-cursor/src/start-wizard.js`（被 UI 设置页取代）
- `agent2lark-cursor/src/session-store.js` JSON 文件读写（统一进 SQLite）
- `relay/src/server/api.ts`（Express → 改 Electron 主进程内嵌的 fastify/express，路由可保留）
- `relay/src/cli/index.ts` 的 web 子命令（不再独立启 dashboard）

**运行时数据**：不读老路径（`~/.agent2lark/` 和 `~/.relay/`），新 app 走自己的 `~/.helm/`。用户老数据如有需要由用户自己手动复制（提供文档说明字段对应关系即可，不写自动迁移代码）。

## 2. 非目标

明确不做：

- 不做手机原生 app（一期由 Lark adapter 兜底；二期可能演进为 PWA）
- 不做云端 server / 多用户 SaaS（所有数据在本机 `~/.helm/`）
- 不做用户认证（dashboard 仅本机访问）
- 不重新发明 Cursor 私有 IPC（仅使用 public hooks 和 Cursor SDK）
- 不替代 lark-cli（继续作为飞书事件订阅和消息发送的客户端）
- 不强制使用 Lark（LocalChannel 必须能独立工作）

## 3. 一期范围（MVP）

按里程碑切分：

### MVP-1：本地闭环
- Electron app 骨架 + menubar + 主窗口
- 安装 Cursor hooks
- bridge socket + SQLite 存储
- 列出活跃 / 历史 Cursor chats（来自 hook 事件流）
- LocalChannel：本机审批弹窗 + macOS 通知
- 需求库 / 角色库 UI（迁移自 relay dashboard）
- MCP stdio server 暴露给 Cursor

### MVP-2：Lark 远程通道
- LarkChannel adapter 实现
- 桌面 UI 一键绑定 Cursor chat 到 Lark thread（取代手输命令）
- 飞书消息注入 chat（Stop hook followup_message）
- 飞书远程审批（`/allow` `/deny` 等命令）
- 两个 channel 平行工作，同一对话双 surface 可见

### MVP-3：完整工作流
- campaign / cycle / 任务的桌面 UI
- doc-first 强制（PreToolUse 拦截无 audit token 的 Write/Edit）
- bug 任务回流到 dev cycle
- summarize_campaign

### Phase 2（不在本文档详细规划）
- PWA：daemon / UI 拆分，Cloudflare Tunnel + Web Push
- 知识 / 需求 bundle 导出导入（团队共享）
- 额外 RemoteChannel adapter（Slack / Telegram）
- Claude Code HostAdapter

## 4. 技术栈

- **桌面壳子**：Electron（30+ stable）
- **主进程语言**：Node.js >= 20.12，TypeScript ESM（`"type": "module"`）
- **渲染进程**：React + Vite + Tailwind（迁移自 relay/web）
- **打包**：`electron-builder`，DMG + zip
- **包管理**：pnpm workspace
- **存储**：better-sqlite3（WAL + foreign keys on）
- **MCP**：`@modelcontextprotocol/sdk`，stdio transport
- **AI SDK**：`@anthropic-ai/sdk`、`@cursor/sdk`
- **飞书**：`@larksuite/cli` 作为 npm dep
- **测试**：Vitest（统一 relay 现有栈，弃用 agent2lark-cursor 的 node:test）
- **TypeCheck**：`tsc --noEmit`
- **进程管理**：Node `child_process`（lark-cli 子进程）

体积控制：

- `electron-builder.config.cjs` 中 `electronLanguages: ['en', 'zh_CN']`
- ASAR 启用，`asarUnpack` 仅放 native module
- renderer bundle 排除 `@anthropic-ai/sdk`、`@cursor/sdk`、`better-sqlite3`、`@larksuite/cli`（仅主进程用）

## 5. 仓库结构

```text
helm/
├── PROJECT_BLUEPRINT.md       # 本文档
├── README.md
├── AGENTS.md                  # 给 AI agent 的协作规则（继承 relay）
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.json
├── electron-builder.config.cjs
├── vitest.config.ts
│
├── electron/                  # Electron 主进程
│   ├── main.ts                # app 启动入口
│   ├── menubar.ts             # tray + menubar
│   ├── windows.ts             # 主窗口管理
│   ├── lifecycle.ts           # auto-launch / 单实例锁 / 关闭确认
│   └── ipc.ts                 # main ↔ renderer IPC 通道
│
├── src/                       # 业务逻辑（主进程引用）
│   ├── config.ts
│   ├── constants.ts
│   ├── storage/
│   │   ├── database.ts
│   │   └── migrations.ts
│   ├── bridge/
│   │   ├── server.ts          # Unix socket bridge server
│   │   ├── client.ts          # hook 子进程使用
│   │   └── protocol.ts        # 消息类型定义
│   ├── host/                  # Host (IDE) adapter
│   │   ├── types.ts
│   │   ├── normalize.ts       # hook event → 统一 HostEvent
│   │   └── cursor/
│   │       ├── adapter.ts
│   │       ├── installer.ts   # 写 ~/.cursor/hooks.json
│   │       └── hook-entry.ts  # bin/helm-hook 实际逻辑
│   ├── channel/               # Remote channel adapter
│   │   ├── types.ts
│   │   ├── local/
│   │   │   ├── adapter.ts     # 桌面通知 + UI 弹窗
│   │   │   └── notifier.ts
│   │   └── lark/
│   │       ├── adapter.ts
│   │       ├── listener.ts    # spawn lark-cli event subscribe
│   │       ├── cli-command.ts
│   │       └── command-parser.ts
│   ├── workflow/
│   │   ├── engine.ts          # 迁移自 relay
│   │   └── doc-audit.ts
│   ├── roles/
│   │   ├── library.ts         # 迁移自 relay
│   │   └── builtin/
│   │       ├── product.ts
│   │       ├── developer.ts
│   │       └── tester.ts
│   ├── requirements/
│   │   ├── capture.ts         # 迁移自 relay
│   │   └── recall.ts
│   ├── spawner/
│   │   └── index.ts           # 迁移自 relay
│   ├── approval/
│   │   ├── registry.ts        # 内存 + 持久化 mirror
│   │   ├── policy.ts          # ~/.relay/approval-policy 迁入 SQLite
│   │   └── scope-inference.ts
│   ├── summarizer/
│   │   └── campaign.ts        # 迁移自 relay
│   ├── mcp/
│   │   ├── server.ts          # 注册所有 tool / prompt
│   │   ├── stdio.ts           # stdio transport entry
│   │   └── tools/             # （可选）按 domain 切分
│   └── api/
│       ├── server.ts          # localhost HTTP for renderer
│       └── routes/
│
├── web/                       # Renderer (React)
│   ├── package.json
│   ├── vite.config.ts
│   ├── index.html
│   └── src/
│       ├── App.tsx
│       ├── pages/
│       │   ├── Chats.tsx          # 活跃 / 历史 Cursor chats
│       │   ├── ChatDetail.tsx     # 单个 chat 的事件流
│       │   ├── Approvals.tsx      # 待审批列表
│       │   ├── Requirements.tsx   # 需求库
│       │   ├── RequirementDetail.tsx
│       │   ├── Roles.tsx          # 专家库
│       │   ├── Campaigns.tsx
│       │   ├── CampaignDetail.tsx
│       │   └── Settings.tsx
│       ├── components/
│       └── hooks/
│
├── bin/
│   ├── helm.mjs            # CLI 入口（headless 模式 / 子命令）
│   └── helm-hook.mjs       # Cursor hook 子进程入口
│
├── tests/
│   └── ...                    # Vitest 用例
│
└── docs/
    ├── ARCHITECTURE.md
    ├── MIGRATION.md            # 从 agent2lark-cursor / relay 迁移
    ├── ROADMAP.md
    ├── roles/
    │   ├── product.md
    │   ├── developer.md
    │   └── tester.md
    └── tech/
        └── HOOK_FLOW.md
```

## 6. 本地文件布局

```text
~/.helm/
├── config.json                     # 用户配置（API key、Lark 开关、port 等）
├── data.db                         # SQLite 单一真相源
├── bridge.sock                     # Unix domain socket（hook ↔ 主进程）
├── logs/
│   ├── main.log                    # Electron 主进程
│   ├── lark-listener.log           # lark-cli 子进程 stdout
│   └── lark-listener.err.log
└── screenshots/                    # Playwright 测试截图
```

Cursor hooks 仍写到 `~/.cursor/hooks.json`，由 installer 模块管理。

**老数据**：新 app 不读 `~/.agent2lark/` 和 `~/.relay/`，新装即新开始。前身项目用户如需保留老数据自行复制（README 提供字段对应说明）。

## 7. 进程拓扑

### 7.1 运行时进程

```text
┌───────────────────────────────────────────────────────────┐
│  helm (Electron app, 主进程, 长期运行)            │
│                                                           │
│  ├─ Bridge UDS Server (~/.helm/bridge.sock)             │
│  ├─ MCP stdio server (per Cursor connection)              │
│  ├─ HTTP API on 127.0.0.1:<port> (renderer 调用)           │
│  ├─ SQLite 单实例                                          │
│  ├─ ApprovalRegistry (内存) + 持久化 mirror                │
│  ├─ ThinkingHeartbeat                                     │
│  ├─ HostAdapter[]: CursorHostAdapter                      │
│  ├─ RemoteChannel[]: LocalChannel, LarkChannel?           │
│  └─ Renderer (Electron BrowserWindow, React)              │
│                                                           │
│  Spawned subprocesses:                                    │
│  └─ lark-cli event +subscribe (when Lark enabled)         │
└───────────────────────────────────────────────────────────┘
       ▲                ▲                  ▲
       │ socket         │ stdio MCP         │ events
       │                │                  │
   Cursor hook      Cursor (作为 MCP    Lark cloud
   子进程 (短命)     client)
```

### 7.2 Cursor hook 子进程

由 Cursor 为每个 hook 事件 spawn 一个短命 Node 进程，执行 `bin/helm-hook.mjs`。它的职责：

1. 读 stdin 中 Cursor 给的 hook payload JSON
2. 通过 bridge socket 把请求发给桌面 app 主进程
3. 把主进程返回的 JSON 写到 stdout 给 Cursor
4. 主进程不可达时 fallback（relay event 返回 `{}` / `{continue: true}`，approval 返回 `permission: ask`）

子进程**绝不**直接读写 SQLite 或 config 文件——它只是 IPC 桥。

### 7.3 桌面 app 启动顺序

```text
1. Electron app.whenReady
2. 加载 ~/.helm/config.json（不存在则创建默认）
3. 触发迁移检查（一次性导入老项目数据）
4. 打开 SQLite，跑 migrations
5. seedBuiltinRoles
6. 启动 Bridge UDS Server
7. 启动 HTTP API (127.0.0.1)
8. 启动 MCP stdio server（fork 出来等 Cursor 连）
9. 注册 HostAdapter（CursorHostAdapter）
10. 注册启用的 RemoteChannel（LocalChannel 必启，LarkChannel 按 config）
11. 创建 menubar tray + 主窗口（默认隐藏）
12. 单实例锁；第二实例启动会唤起主窗口后退出
```

### 7.4 关闭顺序

```text
1. 用户从 menubar 选 Quit / app.before-quit
2. 弹确认（如果有 in-flight 审批）
3. 停止 RemoteChannel（kill lark-cli 子进程组）
4. 关闭 MCP stdio server
5. 关闭 HTTP API
6. 关闭 Bridge UDS Server，清理 sock 文件
7. 关闭 SQLite
8. 退出 app
```

## 8. Bridge Wire Protocol

继承自 agent2lark-cursor 的 `cursor-relay.sock` 协议，用 Unix domain socket + JSON Lines。每次 connection 一来一回一断。

### 8.1 消息类型

| Type | Sender | Purpose | Response |
|---|---|---|---|
| `host_session_start` | hook | 注册新 chat session | `{ additional_context? }` |
| `host_prompt_submit` | hook | 用户 prompt 提交前 | `{ continue, user_message? }` |
| `host_agent_response` | hook | Agent 回复完成 | `{ ok, suppressed? }` |
| `host_progress` | hook | 工具执行进度 | `{ ok, sent? }` |
| `host_stop` | hook | Agent 一轮结束，长轮询消息 | `{ followup_message? }` |
| `host_approval_request` | hook | 高风险工具拦截 | `{ decision: 'allow'|'deny'|'ask', reason }` |
| `channel_inbound_message` | RemoteChannel | 远程通道消息入队 | `{ ok, routed? }` |
| `channel_approval_decision` | RemoteChannel | 远程审批决策 | `{ ok, ... }` |
| `channel_create_binding` | RemoteChannel / UI | 创建 binding | `{ ok, code }` |
| `channel_unbind` | RemoteChannel / UI | 解绑 | `{ ok, removed }` |
| `channel_disable_wait` | RemoteChannel | 关闭 wait loop | `{ ok }` |

消息类型直接采用新命名 `host_*` / `channel_*`，反映 HostAdapter / RemoteChannel 抽象。不保持 wire 兼容（不需要同时识别老 `cursor_*` / `lark_*`）。

### 8.2 hook 子进程超时

继承 agent2lark-cursor 设定：

- 默认 socket timeout：30s
- `host_stop`：max(default, AGENT2LARK_WAIT_POLL_MS + 5s)
- `host_approval_request`：max(default, AGENT2LARK_APPROVAL_TIMEOUT_MS + 5s)

## 9. SQLite Schema

合并自 relay + agent2lark-cursor，单一数据库 `~/.helm/data.db`。

### 9.1 继承自 relay 的表（基本不变）

- `campaigns` — 长期产品/工程 effort
- `cycles` — 一轮 product → dev → test 循环
- `tasks` — dev / test 任务
- `roles` — 内置 + 自定义角色
- `knowledge_chunks` — 角色知识文档分块
- `agent_sessions` — Cursor Agent session 复用（`(provider, role_id, session_id)`）
- `doc_audit_log` — doc-first 审计 token
- `requirements` — 需求记忆
- `capture_sessions` — 多轮捕获中间态

详细字段定义见前身项目 `relay/PROJECT_BLUEPRINT.md` §5。新项目原样迁移。

### 9.2 新增 / 迁移自 agent2lark-cursor 的表

`host_sessions` — Cursor chat session 注册（取代老 `cursor-relay-state.json` 中 `cursorSessions`）：

```sql
CREATE TABLE IF NOT EXISTS host_sessions (
  id              TEXT PRIMARY KEY,         -- Cursor session_id
  host            TEXT NOT NULL,            -- 'cursor' | (future) 'claude-code'
  cwd             TEXT,
  composer_mode   TEXT,
  campaign_id     TEXT REFERENCES campaigns(id),
  cycle_id        TEXT REFERENCES cycles(id),
  status          TEXT DEFAULT 'active',    -- active | closed
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL
);
```

`channel_bindings` — 一个 host session 与一个 RemoteChannel thread 的双向绑定：

```sql
CREATE TABLE IF NOT EXISTS channel_bindings (
  id              TEXT PRIMARY KEY,
  channel         TEXT NOT NULL,            -- 'lark' | 'local' | future
  host_session_id TEXT NOT NULL REFERENCES host_sessions(id) ON DELETE CASCADE,
  external_chat   TEXT,                     -- e.g. lark chat_id
  external_thread TEXT,                     -- e.g. lark om_*/omt_*
  external_root   TEXT,                     -- root message id
  wait_enabled    INTEGER DEFAULT 1,
  metadata        TEXT,                     -- JSON
  created_at      TEXT NOT NULL,
  UNIQUE (channel, external_chat, external_thread)
);
CREATE INDEX idx_bindings_session ON channel_bindings(host_session_id);
```

`channel_message_queue` — 等待被 host_stop 取走的远程消息：

```sql
CREATE TABLE IF NOT EXISTS channel_message_queue (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  binding_id   TEXT NOT NULL REFERENCES channel_bindings(id) ON DELETE CASCADE,
  external_id  TEXT,                        -- 源 message_id
  text         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  consumed_at  TEXT
);
CREATE INDEX idx_queue_binding ON channel_message_queue(binding_id, consumed_at);
```

`pending_binds` — 绑定握手中间态（短期，可定期清理）：

```sql
CREATE TABLE IF NOT EXISTS pending_binds (
  code            TEXT PRIMARY KEY,
  channel         TEXT NOT NULL,
  external_chat   TEXT,
  external_thread TEXT,
  external_root   TEXT,
  expires_at      TEXT NOT NULL
);
```

`approval_requests` — 审批请求持久化（agent2lark-cursor 原本是纯内存）：

```sql
CREATE TABLE IF NOT EXISTS approval_requests (
  id              TEXT PRIMARY KEY,
  host_session_id TEXT REFERENCES host_sessions(id) ON DELETE CASCADE,
  binding_id      TEXT REFERENCES channel_bindings(id) ON DELETE SET NULL,
  tool            TEXT NOT NULL,
  command         TEXT,
  payload         TEXT,                      -- JSON
  status          TEXT NOT NULL,             -- pending | allowed | denied | timeout
  decided_by      TEXT,                       -- 'local-ui' | 'lark' | 'policy' | 'timeout'
  reason          TEXT,
  created_at      TEXT NOT NULL,
  decided_at      TEXT,
  expires_at      TEXT NOT NULL
);
CREATE INDEX idx_approval_status ON approval_requests(status);
CREATE INDEX idx_approval_session ON approval_requests(host_session_id);
```

持久化的好处：app 崩溃重启后能看到当时的 pending；hook 子进程已经 fallback 走过的 ask 也能被 audit。

`approval_policies` — 自动审批规则（迁移自 `cursor-approval-policy.json`）：

```sql
CREATE TABLE IF NOT EXISTS approval_policies (
  id               TEXT PRIMARY KEY,
  tool             TEXT NOT NULL,
  command_prefix   TEXT,
  path_prefix      TEXT,
  tool_scope       INTEGER DEFAULT 0,
  decision         TEXT NOT NULL,             -- 'allow' | 'deny'
  hits             INTEGER DEFAULT 0,
  created_at       TEXT NOT NULL,
  last_used_at     TEXT
);
CREATE INDEX idx_policy_tool ON approval_policies(tool);
```

`host_event_log` — hook 事件流持久化（用于"沉淀某段对话为知识/需求"功能）：

```sql
CREATE TABLE IF NOT EXISTS host_event_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  host_session_id TEXT NOT NULL REFERENCES host_sessions(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,              -- prompt | response | tool_use | tool_result | progress
  payload         TEXT NOT NULL,              -- JSON, 必要时截断
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_event_session ON host_event_log(host_session_id, created_at);
```

注意隐私：`host_event_log` 里的 prompt / response 包含用户原始输入。设置上限（每条 100KB？每 session 最多 N 条？），并提供 UI 一键清除单 session 历史。

## 10. HostAdapter 抽象

定义在 `src/host/types.ts`：

```ts
export type HostEventKind =
  | 'session_start'
  | 'prompt_submit'
  | 'agent_response'
  | 'tool_use_pre'      // 拦截点
  | 'tool_use_post'
  | 'progress'
  | 'stop';

export interface HostEvent<K extends HostEventKind = HostEventKind> {
  host: 'cursor';                  // 一期固定
  kind: K;
  hostSessionId: string;
  cwd?: string;
  raw: unknown;                    // 原始 hook payload
  // 各 kind 特定字段
}

export interface HostAdapter {
  install(): Promise<void>;        // 写 hooks.json
  uninstall(): Promise<void>;
  normalize(rawEvent: unknown): HostEvent;
  formatResponse(event: HostEvent, decision: HostDecision): unknown;
}
```

`CursorHostAdapter` 一期实现，逻辑直接来自 agent2lark-cursor 的 `normalize.js` + `installer.js` + `hook.js`，但事件名/字段重命名为 host_*。

`ClaudeCodeHostAdapter` 接口预留，二期实现。

## 11. RemoteChannel 抽象

定义在 `src/channel/types.ts`：

```ts
export interface RemoteChannel {
  id: string;                                          // 'lark' | 'local'
  start(): Promise<void>;
  stop(): Promise<void>;

  /** 把待审批请求推到该 channel 用户面前 */
  sendApprovalRequest(req: ApprovalRequest, binding?: ChannelBinding): Promise<void>;

  /** 把消息发到 binding 对应的 thread */
  sendMessage(binding: ChannelBinding, text: string, opts?: SendOpts): Promise<void>;

  /** 标记某消息已收到 */
  ackMessage?(binding: ChannelBinding, externalId: string): Promise<void>;

  /** 创建一个新 thread / 复用已有 thread，用于 binding */
  createThread?(opts: CreateThreadOpts): Promise<ExternalThread>;

  /** 用户在 channel 那边的输入 -> bridge */
  onInboundMessage(handler: (m: InboundMessage) => Promise<void>): Unsubscribe;
  onApprovalDecision(handler: (d: ApprovalDecision) => Promise<void>): Unsubscribe;
}
```

### 11.1 LocalChannel

实现要点：

- 不发送任何网络消息
- `sendApprovalRequest`：弹 macOS 通知（`Notification` Web API 通过 Electron），通知点击 → 唤起主窗口 → 跳到 Approvals 页
- `sendMessage`：在 chat 详情页流式追加，不需要"远程"
- `onInboundMessage`：用户在桌面 UI 输入框打字 → 通过 IPC → adapter emit
- `createThread`：no-op，binding 自动用 host_session_id

LocalChannel 永远启用，不可关闭。它保证用户即使没配 Lark 也能正常使用桌面 app。

### 11.2 LarkChannel

迁移自 agent2lark-cursor，主要适配点：

- `start()`：spawn `lark-cli event +subscribe --event-types im.message.receive_v1,card.action.trigger --compact --quiet --as bot`，stdout 行解析
- `sendMessage`：`lark-cli im +messages-reply --message-id <id> --markdown <text> --reply-in-thread --as bot`
- `sendApprovalRequest`：发 markdown 提示（默认 text 模式）或 interactive card
- `createThread`：调 `lark-cli im +chat-create` 或在已有"Cursor Conversation"群里发种子消息
- `command-parser`：识别 `bind chat` / `unbind` / `/help` / `/allow*` / `/deny*` / `stop wait`
- 子进程退出后自动重连，指数退避

**绑定流程取代输 message_id：**

老流程（agent2lark-cursor）需要用户在 Cursor chat 里输入 `bind lark thread message_id: om_xxx`。新流程：

```
1. 用户在 Lark thread 发 "@bot bind chat"
   → LarkChannel 收到 → 创建 pending_bind（10 分钟过期）
   → Lark 回复："已生成绑定码 <code>，请在桌面 app 中点击"绑定到此 thread"按钮"
2. 用户切到桌面 app
   → app 在 menubar 显示一个红点
   → 主窗口 Pending Binds 列表显示这条 pending
   → 点选要绑定的 Cursor chat（或新建一个 chat）
   → 点 "Bind" → bridge 写 channel_bindings → 删 pending
3. 完成
```

或者反向：

```
1. 用户在桌面 app 选定一个 Cursor chat
   → 点 "Mirror to Lark" → 选已有 thread 或 "Create new"
   → 选 "Create new" → app 调 LarkChannel.createThread
   → 飞书侧自动收到种子消息 "📌 已绑定 chat: <项目名>"
2. 完成
```

**两种入口都不需要用户在 Cursor chat 中输任何命令。**

老命令式 bind 在 LarkChannel 中保留作为兼容，但新用户不会被引导用它。

## 12. Approval 流程

继承自 agent2lark-cursor `bridge-server` 的审批流，但加了 LocalChannel 路径。

### 12.1 决策来源优先级

对每个 `host_approval_request`：

```
1. 查 approval_policies → 命中 → 立即返回 decision，更新 hits
2. 不命中 → 创建 approval_requests 记录（status=pending）
3. 并发推送到所有启用的 RemoteChannel：
   - LocalChannel：弹通知 + UI 列表
   - LarkChannel（如启用且 host_session 有 binding）：发 markdown
4. 等待第一个 channel 回 decision，或 timeout
5. 标记 approval_requests.decided_by + status，settle pending hook
6. 如果命令带 `!`（remember），写入 approval_policies
```

### 12.2 远程审批解析（继承）

LarkChannel 命令文法（同 agent2lark-cursor）：

```
/(?:^|\s)\/(?:cursor[:\s]+)?(allow|deny)(!)?(?:\s+(.+?))?\s*$/i
```

支持：

- `/allow` `/deny`（一次性）
- `/allow!` `/deny!`（记住，scope 由 `inferRuleScope` 推断）
- `/allow <request_id>`（多 pending 时定位）
- `/allow shell!` `/allow pnpm!` `/allow mcp__server__tool!`（scoped）

### 12.3 doc-first 强制

继承 relay 的 `update_doc_first` MCP tool。新增点：在 `host_approval_request` 中拦截 Write/Edit/MultiEdit 时，检查最近 N 分钟内是否有 doc_audit_log 记录覆盖目标路径：

```
PreToolUse Write target=/foo/bar.ts
  → query doc_audit_log WHERE file_path startsWith dirname(target) AND created_at > now-30min
  → 命中 → allow
  → 不命中 → 推审批（提示："这个改动没有先调 update_doc_first，是否仍然允许？"）
```

可由 config 关闭强制（默认 on for dev cycles, off otherwise）。

## 13. MCP Server

继承自 relay 的 `src/mcp/server.ts`，所有 tool 和 prompt **保持原名和签名**，确保现有 Claude Code 用户的 MCP 配置零迁移成本。

### 13.1 不变的 tool

- `init_workflow` / `get_cycle_state` / `complete_cycle`
- `create_tasks` / `get_my_tasks` / `complete_task` / `add_task_comment` / `create_bug_tasks` / `add_product_feedback`
- `update_doc_first`
- `list_roles` / `get_role` / `train_role` / `search_knowledge`
- `start_relay_chat_session` / `spawn_agent`（默认仍 Cursor session 复用）
- `capture_screenshot` / `run_e2e_tests`
- `list_campaigns` / `summarize_campaign`
- `capture_requirement` / `recall_requirement`
- `setup_project_rules`

### 13.2 新增 tool（一期）

`get_active_chats` — Agent 可以查询当前活跃的 chat 列表（用于跨 chat 协作）

```ts
{ chats: Array<{ hostSessionId, cwd, campaignId?, lastSeenAt }> }
```

`bind_to_remote_channel` — 通过 MCP 发起绑定（替代 UI 点击）

```ts
input: { hostSessionId, channel, externalThread? }
output: { bindingId } | { pendingCode, instruction }
```

### 13.3 prompt（不变）

继承 relay：`relay:doc-first` / `relay:role-product` / `relay:role-developer` / `relay:role-qa` / `relay:recall-requirement`

## 14. 桌面 UI

### 14.1 Menubar

macOS tray icon，单击展开 popover：

```
┌────────────────────────────────┐
│  ● 2 chats active              │
│  ⚠ 1 approval pending          │
│  ────────────────────────       │
│  Open Dashboard                │
│  Pause Approvals               │
│  ────────────────────────       │
│  Settings...                   │
│  Quit                          │
└────────────────────────────────┘
```

icon 状态：

- 灰色：app 运行中，无活动
- 蓝色：有活跃 chat
- 黄色 + 角标：有 pending approval
- 红色：bridge 异常 / lark 断线

### 14.2 主窗口

左侧 sidebar 导航：

- `对话` (Chats) — 活跃 / 历史 Cursor chats
- `审批` (Approvals) — pending / history
- `需求库` (Requirements) — 来自 relay
- `专家库` (Roles) — 来自 relay
- `任务编排` (Campaigns) — campaign / cycle / task 视图
- `设置` (Settings)

每个 chat 详情页展示：

- session 元数据（cwd / 启动时间 / 关联 campaign）
- hook 事件流（折叠展示，可展开看完整 prompt/response/tool_use）
- 当前绑定的 RemoteChannel 列表（可一键解绑 / 新建）
- 输入框：可在 app 内直接发消息进 chat（走 LocalChannel + Stop hook 注入）
- "沉淀为需求" / "沉淀为知识" 按钮

审批页：

- pending 列表实时更新（IPC push）
- 单击进入详情：完整命令、cwd、所属 chat、风险等级
- 按钮：Allow / Deny / Allow & remember / Deny & remember
- 历史筛选：被 policy 自动通过的、被 timeout 的、被 lark 决策的

### 14.3 IPC 设计

renderer 通过 `window.helm.invoke(channel, payload)` 调主进程，主进程通过 `webContents.send` 推送实时事件。channels：

| Channel | 方向 | 用途 |
|---|---|---|
| `chats.list` | renderer → main | 拉活跃/历史 chat |
| `chats.events` | main → renderer | hook 事件流 push |
| `approvals.list` | renderer → main | pending 列表 |
| `approvals.event` | main → renderer | pending 增删 push |
| `approvals.decide` | renderer → main | 用户点 allow/deny |
| `bindings.create` | renderer → main | 创建 binding |
| `bindings.delete` | renderer → main | 解绑 |
| `requirements.*` / `roles.*` / `campaigns.*` | 双向 | 沿用 relay HTTP API 形态 |

或者：renderer 直接调 `127.0.0.1:<port>` 的 HTTP API（继承 relay/web 的 `useApi` hook），主进程不用单独定义 IPC channel，复用率最高。**推荐后者。** `useWebSocket` hook 用 main → renderer push 实现实时事件。

## 15. 配置系统

`~/.helm/config.json`：

```ts
export interface AppConfig {
  llm: {
    provider: 'anthropic' | 'openai';
    model: string;
    apiKey: string;
    embeddingModel?: string;
  };
  cursor: {
    apiKey: string;
    model: string;
    workspacePath: string;
  };
  spawner: {
    mode: 'sdk' | 'cli';
    fallbackToCli: boolean;
  };
  channels: {
    local: { enabled: true };          // 永远 true
    lark: {
      enabled: boolean;
      approvalMode: 'text' | 'card';
      autoCreateThread: boolean;
    };
  };
  approval: {
    timeoutMs: number;                 // 默认 24h
    waitPollMs: number;                // 默认 10min
    docFirstStrict: boolean;           // PreToolUse 拦截无 token 的 Write
  };
  ui: {
    autoLaunch: boolean;
    closeToTray: boolean;
    notifications: boolean;
  };
  server: { port: number };            // 127.0.0.1 HTTP API
  logging: {
    persistEvents: boolean;            // host_event_log 开关
    maxEventsPerSession: number;
  };
}
```

首次启动时若 config.json 不存在，写入默认值（`channels.lark.enabled = false`，用户在 Settings 中开启）。

## 16. 数据库迁移（schema only）

`src/storage/migrations.ts` 仅做 schema 演进（CREATE TABLE / ALTER TABLE），不导入老项目数据。每次 schema 变更新增一条 numbered migration，记录在 `schema_migrations` 表。

**不做**：从 `~/.agent2lark/*` 或 `~/.relay/*` 读数据。新 app 启动即新开始。

## 17. 测试矩阵

继承 relay vitest 栈，新增针对桥接和 channel 抽象的测试。

### 17.1 主进程单元测试

- `storage/database.test.ts` — schema 初始化、CRUD、schema migration 幂等
- `bridge/protocol.test.ts` — 消息序列化/反序列化
- `bridge/server.test.ts` — UDS 收发、超时、并发连接、unknown type 错误
- `host/cursor/normalize.test.ts` — 每种 Cursor hook event 正确映射到 HostEvent
- `host/cursor/installer.test.ts` — 写 hooks.json、删除老 marker、preToolUse matcher
- `channel/local/adapter.test.ts` — 通知触发、UI push、决策回流
- `channel/lark/adapter.test.ts` — listener 行解析、命令匹配、CLI args 构造
- `channel/lark/command-parser.test.ts` — `/allow!` / scoped 命令文法
- `approval/registry.test.ts` — pending lifecycle、超时、settle、并发 channel
- `approval/policy.test.ts` — longest prefix wins、scope inference、持久化
- `approval/scope-inference.test.ts` — Shell / MCP / path-based / ApplyPatch / MultiEdit
- `workflow/engine.test.ts` — 继承 relay
- `roles/library.test.ts` — 继承 relay
- `requirements/capture.test.ts` / `recall.test.ts` — 继承 relay
- `spawner/index.test.ts` — 继承 relay，Cursor 默认路径 + retry on 5xx
- `summarizer/campaign.test.ts` — 继承 relay
- `mcp/server.test.ts` — tool schema、新 tool

### 17.2 集成测试（fake adapter）

- 端到端 hook → bridge → channel → decision 回路
- doc-first 强制拦截
- approval 多 channel 竞速

### 17.3 Renderer

- `App.test.tsx` 路由
- 关键页面渲染快照
- `useApi` / `useWebSocket` mock 测试

不需要 Playwright e2e，那是被测项目用的，不是测自己。

## 18. CLI 入口

`bin/helm.mjs`：

```text
helm                       # 启动 Electron app（默认）
helm hook --event <e>      # Cursor 调用 hook 子进程的实际命令（不直接给用户用）
helm mcp                   # 仅启动 MCP stdio server，不开 GUI
                              # 用于无 GUI 环境（远程开发机），手动 launchctl 跑 daemon
helm install-hooks         # 单独装 Cursor hooks（不开 app）
helm uninstall-hooks
helm doctor                # 诊断：bridge / hooks / config / lark-cli 状态
```

GUI app 是默认入口，`bin/helm-hook.mjs` 单独打包以便 hook command 引用稳定路径。

## 19. 安全与隐私

- API key 仅存 `~/.helm/config.json`，权限 600
- bridge socket 仅本机用户可访问（mode 0600）
- HTTP API 只绑 127.0.0.1，不暴露
- progress 同步到 Lark 时 redact 敏感环境变量（继承 agent2lark-cursor）
- approval prompt 命令截断 160 字符
- `host_event_log` 单条 100KB 上限，单 session 1000 条上限
- Settings 提供 "Clear all event history" 按钮
- `host_event_log` 不发往任何远程 channel，仅本地

## 20. AGENTS.md

继承 relay 的 AGENTS.md 思路。要求所有 AI agent 在动 `helm` 代码前先读：

- 本文档
- `docs/roles/product.md` / `developer.md` / `tester.md`
- `docs/tech/HOOK_FLOW.md`

doc-first 规则、role 边界、vibe coding loop 不变。

## 21. 实现顺序（从空仓库）

### Phase 0：仓库骨架（半天）

- pnpm workspace + tsconfig + tsup + vitest
- electron-builder 配置
- bin wrapper
- 初始 README / AGENTS / 本蓝图

### Phase 1：数据层（1-2 天）

- `storage/database.ts` 全表 + schema migrations 框架
- 测试覆盖所有 schema

### Phase 2：bridge 协议（1 天）

- `bridge/protocol.ts` 消息类型
- `bridge/server.ts` UDS 服务
- `bridge/client.ts` 子进程客户端
- 测试

### Phase 3：HostAdapter (Cursor)（2 天）

- `host/cursor/normalize.ts`
- `host/cursor/installer.ts`
- `bin/helm-hook.mjs`
- fallback 路径
- 测试

### Phase 4：Approval 核心（2 天）

- registry / policy / scope-inference
- bridge 集成
- 持久化 mirror
- 测试

### Phase 5：LocalChannel（1 天）

- 通知 + UI push
- 端到端审批闭环（无 Lark 也能跑）

### Phase 6：MCP server（1-2 天）

- 迁移 relay 全部 tool
- 新增 `get_active_chats` / `bind_to_remote_channel`
- stdio 启动入口
- 测试

### Phase 7：Workflow / Roles / Requirements / Spawner / Summarizer（2-3 天）

- 全部从 relay 复制 + 适配新 db schema
- 测试

### Phase 8：Electron 壳（2-3 天）

- main process boot 顺序
- menubar + tray
- 主窗口 + 单实例锁
- HTTP API 暴露
- IPC / WebSocket 推送

### Phase 9：Renderer（4-5 天）

- 迁移 relay/web 现有页面（Requirements / Roles）
- 新增 Chats / Approvals / Campaigns / Settings
- 实时事件流

**MVP-1 完成（约 2-3 周）**

### Phase 10：LarkChannel（2-3 天）

- listener 子进程管理
- adapter 实现
- command-parser
- 绑定流程 UI

### Phase 11：Lark 远程审批 + 消息注入（2-3 天）

- approval text 模式打通
- inbound message → queue → host_stop followup
- 飞书 progress relay

**MVP-2 完成**

### Phase 12：完整工作流（3-4 天）

- campaign UI
- doc-first 强制拦截集成
- bug 任务回流
- summarize_campaign

**MVP-3 完成（约 6-8 周）**

## 22. Definition of Done（MVP-3）

- `pnpm typecheck` / `pnpm test` / `pnpm build` 全过
- `pnpm package` 生成可签名的 macOS DMG
- Cursor hooks 自动安装，`helm doctor` 通过
- LocalChannel：本机通知 + UI 审批闭环可用
- LarkChannel：飞书绑定（无需手输命令）+ 消息注入 + 远程审批可用
- 需求库 / 角色库 UI 与 relay dashboard 等价
- doc-first 强制可开关
- campaign / cycle / task 在 UI 中可视化驱动
- MCP stdio server 暴露所有原 relay tool，Claude Code 用户配置兼容
- 关闭 app 时无 orphan lark-cli 子进程

## 23. 待决定 / Open Questions

需要在动手前进一步明确：

- [ ] 项目名（`cockpit` / `pier` / `mantle` / `cocoon` / 其他）
- [ ] 是否一期就做 daemon / UI 拆分（推荐：不做，二期 PWA 时再拆）
- [ ] Cursor 之外是否 MVP-1 就支持 Claude Code（推荐：不做，预留接口即可）
- [ ] `host_event_log` 默认是否开（推荐：开，但单 session 上限 1000 条）
- [ ] DMG 是否签名 / 公证（开源项目可不做，但 Gatekeeper 会拦；建议至少 ad-hoc sign）
- [ ] 是否需要 launchd plist 真后台模式（用于无 GUI 服务器；推荐 MVP 后再加）

## 24. 与前身项目的关系

- `agent2lark-cursor` 仓库归档为只读 reference，README 加 deprecation note 指向新项目
- `relay` 仓库归档同上
- 老 npm 包 `@sherlockfeng/lark2cursor` 不再发布新版本；新项目用新名字发包
- 新项目 README 第一段说明它是这两个项目的合并 / 演进版

---

> 草稿 v0.1，欢迎 review。下一步动作：定项目名、git init 新仓库、按 Phase 0 起骨架。
