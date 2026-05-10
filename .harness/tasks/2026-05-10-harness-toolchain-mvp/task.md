# Harness toolchain MVP — chat_template-driven workflow scaffold

| field           | value                                       |
| --------------- | ------------------------------------------- |
| task_id         | 2026-05-10-harness-toolchain-mvp            |
| current_stage   | implement                                   |
| created_at      | 2026-05-10                                  |
| project_path    | /Users/bytedance/projects/helm              |
| host_session_id | (n/a — this task is bootstrapping Harness in helm itself; Cursor binding deferred until self-hosted dogfooding) |
| implement_base_commit | 4c93f18b521dc06244de96cd76521bde8201b92d |

## Intent

### Background

helm 已经是一个综合提效平台：编排 Cursor / Claude Code chat，桥接 Lark，沉淀 role 知识库（含语义冲突检测），暴露 MCP 工具给 agent。但用户在 Cursor 里走"完整 feature 开发"时，仍然要靠自觉跟 Harness rulebook（new_feature → implement → review → archive，加信息隔离）——helm 没有承接这套流程的脚手架。当前的 roles 抽象是"持久领域知识"（TCC 专家、Disaster Dashboard 专家），不适合表达"流程"语义（stage 单调、tool 限制、task lifecycle）。

Harness 的核心价值是让工程师把粗粒度任务交给 AI 时 review 成本可控——靠两道护栏（行为：tests；形式：lint + reviewer）+ 信息隔离 + durable memory（task.md）。要落到 helm 里就需要一套独立的脚手架。

### Objective

helm 提供一套 **chat_template** 抽象 + **Harness** 的首发实现：用户从 helm UI 启动一个 Harness task，helm 自动注入 stage-specific system prompt + MCP 工具集；agent 通过 `harness_*` MCP 工具操作 task.md 状态、推进 stage、跑 review 子进程、写 archive；archive 同时落盘和入 helm DB 索引，下次新 task 创建时按意图查询并注入 Related Tasks。

"完成"的单句定义：**用户能在 helm UI 上点一下创建 Harness task，跟 Cursor agent 完成 new_feature → implement，让 helm 起 review 子进程审一轮，把审稿建议手动推回 implement chat，最后归档并把 archive 卡片写入索引——全流程不出 helm，且下个 task 创建时能看到上一个 task 的 Related Tasks。**

### Scope

**In:**
- 新抽象 `chat_template`，与 roles 解耦。首发只有 `harness-new-feature` / `harness-implement` 两个 chat 模板。
- Harness 三个 stage 的 system prompt 模板（new_feature / implement / review）。重 tool 轻 prompt：prompt 只放 mental-model 精炼版 + 当前 stage hard rules。
- 双写持久化：`.harness/tasks/<id>/task.md` 和 `.harness/archive/<id>.md` 是 source of truth；helm DB 维护 `harness_tasks` / `harness_archive_cards` / `harness_reviews` 三张表做索引。
- 10 个 MCP 工具：`harness_create_task`、`harness_get_task`、`harness_update_field`、`harness_append_stage_log`、`harness_advance_stage`、`harness_run_review`、`harness_get_review_report`、`harness_push_review_to_implement`、`harness_archive`、`harness_search_archive`。
- review 子进程：复用 `src/cli-agent/claude.ts` 的 `claude -p` 模式；helm 拼装 Intent + Structure + diff + 全局 conventions（**不含** Decisions / Stage Log）；报告落 helm UI 卡片。
- diff base = 进入 implement 时的 git HEAD（写进 task.md 的 Stage Log）。review 时 diff = 当前 HEAD vs 这个 SHA。base 不存在时报错让用户重指定。
- archive 检索的触发：在 `harness_create_task` 内部立刻按 intent 文本跑一次 `harness_search_archive`，命中结果写入 task.md 的 Related Tasks。其他时机由 agent 主动调用。
- helm UI 新增独立 Harness 页：列所有 task 卡片，按 stage 分组；每张卡的操作按钮：Open task.md / Open in Cursor / Run review / Archive（按 stage 显示）。
- helm Settings 新增 "Global Harness Conventions" 多行字段，review 子进程从这里读规约。
- review → implement 回流：UI 卡片上 "Push to implement chat" 按钮，通过 Phase 33 的 `host_stop` 长轮询把报告注入实施 chat。
- Stage 转换主路径：agent 调 `harness_advance_stage` MCP 工具；UI 按钮兜底（异常情况下手动推进）。
- 一个 Harness task 全程绑定一个 Cursor chat（new_feature → implement 同 chat 接力）；review 是子进程插播，不占 chat。
- Information isolation：review 严格（helm 控制注入，天然清白）。implement 阶段不强制 planned_files 限制——靠 prompt 提醒，agent 自觉。

