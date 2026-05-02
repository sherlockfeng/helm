# 新 Session 接手指南

> 给在新 Claude Code session（绑定到 `/Users/bytedance/projects/helm`）接手 Helm 工作的 agent。

## 先读这几份（按顺序）

1. **[PROJECT_BLUEPRINT.md](./PROJECT_BLUEPRINT.md)** — 完整设计，~1500 行，是真相源
2. **[PROGRESS.md](./PROGRESS.md)** — 当前进度、设计决定、待决定项
3. **[AGENTS.md](./AGENTS.md)** — 强制行为规则（不可妥协的 4 条）
4. **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)** — 三层抽象 + 三大数据流的速查
5. **[docs/ROADMAP.md](./docs/ROADMAP.md)** — Phase 划分

读完这五份你就有完整设计上下文。git log 看 commit 链补充时间线。

## 必须知道的关键上下文

### 项目身份

- macOS 桌面 app（Electron），Cursor IDE 的本机管家
- 合并自两个前身项目（agent2lark-cursor / relay），但**不读**它们的运行时数据，**只复制代码**作为起点
- 一期 Cursor only，Lark 兜底远程，二期再做 PWA 和多 host

### 用户给过的 4 条不可妥协强制要求

详见 AGENTS.md "强制要求" 节：

1. **每个用户流程都有 e2e 测试**（攻击性视角，不写乐观测试）
2. **结构化 JSON Lines 日志**（按模块 + 按 session 归档，便于用户反馈 bug 提供 context）
3. **UI 设计与测试交独立 subagent**（资深 Mac app 设计专家 / 资深攻击性测试专家）
4. **TypeScript 强制**（来自前身项目的 .js 复制时改 .ts；禁 console.log；禁 any）

### 三个核心抽象（蓝图 §10 / §11 / §11.5）

```
HostAdapter        谁产生 chat 事件流？(Cursor MVP，ClaudeCode 预留)
RemoteChannel      镜像到哪里？(Local 必启 + Lark opt-in)
KnowledgeProvider  注入什么外部知识？(LocalRoles 内置 + Depscope reference)
```

### KnowledgeProvider v1 已敲定为"轻量版"

- App 内集中配置 mapping（cwd 前缀 → provider 自定义字段）
- **不**读 `.helm-project` / 不读 `rush-scm.json` / 不读任何 monorepo 工具配置
- 单 chat 单 scope；filePath-based 切换留给 v1.5

### depscope 双重身份

- **MVP-3**: 作为 `DepscopeProvider`（KnowledgeProvider）注入 TikTok Web 依赖知识到 Cursor chat
- **Phase 2**: depscope 进程内可挂 relay 模块作为 `DepscopeRelay`（mobile/PWA 通道之一）
- 两者**部署层复用，概念层隔离**：relay 模块跟 ServiceSpec / call_tracer 互不依赖

参考前身项目（如需读源码）：
- `/Users/bytedance/projects/agent2lark-cursor`
- `/Users/bytedance/projects/relay`
- `/Users/bytedance/projects/depscope/pipeline/AGENT_GUIDE.md`

## 当前进度

**Phase 0 — 仓库骨架已完成。** 见 PROGRESS.md。

```
3687b62 chore(phase-0): finish skeleton — configs, stubs, docs
041466e docs: simplify KnowledgeProvider to lightweight v1
bda873a docs: blueprint adds KnowledgeProvider + RelayBackend abstractions
a15ca90 chore: initial scaffold — blueprint, package.json, progress log
```

**下一步：Phase 1 — 数据层**（蓝图 §21 Phase 1）：

- `src/storage/database.ts` 全表（蓝图 §9）
- `src/storage/migrations.ts` schema migration 框架（不导入老数据）
- 单元测试覆盖每个表 CRUD + migration 幂等
- 用 `better-sqlite3`，`PRAGMA journal_mode = WAL; foreign_keys = ON;`

## 待决定的 Open Questions

见 PROJECT_BLUEPRINT.md §23 + PROGRESS.md "待决定"。摘要：

- [ ] 是否一期就拆 daemon / UI（推荐：不拆）
- [ ] 一期是否就支持 Claude Code（推荐：不做，预留接口）
- [ ] DMG 是否签名 / 公证（建议至少 ad-hoc sign）
- [ ] DepscopeProvider 是否 MVP-3 并入（推荐：是）
- [ ] Phase 2 RelayBackend 默认 backend（推荐：内部走 Depscope，开源走 Cloudflare Tunnel）

不阻塞 Phase 1 启动。Phase 1 不需要这些决定。

## 我做了主动判断的几处（review 时注意）

Phase 0 中：

1. **HTTP API 端口默认 17317**（避开常见 dev 端口；可改）
2. **依赖版本**：`@cursor/sdk` 和 `@larksuite/cli` 用了猜测版本号，install 时可能要调
3. **`bin/helm-hook.mjs` fallback**：approval → `permission: "ask"`、submitPrompt → `continue: true`、其他 → `{}`
4. **dev 模式**走 `HELM_DEV=1` 环境变量切到 vite dev server
5. **License**：README 中倾向 MIT，未最终定

## 不要做的事

- 不要重读老项目的运行时数据（`~/.agent2lark/*` / `~/.relay/*`）
- 不要在 hooks 之外用 Cursor 私有 IPC / DOM 自动化
- 不要写 `console.log`（用 logger）
- 不要写乐观路径测试

## 建议的开场 prompt（用户使用）

在新 session 里粘贴：

> 我正在接手 Helm 项目（macOS 桌面 app，Cursor 的本机 chat 管家）。请按 [HANDOFF.md](./HANDOFF.md) 的"先读这几份"列表读完所有文档和最近的 git log，然后用 5-10 句话总结你理解的项目状态和下一步要做什么，等我确认后再开始 Phase 1。
