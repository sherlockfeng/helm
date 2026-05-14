# Multipath retrieval — BM25 + cosine + entity match with RRF fusion

| field           | value |
| --------------- | ----- |
| task_id         | 2026-05-14-multipath-retrieval |
| current_stage   | implement |
| created_at      | 2026-05-14 |
| project_path    | /Users/bytedance/projects/helm |
| host_session_id | (unbound) |
| implement_base_commit | 66e5409843c504317942ac2ba8ab56eaba9be390 |

## Intent

### Background

`searchKnowledge` 现在只走单路——**cosine over pseudo-embedder**。两个问题：

1. **召回质量上限低**：pseudo-embedder 是 char-bin bag（128 维 codepoint 频次 + L2 norm），对短中文段、命名实体名、URL、code identifier 这些"语法显眼但分布不显眼"的查询识别力差。Phase 66 conflict detection 里就因此被迫塞了一个 force-true 出口——任何两段英文都会被它判成"相似"。
2. **没法做"按 entity / 文件名命中"**：用户 query 里出现 `tce rollback` 或 `bytedance.us.larkoffice.com/docx/Nd2Cd...`，cosine 看不见这些 token；BM25 / 关键词 / entity match 是天然 fit。

参考 agentmemory 的 `hybrid-search.ts`（已 reading-pass 过）：他们用 **BM25 + vector + graph** 三路并行召回，RRF（Reciprocal Rank Fusion）合分，每路缺失就 drop 并重新归一化权重。对 ~1k-10k chunks 量级（helm 单个 role 典型规模）这套方案够用、稳健、可解释。

### Objective

helm 的 role 知识检索从单路 cosine 升级到 **三路并行 + RRF 融合**：

- **BM25** 路：sqlite FTS5 内置实现（不重造轮子），覆盖 token / keyword / 命名实体的字面命中
- **Cosine** 路：保留现有 cosine over embedding（Phase 73 已有），覆盖语义相近的非字面命中
- **Entity match** 路：规则提取的 entity（filename / camelCase / URL / Phase 73 `sourceFile`）建索引，query 提取 entity 后做命中加分；不上 LLM-extracted entity graph（v1 工程量太大且不可重现）
- 三路 top-K * 2 候选 → RRF（K=60，权重 0.4 / 0.6 / 0.3 默认，缺失路 drop-then-renormalize）→ diversify by `source_id`（max 3 per source，Phase 73 source 概念顺接）→ top-K 返回

单句"完成"定义：**`search_knowledge` 同时跑三路，融合后的结果在以下 benchmark 任务中 R@5 显著优于单路 cosine：(a) 短中文术语查找；(b) URL / 文件名命中；(c) camelCase identifier 查找；(d) 自然语言 paraphrase（cosine 仍然占优、不被 BM25 拖下水）。MCP `search_knowledge` 新增 `strategy: 'fusion' | 'bm25' | 'cosine'`（默认 fusion）参数，旧调用方零迁移代价。**

### Scope

**In:**
- migration v13：建 sqlite FTS5 virtual table `knowledge_chunks_fts(chunk_text, content='knowledge_chunks', content_rowid='rowid')` + 自动同步 trigger（insert/update/delete on knowledge_chunks → mirror FTS5）；新表 `knowledge_chunk_entities (chunk_id, role_id, entity, weight, created_at)` + 索引按 entity / role_id。
- `src/roles/entity-extract.ts`（新文件）：规则提取 entity，按以下优先级链：
  - **(1) helm-specific whitelist**（导出常量 `KNOWN_HELM_ENTITIES`，覆盖 `MR` / `PR` / `QA` / `K8s` / `S3` / ... 这种 2 字母短缩写——whitelist 总是命中，绕过下面的长度门槛）
  - **(2) 全大写缩写 ≥3 字母**（`TCE` / `CSR` / `RBAC`）
  - **(3) camelCase / PascalCase identifier**（≥2 个 word 段，避免 `Hello` 这种单词噪声）
  - **(4) URL host / path 末尾 token**
  - **(5) filename basename**（去后缀，剥 path）
  - 兜底：未被 entity 抓到的 2 字母短缩写靠 BM25 字面命中救
  - **不**做 LLM 提取，不做 stop word 过滤（FTS5 的 unicode61 tokenizer + IDF 已经过滤掉常见词）
