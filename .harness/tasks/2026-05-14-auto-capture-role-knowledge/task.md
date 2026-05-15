# Auto-capture role knowledge candidates from chats

| field           | value |
| --------------- | ----- |
| task_id         | 2026-05-14-auto-capture-role-knowledge |
| current_stage   | archived |
| created_at      | 2026-05-14 |
| project_path    | /Users/bytedance/projects/helm |
| host_session_id | (unbound) |
| implement_base_commit | f74a38706465dad08f99161562661425ffe02190 |

## Intent

### Background
agentmemory 项目里有一条让 chat 自动积累记忆的设计——agent 每次响应都被扫一遍，命中关键信号的句子被沉淀进知识库。helm 现在的状态相反：role 知识完全靠用户主动训练，agent 在 chat 里产出的高价值内容（一段 runbook 解释、一个新的 entity 解释、一个故障复盘片段）**完全不会回流到 role 知识库**——下次另一个 chat 问同样的事，agent 又要重新现场推理。

这是 agentmemory 三点学习计划的第三条（前两条已经做：Phase 76 多路检索 ✓，Phase 77 衰减 + 归档 ✓），也是把"用 helm 越久，role 越聪明"这条飞轮跑起来的最后一块拼图。

### Objective
每当一个 chat 绑定了至少一个 role，并且 agent 给出响应（`host_agent_response` 触发），helm 后台异步：

1. **Smart-split**：按段落 / fenced code block 边界把响应切成 segment；每段独立打分（Decision §D）。
2. **双信号判断**：对每段并对每个绑定 role，跑（a）实体重合度（Phase 76 entity index）+ （b）cosine vs 现有 chunks 的 max similarity，**任一信号阈值通过**就标为候选（Decision §A：OR）。
3. **持久化**：写入新表 `knowledge_candidates`（migration v15），含 segment 文本、源 chat / segment id、score、status（pending/accepted/rejected/expired）。Decision §B。
4. **UI 透出**：Roles 页加一个新 tab "Candidates (N)"，每行展示 segment + score + 来源 chat 引用 + Accept / Reject / Edit-then-accept 三按钮。badge 显示 pending 数量（Decision §C）。
5. **Accept 流**：单段 accept 直接转 `update_role`（沿用 Phase 66 conflict-detection 路径——和现有 chunks 太像就提示用户）；reject 软标记不再出（保留 audit）；edit 进 modal，用户调整后再 accept。

单句"完成"定义：**绑定 role 的 chat 跑完一段对话后，agent 响应里凡是"新 entity / 新 runbook 段"自动进入 Roles 页的 Candidates tab；用户花 30 秒批量 Accept / Reject 就能把新知识增量喂回 role，无需手动复制粘贴 + 走 train_role 模态。**

### Scope
**In:**
- migration v15：新表 `knowledge_candidates`（columns: id / role_id FK / host_session_id FK / chunk_text / source_segment_index / kind 推测值 / score_entity / score_cosine / status / created_at / decided_at?）；索引 (role_id, status)、(host_session_id)。
- `src/capture/`（新模块）：
- `src/storage/repos/knowledge-candidates.ts`：CRUD —— insert / listByRole / setStatus / countPendingByRole。
- `src/storage/types.ts`：新 type `KnowledgeCandidate`。
- `src/app/orchestrator.ts`：在 `host_agent_response` 现有处理后追加 fire-and-forget 调用 `captureFromAgentResponse(db, hostSessionId, responseText)`；失败仅 warn 不阻塞 mirror。
- `src/capture/index.ts`：编排函数 `captureFromAgentResponse(db, hostSessionId, text)`：lookup roleIds → 对每 role × 每 segment 跑 scorer → 通过的写表 → emit `events.knowledge_candidate.created`。
- `src/api/server.ts`：
- `src/mcp/server.ts`：`list_role_candidates` 只读 MCP 工具（用户问 "我有什么待审的知识" 时 agent 用）。**不**开 mutating MCP 工具（沿用 Task B Decision §4 防 agent 自己接受 / 拒绝）。
- 渲染层：
- 测试：

