# Plugin system + role subscription via remote storage

| field           | value |
| --------------- | ----- |
| task_id         | 2026-05-14-plugin-storage-role-subscription |
| current_stage   | implement |
| created_at      | 2026-05-14 |
| project_path    | /Users/bytedance/projects/helm |
| host_session_id | (unbound) |
| implement_base_commit | d2bce5237aa11f87e88a91f3f2eb01e1c1e5c0c1 |

## Intent

### Background

agentmemory 三件套（多路检索 / lifecycle / capture）目前是**单人单机**——你训出的 goofy-expert / dr-dashboard-expert / 等等漂亮 role 完全无法分享给同事；同事训了好用的 role 也回流不到你这。Phase 78 capture 解决了「自动从 chat 学新知识」，但**新知识只属于你这台机器**。

之前路径 A（单文件 export/import）虽然能解决一部分（手动发 tarball），但**没有变更同步机制**——同事改了 role 你不知道、你改了 role 同事看不到。

agentmemory 那篇 best-practices 也明确把「plugins 把 working setup 打包分发」列为新员工 day-one productivity 的关键。

附加约束：goofy 是 Bytedance **内部工具**，role bundle 不能上 GitHub；必须走内部对象存储（TOS）。但 TOS-specific 代码也不能进 helm 公开 repo——需要插件化。

### Objective

给 helm 加两层：

1. **通用 storage plugin 系统**：helm core 定义 `StoragePlugin` 接口（download / upload / headEtag），具体某个 backend（TOS / S3 / git / GCS / ...）由插件实现，放在 `~/.helm/plugins/<id>/`。helm 启动时扫 `plugins.enabled` 配置加载。helm 公开 repo 干净，Bytedance 内部 TOS 插件单独放内部 git。

2. **Role 远程订阅**：用户配 `tos://bucket/path.helmrole` URL → helm 解析 scheme → 路由到 `helm-storage-tos` 插件 → 24h cron HEAD 检查 etag → 变了就 GET 整个 bundle → diff 本地 role 现有 chunks → 新/改 chunks 直接进 Phase 78 `knowledge_candidates` 表，用户在 Roles Candidates tab 走熟悉的 Accept / Reject / Edit 流程。

Bonus：**完成时 ship helm-storage-tos 插件本体**，验证整个 e2e flow 跑得通——helm core 在公开 repo，TOS 插件在你内部 repo（你后续 push 即可）。

单句"完成"定义：**用户在 Settings → Storage plugins 加入 helm-storage-tos；在 Subscriptions tab 加一条 `tos://bucket/roles/goofy.helmrole` 订阅；下次同事更新 goofy 后 24h 内（或手动 Sync now）helm 拉到 diff，转成候选；用户 Accept All 后本地 goofy 实时同步到最新。**

### Scope

**In:**

helm core 部分（公开 PR）：
- `src/plugins/types.ts` —— StoragePlugin / StoragePluginDeps 接口；apiVersion = 1
- `src/plugins/loader.ts` —— 读 `plugins.enabled`，`require('~/.helm/plugins/<id>/')`，调 `init`，注册到 `PluginRegistry`；失败 log+skip 不阻塞 boot（P2B）
- `src/plugins/registry.ts` —— scheme → plugin lookup
- `src/plugins/builtins/file-storage.ts` —— 内置 `file://` backend（fs.readFile/writeFile + content-hash 当 etag），零配置可用
- `src/roles/bundle.ts` —— `packRole(db, roleId) → Buffer` / `unpackRole(buf) → RoleBundle` / `applyRoleBundle(db, bundle, opts)`
  - bundle 格式：JSON，embedding base64，version 字段，contentHash 字段
  - applyRoleBundle 逐 chunk diff（按 text_hash），existed → skip；missing → 写 `knowledge_candidates`（一个新的 provenance 标记区分 chat-capture vs subscription）
