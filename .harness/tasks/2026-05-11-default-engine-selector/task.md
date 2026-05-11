# Global default-engine selector

| field           | value |
| --------------- | ----- |
| task_id         | 2026-05-11-default-engine-selector |
| current_stage   | implement |
| created_at      | 2026-05-11 |
| project_path    | /Users/bytedance/projects/helm |
| host_session_id | (unbound) |
| implement_base_commit | 321281e40d0eb69b77a9fbe0dd3da4190c215b69 |

## Intent

### Background

helm 当前同时集成两个 LLM 引擎：

- **Cursor SDK / cursor-agent**：通过 `CursorLlmClient` 走云端或本地 Cursor app 认证；目前只驱动一个功能 — `summarize_campaign`。
- **Claude Code CLI（`claude -p`）**：通过 `ClaudeCodeAgent` 子进程；驱动 role-trainer 模态、Harness reviewer、Train-via-CLI 面板。

引擎到功能是**写死映射**——用户没法选 "我想用 Cursor 来跑 Harness review" 或 "我想用 Claude 来 summarize"。这造成两个问题：

1. **环境不一致**：用户只装了其中一个引擎时，部分功能能用、部分不能。比如只装 Cursor 的用户没法用 Harness reviewer，只装 Claude 的用户没法用 summarize。
2. **能力不对称**：两个引擎在同样的任务上都能跑（Claude 能写 JSON 摘要，Cursor 也能进行对话式工具调用），但 helm 没把"用户偏好哪个"作为一等参数暴露。

加上一个 Phase 67 留下的现象：用户在 Cursor 里说"更新 helm 的容灾链路专家"时，agent 第一反应是找 `helm` CLI（不存在）而不是调 MCP 工具。这个不是本任务核心问题，但它暴露了引擎选择的另一面：**用户不仅希望选引擎，也希望引擎认识 helm**。本任务先解决"用户选引擎"这一层。

### Objective

helm Settings 增加一个**全局 default engine** 单选项（`cursor` | `claude`），所有同时支持两引擎的功能默认走选中的那个。功能层不再硬绑某个引擎；orchestrator 启动时按 `liveConfig.engine.default` 注入对应的适配器；切换 Settings 之后**热生效**（不需要重启）。

单句"完成"定义：**用户在 Settings 选 "Default engine: Cursor"，保存，下一次点 Campaigns → Summarize、Harness → Run review、Roles → Train via chat 都通过 CursorLlmClient/cursor-agent 跑；切回 Claude 之后下一次都走 `claude -p`，全过程不重启 helm。**

### Scope

**In:**
- helm Settings 新增 **Default engine** 单选（radio / select），值为 `cursor` 或 `claude`；存到 `~/.helm/config.json` 的 `engine.default` 字段（schema 扩展）。
- 引擎能力探测：启动时探 `cursor` 和 `claude` 各自是否可用（已有 `detectClaudeCli`；新增 `detectCursorCli` 或复用已有的 health check）。Settings 里显示每个引擎的 ready/missing 状态。
- 三个功能加引擎分支：
  - `summarize_campaign`：当 default=claude 时用 `ClaudeLlmClient` 适配（新写，复用 `claude -p` + JSON 输出 prompt）；当 default=cursor 时用现有 `CursorLlmClient`。
  - Harness reviewer (`runReview()`)：当 default=cursor 时新写 `runReviewViaCursor()`（复用 `CursorLlmClient.generate()` + reviewer system prompt）；当 default=claude 时维持现状。
  - Roles 模态 (`handleRoleTrainChat`)：当 default=cursor 时新写 `cursorAgentFactory`（复用 `cursor-agent` CLI 或 cursor SDK 的对话能力）；当 default=claude 时维持现状。
- 选中的引擎不可用时的降级：返回 actionable 错误（沿用 Phase 67 引入的 `interpretClaudeError` 模式，给 cursor 也加 `interpretCursorError`），UI 引导用户去 Settings 切换或 install/login。**不自动 fallback** —— 静默切换引擎会让用户对结果归因更困惑。
- 测试：单测覆盖 `EngineRouter` 的选择逻辑 + 每个适配器的 happy path（mock subprocess）；e2e 覆盖一次 summarize / review / role-train 在两种 engine 下都能跑（用 mocked subprocess）。
- Settings UI：除了 Default engine 单选，还显示 `cursor (ready) / claude (missing — Run \`claude login\`)` 之类的状态行，让用户立刻知道选了之后能不能跑。