**Out:**
- **LLM 驱动的抽取**：不用 claude / cursor 抽 "key facts"，v1 只做启发式（splitter + 双信号）。LLM 抽取放 v2，先看 v1 的 precision/recall。
- **自动 accept**：候选**永远**需要人确认。Decision §B / §C 都默认 "human in the loop"。防 agent hallucination 污染 role 库。
- **跨 role 共享候选**：一段文字只会写入它来源 chat 当前绑定的 role 的候选池。换 role 后旧 chat 的旧候选不迁移。
- **Candidate 过期机制**：暂不做。pending 越积越多再加。预计 expiresAt 字段先留着，逻辑后补。
- **Source citation 链回 chat 转折点**：candidate row 只记 hostSessionId，**不**记 message 时间戳 / index——renderer 想看完整上下文就跳转该 chat。Phase 67 之类的精细溯源等需求出现再加。
- **Per-role 检测阈值配置**：全局 `knowledge.capture` 配置块（实体 >=2、cosine >= 0.6）够用；如果 v1 实测某些 role 误报多，再加 per-role override。
- **Built-in roles 走 capture**：跳过——它们没有用户训练的 chunks，cosine 永远为 0，entity index 永远为空，所以不会产生候选；防御性测一下确认。
- **Reject 后还能 unreject**：reject 是终态。用户后悔重新看那段就再次 accept（dedup 会重新触发——但已 reject 的候选会被 dedup 视为存在并 skip）。这是个小坑，记一笔。

## Structure

### Entities
- **`KnowledgeCandidate`**（新表 + 类型）：`{ id, roleId, hostSessionId, chunkText, sourceSegmentIndex, kind, scoreEntity, scoreCosine, status, createdAt, decidedAt? }` —— 待审知识候选行。
- **`CandidateStatus`**（discriminated string）：`'pending' | 'accepted' | 'rejected' | 'expired'`。状态机：pending → accepted / rejected / expired；终态不回转。
- **`CaptureThresholds`**（导出常量 + 配置）：`{ minEntityOverlap: 2, minCosine: 0.6, minSegmentChars: 80 }` —— 都过门槛才进候选池。
- **`AgentResponseSegment`**：splitter 输出 `{ index, text, kind: 'paragraph' | 'code' }`——下游 scorer 不关心 kind，仅在持久化时一并记下。
- **`CaptureSweepResult`**：编排函数返回 `{ segments, candidatesCreated, byRole: [{ roleId, candidatesCreated }] }`——便于 e2e 断言 + 日志。

### Relations
- `knowledge_candidates.role_id` → `roles.id` (CASCADE)；`host_session_id` → `host_sessions.id` (SET NULL —— chat 关掉候选还在)。
- accept 路径调 `updateRole({ appendDocuments: [{ filename: 'capture-<candidateId>', content: chunkText, kind: candidate.kind }] })` —— 复用 Phase 66 conflict-detection。
- `host_agent_response` 处理顺序：先现有的 Lark 镜像（不动），再 fire-and-forget `captureFromAgentResponse`（不 await，错误只 warn）。
- splitter ↔ scorer ↔ writer 在 capture/index.ts 串成 pipeline，三个文件单独可测——纯函数 + 注入 db。
- candidate 表与 Phase 73 `knowledge_sources` **不冲突**：accept 时 updateRole 走正常 source 创建（kind 自动 inferred `inline`），candidate 行 status=accepted 后只是审计记录。
- `events.knowledge_candidate.created` 给渲染层 SSE 实时跳数字——Roles tab 不用轮询。

### Planned Files
- `src/capture/index.ts` —— `captureFromAgentResponse` 编排 + `CAPTURE_THRESHOLDS` 导出常量。
- `src/capture/splitter.ts` —— `splitAgentResponse(text): AgentResponseSegment[]`。
- `src/capture/scorer.ts` —— `scoreSegment(db, roleId, segmentText, embedFn): Promise<{ scoreEntity, scoreCosine, qualifies }>`。
- `src/capture/candidate-writer.ts` —— `writeCandidateIfNew(db, candidate, options): boolean`（含 dedup）。
- `src/storage/repos/knowledge-candidates.ts` —— CRUD。
- `tests/unit/capture/splitter.test.ts`
- `tests/unit/capture/scorer.test.ts`
- `tests/unit/capture/candidate-writer.test.ts`
- `tests/unit/storage/knowledge-candidates.test.ts`
- `tests/e2e/capture/happy.spec.ts`
- `tests/e2e/capture/dedup.spec.ts`
- `src/storage/migrations.ts` —— migration v15。
- `src/storage/types.ts` —— `KnowledgeCandidate` + `CandidateStatus`。
- `src/app/orchestrator.ts` —— `host_agent_response` 追加 capture 调用 + emit `knowledge_candidate.created` 事件转 SSE。
- `src/events/bus.ts` 或同等位置 —— 注册新 event 类型（如果已有 EventBus 类型，加 union 分支）。
- `src/api/server.ts` —— 4 个新端点（list / accept / reject / edit-and-accept）。
- `src/mcp/server.ts` —— `list_role_candidates` 只读工具。
- `web/src/api/types.ts` —— `KnowledgeCandidate` 类型 + status enum。
- `web/src/api/client.ts` —— 4 个新方法。
- `web/src/pages/Roles.tsx` —— Tab 系统（Chunks / Sources / Candidates）+ Candidates list 渲染 + Accept / Reject / Edit-modal 交互 + role 行 badge `(N)`。

