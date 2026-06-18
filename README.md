# Helm

> macOS 桌面 app — chat-based 知识管理：你的 AI coding agent 用什么知识，从对话里能沉淀什么知识。

**核心问题**：你每天和 AI agent 聊大量技术对话——排查问题、做架构决策、踩坑、问中台用法。对话里有真金白银的知识（决策理由、排错路径、领域事实），但聊完就丢了：下次同样的问题重新聊一遍，新对话开始时 agent 对你的项目一无所知。Helm 把这个循环接起来。

Helm 旁观你和 **Cursor / Claude Code / Codex** 的所有 chat，把"对话 → 知识沉淀 → 知识注入"做成一个本地闭环。两条流向**正交、互不依赖**：

- **Knowledge IN（注入）**：给 chat 绑 role，sessionStart 自动把该领域的 system prompt + 相关 chunks 注入给 agent——agent 一开口就懂你的项目约定。
- **Knowledge OUT（提取）**：helm 对每条对话做策展建议——"这条对话涉及某个领域，要不要给对应的专家提取知识？"（已有 role 匹配）/"反复提到某个主题但没有 role 覆盖，要不要新建一个？"（领域缺口）。提取产物不是原文片段，是 LLM 整理的知识点，分类成 spec / decision / warning / workaround 等，并区分**新知识**和**对已有知识的更新**。
- **Verification**：知识不能只进不出地长——内置 verification 关卡跑回归用例，保证知识库是"活的且对的"，不是过时笔记的坟场。

零云依赖，所有数据在 `~/.helm/`。

## 为什么需要 helm

开发者在 terminal 里用 AI coding agent（Cursor / Claude Code / Codex）工作，常常同时推进多个项目。当工作集中在某个方向时，不同任务会反复用到一批相关但不完全相同的领域知识。

**场景一：不同需求，依赖同一批知识。** 同一方向下的两个需求，往往各自有专属的实现细节，但都建立在同一块领域知识之上。这块共享知识，在每个需求里都要在对话里重新讲给 agent 一遍。

**场景二：同方向的优化需求。** 一个服务改过一版后还会有后续优化；新的对话里 agent 需要重新了解这个领域是什么、该服务如何实现、依赖哪些基础设施。这些背景在上一个需求里已经讲过，这次仍要再讲。

由此归纳出两个通用问题：

1. **知识散落在对话里**：讲清楚的背景随对话关闭而丢失，下一个 agent、下一个需求都看不到。
2. **知识需要更新和复用**：同方向反复用到同一批知识；代码迭代后知识本身也要随之更新，而不是每次从零再讲。

helm 把这两个问题收敛成一条本地闭环：对话里讲清楚的知识被沉淀成可复用、可更新、可校验、可共享的资产，每个新需求都建立在上一次的基础上，而不是从零开始。

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

## 设计红线

历史上踩过的坑，固化成不可违反的原则：

1. **OUT 不依赖 IN** — 提取知识不需要先绑 role。"想抓知识必须先绑定"是把两条正交的流捆在一起，犯过一次，不再犯。
2. **hook 只旁观，永不阻断** — 任何 helm 故障（bridge 不在 / transcript 读不到 / LLM 挂了）都不能影响用户的 chat。hook 永远返回放行。
3. **chat 是一等公民的知识容器** — 每条对话有 TL;DR、turn timeline、策展报告，不是一次性日志。
4. **LLM 调用必须有明确触发原因 + 用户可感知** — helm 自己 spawn 的 LLM 子进程带 `HELM_INTERNAL_LLM=1` 防递归（TL;DR 生成曾把自己的 prompt 模板捕获成新对话，几分钟产了 3631 个幽灵 chat）。
5. **宁可静默不要噪声** — 没把握的建议不出现。实体建议有 stoplist（PR/CI/JSON 这种通用词永不触发"建 role"提示）、有阈值（≥3 次提及才算）。

## 用户路径与路线图

chat → 知识的 5 条用户路径（详见 memory 的 OUT path audit）：

| 路径 | 说明 | 状态 |
|---|---|---|
| A | chat → 已有 role 提取知识（update + new） | ✅ 实体匹配发现 + LLM 策展 |
| B | chat → 新建 role（领域缺口） | ✅ 未知实体检测 + 一键 spawn role |
| C | chat 揭示已有 chunk 过时 / 矛盾 | 🚧 update 候选已有；accept 后真正替换原 chunk + diff UI 待做 |
| D | chunk 反查来源 chat（provenance） | ⏳ 数据有（candidate 带 hostSessionId），UI 未暴露 |
| E | 跨 chat 聚合（同主题多次出现 → 集中沉淀） | ⏳ 未开始 |

**下一步：知识与远端共享仓库双向同步**

- **Pull（已有基础）**：Sources 订阅 → git clone/fetch → profile-aware import（helm-native / wiki / generic 三种 layout）→ 冲突落 `knowledge_merge_conflict` 表。待补：定时 sync 调度 + 冲突 UI。
- **Push（待建）**：从 chat 提取并 promote 的知识，序列化回 markdown → git branch → 开 MR 回传共享仓库，让团队共享个人对话里沉淀的知识。`knowledge-repo/publish.ts` + `pr-runner.ts`（gh/glab 封装）已就位，缺 orchestrator 接线和 UI 入口。

## 它做什么

- **💬 多 agent 旁观** — 装一次 hook，Cursor / Claude Code 的每次 prompt + response 都进 helm 的 Conversations。Codex 通过 MCP 注册（hook 等上游支持）。
- **🧠 Knowledge IN：角色注入** — 给 chat 绑一个或多个 role（按领域组织的专家），sessionStart 自动把 role 的 system prompt + 相关 chunks 注入到 agent context。RAG 走 cosine + entity 融合排序。
- **📥 Knowledge OUT：候选沉淀** — agent 的回答里抓出值得记下来的片段，标成 `pending candidate`，在 Conversations detail 或 Review inbox 里一键 promote / dismiss。`update_role` 自带语义冲突检测（cosine ≥ 0.85 提示用户确认）。
- **📚 Knowledge 三层** — Library（已沉淀 chunks，可搜可编辑）、Review（待 triage 的候选）、Sources（订阅的远端知识库，自动 sync）。
- **🪪 知识源接入** — `KnowledgeProvider` 抽象 + 仓库订阅器，已接入共享知识仓库的 import / sync。支持 helm-native / wiki / generic 三种 layout。
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
2. **订阅 knowledge source**（可选）：Knowledge → Sources → 选个仓库订阅；首启内置一个示例知识仓库可一键 enroll。
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