**Out:**
- 引擎能力的**自动 fallback**（选中的没装 → 偷偷换另一个）。
- 引擎-per-feature 的精细 override（"summarize 用 Cursor，review 用 Claude"）。MVP 只做全局默认；future 可以加 override。
- 模型选择的引擎相关性：Settings 的 Cursor `model` 字段不挪、不分两份；模型字段当前只对 cursor 有意义，claude CLI 用自己的 model 选择。
- Cursor 侧的 "agent doesn't know about MCP tools" 问题（截图里的 `which helm` 浪费）—— 那是独立 UX issue，作为本任务的 follow-up 单独开 PR。
- claude → JSON 摘要 prompt 的精细调优：MVP 出能 parse 的输出即可；后续 prompt-tuning 走单独 task。
- 引擎切换的迁移 UX（已经用 Cursor 跑过的 Harness review 报告，切到 Claude 之后会用 Claude 重跑——这是 user-initiated，没自动迁移）。
- Train-via-CLI 面板的"用 cursor-agent 替代 claude" 文案改造：这个面板只是教用户在终端跑命令，本任务不动它，可以作为 follow-up。
- 一个 chat 内引擎切换（一个 Harness implement chat 一半用 Cursor 一半用 Claude）—— MVP 不支持，切换只影响新发起的请求。

## Structure

### Entities

- **`EngineId`**：字符串字面量联合 `'cursor' | 'claude'`。
- **`EngineCapability`**：引擎能跑的工种集合。MVP 三种：`summarize`（结构化文本生成）、`review`（结构化文本生成 + diff 注入）、`conversational-tools`（多轮对话 + MCP 工具调用）。每个引擎声明自己支持哪些。
- **`EngineAdapter`**（接口）：每个引擎对每个能力的实现，包装在一个 namespace 下：
  - `summarize(prompt, options) → string` — `LlmClient`-shape，给 summarizer 用。
  - `review(payload, systemPrompt, options) → string` — 单次结构化输出，给 Harness reviewer 用。
  - `runConversation(messages, options) → { text, sessionId, stderr }` — 多轮，给 Roles 模态用。
- **`EngineRouter`**：根据 `liveConfig.engine.default` 返回当前 active EngineAdapter；功能层调它，不直接 new client。
- **`EngineHealth`**：探测结果 `{ engine, ready: boolean, version?: string, hint?: string }`，由 Settings 页消费。

### Relations

- `EngineRouter` 持有所有 adapter 实例 + `liveConfig.engine.default` getter。
- 三个功能（summarizer / harness reviewer / role-trainer）从 `EngineRouter` 取当前 adapter，不直接 new claude / cursor。
- helm Settings 的引擎选项 → `liveConfig.engine.default`（PUT /api/config 后 `EngineRouter` 下一次取即热生效）。
- `EngineHealth` 由 orchestrator 启动时 + Settings GET 时各探测一次。

### Planned Files

后端 — 新增：
- `src/engine/types.ts` — `EngineId` / `EngineAdapter` / `EngineRouter` / `EngineHealth` 接口。
- `src/engine/router.ts` — `EngineRouter` 实现：构造时拿 adapter 字典 + config getter，`current()` 返回 active adapter。
- `src/engine/adapters/claude-adapter.ts` — `summarize` / `review` / `runConversation` 三种能力的 claude 实现；底层复用 `ClaudeCodeAgent`、新写一个 `claude --print` 的 single-turn helper。
- `src/engine/adapters/cursor-adapter.ts` — 同上但用 `CursorLlmClient.generate()`；conversational-tools 能力通过 `CursorAgentSpawner` 或 cursor-agent CLI 子进程实现（待定，看 spawner 现有 API）。
- `src/engine/detect.ts` — 引擎可用性探测 + Settings 用的 `EngineHealth[]` 报告。
- `src/cli-agent/cursor.ts` — Cursor CLI 子进程封装（对应 `cli-agent/claude.ts`），如果走 cursor-agent CLI 路径。
- `tests/unit/engine/router.test.ts` — router 路由 + config 变更热生效。
- `tests/unit/engine/adapters.test.ts` — 两个 adapter 的 summarize/review/runConversation 都接受 stub exec。
- `tests/e2e/engine-default-switch/happy.spec.ts` — Settings 改 default，下一次 summarize / review / role-train 的 subprocess 类型对应切换。

