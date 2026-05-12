# Role knowledge typing + source lineage

| field           | value |
| --------------- | ----- |
| task_id         | 2026-05-12-role-typing-and-lineage |
| current_stage   | implement |
| created_at      | 2026-05-12 |
| project_path    | /Users/bytedance/projects/helm |
| host_session_id | (unbound) |
| implement_base_commit | 74eb09ac153646d01c6cf9d1eb720ff995b984d8 |

## Intent

### Background

helm 的 role 知识库现在是 *"raw doc → 朴素 line-based chunking → cosine 向量召回"* 的直管线。这套在 role 知识规模小（每个 role 几十到几百 chunk）时工作得不错，但有两个结构性弱点：

1. **chunks 没有类型**——`spec` / `example` / `warning` / `runbook` / `glossary` 这些不同性质的内容混在一起，agent 在 `search_knowledge` 拿 top-K 结果时没法说"只给我 warning"或"先看 runbook"。检索精度的上限被打平。
2. **chunks 没有 lineage**——每个 chunk 只有一个软性的 `sourceFile` 字符串，没有指向"它从哪个被采集的 raw doc 编译出来"的硬引用。一份 Lark 文档被废弃时，从它编译出的派生 chunks 不会联动消失；用户得手动 grep 删，否则知识库随时间积累过时内容。

C4A Context (2026-05-12 读到的同类型项目) 在两个点上都做了升级——typed Sections + source provenance with cascade drop。它选择极端方案（完全放弃向量），我们不学这一步，但把"typing"和"lineage"这两层加上去对 helm 的知识库价值很大，工程量也小。

### Objective

把 helm 的 role 知识库从 *"untyped text chunks + 软引用 sourceFile"* 升级成 *"typed Sections + 硬引用 source lineage"*：

- 每个 chunk 带一个 `kind` 字段（spec / example / warning / runbook / glossary / other），`search_knowledge` 支持按 kind 过滤；
- 引入 `knowledge_sources` 表记录每次 `train_role` / `update_role` 的来源（一个 source = 一份 raw doc 或一段被 ingest 的内容）；每个 chunk 有 `source_id` 外键；
- 新增 `drop_knowledge_source` MCP 工具：移除一个 source → 联动 ON DELETE CASCADE 删掉所有派生 chunks；
- 已有的训练管线（`train_role` / `update_role`）在写 chunks 时**自动**生成 source 行并打上 kind（默认 `other`，agent 可以在 MCP 工具入参里显式声明）；
- 不动 cosine 向量 RAG——这层留着，作为"按语义模糊召回"的 fallback；typing + lineage 是新的过滤维度，正交叠加。

单句"完成"定义：**用户 `train_role` 一份带 specs 和 examples 的文档 → 各 chunk 在 DB 里带正确的 kind + source_id；`search_knowledge` 可以按 `{ kind: 'spec' }` 过滤；`drop_knowledge_source` 撤回某 source 后，该 source 的 chunks 全部消失，其它 source 的 chunks 不受影响。**

### Scope

**In:**
- migration v12：新表 `knowledge_sources`（id / role_id / kind: 'lark-doc'|'file'|'inline' / origin / fingerprint / label / created_at）+ `knowledge_chunks` 加列 `source_id` (FK→knowledge_sources.id ON DELETE CASCADE) + `kind` (TEXT, default `'other'`)。
- migration v12 **同时一次性 `DELETE FROM knowledge_chunks WHERE source_id IS NULL`**——按 user 拍板 (decision §D)，清理 source_id 为空的存量 chunks，迁移完成后所有 chunks 都带 source。built-in roles 因为没真实 source，由 `seedBuiltinRoles` 在启动时重新建（系统提示重写，chunks 为空——本来也是）。
- `src/storage/repos/roles.ts`：新增 source-级 CRUD（`insertSource` / `getSource` / `getSourceByFingerprint` / `listSourcesForRole` / `deleteSource`） + chunk 写入接受 `kind` + `sourceId`。
- `src/roles/library.ts`：`trainRole` / `updateRole` 入参扩展，每份 input document 可带 `kind` + 自动生成（或复用同 fingerprint 的）source 行；chunk 写入时绑定 `source_id`。fingerprint = SHA-256(filename + '\n' + content)。
- `src/mcp/server.ts`：
  - `train_role` / `update_role` 入参 `documents` 字段每条新增可选 `kind`；
  - `search_knowledge` 新增可选 `kind` filter；
  - 新工具 `drop_knowledge_source`（输入 `sourceId`，返回删了几个 chunks + source 元数据）；
  - 新工具 `list_knowledge_sources`（按 roleId 列出所有 source 含统计 chunkCount）。