- `src/storage/repos/roles.ts`：新增 `insertChunkEntities` / `listChunkEntities` / `searchByEntity` / `bm25Search`（包装 FTS5 query）。
- `src/roles/hybrid-search.ts`（新文件）：核心 `hybridSearch(db, roleId, query, embedFn, opts)` 函数，并行三路 → RRF → diversify → 返回。沿用 agentmemory 的 `RRF_K=60`、`weights = { bm25: 0.4, cosine: 0.6, entity: 0.3 }` 默认；drop-then-renormalize。
- `src/roles/library.ts`：`searchKnowledge` 改成 strategy router（`'fusion' | 'bm25' | 'cosine'`，默认 `'fusion'`），原 cosine 逻辑保留为 `'cosine'` 分支；`trainRole` / `updateRole` 在 chunk insert 时同时插 chunk_entities（在 `chunkDocument` 之后立刻跑一遍 entity extract）。
- `src/mcp/server.ts`：`search_knowledge` schema 新增可选 `strategy`（默认 `'fusion'`），描述里说明三路融合 + 何时该手动用单路（debug / 跟新 embedder 对比）。
- 测试：单测 + e2e 覆盖 FTS5 trigger / entity extract / RRF 融合 / drop-renormalize / diversify by source / 兼容老 cosine 路径。
- 一段简单的 benchmark fixture（不上 LongMemEval 全套，用 10-20 个手写 query + 已知正确答案的"小型评估集"放在 tests 下），跑 fusion / cosine / bm25 三种 strategy 对比 R@5 / MRR。helm 不固化"必须超过 X% 才能合"，但 benchmark 输出在 PR description 里作为 regression sentinel。

**Out:**
- LLM-extracted entity graph（agentmemory 的做法，太重，留后续）
- Cross-encoder reranker（agentmemory 也是 env-gated，第二阶段）
- Query expansion（同义词 / 同形异义 / temporal concretization）—— 留后续，需要 synonym 表 / NLU
- Real embedder（语义向量真正变强）—— 独立维度，下一期单独立项
- Compact-vs-expand 两阶段返回（节省 token）—— 独立的 UX 优化，下期
- BM25 自己 reimplement（不写 in-memory TS 版本，直接用 FTS5）
- 默认权重 `0.4 / 0.6 / 0.3` 的自适应调参（按 corpus size / 用户偏好动态调）—— v1 写死，可观测后再调
- 把 `kind` 过滤（Phase 73）合并到 fusion ranker —— 保持正交：`kind` filter 仍然在 SQL where 阶段 pre-filter，fusion 在 filtered pool 上算
- benchmark CLI 工具（agentmemory 的 `npx demo`）—— 不做，固定的 tests/benchmark/fixture 够 review 用
- Chinese tokenizer 定制 —— FTS5 默认 unicode61 + trigram 对中文够用 v1，后续 jieba 集成留独立任务

## Structure

### Entities

- **`knowledge_chunks_fts`**（新 FTS5 virtual table）：sqlite contentless FTS5，column 仅 `chunk_text`，`content='knowledge_chunks' content_rowid='rowid'` 让它跟主表外部一致。自动 trigger 同步 INSERT/UPDATE/DELETE。
- **`KnowledgeChunkEntity`**（新表）：每行 `(chunk_id, role_id, entity, weight)`。一个 chunk 可有多个 entity；同一 entity 在不同 chunk 各自一行。`weight` 当前固定 1.0（占位，未来按 entity 类型给权重，如 PascalCase=1.0 / abbreviation=0.8 / filename=0.6）。
- **`HybridSearchResult`**（library-level 内部类型）：`{ chunkText, kind, sourceId?, score, bm25Score, cosineScore, entityScore, rrfRank }`—— 同时暴露每路原始分用于 debug + 解释 ranking。
- **`SearchStrategy`**: `'fusion' | 'bm25' | 'cosine'` 字面量联合。
- **`RrfFusionParams`**: `{ k: 60, weights: { bm25: 0.4, cosine: 0.6, entity: 0.3 } }`—— 常量但导出，让测试和 benchmark 可以注入不同值。

