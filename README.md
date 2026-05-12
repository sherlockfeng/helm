# Helm

> macOS 桌面 app — Cursor IDE 的本机 chat 管家 + AI-assisted dev 工作流引擎。

Helm 在 menubar 常驻，通过 Cursor public hooks 旁观所有 chat 的生命周期，把"IDE chat → 远程协作 → 知识沉淀 → 多 Agent 工作流"串成一个本地优先、零云依赖的闭环。

## 它做什么

- **🛡 本地审批护栏** — 拦截 Cursor 高风险工具（Shell / Write / MCP），桌面 + Lark 双通道审批。`unbind` 自动 settle 残留请求；无 Lark binding 的 chat 自动放行。
- **💬 远程协作通道** — 一键把 Cursor chat 镜像到 Lark thread，手机上继续对话和审批；Lark 消息回流时在 Active Chats 卡片显示 *"📨 N queued"* 徽章 + 系统通知。
- **🧠 角色知识库** — 通过 chat 对话沉淀领域专家（"TCC 专家"/"容灾链路专家"…）；`update_role` 自带语义冲突检测（cosine ≥ 0.85 即提示用户确认）；sessionStart 自动把绑定的 role context 注入到 Cursor。
- **📋 Harness 工作流** — `new_feature → implement → archive` 单调阶段机；reviewer 走独立子进程 + 信息隔离合约；archive 按 entity/file 精确索引，新任务自动找相关老任务。详见下方 [Harness](#harness-工作流) 一节。
- **🔌 MCP server** — `127.0.0.1:17317/mcp/sse` 暴露 30+ 个工具给 Cursor / Claude Code agent（roles、harness、bindings、knowledge、approvals、…）。一键 setup 写 `~/.claude.json` / `~/.cursor/mcp.json`。
- **⚙️ 多引擎可切换** — Settings → Default engine，全局选 Cursor 或 Claude Code，summarizer / Harness reviewer / role-trainer 三处统一切换；Settings 改完热生效，不用重启。
- **🪪 外部知识源** — `KnowledgeProvider` 抽象，已接入 depscope、本地 roles、需求归档，可扩展到内部 wiki / SDK 文档站。

## 快速开始

```bash
pnpm install

# 一键启动（推荐）：构建后端 + 渲染层，启动 Electron
pnpm start

# 或：dev 模式（renderer 热重载 + 后端 watch；需要分两个终端跑）
pnpm dev:backend       # 终端 1
pnpm dev:web           # 终端 2
HELM_DEV=1 pnpm dev:electron   # 终端 3，loadURL → vite dev server
```

首次启动后：

1. **配置 MCP**：Roles 页面 → *"Set up Claude Code"* / *"Set up Cursor"* 按钮，一键写 MCP 配置
2. **配置默认引擎**：Settings → Default engine，选 Claude Code 或 Cursor
3. （可选）**接 Lark**：Settings → Lark integration，启用并指定 `lark-cli` 路径

## Harness 工作流

Helm 内置一套 AI-assisted feature development 工作流，把"工程师把粗粒度任务交给 AI"变成可控的协作模式。

### 核心思想

两道护栏让 review 成本可控：

- **行为护栏**（tests）— 不管 AI 改了什么，业务行为不能崩
- **形式护栏**（lint + reviewer）— 不管 AI 写了什么，要符合项目规约

只要两道护栏过了，工程师的 review burden 就从"逐行读"降到"确认护栏过了"。

### 阶段

```
  new_feature  →  implement  →  archived
    (scope)       (build+test)    (record)
                       ↓
                    review
                (independent check
                 at the boundary)
```

- **`new_feature`**：和工程师对齐 Intent + Structure，写到 `.harness/tasks/<id>/task.md`。**不许写代码**，**≤5 文件读取预算**。
- **`implement`**：按 planned_files 写代码 + 测试。task.md 是 durable memory，每个有意义的 turn 都要更新。
- **`review`**：在独立子进程（claude -p 或 cursor-agent -p）里跑，**只能看 Intent + Structure + diff + 项目规约**，**看不到 Decisions 和 Stage Log**——这是信息隔离合约，确保 reviewer 给出未被实现者叙事污染的独立判断。
- **`archived`**：把 task 冻结成一张结构化卡片（entities / files_touched / modules / one_liner），落到 `.harness/archive/<id>.md` + helm DB 索引。新任务创建时按 token 精确匹配查找相关老任务，自动写进 Related Tasks。

阶段是**单调向前**的——一旦推进就不能回退。Scope 变了就在原阶段改 task.md 的 In/Out，不开倒车。

### 怎么用

**从 helm UI**：

- 左侧 Harness 入口 → *"+ New Harness task"*，填项目路径 + 一句话描述
- 卡片上的按钮：Open task.md / Open in Cursor / Run review / Push review to chat / Archive

**从 Cursor / Claude Code chat 里**（通过 MCP 工具，agent 自己调）：

```text
harness_create_task     创建任务 + 自动检索相关历史
harness_get_task        读全字段
harness_update_field    更新 Intent/Structure/Decisions/Risks/planned_files
harness_append_stage_log  追加时间线
harness_advance_stage   推进阶段（强制单调）
harness_run_review      spawn 独立子进程跑 review
harness_get_review_report  拉报告
harness_push_review_to_implement  通过 host_stop 把报告注入实施 chat
harness_archive         归档 + 写入索引
harness_search_archive  token 精确匹配检索过往任务
```

### 信息隔离举例

implement chat 里 agent 写了一段代码 + 一段"我之所以选 X 不选 Y 是因为…"的 Decisions。当工程师触发 review：

- ✅ reviewer 看到：Intent / Structure / diff / `CONVENTIONS.md` 全局规约
- ❌ reviewer 看不到：Decisions / Stage Log / implement chat 历史

这是故意的。reviewer 的价值在于"独立判断 diff 是否实现了 intent"——如果它看了 implementer 的论证，就会被叙事带偏，退化成"评估 implementer 的论证是否合理"，产出共识而非洞察。当 reviewer 提出 implementer 已经驳回过的方案，是预期的——工程师作为决策者，看 reviewer 在不知情下的独立观点是否动摇了 implementer 的原 rationalization。

更多细节：`docs/ARCHITECTURE.md`、`.harness/templates/task.md`。

## 架构速览

```
┌─────────────────────────────────────────────────────────────┐
│ Cursor IDE (chat)                                            │
│  ↳ public hooks → helm-hook CLI → UDS bridge                 │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ helm Electron main process                                   │
│  ├─ BridgeServer (UDS)        - session_start / approval /…  │
│  ├─ ApprovalRegistry          - pending / settled / policy   │
│  ├─ KnowledgeProviderRegistry - local roles / depscope / …   │
│  ├─ EventBus                  - SSE fan-out                  │
│  ├─ HTTP API (127.0.0.1:port) - /api/* + /mcp/sse            │
│  ├─ EngineRouter              - claude / cursor adapters     │
│  └─ LarkChannel  (optional)   - lark-cli subprocess          │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ Renderer (React 19, Vite, no framework)                      │
│  Approvals · Active Chats · Bindings · Campaigns · Roles    │
│  Requirements · Harness · Settings                           │
└─────────────────────────────────────────────────────────────┘
```

详细设计：[`PROJECT_BLUEPRINT.md`](./PROJECT_BLUEPRINT.md) · [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)

## 开发

```bash
# 测试
pnpm test           # 单元（vitest）—— 1158 cases
pnpm test:e2e       # 端到端 —— 134 specs
pnpm typecheck

# 构建
pnpm build:backend  # tsup → dist/electron/*.cjs
pnpm build:web      # vite → web/dist/*
pnpm build          # both

# 打包
pnpm package        # build + electron-builder
pnpm package:mac    # build + macOS .dmg
```

约定：

- **AI agent 协作规范**：[`AGENTS.md`](./AGENTS.md)
- **当前进度**：[`PROGRESS.md`](./PROGRESS.md)
- **路线图**：[`docs/ROADMAP.md`](./docs/ROADMAP.md)
- **分支命名**：每个需求一个独立语义化分支（`feat/` / `fix/` / `chore/` / `docs/` / `refactor/`），不复用工作树自动生成的分支名

## 项目布局

```
electron/             Electron 主进程 + preload
src/
  app/                orchestrator + lark-wiring + tool-guide
  api/                HTTP server (renderer + MCP SSE)
  approval/           registry + policy + handler
  bridge/             UDS protocol + server (Cursor hooks)
  channel/lark/       lark-cli adapter + binding resolver
  channel/local/      Electron notifier
  cli-agent/          claude / cursor-agent CLI wrappers
  config/             ~/.helm/config.json schema + loader
  engine/             EngineRouter + claude / cursor adapters
  events/             AppEvent bus
  harness/            workflow library + file-io + review-runner
  knowledge/          providers (local-roles / depscope / req-archive)
  mcp/                helm MCP server (30+ tools)
  roles/              role + chunk + RAG (cosine + conflict detect)
  storage/            sqlite migrations + repos
  summarizer/         campaign summary (cursor or claude LLM)
  workflow/           campaign / cycle / task engine

web/src/
  pages/              Approvals / Chats / Bindings / Campaigns /
                      Roles / Requirements / Harness / Settings
  components/         Layout (sidebar) + small UI primitives
  hooks/              useApi / useEventStream

bin/                  helm + helm-hook CLI entry points
tests/                vitest unit + e2e + renderer
docs/                 ARCHITECTURE / ROADMAP / design notes
.harness/             on-disk Harness task scaffold (tasks/ + archive/)
```

## 与前身项目的关系

Helm 合并自：

- [`agent2lark-cursor`](https://github.com/sherlockfeng/agent2lark-cursor) — 飞书 ↔ Cursor 中继 + 远程审批
- [`relay`](https://github.com/sherlockfeng/relay) — MCP 多 Agent 编排

老项目仓库归档为只读 reference。Helm 不读老项目的运行时数据；如需保留请用户自行复制。

## License

TBD，倾向 MIT。