**Out:**
- 项目级 `CONVENTIONS.md`（只支持 helm Settings 的全局字段，跨项目共享）。
- `planned_files` 的强制拦截（不动 `beforeMCPExecution` hook 拦 read/edit）。
- 自动推 review 报告到 implement chat（必须用户手动点按钮）。
- file watcher 自动同步 task.md 到 helm DB（只在工具调用时 re-read + UI reindex 按钮）。
- archive 检索的 sessionStart 自动注入（仅在 `harness_create_task` 时跑一次，写进 Related Tasks）。
- 多人协作下的 task ownership / archive merge（单人本地工作流先跑通）。
- review subprocess 的多轮对话（一次性出报告即可，不再交互）。
- Harness 流程的 Cursor slash 解析（不接 Cursor `/implement` 之类的快捷输入；agent 主动调 MCP 工具就行）。

## Structure

### Entities

- **HarnessTask** — task.md 在数据库的对应行。字段：`id`（= task_id, e.g. `2026-05-10-foo-bar`）、`title`、`current_stage`（`new_feature` | `implement` | `archived`）、`project_path`、`host_session_id`（绑定的 Cursor chat，可空）、`intent_json`、`structure_json`、`decisions_json`、`risks_json`、`related_tasks_json`、`stage_log_json`（append-only 数组）、`implement_base_commit`（进入 implement 时的 SHA，可空）、`created_at`、`updated_at`。
- **ArchiveCard** — archive 入索引的结构化字段。字段：`task_id` (PK + FK→HarnessTask.id)、`entities_json`、`files_touched_json`、`modules_json`、`patterns_json`、`downstream_json`、`rules_applied_json`、`one_liner`、`full_doc_pointer`（`.harness/archive/<task_id>.md` 的相对路径）、`project_path`、`archived_at`。
- **HarnessReview** — review 子进程一次产出的报告。字段：`id` (uuid)、`task_id` (FK)、`status`（`pending` | `completed` | `failed`）、`report_text`（subprocess stdout 全文，一次性写入）、`spawned_at`、`completed_at`、`base_commit`、`head_commit`、`error`（失败时填）。
- **ChatTemplate** — 抽象，本期只落两个常量：`harness-new-feature`（system prompt 模板 + 允许的 MCP 工具白名单）、`harness-implement`（同左，但工具白名单更宽，含 read/edit）。review 是 helm 内部子进程，不算 chat_template 实例。chat_template 不入 DB（先做成代码常量），未来要扩展再考虑表化。

### Relations

- `HarnessTask.host_session_id` → 既有的 Cursor host_sessions 表（已存在；外键软引用，可空）。
- `ArchiveCard.task_id` → `HarnessTask.id` (FK, ON DELETE CASCADE)。
- `HarnessReview.task_id` → `HarnessTask.id` (FK, ON DELETE CASCADE)。
- 文件层：`.harness/tasks/<task_id>/task.md` ↔ `harness_tasks` 行；`.harness/archive/<task_id>.md` ↔ `harness_archive_cards` 行。同步靠 helm 工具调用前 re-read 文件。

### Planned Files

后端（src/）：
- `src/storage/migrations.ts` — migration v10：建 `harness_tasks` / `harness_archive_cards` / `harness_reviews` 三张表 + 必要索引（按 `project_path` + 按 `archived_at`）。
- `src/storage/types.ts` — 新增 `HarnessTask` / `ArchiveCard` / `HarnessReview` interface。
- `src/storage/repos/harness.ts`（新文件） — function-style repo（沿用 roles.ts 的风格）：upsertTask / getTask / listTasks / deleteTask / upsertArchive / searchArchiveByTokens / insertReview / updateReview / getReview。
- `src/harness/library.ts`（新文件） — 核心域逻辑：`createTask` / `getTask` / `updateField` / `appendStageLog` / `advanceStage`（强制单调）/ `archiveTask` / `searchArchive` / `runReview`（spawn subprocess）/ `getReviewReport` / `pushReviewToChat`。
- `src/harness/templates/new-feature.ts`（新文件） — new_feature stage 的 system prompt（精炼 mental model + hard rules）。
- `src/harness/templates/implement.ts`（新文件） — implement stage 的 system prompt。
- `src/harness/templates/review.ts`（新文件） — reviewer 子进程的 system prompt + 注入包格式（Intent / Structure / diff / conventions 拼装函数）。
- `src/harness/file-io.ts`（新文件） — `.harness/` 文件读写：`readTaskFile` / `writeTaskFile` / `readArchiveFile` / `writeArchiveFile`，含 markdown 序列化反序列化。
- `src/harness/review-runner.ts`（新文件） — 包装 `src/cli-agent/claude.ts` 的 `claude -p` 调用，注入 reviewer prompt + 不含 Decisions/Stage Log 的载荷，一次性收 stdout 写到 `harness_reviews.report_text`。
- `src/mcp/server.ts` — 注册 10 个 `harness_*` MCP 工具（新分组）。
- `src/api/server.ts` — 给 renderer 用的 HTTP 端点：GET `/api/harness/tasks`、POST `/api/harness/tasks`、POST `/api/harness/tasks/:id/run-review`、POST `/api/harness/tasks/:id/push-review/:reviewId`、POST `/api/harness/tasks/:id/archive`、POST `/api/harness/reindex`、GET/PUT 全局 conventions。
- `src/app/orchestrator.ts` — 在 sessionStart hook 中，当 chat 绑定的是 Harness task 时，按 `current_stage` 注入对应的 chat_template 系统提示 + task.md 当前内容片段。

