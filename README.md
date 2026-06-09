# Helm

> macOS 桌面 app — chat-based 知识管理：你的 AI coding agent 用什么知识，从对话里能沉淀什么知识。

Helm 旁观你和 **Cursor / Claude Code / Codex** 的所有 chat，把"对话 → 知识沉淀 → 知识注入"做成一个本地闭环：

- **Knowledge IN**：role 绑定 + 检索到的 chunks 在 sessionStart 注入到 agent，让你的 AI 一开口就懂你的项目。
- **Knowledge OUT**：agent 回答里值得记下来的片段被自动标成候选，一键 promote 到永久知识库。
- **Verification**：知识不能只进不出地长——内置的 verification 关卡跑回归用例确认它们仍然对。

零云依赖，所有数据在 `~/.helm/`。

## 核心闭环

```
┌─────────────────────────────────────────────────────────────┐
│  你的 Coding Agent (Cursor / Claude Code / Codex)             │
└────────────────────────────────┬─────────────────────────────┘
              hooks / MCP        │
                                 ▼
        ┌───────────────────────────────────────────┐
        │              helm desktop app              │
        │  ┌─────────────────────────────────────┐  │
        │  │  Conversations                       │  │
        │  │   ├─ Knowledge IN  (roles + chunks)  │  │
        │  │   └─ Knowledge OUT (promote / drop)  │  │
        │  └─────────────────────────────────────┘  │
        │  ┌─────────────────────────────────────┐  │
        │  │  Knowledge                           │  │
        │  │   ├─ Library  (curated chunks)       │  │
        │  │   ├─ Review   (pending candidates)   │  │
        │  │   └─ Sources  (subscribed repos)     │  │
        │  └─────────────────────────────────────┘  │
        │  ┌─────────────────────────────────────┐  │
        │  │  Verification                        │  │
        │  │   ├─ Cases  ├─ Runs  └─ Coverage     │  │
        │  └─────────────────────────────────────┘  │
        └───────────────────────────────────────────┘
```

## 它做什么

- **💬 多 agent 旁观** — 装一次 hook，Cursor / Claude Code 的每次 prompt + response 都进 helm 的 Conversations。Codex 通过 MCP 注册（hook 等上游支持）。
- **🧠 Knowledge IN：角色注入** — 给 chat 绑一个或多个 role（`Goofy 专家` / `容灾大盘专家` …），sessionStart 自动把 role 的 system prompt + 相关 chunks 注入到 agent context。RAG 走 cosine + entity 融合排序。
- **📥 Knowledge OUT：候选沉淀** — agent 的回答里抓出值得记下来的片段，标成 `pending candidate`，在 Conversations detail 或 Review inbox 里一键 promote / dismiss。`update_role` 自带语义冲突检测（cosine ≥ 0.85 提示用户确认）。
- **📚 Knowledge 三层** — Library（已沉淀 chunks，可搜可编辑）、Review（待 triage 的候选）、Sources（订阅的远端知识库，自动 sync）。
- **🪪 知识源接入** — `KnowledgeProvider` 抽象 + 仓库订阅器，已接入 llm-wiki 等仓库的 import / sync。支持 helm-native / llm-wiki / generic 三种 layout。
- **✅ Verification** — 给知识写回归 case + 调度 runs，按 entity/file/role 维度看 coverage，知识更新后自动 re-run 受影响的 case。
- **🔌 MCP server** — `127.0.0.1:17317/mcp/sse` 暴露 30+ 工具给 agent（roles、knowledge、approvals、harness、…），一键 setup 写各 agent 的 mcp config。
- **⚙️ 多引擎切换** — Settings → Default engine，全局选 Cursor 或 Claude Code，summarizer / harness reviewer / role-trainer 三处统一切换；热生效。

## 快速开始

```bash
pnpm install

# 一键启动（推荐）：构建后端 + 渲染层，启动 Electron
pnpm start

# 或：dev 模式（renderer 热重载 + 后端 watch；分三个终端跑）
pnpm dev:backend       # 终端 1
pnpm dev:web           # 终端 2
HELM_DEV=1 pnpm dev:electron   # 终端 3
```

首次启动后，按这个顺序走：

1. **装 hooks**：Settings → Cursor / Claude Code 卡片上的 *"Install hooks"*。
   - Cursor 写 `~/.cursor/hooks.json`
   - Claude Code 写 `~/.claude/settings.json`（订阅 UserPromptSubmit + Stop）
   - Codex 目前只装 MCP（hook 上游支持待落）