## Decisions

- **Dedup 在 DB 层做（partial unique index）而非应用层 SELECT-then-INSERT**：避免 race + 少写一次往返。`insertCandidateIfNew` 把 `SQLITE_CONSTRAINT_UNIQUE` 翻译成 `inserted: false`；其它 SQL error 仍 throw。
- **Partial unique 覆盖 pending + rejected，但放过 accepted**：accept 进 role 后再次出现同段更可能是"用户删了那个 chunk 想重新加"，让它入候选给用户决定。
- **`KnowledgeCandidate` type 用 optional `hostSessionId`** 而非 nullable：跟 helm 其它存储类型 conventions 一致（Phase 73 `KnowledgeSource.label` 同款）。
- **scorer cosine 包含 archived chunks**：刚被 sweep 归档的 chunk 的近似复述不应被当作"新知识"——它来源就是那个 archived chunk。已写入 scorer 注释里。
- **scoreEntity 是 distinct entity 数，不是 hit 数**：避免一段反复提同一个实体被算 4 分。`searchChunksByEntity` 返回的不是实体集，所以我们要二次 query `knowledge_chunk_entities` 拿命中的 distinct entity 名。
- **`captureFromAgentResponse` 是纯函数 + 不写事件**：事件 emit 责任在 orchestrator（拿到 `inserted` 列表后逐条 emit）。capture 模块自身不依赖 EventBus，让 unit test 不需要 mock 事件。
- **API accept 路径 reuse Phase 66 conflict-detection**：accept 端点显式不传 `force`；如果检测到冲突，候选**留在 pending**，前端拿 conflicts payload 决定 Edit-and-Accept（编辑掉相似部分）还是放弃。
- **Edit-then-Accept 在一次 POST 内做完**：renderer 编辑 → 后端先 `updateCandidateText`（partial unique 会撞冲突→ 409 `edit_collides`）→ 再走 accept 流。两步合一减少状态机暴露面。
- **每次 host_agent_response 都同步算 splitter，但 scorer + writer fire-and-forget**：splitter 是 sub-ms，先跑掉；scorer 需要 embedFn（潜在慢）所以包在 IIFE 异步里。errors → warn log，不冒泡到 RPC。
- **`pendingCandidateCount` 用一次 GROUP BY 而非 N+1**：roles list 端点 `pendingCountsByRole(db)` 返回 Map，零调用 cost per role。
- **MCP `list_role_candidates` 直接复用 `listCandidatesForRole` repo**：不引入额外封装层，response shape 跟 HTTP `/api/roles/:id/candidates` 一致便于 cross-consume。
- **scorer 测试的 pseudo-embedder false-positive 处理**：e2e "无信号"测试显式传 `thresholds: { minCosine: 0.99 }`，因为 char-bin embedder 给任意两段英文都 0.5-0.9 cosine。docstring 里说明这是测试 sentinel 而非生产取舍。

## Risks

- **召回率不可知**：双信号 OR 在真实 chat 上是 spam 还是 starvation 不可预测。v1 留两个 score 在表里，accept/reject 比例就是 ground truth；如果两周内 reject > 70%，回去把阈值调严。
- **Embedding 计算成本**：每次 agent response 触发 segment×roleCount 次 embed。当前 pseudo-embedder 极便宜，但换真 LLM embedder 后会扎眼——届时要么 cache，要么把 cosine signal 改成"先 entity 过滤再 cosine"。
- **Conflict-detection 误伤**：Phase 66 的 pseudo-embedder 相似度对中文段落容易给 0.9+ false-positive（Task B 的 goofy update 撞过）。从 Candidates accept 时会把这个 false-conflict 抛给用户；user 可能会困惑——v1 接受，文档里说明。
- **Reject 不可逆体验**：见 Decision §8。文档里加一行说明；如果实测投诉多再加 unreject 路径。
- **Capture 函数在测试里需要确定性 embed**——继续用 `makePseudoEmbedFn` 的字符桶；测试需要 marker-keyword embedder 时显式注入。

## Related Tasks

_(none)_

## Stage Log

- **2026-05-15T02:22:10.298Z** [archived] — archived: Auto-capture role-knowledge candidates from chat agent responses（splitter→双信号 scorer→dedup 候选表→Roles Candidates tab Accept/Reject/Edit）。MCP 只读，accept 复用 Phase 66 conflict-detection；reject 在 DB-level partial unique index 上是终态。