- `src/roles/library.ts → searchKnowledge`：实现 `kind` 过滤。
- **Roles 页 UI（user decision §E）**：每个 chunk 详情显示 `kind` badge + source 链接；role 详情页加一个 "Sources" 区块列出该 role 的所有 source（含 origin / kind / chunkCount / Drop 按钮）。
- 测试：单测 + e2e 覆盖 typing / lineage / cascade drop / search filter / fingerprint dedup。

**Out:**
- 完全放弃向量召回（C4A 路线，工程量太大，对 helm 当前知识规模 ROI 不足）。
- chunk 间交叉引用（cross-refs / "see also"）：值得做但和本任务的"打类型 + 拉血缘"是正交维度，留 follow-up。
- AI-mediated "编译" 阶段（让 agent 把 raw doc 加工成结构化 Sections 而不是 line-based chunk）：值得但要单独立项，本任务先做存储层 + 接口层。
- 给非 role 知识库（Harness archive cards / requirements）加 typing：已经有自己的结构化字段，不需要这层。
- `update_role` 的冲突检测要不要按 kind 分桶（"spec 和 example 不算冲突"）：值得，但留 follow-up。
- 新增的 source / chunk-kind 字段在 **Settings UI** 上做配置（"我倾向给我训过的所有 chunks 默认 kind 为 spec"之类）—— Phase 2。

## Structure

### Entities

- **KnowledgeSource**（新表）：一次资料采集事件的具象化。字段：`id` (uuid PK)、`roleId` (FK→roles.id)、`kind`（`'lark-doc'` | `'file'` | `'inline'`，表示来源类型）、`origin`（URL 或文件路径或 `'inline-<hash>'`）、`fingerprint`（内容 SHA-256，便于"同一个 doc 重训时复用 source 行"）、`label`（可选用户备注）、`createdAt`。
- **KnowledgeChunk**（已有表，扩列）：`source_id` (FK→knowledge_sources.id ON DELETE CASCADE，可空——存量数据 / inline-no-source 情况下为 null)、`kind`（`'spec'` | `'example'` | `'warning'` | `'runbook'` | `'glossary'` | `'other'`，默认 `'other'`）。`sourceFile` 列保留（向后兼容），但 `source_id` 是新的硬引用。

### Relations

- `KnowledgeSource.role_id` → `roles.id` (FK, ON DELETE CASCADE)
- `KnowledgeChunk.source_id` → `knowledge_sources.id` (FK, ON DELETE CASCADE)
- 一个 source 可以产生 N 个 chunks；一个 chunk 最多绑一个 source。`source_id` 为 null 表示"chunk 没有可追溯的 source"（migration 跑完之后的存量 chunks 都是这种）。

### Planned Files

后端 — 改动：
- `src/storage/migrations.ts` — migration v12：建 `knowledge_sources` 表 + `ALTER knowledge_chunks ADD COLUMN source_id` + `ALTER knowledge_chunks ADD COLUMN kind`，加索引 `idx_chunks_source`、`idx_sources_role`。
- `src/storage/types.ts` — 新增 `KnowledgeSource` interface；`KnowledgeChunk` 加 `sourceId?: string` + `kind: KnowledgeChunkKind`；导出 `KnowledgeChunkKind` 字面量联合。
- `src/storage/repos/roles.ts` — 新增 `insertSource` / `getSource` / `listSourcesForRole` / `deleteSource`；`insertChunk` 接受 `sourceId` + `kind`；`getChunksForRole` 返回新字段；新增 `getChunksForRole(roleId, { kind })` 过滤。
- `src/roles/library.ts` — `trainRole` / `updateRole` 的 `documents` 元素接受 `kind`；在 chunk 写入前先生成一行 source（如果该 doc 没有现成的同 fingerprint source）；`searchKnowledge` 接受 `kind` filter 并下推到 `getChunksForRole`。
- `src/mcp/server.ts` — `train_role` / `update_role` schema 添加 `documents[i].kind` 可选；`search_knowledge` schema 添加 `kind` 可选；注册 2 个新工具 `drop_knowledge_source` / `list_knowledge_sources`。

