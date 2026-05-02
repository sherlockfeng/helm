# AGENTS.md — Helm

本文档面向所有在 Helm 仓库工作的 AI agent（Claude / Cursor / 其他）。

## 必读

在动 Helm 任何代码之前，必须读完：

1. [`PROJECT_BLUEPRINT.md`](./PROJECT_BLUEPRINT.md) — 完整架构与每节实现规范
2. 与你任务相关的角色文档：
   - [`docs/roles/product.md`](./docs/roles/product.md)
   - [`docs/roles/developer.md`](./docs/roles/developer.md)
   - [`docs/roles/tester.md`](./docs/roles/tester.md)
3. [`docs/tech/HOOK_FLOW.md`](./docs/tech/HOOK_FLOW.md) — Cursor hook 数据流与 bridge 协议

## 强制要求

### 1. 每个用户流程必须有 e2e 测试（攻击性视角）

**用户级强制要求，不可妥协。** 详见蓝图 §17.4。

- 每条用户流程一个 e2e 套件目录（`tests/e2e/<flow-name>/`）
- 每个套件至少包含：`happy.spec.ts`（正常路径）+ `attack.spec.ts`（≥3 条攻击变体）
- 攻击性视角：边界、并发、超时、损坏输入、外部依赖故障、用户中断等
- **禁止乐观测试**：不写"假设外部服务总是返回正确数据"的测试
- CI 里 e2e 套件必须全绿才能合 PR
- 所有外部依赖 mock，禁止打真实网络

写完代码即写 e2e。新增功能没有 e2e 视为没完成。

### 2. 详细的结构化日志

**用户级强制要求。** 详见蓝图 §19.5。

- 每个模块独立 logger（`src/logger.ts` 工厂）
- 结构化 JSON Lines；包含 `host_session_id` 等关联字段
- 敏感信息按 §19 规则 redact
- 每个 host_session 独立归档到 `~/.helm/logs/sessions/<id>.jsonl`
- 不允许 `console.log`；用 logger
- 改代码时同步检查日志：新增分支必须有相应 log（特别是错误路径）

### 3. 测试 / UI 设计交独立 subagent

工作流约定：

- **UI 设计与交互**：交给 senior Mac app 设计交互专家 subagent
  - Mac 一等公民：尊重 macOS HIG，菜单栏行为、原生通知、键盘快捷键
  - 不接受"web app 套个壳"的设计
- **测试**：交给 senior 攻击性测试专家 subagent
  - 不做乐观假设
  - 主动找出竞态、空指针、超时、外部依赖断网等场景
  - 反对"测试只覆盖 happy path"

调用约定：在动 UI / 测试相关代码前先调对应 subagent。

## 工作准则

### Doc-first

任何代码 / 设计变更，**先调 `update_doc_first` 写文档，再写代码**。

- Helm 自身的开发遵循同样的 doc-first 规则（你正在构建的工作流，自己也用）
- 接口变更必须先更新 `PROJECT_BLUEPRINT.md` 对应节
- doc-first 的 audit token 必须在 `complete_task` 时附上

### 不复用老项目运行时数据

- 不读 `~/.agent2lark/`、`~/.relay/`
- 不在代码里做"老格式 → 新格式"自动转换
- 老仓库只是代码 reference；运行时是新开始

### TypeScript 强制

- **所有 `.js` 文件复制过来时改成 `.ts`**（来自 agent2lark-cursor 的 JS 文件须 TS 化）
- 全部公开函数有完整类型注解
- 禁用 `any`；必要时用 `unknown` + 类型 narrowing

### Git 分支

每个需求独立语义分支，格式：

- `feat/<description>`
- `fix/<description>`
- `chore/<description>`
- `docs/<description>`
- `refactor/<description>`

不复用 Claude Code 自动生成的 worktree 分支名。

### 错误处理

- 所有外部 IO（hooks / bridge / Lark / depscope / SQLite / 子进程）必须 try/catch
- 错误不允许 swallowed；至少 log warn 并附上完整 context
- bridge / 子进程 / 远程服务的失败：返回明确 fallback，不阻塞主流程

### 不要

- 不要写 `console.log`
- 不要在主流程中静默 swallow 异常
- 不要写"乐观测试"
- 不要绕过 Cursor public hooks（用私有 IPC / DOM 自动化）
- 不要把 API key / token / 用户消息直接打日志
- 不要在 PR 描述外的地方提及 fix 的具体 issue 号（commit 信息保持自包含）

## 与 helm 自身工作流的关系

helm 是一个用 doc-first / cycle / role 的工作流构建出的产品。在开发 helm 时同样使用这套工作流：

```
init_workflow(repo)
  → Product Agent: get_cycle_state, update_doc_first, create_tasks
  → Dev Agent: get_my_tasks, update_doc_first, implement, complete_task (with audit token)
  → Test Agent: write/run e2e (attacker mode), complete_cycle or create_bug_tasks
```

完整循环见蓝图 §13.3 prompts。