渲染层（web/src/）：
- `web/src/pages/Harness.tsx`（新文件） — 列所有 task 卡片，按 stage 分组；每张卡片：title / created_at / project_path / current_stage / 关联 chat 链接 / 操作按钮（Open task.md、Open in Cursor、Run review、View report、Push to implement、Archive）。
- `web/src/components/Layout.tsx` — sidebar 加 `{ to: '/harness', label: 'Harness' }` 入口。
- `web/src/api/client.ts` — `helmApi.harness.*` 一组方法包装。
- `web/src/main.tsx` 或路由文件 — 加 `/harness` 路由。
- `web/src/pages/Settings.tsx` — 加 "Global Harness Conventions" 多行字段（保存到 helm 配置 / DB）。

测试（tests/）：
- `tests/unit/harness/library.test.ts` — `advanceStage` 单调性、`archiveTask` 双写、`searchArchive` 命中策略。
- `tests/unit/harness/file-io.test.ts` — task.md / archive.md 的 round-trip 序列化。
- `tests/e2e/harness-task-lifecycle/happy.spec.ts` — 创建 → advance → archive 全流程，含 Related Tasks 注入。
- `tests/e2e/harness-task-lifecycle/review.spec.ts` — review 子进程注入隔离（确保 Decisions 不在 payload 中）+ 报告回流。
- `tests/e2e/harness-task-lifecycle/attack.spec.ts` — 退步 stage 报错；找不到 task 报错；review 时 base commit 丢失报错；archive 之前没 review 警告但允许（review 是 advisory）。

总计新文件 ~15，已有文件改动 ~7，迁移 +1。

## Execution

### Actual Files

后端 — 新增：
- `src/harness/library.ts` — 域逻辑（createTask / updateField / appendStageLog / advanceStage / archiveTask / searchArchive / pushReviewToImplementChat / reindexTask + harness binding helper）。
- `src/harness/file-io.ts` — `.harness/` 文件读写 + markdown round-trip。
- `src/harness/review-runner.ts` — `claude -p` 子进程封装，负责 diff 计算 + 注入 + 报告落库。
- `src/harness/session-inject.ts` — 把 stage 系统提示注入 sessionStart additional_context 的 chokepoint。
- `src/harness/templates/new-feature.ts` / `implement.ts` / `review.ts` — 三个 stage 的 system prompt + reviewer payload 拼装函数。
- `src/storage/repos/harness.ts` — 新 repo（function-style，沿用 roles.ts 风格）。

后端 — 改动：
- `src/storage/migrations.ts` — 新增 v10：`harness_tasks` / `harness_archive_cards` / `harness_reviews`。
- `src/storage/types.ts` — 新增 `HarnessTask` / `HarnessIntent` / `HarnessStructure` / `HarnessStageLogEntry` / `HarnessRelatedTask` / `HarnessArchiveCard` / `HarnessReview` 等。
- `src/config/schema.ts` — `HelmConfigSchema` 新增 `harness.conventions` 字段。
- `src/mcp/server.ts` — 注册 11 个 harness 工具（实际多了 `harness_list_tasks` / `harness_list_reviews` / `harness_reindex_task`，以及独立的 `harness_push_review_to_implement`，超出最初规划的 10 个；`harnessConventions` / `runReviewOverride` 加入 `McpServerDeps`）。
- `src/api/server.ts` — 新增 `/api/harness/tasks`（GET/POST）、`/api/harness/tasks/:id`（GET）、`/advance`、`/review`（POST + GET）、`/api/harness/reviews/:id`、`/push-review/:reviewId`、`/archive`、`/reindex`、`/api/harness/archive`；`HttpApiDeps` 加 `runHarnessReview` 钩子。
- `src/app/orchestrator.ts` — sessionStart 处理器拼接 Harness 注入；mcpFactory 接通 `harnessConventions`；HTTP API 拿到 `runHarnessReview`。