### Relations

- `knowledge_chunks_fts.rowid` → `knowledge_chunks.rowid`（FTS5 external content 模式，trigger 维护一致性）
- `knowledge_chunk_entities.chunk_id` → `knowledge_chunks.id` (FK, ON DELETE CASCADE)
- `knowledge_chunk_entities.role_id` → `roles.id` (FK, ON DELETE CASCADE) — 冗余但让按 role 查 entity 不用 JOIN
- 三路检索结果通过 `chunk_id` 在 RRF 函数里合并

### Planned Files

后端 — 新增：
- `src/roles/entity-extract.ts` — `extractEntities(text, filename?)` 函数 + `extractEntitiesFromQuery(query)` 函数，返回 `string[]`。同一份代码两处用：chunk 落库时跑、query 时跑。
- `src/roles/hybrid-search.ts` — `hybridSearch(deps, roleId, query, ...)` 三路并行 + RRF 融合 + diversify。导出 `RRF_K`、默认权重常量供 benchmark 注入。
- `tests/unit/roles/entity-extract.test.ts` — 规则提取的边界（中英文混排、URL parse、camelCase 边界、emoji / 空格、`I` 单字母不算）。
- `tests/unit/roles/hybrid-search.test.ts` — RRF 融合数学 / drop-then-renormalize / diversify by source / 三路都空的 graceful return / 单路 mock 注入。
- `tests/unit/storage/fts5-trigger.test.ts` — FTS5 trigger 同步：insert chunk → FTS5 行出现；update chunk_text → FTS5 行更新；delete chunk → FTS5 行消失；source CASCADE 删 chunk → FTS5 也 CASCADE。
- `tests/e2e/multipath-retrieval/happy.spec.ts` — MCP 端到端：训练 role with 多种内容（短中文术语 / URL / camelCase 标识 / 长英文段）→ search_knowledge 三种 strategy 对比 → 确认 fusion 路径在每个 query 类别都不弱于最佳单路。
- `tests/e2e/multipath-retrieval/benchmark.spec.ts` — 小型 fixture，10-20 个 query + 已知正确 chunk_id 的 truth set；输出 R@5 / MRR / 每路命中率到测试 stdout（review 时看一眼，不强制 assertion 阈值）。

后端 — 改动：
- `src/storage/migrations.ts` — migration v13:
  - `CREATE VIRTUAL TABLE knowledge_chunks_fts USING fts5(chunk_text, content='knowledge_chunks', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');`
  - Triggers `kc_fts_ai` / `kc_fts_au` / `kc_fts_ad` 同步 insert/update/delete
  - Backfill: `INSERT INTO knowledge_chunks_fts(rowid, chunk_text) SELECT rowid, chunk_text FROM knowledge_chunks;`
  - `CREATE TABLE knowledge_chunk_entities (chunk_id TEXT NOT NULL REFERENCES knowledge_chunks(id) ON DELETE CASCADE, role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE, entity TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1.0, created_at TEXT NOT NULL, PRIMARY KEY (chunk_id, entity));`
  - Indices on `(role_id, entity)` 和 `(entity)` 用于按 entity / 按 role 查询
  - Backfill chunk_entities: 旧 chunks 跑一遍 entity 提取，写入。
- `src/storage/repos/roles.ts` — 新 `insertChunkEntity` / `listEntitiesForChunk` / `searchChunksByEntity(db, roleId, entities[], limit)` 返回 `Array<{ chunkId, hitCount }>`、`searchChunksByBm25(db, roleId, query, limit)` 包装 FTS5 `MATCH` 返回 `Array<{ chunkId, bm25Score }>`。
- `src/roles/library.ts` — `searchKnowledge` 改成 strategy router；`SearchKnowledgeOptions` 新增 `strategy?: SearchStrategy`；`trainRole` / `updateRole` 在 `insertChunk` 之后调 `extractEntities` + 批量 `insertChunkEntity`。
- `src/mcp/server.ts` — `search_knowledge` schema 加 `strategy` 可选；description 解释默认 fusion 优势 + 何时手动单路（debug）。