测试 — 新增：
- `tests/unit/storage/knowledge-sources.test.ts` — source CRUD、cascade delete、按 role 列出。
- `tests/unit/storage/knowledge-chunks-kind.test.ts` — kind 默认值、按 kind 过滤、source_id null 行的行为。
- `tests/unit/roles/library-typing.test.ts` — `trainRole` 自动生成 source；`searchKnowledge` 按 kind 过滤；`updateRole` append 时复用同 fingerprint source。
- `tests/e2e/role-typing-lineage/happy.spec.ts` — 端到端：训 role 带两种 kind 的 documents → search 按 kind 过滤 → drop source 后 chunks 联动消失，其它 source 不受影响。

合计：4 已有文件改动、4 新测试文件、1 migration。

## Execution

### Actual Files

后端 — 改动:
- `src/storage/migrations.ts` — migration v12: 建 knowledge_sources 表 + chunks 加 source_id/kind 列 + 一次性 DELETE source_id IS NULL 的存量 chunks (Decision §D).
- `src/storage/types.ts` — 新增 `KnowledgeSource` / `KnowledgeChunkKind` / `KnowledgeSourceKind` 字面量联合 + `KNOWLEDGE_CHUNK_KINDS` 常量; `KnowledgeChunk` 加 `kind` (required) + `sourceId` (optional).
- `src/storage/repos/roles.ts` — 新 source CRUD: `insertSource` / `getSource` / `getSourceByFingerprint` / `listSourcesForRole` (含 chunkCount JOIN) / `deleteSource` (返回 `{ removed, chunksDeleted }`); chunk 写入接受 kind+sourceId; `getChunksForRole` 加 `{ kind?, sourceId? }` 过滤选项.
- `src/roles/library.ts` — `TrainRoleDocument` 接口暴露 `kind` / `sourceKind` / `origin` / `sourceLabel`; `fingerprintDoc()` + `inferSourceKind()` + `ensureSource()` helpers; trainRole 在 full-replace 时也清除存量 sources (避免孤儿); updateRole 用 `sourceByDocIndex` map 在 chunk insert 之前 materialize source; `searchKnowledge` 改为 `(opts: SearchKnowledgeOptions | number)` 兼容签名 + 把 kind 过滤下推到 `getChunksForRole`.
- `src/mcp/server.ts` — `train_role` / `update_role` schema 新增可选 `kind` / `sourceKind` / `origin` / `sourceLabel` per doc; `search_knowledge` schema 加 `kind`; 注册 `list_knowledge_sources` + `drop_knowledge_source` 两个新工具.
- `src/api/server.ts` — `GET /api/roles/:id` 在响应里加 `sources` 数组 (含 chunkCount); `DELETE /api/knowledge-sources/:id` 新端点; `POST /api/roles/:id/train` 接受新字段; `HttpApiDeps.trainRole` 入参类型扩展.

渲染层:
- `web/src/api/types.ts` — `KnowledgeChunkKind` / `KnowledgeSourceKind` 字面量; `RoleChunk.kind` + `sourceId`; 新增 `KnowledgeSource` 接口; `TrainRoleInput.documents` 加可选字段.
- `web/src/api/client.ts` — `role()` 返回里加 `sources`; 新 `dropKnowledgeSource()` 方法.
- `web/src/pages/Roles.tsx` — `KindBadge` 组件 + 6 色板; "Sources" 区块带 Drop 按钮 + 二次确认; 训练表单加 Kind 下拉 (默认 other); 每个 chunk 列表项前显示 KindBadge.