2. **订阅 knowledge source**（可选）：Knowledge → Sources → 选个仓库订阅；首启给了 `llm-wiki` 一键 enroll。
3. **绑 role**：Conversations → 选一条 chat → KNOWLEDGE IN 里 `+ role`。

打开新的 agent session，对话和检索就开始进 helm。

## 架构速览

```
┌─────────────────────────────────────────────────────────────┐
│  AI Coding Agent  (Cursor / Claude Code / Codex)             │
│   ↳ hooks      → bin/helm-hook*.mjs → UDS bridge             │
│   ↳ MCP tools  ↘                                             │
└─────────────────────────────────────────────────┬───────────┘
                                                  │
                                                  ▼
┌─────────────────────────────────────────────────────────────┐
│ helm Electron main                                           │
│  ├─ BridgeServer (UDS)        - session/prompt/response/stop │
│  ├─ HostAdapter pile          - cursor / claude-code / codex │
│  ├─ EngineRouter              - claude / cursor adapters     │
│  ├─ KnowledgeProviderRegistry - local roles, repos, depscope │
│  ├─ ApprovalRegistry          - pending / settled / policy   │
│  ├─ EventBus                  - SSE fan-out                  │
│  ├─ HTTP API (127.0.0.1:port) - /api/* + /mcp/sse            │
│  └─ LarkChannel  (optional)   - 远程 binding + 镜像        │
└─────────────────────────────────────────────────┬───────────┘
                                                  │
                                                  ▼
┌─────────────────────────────────────────────────────────────┐
│ Renderer (React 19 + Vite, no framework)                     │
│  Conversations · Knowledge {Library/Review/Sources}          │
│  Verification {Cases/Runs/Coverage} · Settings               │
└─────────────────────────────────────────────────────────────┘
```

详细设计：[`PROJECT_BLUEPRINT.md`](./PROJECT_BLUEPRINT.md) · [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)

## Harness 工作流（次要）

Helm 还内置一套 AI-assisted feature development 工作流（`new_feature → implement → archived`，independent reviewer + 信息隔离合约）。目前是 Settings → Advanced 的隐藏入口，不是这个 PR 周期的核心叙事，不展开。要看流程见 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) 的 Harness 一章，或 `.harness/templates/task.md`。

## 远程协作（可选）

历史项目（agent2lark-cursor）合并进 helm，仍然支持把 chat 镜像到 Lark thread + 远程审批。Conversations detail pane 不再展示这条入口；Settings → Bindings 走配置和管理。

## 开发

```bash
# 测试
pnpm test           # 单元（vitest）
pnpm test:e2e       # 端到端
pnpm typecheck

# 构建
pnpm build:backend  # tsup → out/electron/*.cjs + out/host/*/hook-entry.js
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
  api/                HTTP server (renderer + MCP SSE) + conversation-detail aggregator
  approval/           registry + policy + handler
  bridge/             UDS protocol + server
  channel/lark/       lark-cli adapter + binding resolver
  channel/local/      Electron notifier
  cli-agent/          claude / cursor-agent CLI wrappers
  config/             ~/.helm/config.json schema + loader
  engine/             EngineRouter + claude / cursor adapters
  events/             AppEvent bus
  harness/            workflow library + file-io + review-runner
  host/               adapters for cursor / claude-code / codex
                       └─ installer + normalize + hook-entry + transcript
  knowledge/          providers (local-roles / depscope / req-archive)
  knowledge-repo/     importer + sync runner for subscribed repos
  mcp/                helm MCP server
  roles/              role + chunk + RAG (cosine + entity + conflict detect)
  storage/            sqlite migrations + repos
  summarizer/         campaign summary
  workflow/           campaign / cycle / task engine

web/src/
  pages/              Conversations / KnowledgeLibrary / KnowledgeReview /
                      KnowledgeSources / VerificationCases / VerificationRuns /
                      VerificationCoverage / Settings (+ Approvals / Bindings /
                      Harness under Settings › Advanced)
  components/         Layout (sidebar) + Combobox / Dialog / EmptyState / ...
  hooks/              useApi / useEventStream

bin/                  helm + helm-hook + helm-hook-claude CLI entry points
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