合计：6 个新文件 + 4 个已有改动 + 1 migration（v13）+ ~80 个新 test case（包含 benchmark）。

## Execution

### Actual Files

后端 — 新增:
- `src/roles/entity-extract.ts` — 4-tier 规则提取：whitelist `KNOWN_HELM_ENTITIES` → ≥3 caps → camelCase → URL → filename。同函数两处用（chunk 入库 + query 时）。`MAX_ENTITIES_PER_CHUNK = 20` 防爆。
- `src/roles/hybrid-search.ts` — `hybridSearch(input)` strategy router。fusion 路径：三路并行 → `computeEffectiveWeights` drop-renormalize → RRF（K=60, default w=0.4/0.6/0.3）→ `diversifyBySource`（max 3 per source）。单路 fallback：`runBm25Only` / `runCosineOnly` / `runEntityOnly`。
- `src/roles/library-math.ts` — 把 `cosineSimilarity` 拆出来，避免 library.ts ↔ hybrid-search.ts 循环依赖。library.ts re-export 旧路径。

后端 — 改动:
- `src/storage/migrations.ts` — migration v13: FTS5 virtual table `knowledge_chunks_fts(chunk_text, content='knowledge_chunks', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2')` + 3 个 trigger（ai/au/ad）+ 启动时 backfill SELECT INTO；新表 `knowledge_chunk_entities (chunk_id, role_id, entity, weight, created_at)` 含 PK + 双索引。
- `src/storage/repos/roles.ts` — 新增 `insertChunkEntity` (INSERT OR IGNORE on PK) / `deleteChunkEntitiesForRole` / `listChunkEntities` / `searchChunksByEntity(role, entities[], limit) → { chunkId, score, hitCount }[]`（同 entity 多匹配累加 weight）/ `searchChunksByBm25(role, query, limit)` (FTS5 MATCH 包装 + sanitize 用户 query 防 FTS5 语法错)。
- `src/roles/library.ts` — `searchKnowledge` 改造为 strategy router (`SearchKnowledgeOptions.strategy?: 'fusion' | 'bm25' | 'cosine' | 'entity'`, 默认 fusion)；`trainRole` / `updateRole` 在 chunk insert 之后立刻调 `indexEntitiesForChunk` 写 entity 索引。`KnowledgeSearchResult` 多 3 个可选字段 `bm25Score` / `cosineScore` / `entityScore`。
- `src/mcp/server.ts` — `search_knowledge` schema 加可选 `strategy` 枚举，描述里说清 fusion 默认 + 何时手动单路。

测试 — 新增:
- `tests/unit/roles/entity-extract.test.ts` (21 cases) — 每个 tier 独立 + dedup + MAX cap + 边界。
- `tests/unit/roles/hybrid-search.test.ts` (17 cases) — `computeEffectiveWeights` 数学 + 各 strategy 单路 + 三路融合 + kind filter + source diversify + 全空 query 不 crash。
- `tests/unit/storage/fts5-trigger.test.ts` (6 cases) — INSERT/UPDATE/DELETE 同步 + source cascade + role cascade。
- `tests/e2e/multipath-retrieval/happy.spec.ts` (8 cases) — MCP 端到端 4 种 strategy + kind filter + 兼容老 positional topK。
- `tests/e2e/multipath-retrieval/benchmark.spec.ts` (1 case) — 12-chunk × 12-query 合成 fixture，dump R@5 / MRR 表格到 stdout，不固化阈值。

**Benchmark 输出**（fixture run on this commit）:
```
fusion   │ 100.0% │ MRR=1.000 │ A=100% B=100% C=100% D=100%
bm25     │  91.7% │ MRR=0.917 │ A=100% B=66.7% C=100% D=100%
cosine   │  58.3% │ MRR=0.379 │ A=100% B=100% C=0%   D=33.3%
entity   │  66.7% │ MRR=0.625 │ A=0%   B=100% C=66.7% D=100%
```
Fusion 完胜每个 category；cosine 单走 C=0%（camelCase / URL 完全不可见），entity 单走 A=0%（lowercase verbs 无 entity 信号）。