- `src/storage/migrations.ts` —— migration v16：`role_subscriptions` 表 + `(role_id)` / `(status, next_sync_at)` 索引
- `src/storage/types.ts` —— `RoleSubscription` / `SubscriptionStatus`（active / paused / error）
- `src/storage/repos/role-subscriptions.ts` —— CRUD + listDueForSync
- `src/subscriptions/sync.ts` —— `runSubscriptionSweep(db, registry)`：扫所有 active 订阅，调 plugin.headEtag，etag 变了则 download + unpack + applyRoleBundle
- `src/app/orchestrator.ts` —— boot 时加载 plugins + 起 24h cron（unref'd）+ shutdown 时调 plugin.shutdown
- `src/api/server.ts`：
  - `GET /api/role-subscriptions?roleId=…`（列表）
  - `POST /api/role-subscriptions`（body: roleId, sourceUrl, autoApply）
  - `DELETE /api/role-subscriptions/:id`（取消订阅，不动 chunks——P8A）
  - `POST /api/role-subscriptions/:id/sync-now`（手动触发）
  - `POST /api/roles/:id/export`（return bundle JSON 给浏览器下载 OR `?upload=tos://…` 直接走插件 upload）
  - `GET /api/plugins`（列已加载插件 + 状态）
- 不开 MCP 工具（P6B 沿用：upload 是高权限动作，不给 agent）
- 新增 `knowledge_candidates.provenance` 列（migration v17 OR 进 v16？合并到 v16 单 migration 更清爽）：`'chat_capture' | 'subscription'`；renderer 显示 badge 区分（沿用旧 forks #5A）
- 渲染层：
  - `web/src/api/types.ts`：`RoleSubscription` / `RoleBundle` / `StoragePluginInfo`
  - `web/src/api/client.ts`：subscription CRUD + sync-now + export
  - `web/src/pages/Settings.tsx`：新增「Storage plugins」段（只读，显示 enabled / status / error）+「Role subscriptions」段（新增 / 删除 / sync-now）
  - `web/src/pages/Roles.tsx`：Candidates tab 区分 provenance：chat-capture 显示来源 chat；subscription 显示来源 URL
- 测试：
  - unit: plugin loader（missing / bad apiVersion / init throws）、bundle pack/unpack roundtrip、applyRoleBundle 三种情形（all new / all dup / partial）、file:// roundtrip、subscription repo
  - e2e: 完整路径——export role → file:// backend → 第二个 role 订阅同 URL → cron tick → candidates 出现 → accept → role 同步

TOS 插件部分（不在 helm repo，单独 dir `/Users/bytedance/projects/helm-storage-tos/`）：
- `package.json` —— 依赖 `@byted-service/tos`
- `index.js` —— 实现 StoragePlugin
  - 支持两种 mode：consul（生产）/ endpoints（本地开发）
  - per-bucket TosClient pool（lazy init + shutdown destroy）
  - AKSK 从 env 读（`TOS_ACCESS_KEY` / `TOS_SECRET_KEY`），非敏感配置（endpoint / region / psm）从 helm config 读
  - `download` → `tosClient.getObject(key)` → ArrayBuffer
  - `upload` → `tosClient.upload(buffer, key)` → etag
  - `headEtag` → `tosClient.headObject({ bucket, key })` → headers.etag；404 → null
- 本地安装：symlink 到 `~/.helm/plugins/helm-storage-tos/`，pnpm install

**Out:**
- **MCP 工具暴露 upload**：高权限动作，agent 不该自己改 role 库（P6B）
- **加密 AKSK 存配置**：明文 risk 太大，env 才是路（fork #1B → 与 plugin P 系列共识）
- **GUI 装插件**：v1 用户手动 git clone + pnpm install。CLI / GUI 自动化等真实使用频次起来再做
- **多个 storage plugin 实现**：v1 只 ship file:// (built-in) + TOS（外部）。S3 / GCS / git 留给社区贡献或后续
- **bundle 增量传输 / 差分上传**：每次都全量 PUT。bundle 通常 < 1MB，不优化也够用
- **跨 role 共享 chunks**（一段同步内容自动出现在两个订阅 role 里）：v1 一对一 role-subscription
- **订阅冲突解决**：同一 roleId 不允许超过 1 个订阅（DB 加 UNIQUE 约束）；后续要做时再放开
- **Plugin hot-reload**：改插件代码要重启 helm；不做开发期 watch
- **Embedder / LLM provider 扩展点**：v1 只 storage（P6A）

## Structure

### Entities

