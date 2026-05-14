# Knowledge lifecycle (decay + auto-archive) + SSE keepalive

| field           | value |
| --------------- | ----- |
| task_id         | 2026-05-14-knowledge-lifecycle |
| current_stage   | implement |
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
  - `knowledge_chunks` 加 3 列：`access_count INTEGER NOT NULL DEFAULT 0` / `last_accessed_at TEXT` / `archived INTEGER NOT NULL DEFAULT 0`
  - 索引 `(role_id, archived)` 以加速"非 archived 的 chunks"路径
- `src/storage/repos/roles.ts`：
  - `bumpChunkAccess(chunkIds[], at)` 单事务批量更新 access stats
  - `archiveChunks(chunkIds[], at)` / `unarchiveChunk(chunkId)`
  - `getChunksForRole` 增加 `includeArchived: boolean` 选项，**默认 false**（向后兼容地排除 archived）
  - `searchChunksByBm25` / `searchChunksByEntity` 同步加 `includeArchived` 过滤
- `src/roles/lifecycle.ts`（新文件）：
  - `scoreDecay(lastAccessedAt, now, tau): number` —— 简单指数衰减 `exp(-Δt/tau)`，τ 默认 30 天
  - `runArchivalSweep(db, opts)` —— 单次扫描，按 `lastAccessedAt < now-90d AND accessCount < 3` 阈值标 archived
  - 启动时跑一次 + `setInterval(24h)` 兜底
- `src/roles/hybrid-search.ts`：
  - 三路检索前 `getChunksForRole` / `searchChunksByBm25` / `searchChunksByEntity` 都不传 `includeArchived`（用 default=false）
  - RRF 融合后**额外做一道 decay re-rank**：`final = rrf * (1 + α * decay)`，α 默认 0.3（boost 不超过 30%）
  - 检索完成后**异步**调 `bumpChunkAccess`（fire-and-forget；失败仅 warn 不阻塞）
- `src/mcp/server.ts`：`search_knowledge` 加可选 `includeArchived?: boolean`（默认 false，agent 显式恢复 archived 时用）
- `src/app/orchestrator.ts`：启动时调 `runArchivalSweep` 全局 + 注册 24h cron；shutdown 时清理 interval；暴露一个 `scheduleRoleSweep(roleId)` 给写路径用（fire-and-forget）
- `src/roles/library.ts`：`trainRole` / `updateRole` 返回后异步触发 `scheduleRoleSweep(roleId)`（fire-and-forget，失败仅 warn）；library 通过 deps 接 sweep trigger，不直接 import orchestrator 避免循环
- `src/mcp/server.ts`：`drop_knowledge_source` 也触发该 role 的 sweep
- `src/config/schema.ts`：新增 `knowledge.lifecycle = { archiveAfterDays: number(default 90), archiveBelowAccessCount: number(default 3), decayTauDays: number(default 30), decayAlpha: number(default 0.3) }` 配置块
- **SSE keepalive**（独立 sidecar）：`src/mcp/http-sse.ts` 在 `server.connect(transport)` 后启动 25s 间隔 `setInterval`，写 `: ping\n\n` 到 `res`；onclose 时 `clearInterval`
- Roles UI（`web/src/pages/Roles.tsx`）：
  - 每个 chunk 卡片底部多一行 `accessed N times · last <reltime>` + archived 状态徽章
  - 新增 "Archived chunks (N)" 折叠区，展开后每行一个 unarchive 按钮
  - 类型 `RoleChunk` 扩展 `accessCount` / `lastAccessedAt` / `archived`
- 测试：
  - unit: 衰减函数 / archival sweep 阈值 / bump fire-and-forget / FTS5 + entity 仍能正确过滤 archived
  - e2e: archive + search 排除 / unarchive + search 重出 / SSE keepalive 帧确实写到 response
  - benchmark fixture 加一次"模拟旧 chunk"的 case，验证 decay re-rank 没破坏 Phase 76 的 R@5

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

后端 — 新增：
- `src/roles/lifecycle.ts` — `scoreDecay` / `applyDecayBoost` / `runArchivalSweep` / 常量导出。
- `tests/unit/roles/lifecycle.test.ts` — 衰减函数边界（tau 0、now=lastAccess、远古时间）+ sweep 阈值。
- `tests/unit/storage/access-bump.test.ts` — bumpChunkAccess 单事务原子 + 不存在的 id 不抛。
- `tests/unit/storage/archived-filter.test.ts` — getChunksForRole / searchChunksByBm25 / searchChunksByEntity 三个 reader 都正确遵守 includeArchived 默认。
- `tests/e2e/knowledge-lifecycle/happy.spec.ts` — 端到端：训 role → 搜几次 bump access → 手动 archive → search 不见 → unarchive → search 重见。
- `tests/e2e/sse-keepalive/happy.spec.ts` — 起 helm 测试 server，开 SSE 连接，模拟 idle 60s（vitest fake timers），验证至少收到 2 个 keepalive 帧。