测试:
- `tests/unit/storage/knowledge-sources.test.ts` (12 cases) — source CRUD / fingerprint scoping / cascade delete / kind filter / role-delete cascade.
- `tests/unit/roles/library-typing.test.ts` (10 cases) — trainRole 源生成 / 默认 kind 'other' / full-replace 清 sources / 推断 sourceKind / fingerprint 复用 / updateRole 不同内容生成新 source / searchKnowledge kind 过滤 / 兼容 positional topK / sourceId 回传.
- `tests/e2e/role-typing-lineage/happy.spec.ts` (6 cases) — MCP 端到端: train+search kind 过滤 / list_knowledge_sources chunkCount / drop_knowledge_source 级联 / 未知 id idempotent / fingerprint 复用 / 默认 kind 'other'.
- `tests/unit/storage/roles.test.ts` + `tests/e2e/session-start-injection/happy.spec.ts` — 旧 fixture 加 `kind: 'other'` 字段。

合计：8 source 文件改动、4 新测试文件、1 migration、+22 unit cases、+6 e2e cases.

### Patterns Used

- **典型联合: `KnowledgeChunkKind = 'spec' | 'example' | ...`** + `KNOWLEDGE_CHUNK_KINDS` runtime 数组导出. zod schema 和 SQL 数据是松绑定 (DEFAULT 'other')，新 kind 加法不需要 migration.
- **Fingerprint = SHA-256(filename + '\n' + content)**, 单调函数, 让 dedup 决策可重现 + 跨进程可复制.
- **Source row 是"raw doc ingestion event"的具象化**, 不是 doc 内容本身——cascade delete 只删 helm DB 的 chunks, 不动用户原始 Lark/文件.
- **Decision §6 (fingerprint 复用 source) + §C (不 dedup chunks)** 的组合: 同一份 doc 重训会得到一份 source 多份 chunk, 用户可见 + 可选择性手动 drop. 比"全自动 dedup"更显式.
- **`getChunksForRole(roleId, { kind?, sourceId? })`** 把过滤下推到 SQL WHERE, 不在 JS 端 filter, 避免 LOAD-then-discard 浪费.
- **API 兼容性**: `searchKnowledge` 第 5 参数接受 `SearchKnowledgeOptions | number`——旧代码用 `topK` 数字传参的路径还能工作, 避免连锁修改.

## Validation

### Test Plan

(已实现, 见 Cases Added)

### Cases Added

- `tests/unit/storage/knowledge-sources.test.ts` — 12
- `tests/unit/roles/library-typing.test.ts` — 10
- `tests/e2e/role-typing-lineage/happy.spec.ts` — 6

### Lint Results

- `pnpm typecheck` — clean (root + web)
- `pnpm test` — **1180 passed** (was 1158)
- `pnpm test:e2e` — **140 passed** (was 134)

## Decisions

(implement 阶段填实施级取舍)

**Pre-implement aligned forks**（user-confirmed 2026-05-12；reviewer 不应见此段；archive 时由 reviewer 注入函数过滤）：

1. **typing 不做 AI-mediated 编译**——只在 input doc 上加可选 `kind`，由 agent / 用户显式声明。raw → chunk 的内部切分仍然走现有的 line-based `chunkDocument`。"AI 编译"留未来扩展。
2. **不动 cosine 向量**——typing + lineage 是正交叠加。`search_knowledge` 流程改成"先按 kind 过滤候选 chunks，再算 cosine 排序"；空 kind = 不过滤（向后兼容）。
3. **migration 删除存量未追溯 chunks**（user §D）——v12 跑完 `DELETE FROM knowledge_chunks WHERE source_id IS NULL`。承担一次性数据损失换"系统从迁移完就 100% 可追溯"。built-in roles 没有真实 chunks（只有 system prompt），不受影响；用户训过的 chunks 全部要重训。release notes 必须显式标注。
4. **kind 6 个起步**（user §A）：`'spec'` / `'example'` / `'warning'` / `'runbook'` / `'glossary'` / `'other'`。默认 `'other'` 兜底，agent 不主动声明也能写入。后续观察 agent 实际分布按需扩。
5. **source 3 类**（user §B）：`'lark-doc'` / `'file'` / `'inline'`。
6. **fingerprint 在 source 上**——SHA-256(filename + '\n' + content)。`update_role` 同 fingerprint **复用 source**（不新建 source 行），但**直接 insert 新 chunks**（user §C：保留冗余，明示用户重复行为；要 dedup 必须显式 drop + 重训）。重训内容变了就生成新 source，旧 source 的 chunks 不动。
7. **`drop_knowledge_source` 是显式动作**——只能 user / agent 主动触发；连带删除靠 SQL `ON DELETE CASCADE` 保证原子性。
8. **本期做 UI**（user §E）——Roles 页加 chunk kind badge + Sources 列表 + Drop 按钮。不在 Settings 做 kind/source 默认值配置（留 Phase 2）。