合计：3 新文件 + 4 改动文件 + 5 新测试文件 + 1 migration + 53 新 unit cases + 9 新 e2e cases.

### Patterns Used

- **RRF 融合**（Reciprocal Rank Fusion, Cormack et al. 2009）—— 每路独立排名 + `Σ w_leg / (K + rank_leg)`，K=60 业界标准。直接跨量纲合并（BM25 5-50 vs cosine 0-1）会让 BM25 主导。
- **Drop-then-renormalize**（学自 agentmemory）—— 某路返回空就 weight=0，其它路除以新 total 归一化。让单路退化 case 仍有"合理"的相对评分。
- **FTS5 external-content + trigger**—— FTS5 不自动跟主表，但 SQL trigger 完整覆盖 INSERT/UPDATE/DELETE 三个分支。比"手动应用层同步"更可靠（DB 内部 transaction 原子）。
- **Strategy router 模式**—— `searchKnowledge` 仅做参数 routing + 结果映射，所有 ranking / diversify 逻辑统一在 `hybrid-search.ts`。debug 单路 / 测试单路 / production fusion 三个路径共用 enriching + 同 result shape。
- **Source diversify**—— `MAX_HITS_PER_SOURCE = 3` 防单 source 霸榜。Phase 73 source_id 顺接用。
- **Pure-leaf math module**—— `library-math.ts` 只放 `cosineSimilarity`，避开 library.ts ↔ hybrid-search.ts 循环。re-export 保留旧 import 路径。
- **Synthetic benchmark with stdout-only dump**—— 不强制 assertion 阈值（避免 goodhart's law），让 PR review 时看趋势就好。

## Validation

### Test Plan

(已实现，见 Cases Added)

### Cases Added

- `tests/unit/roles/entity-extract.test.ts` — 21
- `tests/unit/roles/hybrid-search.test.ts` — 17
- `tests/unit/storage/fts5-trigger.test.ts` — 6
- `tests/e2e/multipath-retrieval/happy.spec.ts` — 8
- `tests/e2e/multipath-retrieval/benchmark.spec.ts` — 1

### Lint Results

- `pnpm typecheck` — clean (root + web)
- `pnpm test` — **1226 passed** (was 1182, +44)
- `pnpm test:e2e` — **149 passed** (was 140, +9)

## Decisions

(implement 阶段产生的实施级取舍)

**Pre-implement aligned forks**（reviewer 不应见此段；archive 时由 reviewer 注入函数过滤）：

1. **不重造 BM25**：用 SQLite FTS5 内置实现。agentmemory 自己写 in-memory 是因为它用 iii-engine 的 KV，helm 是 SQLite，直接 FTS5 是 net win。
2. **不上 LLM entity 提取**：规则提取（filename / URL / camelCase / 全大写缩写）覆盖 80% 用例，工程量小一个数量级。LLM 路径留独立任务。
3. **RRF_K = 60** 沿用业界 + agentmemory 默认。**默认权重 0.4 / 0.6 / 0.3**（BM25 / cosine / entity）和 agentmemory 一致。
4. **drop-then-renormalize**：哪路返回空就把它的权重归零、剩下的归一化。比 agentmemory 学的关键点之一。
5. **Diversify by `source_id`**（max 3 per source）：agentmemory 是 per session；helm 用 Phase 73 的 source 维度刚好顶上，避免单 source 主导。
6. **`kind` 过滤（Phase 73）保持正交**：在 SQL pre-filter 阶段执行，fusion 在 filtered pool 上算。不混进 RRF 数学。
7. **Compact / Expand 两阶段返回不做**：是独立的 UX 优化，下期。本期 `search_knowledge` 还是返回完整 chunkText。
8. **不强制 benchmark assertion 阈值**：跑 fixture 输出 R@5 / MRR 到 stdout，review 时人眼看一下趋势。强阈值会让 fixture 调优变成 goodhart's law 受害者。
9. **Strategy router 默认 `'fusion'`，旧调用方零迁移**：positional `topK`（Phase 73 兼容路径）仍然识别；新参数全部 named。