- **`StoragePlugin`**（src/plugins/types.ts 接口）：`{ id, scheme, version, apiVersion, init, download, upload, headEtag, shutdown? }`
- **`PluginRegistry`**：scheme → loaded StoragePlugin 实例的 Map，包内单例
- **`RoleBundle`**（in-memory + serializable）：
  ```
  {
    bundleVersion: 1,
    exportedAt: ISO,
    sourceHelmVersion: string,
    contentHash: string (sha256 of canonical JSON of chunks),
    role: { id, name, systemPrompt, isBuiltin: false, ... },
    chunks: [{ chunkText, kind, sourceFile?, sourceLabel?, embedding: base64 }, ...],
    sources: [{ kind, origin, label?, fingerprint }, ...]
  }
  ```
- **`RoleSubscription`** (DB row)：`{ id, roleId, sourceType ('file'|'tos'|...), sourceUrl, lastEtag, lastSyncAt, syncIntervalMinutes, autoApply, status, lastError?, createdAt }`
- **`SubscriptionStatus`**：`'active' | 'paused' | 'error'`
- **`SubscriptionSyncResult`**（cron 回报）：`{ subscriptionId, action: 'noop' | 'updated' | 'error', candidatesCreated?, error? }`
- **`CandidateProvenance`**（新枚举）：`'chat_capture' | 'subscription'` —— 加到 `knowledge_candidates` 表，UI 用来区分来源

### Relations

- `role_subscriptions.role_id` → `roles.id` (CASCADE)
- `knowledge_candidates.provenance` 列新增；旧行 default 'chat_capture'（向后兼容）
- subscription cron 与 Phase 77 lifecycle cron 是**两个独立 setInterval**，互不依赖（不复用 trigger setter pattern——subscription 触发器没有写路径上的等价物）
- file:// backend 是 helm core 自带的，永远注册，不计入 plugins.enabled
- 插件 init 失败 → 该 scheme 的所有订阅状态自动转 'error'，UI 显示原因

### Planned Files

后端 — 新增：
- `src/plugins/types.ts`
- `src/plugins/loader.ts`
- `src/plugins/registry.ts`
- `src/plugins/builtins/file-storage.ts`
- `src/roles/bundle.ts`
- `src/storage/repos/role-subscriptions.ts`
- `src/subscriptions/sync.ts`
- `tests/unit/plugins/loader.test.ts`
- `tests/unit/plugins/file-storage.test.ts`
- `tests/unit/roles/bundle.test.ts`
- `tests/unit/storage/role-subscriptions.test.ts`
- `tests/unit/subscriptions/sync.test.ts`
- `tests/e2e/role-subscription/happy.spec.ts`

后端 — 改动：
- `src/storage/migrations.ts` —— v16 (role_subscriptions + knowledge_candidates.provenance + unique index on role_id)
- `src/storage/types.ts` —— RoleSubscription / RoleBundle / SubscriptionStatus / CandidateProvenance
- `src/storage/repos/knowledge-candidates.ts` —— provenance 字段透传 + 反序列化
- `src/capture/candidate-writer.ts` —— provenance 默认 `'chat_capture'`
- `src/api/server.ts` —— 5 个新 endpoints
- `src/app/orchestrator.ts` —— 加载 plugins + 注册 subscription cron + shutdown 调插件
- `src/config/schema.ts` —— `plugins.enabled: string[]` + `storage: Record<scheme, any>` config 块

渲染层 — 改动：
- `web/src/api/types.ts`
- `web/src/api/client.ts`
- `web/src/pages/Settings.tsx` —— Storage plugins + Role subscriptions 段
- `web/src/pages/Roles.tsx` —— Candidates 行加 provenance badge + 来源链接

外部仓库（不在 helm repo）：
- `/Users/bytedance/projects/helm-storage-tos/`：
  - `package.json`
  - `index.js`
  - `README.md`（说明 env vars / 配置项 / 安装步骤）

合计：12 新后端文件 + 7 改动 + 1 migration + 3 渲染层 + 1 外部 plugin。

## Decisions

**Implement-stage** (2026-05-14):