后端 — 改动：
- `src/config/schema.ts` — 新增 `engine: { default: 'cursor' | 'claude' }`，default value 看 Issue（建议根据探测结果挑能用的；都能用时默认 `claude` 沿用现状）。
- `src/app/orchestrator.ts` — 构造 `EngineRouter`，注入到 `mcpFactory` / `summarizeFn` / `runHarnessReview` / `cliAgentFactory` 路径。删除"硬绑 claude/cursor"的写法。
- `src/api/server.ts` — `handleRoleTrainChat` 改用 `EngineRouter.current().runConversation()`；不再直接拿 `cliAgentFactory`。新增 `/api/engine/health` 端点给 Settings 拉状态。
- `src/summarizer/campaign.ts` — `summarizeCampaign` 接受任意 `LlmClient`，主入口（orchestrator 那一行）改成从 `EngineRouter` 取。
- `src/harness/review-runner.ts` — `runReview()` 改用 `EngineRouter.current().review()` 而不是直接 spawn claude。

渲染层 — 改动：
- `web/src/pages/Settings.tsx` — 新增 "Default engine" 区块（radio + 每个引擎的 health 行）。
- `web/src/api/client.ts` — `helmApi.engineHealth()` + types。
- `web/src/api/types.ts` — `HelmConfig.engine?: { default: 'cursor' | 'claude' }` + `EngineHealth` 类型。

合计：~9 新文件、~6 已有文件改动，无新 migration。

## Execution

### Actual Files

后端 — 新增：
- `src/engine/types.ts` — EngineId / EngineAdapter / EngineHealth / EngineCapabilityUnsupportedError.
- `src/engine/router.ts` — EngineRouter（持 adapter map + defaultGetter, `current()` 每次重读）+ EngineNotAvailableError.
- `src/engine/json-retry.ts` — `parseJsonWithFormatRetry()` + `stripFences()` + `formatPassPrompt()` 的 LLM JSON 输出"二次 format pass"工具集。
- `src/engine/adapters/claude-adapter.ts` — claude EngineAdapter（summarize/review/runConversation 三能力）+ `claudePrintOnce()` 单次 helper。
- `src/engine/adapters/cursor-adapter.ts` — cursor EngineAdapter（summarize/review 走 CursorLlmClient，runConversation 走 cursor-agent CLI；CLI 不可用时 runConversation 抛 EngineCapabilityUnsupportedError）。
- `src/engine/detect.ts` — `detectEngines()` 返回 EngineHealth[] + `pickBootDefault()`。
- `src/cli-agent/cursor.ts` — `cursor-agent` CLI 子进程封装 + `detectCursorAgentCli()` + `interpretCursorAgentError()`。

后端 — 改动：
- `src/config/schema.ts` — `HelmConfigSchema` 新增 `engine.default`（`'cursor' | 'claude'`，default `claude`）。
- `src/app/orchestrator.ts` — 构造 EngineRouter（Proxy adapter map + defaultGetter），探测两个 CLI，把 summarizer / Harness reviewer / role-trainer 三处都路由过去；Settings 保存时 `refreshEngineRouter()` 让 cursor 配置变化生效。
- `src/api/server.ts` — 新增 `/api/engine/health` 端点 + 新 `runConversation` deps（替代 `cliAgentFactory` 在 handleRoleTrainChat 的角色，老 factory 仍保留为 fallback）；EngineHealth / RunConversationInput / RunConversationResult 类型从 engine/types 导出。
- `src/harness/review-runner.ts` — `RunReviewDeps` 新增 `runReviewerEngine` 钩子（默认仍 spawn claude，orchestrator 注入 EngineRouter-routed 版本）。

渲染层 — 改动：
- `web/src/api/types.ts` — `HelmConfig.engine?: { default }` + 新 `EngineHealth` 类型。
- `web/src/api/client.ts` — `helmApi.engineHealth()` 新方法。
- `web/src/pages/Settings.tsx` — 新 "Default engine" section + `DefaultEngineField` 组件（radio 二选一 + 每行显示 ready/missing + actionable hint）。

测试 — 新增：
- `tests/unit/engine/router.test.ts` (7 cases)
- `tests/unit/engine/json-retry.test.ts` (12 cases)
- `tests/unit/engine/adapters.test.ts` (5 cases)
- `tests/e2e/engine-default-switch/happy.spec.ts` (2 cases)

合计：7 新文件、6 已有文件改动、0 migration、24 新 unit cases、2 新 e2e cases。