## Risks

- **migration 对存量 chunks 的影响**：新加的 `source_id` 列对旧行是 NULL、`kind` 列默认 `'other'`。读路径要容忍 source_id 为 null（已规划）。写路径要避免误把 null 当 invalid（要测）。
- **kind 字面量后续扩展**：6 个值是当前判断够用的最小集。未来加新 kind（如 `'process'` / `'decision'`）时，DB 列是 TEXT 不需要 migration，但 TypeScript 联合类型 + zod schema 要同步更新——这是好事，反而能在新 kind 推出时强制 review。
- **fingerprint 算重训会产生新 source vs 复用 source**：策略是"完全相同的内容（含 filename + content）算同 fingerprint"。如果用户改了一字然后重训，会生成新 source；旧 source 的 chunks 不会自动失效。这条要在 update_role 文档里明确说，避免用户期待"自动 dedup"。
- **chunk 重训 vs source 复用**：当 fingerprint 命中已有 source 时，要不要把旧 chunks 全删再插？现在的 `train_role` 是 full-replace 整 role 的 chunks，所以问题不大；`update_role` (append) 复用同 fingerprint source 时直接 insert 新 chunks，会有"同 source 下多份冗余 chunks" 的可能——本任务**接受**这个，作为已知行为：用户可以手动 drop 这个 source 重训。
- **测试覆盖范围**：cascade delete 在 sqlite WAL + foreign_keys=ON 下的行为，要单测显式 pin（migration 跑完后 PRAGMA 是否还生效、不同连接是否一致）。

## Related Tasks

(在 `harness_create_task` 内部 token 搜索时由 helm DB 自动检索；目前 archive 表只有 `2026-05-10-harness-toolchain-mvp`，与本任务无 entity 重叠——它是工作流，本任务是 role 知识库。)

## Stage Log

- **2026-05-12** — task created from C4A Context comparison discussion. Intent + Structure 从 helm 现状 + C4A 借鉴点综合而来。budget 用 3 source files：`src/storage/types.ts`（KnowledgeChunk 形状）、`src/roles/library.ts`（trainRole/updateRole 管线）、`src/storage/migrations.ts`（current version=11 → next=12）。剩余 2 file budget。current_stage = `new_feature`，等用户对 Intent / Out / forks 确认后转 implement。
- **2026-05-12** — user confirmed A/B/C/D/E. Locked into Decisions §3-§8. Notably §D = delete existing source_id-NULL chunks during migration (one-shot clean slate); §E = include Roles UI in this task scope. Transitioning to implement. `implement_base_commit = 74eb09ac153646d01c6cf9d1eb720ff995b984d8`.
- **2026-05-12** — implement done. 8 file modifications, 4 new test files, 1 migration. typecheck clean. 1180 unit (+22), 140 e2e (+6). Implementation notes: (a) `trainRole` full-replace also wipes existing source rows (no orphans); (b) ABI mismatch hit mid-build because `pnpm package:dir` had earlier rebuilt better-sqlite3 against Electron — fixed with `pnpm rebuild better-sqlite3`; (c) `searchKnowledge`'s 5th param accepts `SearchKnowledgeOptions | number` for backward-compat (existing callers passed `topK` positionally); (d) Decisions §6 + §C combination produces user-visible "I retrained the same doc → I now have 1 source + 2× chunks" — feels right, no automatic surprise; (e) Roles UI Kind picker is per-batch (not per-file) — agents driving the MCP path can do per-doc kinds. Ready for review.