- **migration v16 单一 ALTER + 单一新表**：role_subscriptions 表 + knowledge_candidates.provenance 字段在同一 migration 内，避免拆 v16/v17 造成 reviewer 看 diff 跳跃。partial unique index 覆盖 (pending OR rejected) 沿用 Phase 78 §8 的设计。
- **`loadPlugins` 接受现有 registry 而非新建**：解决 `createHelmApp` 是同步工厂、不能 await 的问题——同步创建空 registry → 同步传给 createHttpApi → 异步在 start() 里 populate。endpoint 调 `registry.getByScheme()` 在 hit 时取最新——populate 完成前到达的请求才会看到空 registry，但 start() 立刻完成所以窗口极短。
- **file:// 是 helm core 直接 register，不走 plugin loader**：避免「内置也要 enable」的反直觉；同时让所有测试零配置可用。
- **bundle 格式用 JSON 不用 tarball**：grep-able / diff-friendly / 单 PUT 上传原子。Embedding base64 编码避免二进制污染。Size cost 可忽略（典型 < 1 MB）。
- **contentHash 是 canonical-form sha256（按 textHash 排序后 join \n）**：保证「相同 chunks 集合 → 相同 hash」无视插入顺序，避免「同 commit 重新 export 触发 sync」。
- **applyRoleBundle 不删 chunks**：bundle 描述「这是 role 当前应有的内容」，但本地多出来的 chunks 是用户加的——v1 不动它们。这跟 git pull 的 fast-forward 语义类似（local 不被覆盖）。
- **`SUBSCRIPTION_CRON_MS = 15min` 但 `sync_interval_minutes` per-row 默认 24h**：cron tick rate 是「醒来检查谁该 sync」频率；实际 sync 频率由 row 自己控制。让"Sync now"按钮的 race recovery 不会等 24h。
- **subscription 失败 → status='error' + lastError**：sync 内部 catch all errors；UI 看 row 状态决定要不要让用户介入。
- **bundle 的 `sourceSegmentIndex` 设为 bundle 内的 chunk index**：跟 Phase 78 chat-capture 用 splitter index 不同——bundle 没有 splitter；用 bundle 内 chunks 数组位置满足字段非 null 约束即可。
- **scoreEntity / scoreCosine 设 0**：bundle 来源不是统计发现，是 peer 显式写的。UI 显示「entity=0 cosine=0」让用户一眼看出这条来自 subscription 而非 chat capture（双重信号：provenance badge + 全 0 score）。
- **`insertCandidateIfNew` 只吞 `SQLITE_CONSTRAINT_UNIQUE`**（继承 Phase 78 reviewer #1 修复）：subscription 触发的 FK 失败（role 被删）也能正确冒泡到 sync 层处理。
- **export endpoint `?upload=tos://…` 直接走插件**：不是单独 endpoint。复用同一 `pack → bytes → plugin.upload` 路径，减少 surface 多样性。

**Pre-implement aligned forks**（user-confirmed 2026-05-14；reviewer 不应见此段）：

Plugin system forks (P 系列)：
1. **P1A 显式 allowlist**：`plugins.enabled: ['helm-storage-tos']` 配置，从 `~/.helm/plugins/<id>/` 加载。不做 npm 包名前缀 auto-scan，不做绝对路径配置。
2. **P2B 失败 skip**：plugin 加载/init 失败 → log+warn+从 registry 跳过；helm 继续启动；该 scheme 的订阅自动 status='error'。
3. **P3B integer apiVersion**：v1 = `apiVersion: 1`；后续 helm 维护 `SUPPORTED_PLUGIN_API_VERSIONS = [1]`，加新版兼容性显式管理。
4. **P4B Bytedance 内部 git**：TOS 插件 repo 不在公开 GitHub。helm core 公开 repo 完全不含 TOS 字眼。
5. **P5A vendor types**：helm core 的 `src/plugins/types.ts` 是规范；插件作者复制这个文件到自己 repo 即可（不发 npm `helm-plugin-api`）。
6. **P6A 只 storage**：v1 plugin loader 只识别 StoragePlugin；不预留 embedder/llm extension point。需要时再扩。
7. **P7A 默认内置 file://**：file:// scheme 由 helm core 直接实现并注册，不算 plugin。http(s):// 不内置（让插件做）。

继承自前一轮的 TOS-specific forks（"全按默认走"已隐式确认）：
- **#1B AKSK 走 env**：TOS_ACCESS_KEY / TOS_SECRET_KEY。helm config 只存 endpoint / region / psm / clientPSM 这类非敏感字段
- **#2B 推荐但不强制 bucket 结构**：文档建议 `<bucket>/helm/roles/<roleId>.helmrole`，但 helm 不验证 URL 路径
- **#3C 24h 默认 + 手动 Sync now**：cron 24h tick + UI 按钮
- **#4C trusted-source 白名单**：per-subscription `autoApply: boolean` 字段；默认 false 走 candidates；true 直接 applyRoleBundle 跳过用户审批
- **#5A 同 tab badge 区分**：Candidates tab 不拆，每行渲染 provenance badge（"📤 from chat-1" vs "🔗 from tos://...")
- **#6B 只 CLI/UI 上传**：不开 MCP `role_export` 工具
- **#7B content hash 版本**：bundle 的 contentHash 字段是 sha256(canonical JSON of chunks)；subscription 表存 lastEtag (来自存储后端) + lastContentHash（来自最近 unpack 的 bundle），任一变就触发 apply
- **#8A 取消订阅保留 chunks**：DELETE /api/role-subscriptions/:id 只删订阅行，不动 role 的 chunks（已 accept 的就是用户的）

