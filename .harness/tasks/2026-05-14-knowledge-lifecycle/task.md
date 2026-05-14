# Knowledge lifecycle (decay + auto-archive) + SSE keepalive

| field           | value |
| --------------- | ----- |
| task_id         | 2026-05-14-knowledge-lifecycle |
| current_stage   | archived |
| created_at      | 2026-05-14 |
| project_path    | /Users/bytedance/projects/helm |
| host_session_id | (unbound) |
| implement_base_commit | f6779c34343e7cf2f6beff5209203322e40e7f8e |

## Intent

### Background
helm 的 role 知识库目前**永不衰减**——每个 chunk 一旦写入就和最新 chunk 平权参加检索，永远不被遗忘。短期没问题，长期所有 role 都会积累过时内容：

- 旧 runbook 描述的服务架构已经被重构，新 chunk 写进去后旧的还在召回
- Phase 73 的 `drop_knowledge_source` 是手动撤回，依赖用户主动清理；用户多数时候不会想起来
- 重训同 fingerprint 的 doc 走 dedup source（Decision §C of Phase 73），但**新旧 chunks 并存且全部参与检索**——用户的本意是用新内容覆盖旧，结果是新旧一起出

参考 agentmemory 的设计：每个 obs 有 `accessCount` / `lastAccessedAt` 列，检索后异步 bump；后台周期任务把 cold obs 降权或归档。helm 这边的等价物就是 **chunk 级生命周期**。

顺便：刚发现 helm `src/mcp/http-sse.ts` **没发 SSE keepalive ping**，Chrome/Electron 自带 idle-connection timeout ~5min 把连接掐了，Cursor 重连时偶尔会 truncate tool list（今天用户撞到的 "Tool not found"）。这个修法非常小（一行 `: ping\n\n` 每 25s），跟生命周期管理一起出更省 PR 噪声。

### Objective
给 role 知识库一套**自然衰减 + 显式归档**机制：

- 每个 chunk 写入时记 `createdAt`（已有）+ 新增 `accessCount` / `lastAccessedAt`
- `searchKnowledge` 异步 bump 命中 chunk 的 access stats（不阻塞返回）
- Phase 76 的 fusion 排序融入**衰减权重**：长期没人访问的 chunk 即便 RRF 分数高也会被压低
- 后台周期任务（boot 时启动 + 24h tick）扫描"长期未访问 + 创建时间老"的 chunk → 标记 `archived = 1`
- archived chunks **默认从 search 排除**，可通过 MCP / API 参数 `includeArchived` 取回
- Roles UI 在 chunk 卡片显示 access 统计（`accessed N times, last 3d ago`）+ archived chunks 折叠区 + "unarchive" 单 chunk 按钮
- **不真删**——archived 是软状态，永远能恢复（Decision: 同 Phase 73 §D 之后的保守路线，"破坏式 migration" 一次性损失够多了）

附带一个**独立的小 fix**：SSE keepalive ping，把 ~5min idle disconnect 解决。

单句"完成"定义：**用户训练 role 后，2 周后再训新内容、再做几次搜索：未被访问的 chunks 自动 archived；archived chunks 不在 default search 里出现；Roles 页能看到每个 chunk 的 access 统计；archived 区可展开 + 单个恢复。SSE keepalive ping 让 Cursor 端的 tool-list 缓存稳到一直 alive。**

### Scope
**In:**
- migration v14:
- `src/storage/repos/roles.ts`：
- `src/roles/lifecycle.ts`（新文件）：
- `src/roles/hybrid-search.ts`：
- `src/mcp/server.ts`：`search_knowledge` 加可选 `includeArchived?: boolean`（默认 false，agent 显式恢复 archived 时用）
- `src/app/orchestrator.ts`：启动时调 `runArchivalSweep` 全局 + 注册 24h cron；shutdown 时清理 interval；暴露一个 `scheduleRoleSweep(roleId)` 给写路径用（fire-and-forget）
- `src/roles/library.ts`：`trainRole` / `updateRole` 返回后异步触发 `scheduleRoleSweep(roleId)`（fire-and-forget，失败仅 warn）；library 通过 deps 接 sweep trigger，不直接 import orchestrator 避免循环
- `src/mcp/server.ts`：`drop_knowledge_source` 也触发该 role 的 sweep
- `src/config/schema.ts`：新增 `knowledge.lifecycle = { archiveAfterDays: number(default 90), archiveBelowAccessCount: number(default 3), decayTauDays: number(default 30), decayAlpha: number(default 0.3) }` 配置块
- **SSE keepalive**（独立 sidecar）：`src/mcp/http-sse.ts` 在 `server.connect(transport)` 后启动 25s 间隔 `setInterval`，写 `: ping\n\n` 到 `res`；onclose 时 `clearInterval`
- Roles UI（`web/src/pages/Roles.tsx`）：
- 测试：