渲染层 — 新增：
- `web/src/pages/Harness.tsx` — 列任务 / 创建表单 / Run review / Push to chat / Archive。

渲染层 — 改动：
- `web/src/components/Layout.tsx` — sidebar 加 `/harness` 入口。
- `web/src/App.tsx` — 路由表加 `/harness`。
- `web/src/api/client.ts` — `harness*` 端点 + view 类型。
- `web/src/api/types.ts` — `HelmConfig.harness?: { conventions: string }`。
- `web/src/pages/Settings.tsx` — 新增 "Harness Conventions" 多行字段。

测试 — 新增：
- `tests/unit/harness/library.test.ts`（13 cases）— createTask / advanceStage 单调性 / archiveTask 双写 / searchArchive 项目隔离 / updateField / appendStageLog / pushReviewToImplementChat 异常路径。
- `tests/unit/harness/file-io.test.ts`（2 cases）— task.md round-trip + 占位符还原为空。
- `tests/unit/harness/review-payload.test.ts`（3 cases）— **information-isolation chokepoint**：reviewer 不见 Decisions / Stage Log。
- `tests/e2e/harness-task-lifecycle/happy.spec.ts`（5 cases）— 全流程 + Related Tasks 自动填充 + 攻击。
- `tests/e2e/harness-task-lifecycle/review.spec.ts`（4 cases）— 子进程 mock + push-to-chat + 异常路径。

合计：14 新文件、9 已有文件改动、1 migration、25 unit cases、9 e2e cases。

### Patterns Used

- **Function-style repo**（沿用 roles.ts）— 没有 OO class，每个 SQL 操作一个具名函数。
- **File-first, DB-second**（写入顺序）— 文件磁盘是 source of truth；DB 是索引。每个 mutation 先写文件，再更新 DB。
- **Chokepoint test pattern** — 信息隔离合约（`assembleReviewerPayload`）由专门 unit test 守护，未来重构能立刻发现泄漏。
- **`runReviewOverride` factory injection**（沿用 Phase 6 deps 风格）— 测试不 shell out 到 claude，直接传入桩。
- **Pseudo-binding for synthetic delivery** — 用 `channel='harness'` 的伪 channel binding 复用现成的 `enqueueMessage` + `host_stop` 长轮询管道，避免给 host_session 加新的 message queue。
- **Discriminated union for stage transitions** — `HarnessStage` 是字符串字面量联合，`canAdvance` 表显式列出允许迁移。

## Validation

### Test Plan

(已实现，见 Cases Added)

### Cases Added

- `tests/unit/harness/library.test.ts` — 13 cases
- `tests/unit/harness/file-io.test.ts` — 2 cases
- `tests/unit/harness/review-payload.test.ts` — 3 cases
- `tests/e2e/harness-task-lifecycle/happy.spec.ts` — 5 cases
- `tests/e2e/harness-task-lifecycle/review.spec.ts` — 4 cases

### Lint Results

- `pnpm typecheck` — 通过（root + web）
- `pnpm test` — 1110 passed (was 1092)
- `pnpm test:e2e` — 125 passed (was 116)
- 无 lint runner（`pnpm lint` 占位脚本）

## Validation

### Test Plan

- 单测覆盖：`advanceStage` 单调约束（implement → new_feature 必须报错）；`archiveTask` 后 helm DB 与 `.harness/archive/<id>.md` 内容一致；`searchArchive` 在按 entity 匹配时返回正确卡片；`file-io` 的 markdown round-trip。
- e2e 覆盖：通过 MCP 客户端走完 `harness_create_task` → 注入 → `harness_advance_stage` → `harness_run_review` → `harness_get_review_report` → `harness_push_review_to_implement` → `harness_archive` → `harness_search_archive` 全链路。`review.spec.ts` 显式断言 review 子进程的 prompt 中不出现 "Decisions" 或 "Stage Log"。
- 手动覆盖：在本地 helm UI 走一次端到端，确认 sidebar、卡片、按钮 UX 不别扭。

### Cases Added

(implement 阶段填)

### Lint Results

(implement 阶段填)

## Decisions

(此阶段为空——仅捕获 new_feature 时的取舍即可。当前已捕获于 chat 中：见 Risks 末尾"Pre-implement aligned forks"。implement 中产生的实施级决策在那里继续追加。)