后端 — 改动：
- `src/storage/migrations.ts` — migration v14：ALTER 三列 + 一个索引；不 backfill `last_accessed_at`（NULL 是合理初值，第一次访问时填）。
- `src/storage/types.ts` — `KnowledgeChunk` 加 `accessCount` / `lastAccessedAt` / `archived`。
- `src/storage/repos/roles.ts` — 新 repo 函数 + 三个 reader 加 `includeArchived` 参数。
- `src/roles/hybrid-search.ts` — 引入 decay re-rank；async access bump（不 await）。
- `src/roles/library.ts` — `searchKnowledge` 透传 `includeArchived` 到 `hybridSearch`；`SearchKnowledgeOptions` 加同字段。
- `src/mcp/server.ts` — `search_knowledge` schema 加 `includeArchived`；两个 archive / unarchive 新工具？**不**——MCP 层只读，归档由后台 sweep / UI 触发。reviewer 不该看，但写这里防遗忘：MCP 不开 mutating archive tool，避免 agent 误删数据。
- `src/mcp/http-sse.ts` — SSE keepalive：`setInterval` 写 `: keepalive\n\n`；onclose 清。
- `src/app/orchestrator.ts` — boot 调 `runArchivalSweep` + 注册 24h cron。

渲染层 — 改动：
- `web/src/api/types.ts` — `RoleChunk` 加 `accessCount` / `lastAccessedAt?` / `archived`；`HelmConfig.knowledge.lifecycle` 新结构同后端 schema。
- `web/src/pages/Roles.tsx` — chunk 卡片底栏多一行；Archived 折叠区；unarchive 按钮。
- `web/src/api/client.ts` — `helmApi.unarchiveChunk(chunkId)` 单个恢复。
- `web/src/pages/Settings.tsx` — 新增 "Knowledge lifecycle" 区，4 个数字字段（archive after days / archive below access count / decay tau days / decay alpha），都有 helper text + 默认值标注。
- `src/api/server.ts` — `POST /api/knowledge-chunks/:id/unarchive` 端点（DELETE 已经被 `delete_role_chunk` 占用，用 POST verb 区分；archive 由 sweep 自动 done 不开端点）。

合计：6 新文件 + 9 已有改动 + 1 migration + ~50 新 test case（含 1 个 SSE keepalive e2e）。

## Decisions

**Implement-stage (2026-05-14)**:

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

**Pre-implement aligned forks**（user-confirmed 2026-05-14；reviewer 不应见此段）：

1. **archived 是软状态，永不真删**——硬删走 `drop_knowledge_source`（用户显式动作）。
2. **decay 是 boost / penalty，不是 filter**——`final = rrf * (1 + α * decay)`，max 30% boost；冷 chunk 仍可能进 top-K，只是优先级低。
3. **archival 阈值用户可调**（user §A）——helm Settings 加 `knowledge.lifecycle` 配置块，字段 `archiveAfterDays: number`（默认 90）、`archiveBelowAccessCount: number`（默认 3）。后端从 `liveConfig.knowledge.lifecycle` 读取，sweep / repo 接口都接受 override 便于测试注入。
4. **MCP 不开 mutating archive tool**（user §C）——`archive_chunk` / `unarchive_chunk` 不暴露给 agent，防 agent 误删。UI / 后台 sweep 才能改 archived。MCP 只读 `includeArchived` 取回 archived 内容。
5. **access bump 异步**——`searchKnowledge` 返回后 fire-and-forget；失败仅 warn。不阻塞 search 响应。
6. **decay 用 indicator 函数 `exp(-Δt/τ)`**——`τ=30d`。简单可解释。指数衰减比 sigmoid / linear 在长尾处更"温柔"。
7. **archival sweep 触发时机**（user §B）—— **每次知识修改后**（trainRole / updateRole / dropKnowledgeSource）异步跑该 role 的 sweep + boot 时全局跑一次 + 24h 全局 cron 兜底。前两条是热事件触发，最后一条防"用户长期不用 helm 但 helm 一直开着"的边角情形。修改触发跑**当前 role only**，避免 train 一个 role 顺手把别的 role 改了。
8. **SSE keepalive 25s 一次**（user §D bundled）——刚好踩在 Chrome 默认 30s idle 之下；轻成本，每连接每秒 < 0.04 byte。
9. **架构边界**：lifecycle 是单独模块（`src/roles/lifecycle.ts`），不混进 `hybrid-search.ts`——后者只负责"给定数据找相关"，前者负责"哪些数据该被找"。
10. **migration v14 不 backfill `last_accessed_at`**——NULL 是合理初值；衰减时 NULL 视作 `createdAt`（保守，避免新写的 chunk 立刻被衰减）。
11. **sweep 报告只写 log，UI 不显示**（user §E 默认）——每次 sweep 完写 INFO `archival_sweep_completed { scanned, archived, skipped, durationMs }`。Roles 页面不加冗余 "Last sweep" 信息密度。