**Out:**
- 真删 chunks——`archived` 是软状态。用户要硬删走 `drop_knowledge_source` 路径。
- Per-role / per-kind 衰减系数调优——v1 一个全局 τ + α
- 显式"长期 vs 短期 memory" 分两条曲线——v1 一层 decay 撑住，撑不住再拆
- Real cron framework（node-cron 之类）——boot 一次 + `setInterval(24h)` 够用
- "session-scoped 短期记忆"——agentmemory 有这层，helm 当前没必要
- Manual cleanup CLI（`helm prune-stale`）——UI 单 chunk unarchive 够用，批量 prune 让 cron 自动跑
- Built-in role 走 lifecycle——它们 chunks 是 0，不受影响（防御性测一下）
- SSE keepalive 间隔可配——v1 写死 25s（小于 Chrome 30s idle timeout）
- 决定哪些 access 算"真访问"——v1 `searchKnowledge` 返回的命中都算，不区分"agent 看了 vs 用户 click"

## Structure

### Entities
- **`AccessStats`**（chunk-level fields）：`accessCount: number`、`lastAccessedAt?: string` —— 一对统计字段，常被一起读写。
- **`ArchivedFlag`**（chunk-level 布尔列）：`archived: boolean` —— 软删标记。
- **`DecayParams`**（导出常量）：`{ tau: 30 days, alpha: 0.3 }` —— 衰减时间常数 + 最大 boost 系数。常量但导出便于测试覆盖 + 未来动态化。
- **`ArchivalThreshold`**（导出常量）：`{ minAgeMs: 90 days, maxAccessCount: 3 }` —— "够老 + 用得少" 才归档。
- **`KeepalivePing`**（SSE-level 字符串常量）：`': keepalive\n\n'` —— SSE comment frame，Cursor / 浏览器/ Electron 客户端都忽略 payload，只用来阻止 idle timeout。
- **`ArchivalSweepResult`**：`{ scanned: number, archived: number, skipped: number, durationMs: number }` —— 后台 sweep 的可观测产出。

### Relations
- `knowledge_chunks.archived` 与现有 `kind` / `source_id` / `embedding` 等列共存——彼此正交。
- `searchChunksByBm25` / `searchChunksByEntity` / `getChunksForRole` 三个 reader 都接受 `includeArchived` 参数；fusion 调它们时**始终传 false**，单点 unarchive 流程用 `true`。
- `runArchivalSweep` 调 `archiveChunks` 批量 update；不调 `drop_knowledge_source` 那条硬删路径，保持职责分离。
- SSE keepalive 是 transport 层，跟 lifecycle 完全独立——bundled 仅因为它是"刚发现的小 bug"，不应该牵连 lifecycle 的设计取舍。

### Planned Files
- `src/roles/lifecycle.ts` — `scoreDecay` / `applyDecayBoost` / `runArchivalSweep` / 常量导出。
- `tests/unit/roles/lifecycle.test.ts` — 衰减函数边界（tau 0、now=lastAccess、远古时间）+ sweep 阈值。
- `tests/unit/storage/access-bump.test.ts` — bumpChunkAccess 单事务原子 + 不存在的 id 不抛。
- `tests/unit/storage/archived-filter.test.ts` — getChunksForRole / searchChunksByBm25 / searchChunksByEntity 三个 reader 都正确遵守 includeArchived 默认。
- `tests/e2e/knowledge-lifecycle/happy.spec.ts` — 端到端：训 role → 搜几次 bump access → 手动 archive → search 不见 → unarchive → search 重见。
- `tests/e2e/sse-keepalive/happy.spec.ts` — 起 helm 测试 server，开 SSE 连接，模拟 idle 60s（vitest fake timers），验证至少收到 2 个 keepalive 帧。
- `src/storage/migrations.ts` — migration v14：ALTER 三列 + 一个索引；不 backfill `last_accessed_at`（NULL 是合理初值，第一次访问时填）。
- `src/storage/types.ts` — `KnowledgeChunk` 加 `accessCount` / `lastAccessedAt` / `archived`。
- `src/storage/repos/roles.ts` — 新 repo 函数 + 三个 reader 加 `includeArchived` 参数。
- `src/roles/hybrid-search.ts` — 引入 decay re-rank；async access bump（不 await）。
- `src/roles/library.ts` — `searchKnowledge` 透传 `includeArchived` 到 `hybridSearch`；`SearchKnowledgeOptions` 加同字段。
- `src/mcp/server.ts` — `search_knowledge` schema 加 `includeArchived`；两个 archive / unarchive 新工具？**不**——MCP 层只读，归档由后台 sweep / UI 触发。reviewer 不该看，但写这里防遗忘：MCP 不开 mutating archive tool，避免 agent 误删数据。
- `src/mcp/http-sse.ts` — SSE keepalive：`setInterval` 写 `: keepalive\n\n`；onclose 清。
- `src/app/orchestrator.ts` — boot 调 `runArchivalSweep` + 注册 24h cron。
- `web/src/api/types.ts` — `RoleChunk` 加 `accessCount` / `lastAccessedAt?` / `archived`；`HelmConfig.knowledge.lifecycle` 新结构同后端 schema。
- `web/src/pages/Roles.tsx` — chunk 卡片底栏多一行；Archived 折叠区；unarchive 按钮。
- `web/src/api/client.ts` — `helmApi.unarchiveChunk(chunkId)` 单个恢复。
- `web/src/pages/Settings.tsx` — 新增 "Knowledge lifecycle" 区，4 个数字字段（archive after days / archive below access count / decay tau days / decay alpha），都有 helper text + 默认值标注。
- `src/api/server.ts` — `POST /api/knowledge-chunks/:id/unarchive` 端点（DELETE 已经被 `delete_role_chunk` 占用，用 POST verb 区分；archive 由 sweep 自动 done 不开端点）。