### Patterns Used

- **Router + Adapter**（fork #3）— EngineRouter 不直接构造 adapter，由 orchestrator 注入；方便测试 + 解耦订阅式探测。
- **Proxy adapter map** — 让"启动时 adapter 还不全"和"运行时配置变更"通过同一个 `currentAdapters` 槽位透明热切，避免重新构造 EngineRouter。
- **Optimistic-then-refresh** — 启动时假设两个 CLI 都可用，async 探测完成后 `refreshEngineRouter()` 修正。
- **Pluggable runner deps**（沿用 Phase 67 review-runner 风格）— `RunReviewDeps.runReviewerEngine` 让 review-runner 不直接依赖 EngineRouter，orchestrator 在 wire 处 routing。
- **Optional capabilities + structured error**（`EngineCapabilityUnsupportedError`）— cursor adapter 在 cursor-agent CLI 不可用时只丢 runConversation 一项能力，UI 拿到具体 hint。
- **Format-pass retry**（fork #9）— 不重写 prompt，只让模型 fix 自己的输出，一次为限。

## Validation

### Test Plan

(已实现，见 Cases Added)

### Cases Added

- `tests/unit/engine/router.test.ts` — 7
- `tests/unit/engine/json-retry.test.ts` — 12
- `tests/unit/engine/adapters.test.ts` — 5
- `tests/e2e/engine-default-switch/happy.spec.ts` — 2

### Lint Results

- `pnpm typecheck` — clean (root + web)
- `pnpm test` — 1134 passed (was 1110)
- `pnpm test:e2e` — 127 passed (was 125)

## Decisions

(此阶段空，implement 时填实施级取舍)

**Pre-implement aligned forks**（reviewer 不应见此段；archive 时由 `assembleReviewerPayload` 过滤）：

1. 全局**单一**默认引擎，不做 per-feature override（MVP）。
2. 选中引擎不可用 → **不自动 fallback**，给 actionable error 引导用户切 Settings 或装/登录。
3. 引擎抽象走 **router + adapter** 模式（一个 `EngineRouter`、N 个 `EngineAdapter`）；不走"动态 plugin loader"。
4. **同步热生效**：Settings 保存后下一次 `router.current()` 立即用新值；不缓存 adapter instance 引用。
5. 不动 Cursor `model` 字段在 Settings 里的位置——它只对 cursor adapter 有意义。
6. claude 的 summarize/review 路径走 `claude -p --output-format text` 单次调用（同 reviewer 现状），不复用 `ClaudeCodeAgent`（那个是多轮对话型）。
7. **A**: Cursor 的 conversational-tools 路径**先走 cursor-agent CLI**（路径 i），如果 cursor-agent CLI 探测不可用或调用不稳，**fallback 走 Cursor SDK + 手动 tool-use 循环**（路径 ii）。MVP 实现 (i)，把 (ii) 留为 follow-up；implement 中如果发现 (i) 在常见用户机器上覆盖率不足，再加 (ii)。
8. **B**: `engine.default` 的默认值由启动时探测决定：两个都可用 → `claude`（沿用现状）；只一个 → 那个；都没装 → `claude`（占位），Settings 里显著标 *neither engine ready*。冷启动写入 `~/.helm/config.json` 的逻辑只在该字段缺失时跑。
9. **C**: claude summarize/review 的 **JSON 输出可靠性**走"乐观 + 二次 format pass"策略——先按 strict-JSON system prompt 生成；如果 `JSON.parse` 失败，把"原响应 + 'fix-the-JSON' 指令"再喂一次 claude 让它自己修。两次都失败才报错。Retry 限定一次，避免无限循环。
10. **D**: 做 EngineHealth。Settings 增加 `/api/engine/health` 端点 + 每行显示 ready/missing + actionable hint（"Run \`claude login\`" / "Install cursor-agent CLI"）。多花约 1 day，但 UX 价值大——用户在选之前就能看到哪个能用。
11. **关于 reviewer**：Harness reviewer 严格沿用现有 claude 路径，**不走 EngineRouter** —— reviewer 的信息隔离合约比引擎选择更重要，让 reviewer 总是用一个稳定的引擎避免引入"换引擎 → 评审风格漂移"的额外变量。在文档里把这条作为 explicit exception 列出。

  **Wait — 重新校准 #11 矛盾**: 上面 Scope In 里说 "Harness reviewer 当 default=cursor 时新写 `runReviewViaCursor()`"，但 fork #11 又说 reviewer 不走 EngineRouter。两者只能选一个。**最终取**: reviewer **也走 EngineRouter** —— 用户既然选了 default=cursor，整套都应当一致；信息隔离的合约由 `assembleReviewerPayload` 守，与引擎选择正交。Scope In 保持，删除 fork #11 后半的限制。