Implement-stage 新增取舍（开工时再补）。

## Risks

- **TOS SDK 是 Bytedance 内部 npm**：CI 跑不到（github actions 拉不到内部 registry）。helm core 的测试不依赖 TOS——只在外部插件 dir 测；helm core CI 只测 file:// + plugin loader mechanics。
- **AKSK 泄漏**：env 是最不糟糕的方案但仍可能误进 ps / shell history。文档要警告。永远不写进任何 log（plugin 实现要小心 stringify error）。
- **bundle 兼容性**：bundleVersion = 1 现在；将来 schema 变化要怎么 migrate？v1 简单——unpack 时检查 version，不匹配就 reject 订阅。Migration tool 后补。
- **content-hash 漂移**：导出时 JSON.stringify 顺序敏感；要用 canonical JSON（key 排序）。否则同样数据每次 hash 不同，无穷触发 apply。
- **autoApply=true + 恶意 bundle**：被插件路径污染的远程内容会直接进 role 库。文档强调只对完全可信的源开。
- **subscription unique on role_id**：一个 role 只能订一个源。后续多源合并需求出现时要重新建模——v1 不做。
- **Phase 78 candidates 增量来源**：以前是 chat-capture only，现在加 subscription 一类——renderer / repo / scorer 都要确认对 provenance 列不假设。

## Related Tasks

- `2026-05-14-auto-capture-role-knowledge`（Phase 78）：subscription 复用 candidates 表 + UI flow；本任务给它加 provenance 列
- `2026-05-12-role-typing-and-lineage`（Phase 73）：bundle 导出时包含 sources lineage；import 时 source 行重建
- `2026-05-10-harness-toolchain-mvp`（Phase 67）：plugin loader 跟 harness 无依赖关系，但 Settings UI 风格统一

## Stage Log

- **2026-05-14** — task created。所有 plugin / TOS forks 已锁定。current_stage = `implement`。implement_base_commit = `d2bce5237aa11f87e88a91f3f2eb01e1c1e5c0c1` (main HEAD 即 Phase 78 archive PR #80 合入后)。
- **2026-05-14** — implement complete。Files：
  - **新增**：`src/plugins/{types,registry,loader,index}.ts`, `src/plugins/builtins/file-storage.ts`, `src/roles/bundle.ts`, `src/storage/repos/role-subscriptions.ts`, `src/subscriptions/sync.ts`, plus 5 test files (loader / file-storage / bundle / subscriptions sync / e2e happy)
  - **后端改动**：migration v16, types.ts (RoleSubscription / SubscriptionStatus / CandidateProvenance + 在 KnowledgeCandidate 上加 provenance), knowledge-candidates repo (provenance 列读写), candidate-writer.ts (默认 provenance='chat_capture'), api/server.ts (5 new endpoints + helmVersion + pluginRegistry/runSubscriptionSyncOnce deps), config/schema.ts (plugins + storage 配置块), orchestrator.ts (registry + cron + plugin shutdown)
  - **渲染层**：api/types.ts + api/client.ts + Settings.tsx (StoragePluginsCard + RoleSubscriptionsCard 子组件)
  - **外部仓**：`/Users/bytedance/projects/helm-storage-tos/`（package.json + index.js + README）—— 不在 helm repo，要 push 到内部 git
  - **本地安装**：symlink `~/.helm/plugins/helm-storage-tos -> /Users/bytedance/projects/helm-storage-tos`，require.resolve 验证成功
  - **测试**：1329 unit (+33 vs Phase 78 baseline)，162 e2e (+2)，全绿；typecheck 通过
  - **下一步**：current_stage 仍是 `implement`；等用户在新 chat 跑 `/review` 或叫起子代理审。