**Pre-implement aligned forks**（这是 new_feature 阶段已和工程师达成共识的重大取舍，写出来供 implementer 自检；reviewer 不应看到此段，archive 时这段需要剔除或 reviewer 注入包构建函数过滤掉）：

1. chat_template 是新抽象，不复用 roles。
2. 注入策略 = prompt + tool 双管，重 tool 轻 prompt。
3. 持久化双写：文件是 source of truth + helm DB 索引。
4. review 用 `claude -p` 子进程（沿用 Phase 60b 模式）。
5. opt-in 粒度 = chat 级，不做项目级自动注入。
6. implement 不强制 planned_files 限制，靠 agent 自觉。
7. conventions 来源 = helm Settings 全局，无项目级覆盖。
8. archive 检索时机 = `harness_create_task` 内部一次性跑，写入 Related Tasks。
9. stage 转换主路径 = agent 调 MCP 工具，UI 按钮兜底。
10. 一个 task 全程一个 Cursor chat，review 是子进程插播。
11. review 报告回流 = UI 卡片 + "Push to implement chat" 按钮，不自动推。

## Risks

- **review 子进程的 conventions 来源**：MVP 用 helm Settings 全局字段。跨项目混用规约会有泄漏感（A 项目规约审 B 项目代码）。后续需加项目级覆盖。
- **diff base 的脆弱性**：`implement_base_commit` 失效（用户 reset）时 review 拒绝运行。MVP 仅报错让用户重指定，长期可考虑自动 fallback 到 `git merge-base` 之类。
- **task.md 与 helm DB 同步**：用户手改 task.md 后没触发 helm 工具，索引会过期。MVP 加 reindex 按钮兜底；长期方案是 file watcher 或写时 hash 校验。
- **archive 检索的精度**：基于 token / 文件名 / entity 字符串匹配，不是语义。短期足够；长期可考虑加入轻量 embedding 索引（但要小心又重新引入"AI 判断不可重现"的问题）。
- **review subprocess 的失败模式**：`claude` 没装、未登录、超时——用户体验需要友好降级。MVP 至少要把 stderr 落进 `harness_reviews.error` 字段。
- **chat_template 与 roles 的边界**：未来若用户希望"既是 Harness implement chat 又有 TCC 专家知识"，需要支持组合注入。MVP 先互斥，未来再考虑组合语义。
- **Bootstrap 的鸡生蛋问题**：本任务是 helm 自身的第一个 Harness task，没法用 helm 自己的 Harness 工具来跑 review——implement 阶段产出后 review 这一关只能人工模拟（开新 chat 把 Intent + Structure + diff 喂给 reviewer agent）。这是一次性问题，下一个 task 起就能用上自己。

## Related Tasks

(本任务是首个 Harness task，archive 索引为空。Bootstrap moment.)

## Stage Log

- **2026-05-10** — task created. Intent + Structure 来自先前 chat 中的对齐讨论（用户确认了 8 个 forks 的所有取舍）。budget 用了 3 个 source files：`src/cli-agent/claude.ts`（subprocess 模式确认）、`src/storage/migrations.ts`（current version=9，next=10）、`web/src/components/Layout.tsx`（sidebar nav 形态）。剩余 2 file 的 budget 留作 implement 之前的微调。current_stage = `new_feature`，等待用户确认 Intent / Structure / Scope 后转 implement。
- **2026-05-10** — user confirmed scope. Transitioning to implement. `implement_base_commit = 4c93f18b521dc06244de96cd76521bde8201b92d` (main HEAD at PR #65 merge). 2 file-budget tokens left for in-flight planned_files expansion (e.g. helm config / sessionStart wiring locations).
- **2026-05-10** — implement done. 14 new files, 9 changes, migration v10. typecheck clean. 1110/125 tests pass (+18 unit, +9 e2e). Decisions captured: (a) 11 mcp tools (vs initial 10) since I split out `harness_list_tasks` / `harness_list_reviews` / `harness_reindex_task`; (b) `runReview` injected via `runReviewOverride` dep so tests don't shell out to claude; (c) push-to-implement uses synthetic `channel='harness'` binding to reuse host_stop pipeline rather than building a parallel queue; (d) sessionStart injection layered AFTER role/knowledge context with `---` separator. Ready for review. **Bootstrap caveat**: this task can't review itself via helm's reviewer — needs a human-driven review pass in a fresh chat. Per the rulebook: open a new Cursor/Claude chat, hand it Intent + Structure + diff vs `4c93f18` + the global conventions; explicitly do NOT pass Stage Log / Decisions / this conversation history.