## Risks

- **Archival 阈值 `90d + access<3` 在真实数据上不可知**：当前 helm 实际用 role 有 1-2 个月，没数据决定阈值是松还是紧。v1 用上述默认；如果实测大量"该归档没归档"或"误归档活跃 chunk"，再调。
- **decay re-rank 可能压住 freshly trained 但还没被 access 的 chunk**——刚写完的 chunk `lastAccessedAt = NULL`，当 NULL 视为 `createdAt` 时 decay 几乎是 1.0，所以新 chunk 不亏；但如果 `createdAt` 本身就老（reindex 时回填的旧时间戳）会被低估。v1 接受这个。
- **bumpChunkAccess 异步失败静默丢**：access stats 短暂落后，对决策没致命影响（decay 时差几秒不可感知）。warn 日志足够。
- **SSE keepalive 与 SDK 内部状态冲突**：`SSEServerTransport` 可能将来自己加 keepalive；现在没看到这逻辑（已读过 SDK 代码确认）。万一未来 SDK 加了我们这层就 redundant 但无害。
- **cron interval 在 shutdown 没干净清理 → Vitest 进程不退出**：必须 `unref()` interval 或 orchestrator stop() 时清。

## Related Tasks

- `2026-05-14-multipath-retrieval`（Phase 76）：本任务的 decay re-rank 直接挂在它的 RRF 输出上。无重叠 implementation。
- `2026-05-12-role-typing-and-lineage`（Phase 73）：archived chunks 仍属于其 source；drop_knowledge_source 会级联清掉 archived chunks（PK 不变）。

## Stage Log

- **2026-05-14** — task created. Reads used: `src/mcp/http-sse.ts`（keepalive 嵌入位置确认）+ `migrations.ts` 现状的 grep（确定 v13 → v14）。剩余 3 file budget。current_stage = `new_feature`。等用户对 Decisions §1–§10 / Out / SSE keepalive 范围确认后转 implement。`implement_base_commit` 待 advance 时记。
- **2026-05-14** — user confirmed A/B/C/D/E. Locked: §3 (thresholds user-tunable via Settings + new config block) and §7 (sweep triggered after every knowledge mutation + boot + 24h cron). Other decisions per task.md. Transitioning to implement. `implement_base_commit = f6779c34343e7cf2f6beff5209203322e40e7f8e` (main HEAD at PR #76 merge).
- **2026-05-14** — implement complete. Files touched:
  - **新增**：`src/roles/lifecycle.ts`, `tests/unit/roles/lifecycle.test.ts`, `tests/unit/storage/access-bump.test.ts`, `tests/unit/storage/archived-filter.test.ts`, `tests/e2e/knowledge-lifecycle/happy.spec.ts`, `tests/e2e/sse-keepalive/happy.spec.ts`
  - **后端改动**：`src/storage/migrations.ts` (v14), `src/storage/types.ts` (KnowledgeChunk lifecycle 字段), `src/storage/repos/roles.ts` (bumpChunkAccess / archiveChunks / unarchiveChunk / findArchiveCandidates / listRoleIdsWithChunks / getChunkById + 三个 reader 的 includeArchived 参数), `src/roles/hybrid-search.ts` (decay re-rank + async access bump + includeArchived 透传 + HybridSearchHit 加 chunkId), `src/roles/library.ts` (lifecycleSweepTrigger setter + searchKnowledge options 扩展), `src/mcp/server.ts` (search_knowledge includeArchived + drop_knowledge_source 触发 sweep), `src/mcp/http-sse.ts` (SSE keepalive interval + deps.keepaliveIntervalMs override), `src/app/orchestrator.ts` (boot sweep + 24h cron + setLifecycleSweepTrigger 注册), `src/api/server.ts` (POST /api/knowledge-chunks/:id/unarchive + role-detail 返回 lifecycle 字段 + mcpKeepaliveIntervalMs deps), `src/config/schema.ts` (KnowledgeLifecycleConfigSchema)
  - **渲染层改动**：`web/src/api/types.ts` (KnowledgeLifecycleConfig + RoleChunk lifecycle 字段 + HelmConfig.knowledge.lifecycle), `web/src/api/client.ts` (unarchiveChunk), `web/src/pages/Roles.tsx` (live vs archived split + access stats + Unarchive button + formatRelative helper), `web/src/pages/Settings.tsx` (Knowledge lifecycle 配置卡片)
  - **测试结果**：unit suite 全绿 (1260 passed, ↑34 vs PR #76)；e2e suite 全绿 (153 passed, ↑4 vs PR #76)；typecheck 通过；Phase 76 benchmark 仍是 fusion R@5=100% / MRR=1.000（decay re-rank 没破坏既有 ranking）。
  - **下一步**：current_stage 仍是 `implement`；等用户在新 chat 跑 `/review` 后再 archive。