## Decisions

- **`accessCount` / `archived` 设为 KnowledgeChunk 可选字段**：SQL DEFAULT 在 INSERT 路径保底，Reader 必填充。否则 100+ 处既有 `insertChunk({...})` 调用全部要改，污染面太大。
- **微任务调度 access bump**：`queueMicrotask` 而非 `setImmediate` —— 让调用方 `await search()` 先 resolve、再回写 DB；尽量缩短调用方观察到的延迟尾巴。失败仅 `console.warn`，不注入 logger（avoid pulling 自顶向下的 logger 到 hybrid-search 这种 leaf 模块）。
- **`HybridSearchHit` 加 `chunkId` 字段**：access bump 需要 chunk id；之前 Hit 只有文本和 sourceId，重新查 chunkId 浪费。把 id 加进返回结构最清爽。
- **sweep 触发器用 module-level setter 而非 DI**：`setLifecycleSweepTrigger(fn)` —— 避免 `library.ts` import `orchestrator.ts`（orchestrator 已经 import library，会成环）。代价是 trigger 是全局单例，但因为整个进程只有一个 helm app handle，事实上不冲突。
- **archive 是 boost 但不是 filter 的具体形式**：`final = rrf * (1 + α * decay)` —— α=0 时 decay 不影响排名（formula collapse），保留 Phase 76 原始行为。
- **`includeArchived=true` 时跳过 access bump**：agent 主动看 archived 内容不应"复活"那批 chunk；让 sweep 下次仍然能再次归档。
- **migration v14 NOT NULL DEFAULT 同步 backfill**：`access_count` / `archived` 加 `NOT NULL DEFAULT 0`，已有行得到默认值；`last_accessed_at` 保持 nullable（Decision §10 of pre-implement）。
- **API 不开 archive 端点，只开 unarchive**：archive 由 sweep / mutation 触发，UI 永远只用 POST `/api/knowledge-chunks/:id/unarchive` 这一个端点（语义对称：用户能撤销自动决定，不能自己手动触发归档）。
- **SSE keepalive 间隔通过 `mcpKeepaliveIntervalMs` deps 透传**：测试要 100ms、生产要 25s，写死常量会让 e2e 跑 26s。通过 createHttpApi deps 接受 override 是最小侵入路径。
- **e2e 测试顺序**：先 sweep 再 search —— 否则 search 会把 stale chunk 的 last_accessed_at 也写新，导致 sweep 看不到候选（"用过就是热"原则的副作用）。
- **task.md `current_stage` 保持 `implement` 直到 user 跑 /review**：Harness 规则——complete 时不自动 archive，把决定权留给 reviewer 跑完之后。

## Risks

- **Archival 阈值 `90d + access<3` 在真实数据上不可知**：当前 helm 实际用 role 有 1-2 个月，没数据决定阈值是松还是紧。v1 用上述默认；如果实测大量"该归档没归档"或"误归档活跃 chunk"，再调。
- **decay re-rank 可能压住 freshly trained 但还没被 access 的 chunk**——刚写完的 chunk `lastAccessedAt = NULL`，当 NULL 视为 `createdAt` 时 decay 几乎是 1.0，所以新 chunk 不亏；但如果 `createdAt` 本身就老（reindex 时回填的旧时间戳）会被低估。v1 接受这个。
- **bumpChunkAccess 异步失败静默丢**：access stats 短暂落后，对决策没致命影响（decay 时差几秒不可感知）。warn 日志足够。
- **SSE keepalive 与 SDK 内部状态冲突**：`SSEServerTransport` 可能将来自己加 keepalive；现在没看到这逻辑（已读过 SDK 代码确认）。万一未来 SDK 加了我们这层就 redundant 但无害。
- **cron interval 在 shutdown 没干净清理 → Vitest 进程不退出**：必须 `unref()` interval 或 orchestrator stop() 时清。

## Related Tasks

_(none)_

## Stage Log

- **2026-05-14T23:32:00.172Z** [archived] — archived: Role 知识库 access-tracking + 指数衰减重排 + 软归档 sweep（90d+access<3 阈值，user-tunable）；附带 MCP SSE 25s keepalive 修复 Cursor tool-list 缓存掉队。