## Risks

- **Cursor 的 conversational-tools 能力**最弱：`CursorLlmClient.generate()` 是单次文本生成，不天然支持"调 MCP 工具→拿结果→再生成"循环。如果 cursor-agent CLI 不靠谱或不普及，可能需要降级让 default=cursor 时 role-trainer 仍然走 Claude（违反"全局单一引擎"原则）。Implement 中重新评估，必要时 scope 调整。
- **Claude summarize/review 的 JSON 输出可靠性**：`claude -p` 默认是自由对话；需要 system prompt 严格约束到 JSON-only 输出。如果偶发漏字段，summarizer 解析会失败。Implement 中加 retry-on-parse-error，或回退到自然语言摘要。
- **引擎切换的并发安全**：用户在跑一次 long-running review 期间改 Settings，那次 review 还在用旧 adapter 跑；新 review 用新的。这是预期行为，但要在 UI 上说清楚（"切换只影响新发起的请求"）。
- **Health 探测的成本**：`detectClaudeCli` 是 `claude --version` 一次 exec；`detectCursorCli` 类似。Settings 页打开时跑一次没问题；启动时也跑一次没问题。如果未来加更多引擎要小心 fan-out。
- **Bootstrap with Harness**：本任务通过 Harness `/new-feature` 立项。implement 完后 review 用**当前默认引擎**（claude，沿用现状）跑一次 review；review 完后才能合入，所以这次新加的 cursor adapter 在 review 这道关里没被验证（review 子进程仍用 claude）。这是预期的，因为 review 流程本身没被改成"用全局默认引擎"——它仍然走 claude（reviewer 的特殊性：信息隔离合约比引擎选择更重要）。

## Related Tasks

(在 implement 阶段开始时由 `harness_create_task` 自动检索；目前 archive 表里只有上一个 Harness MVP，与本任务无 entity 重叠)

## Stage Log

- **2026-05-11** — task created from prior alignment chat (用户 #4 选项：全局一个默认引擎). Intent + Structure 从那次讨论 + 当前代码状态总结而来。budget 用 2 个 source files：`src/summarizer/campaign.ts`（LlmClient 接口形状）+ `src/summarizer/cursor-client.ts`（CursorLlmClient 已有）。剩余 3 file budget。current_stage = `new_feature`。等待用户对 Intent / Structure / Out 列表确认后转 implement。
- **2026-05-11** — user confirmed A/B/C/D forks. Locked into Decisions §7-§10. fork #11 was self-contradictory; reconciled to "reviewer DOES use EngineRouter; isolation contract is orthogonal". Ready to transition to implement once user gives final go.
- **2026-05-11** — user greenlight; transitioning to implement. `implement_base_commit = 321281e40d0eb69b77a9fbe0dd3da4190c215b69` (main HEAD at PR #67 merge; note PR #68 is open but not merged — its UX changes don't conflict with this task's planned files). Follow-up "Helm tool guide sessionStart injection (option α)" recorded; will be a separate Harness task after this lands.
- **2026-05-11** — implement done. 7 new files / 6 changes / 0 migration. typecheck clean. 1134 unit (+24), 127 e2e (+2). Implementation decisions captured: (a) **Proxy adapter map** is unusual but lets EngineRouter pick up adapter changes without rebinding — keeps `summarizeFn` closure stable; (b) `runReviewerEngine` hook on RunReviewDeps avoids cross-module coupling between review-runner and EngineRouter — orchestrator does the wiring; (c) old `cliAgentFactory` kept as fallback in handleRoleTrainChat so existing test seams that wire only the legacy factory don't break; (d) initial `refreshEngineRouter()` must run AFTER httpApi build (needs port) but BEFORE async CLI probes resolve — so availability flags declared up-front, defaulted true, async probes flip them later; (e) cursor adapter remains constructable when cursor-agent CLI is missing — only the runConversation capability throws, so `summarize`/`review` still work via the SDK. Bootstrap note: this PR's reviewer runs through the SAME router; if user has default=claude, review uses claude (same as before, no behavior change for them). Ready for review.