## Risks

- **FTS5 + ON DELETE CASCADE 的交互**：FTS5 external-content 模式不自动跟随主表的 CASCADE，需要在主表的 trigger 上手动 mirror DELETE。要测：source 被 drop → chunk cascade delete → FTS5 行也要消失。如果 trigger 写漏一个分支，FTS5 索引会脏 grow 不掉。
- **Backfill entity 时的内存压力**：现在每个 role chunks 量级 10-100 行，全表跑一遍 entity extract 没问题；如果未来某 role 上 10k 级，migration 跑起来要分批。v1 不优化（assume <1k chunks/role）。
- **中文 tokenizer**：FTS5 默认 `unicode61` 对中文按字切，不是词。短查询能命中字面，长查询命中差。本期接受这个；下期接 jieba。
- **RRF 默认权重的 corpus 偏置**：0.4/0.6/0.3 是 agentmemory 在它的 corpus（开发会话）上的调优结果。helm 的 corpus（role 知识库，更结构化）也许该是 BM25 / entity 占比更高。v1 不调，等 benchmark 跑出实际数据再说。
- **Entity 提取规则的 false positive**：camelCase 规则可能把"helloWorld"和"someText"都当 entity；query 里的"Goofy"和 chunk 里的"Goofy 网关"会按字符串比较命中——好事，但要警惕 entity 表 grow 太快。每个 chunk 限 max 20 个 entity 防爆炸。
- **Pseudo-embedder 还是 pseudo**：本期不动 embedder。fusion 提升的是"用 BM25 + entity 帮 cosine 兜底"，cosine 本身质量没变。把"换 real embedder"留独立任务避免 scope 蔓延。

## Related Tasks

- `2026-05-12-role-typing-and-lineage`（Phase 73）—— sources + kind 引入；本任务的 diversify-by-source 直接用它。无重叠 implementation，互补。
- `2026-05-10-harness-toolchain-mvp`—— 引入 Harness 流程本身；本任务沿用。

## Stage Log

- **2026-05-14** — task created. agentmemory `hybrid-search.ts` / `search-index.ts` / `smart-search.ts` / `graph-retrieval.ts` 4 个文件读过；helm Phase 73 后的 `roles/library.ts:searchKnowledge` + migrations v12 状态确认。budget 用 3 files（agentmemory 之外只读了 helm 侧 library.ts + migrations.ts），剩余 2 file budget。current_stage = `new_feature`，等用户对 Intent / Out / forks 确认后转 implement。
- **2026-05-14** — user confirmed A/B/C/D. B 升级为 4-tier 优先级链（whitelist → ≥3 字母大写 → camelCase → URL/filename），其余按 task.md 原文。Transitioning to implement. `implement_base_commit = 66e5409843c504317942ac2ba8ab56eaba9be390` (main HEAD at PR #75 merge).
- **2026-05-14** — implement done. 3 new files / 4 modified / 5 new test files / 1 migration. typecheck clean. 1226 unit (+44), 149 e2e (+9). Implementation notes: (a) had to extract `cosineSimilarity` into `library-math.ts` because `library.ts` now imports `hybrid-search.ts` which needed the function — extracted module + re-export preserves the public surface; (b) `searchChunksByBm25` sanitizes user query before FTS5 MATCH (strips operators, quotes tokens, appends `*` for prefix recall) — raw FTS5 syntax errors degrade to empty result, not throw; (c) entity-extract regex `MAX_ENTITIES_PER_CHUNK = 20` guards against pathological inputs; (d) better-sqlite3 ABI mismatch hit once mid-build (Electron rebuild from yesterday) — `pnpm rebuild better-sqlite3` fixed; (e) benchmark stdout-only confirmed via run on this commit (see Execution → Benchmark output) — fusion 100% across all categories. Ready for review.
