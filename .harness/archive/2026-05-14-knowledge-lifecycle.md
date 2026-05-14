# Archive — 2026-05-14-knowledge-lifecycle

> Role 知识库 access-tracking + 指数衰减重排 + 软归档 sweep（90d+access<3 阈值，user-tunable）；附带 MCP SSE 25s keepalive 修复 Cursor tool-list 缓存掉队。

| field            | value |
| ---------------- | ----- |
| task_id          | 2026-05-14-knowledge-lifecycle |
| project_path     | /Users/bytedance/projects/helm |
| archived_at      | 2026-05-14T23:32:00.172Z |
| full_doc_pointer | .harness/archive/2026-05-14-knowledge-lifecycle.md |

## Entities
- knowledge lifecycle
- accessCount
- lastAccessedAt
- archived
- scoreDecay
- applyDecayBoost
- runArchivalSweep
- exp(-Δt/τ)
- decay tau 30d
- decay alpha 0.3
- archive after 90d
- archive below access 3
- SSE keepalive
- KEEPALIVE_INTERVAL_MS 25000
- migration v14
- includeArchived
- bumpChunkAccess
- archiveChunks
- unarchiveChunk
- fireLifecycleSweep
- setLifecycleSweepTrigger
- KnowledgeLifecycleConfig
- POST /api/knowledge-chunks/:id/unarchive
- HybridSearchHit.chunkId
- queueMicrotask access bump

## Files Touched
- src/roles/lifecycle.ts
- src/roles/hybrid-search.ts
- src/roles/library.ts
- src/storage/migrations.ts
- src/storage/repos/roles.ts
- src/storage/types.ts
- src/config/schema.ts
- src/mcp/server.ts
- src/mcp/http-sse.ts
- src/app/orchestrator.ts
- src/api/server.ts
- web/src/api/client.ts
- web/src/api/types.ts
- web/src/pages/Roles.tsx
- web/src/pages/Settings.tsx
- tests/unit/roles/lifecycle.test.ts
- tests/unit/storage/access-bump.test.ts
- tests/unit/storage/archived-filter.test.ts
- tests/e2e/knowledge-lifecycle/happy.spec.ts
- tests/e2e/sse-keepalive/happy.spec.ts

## Modules
- src/roles
- src/storage/repos
- src/mcp
- src/app
- src/api
- src/config
- web/src/pages

## Patterns
- Exponential decay re-rank with α-boost cap (final = rrf * (1 + α·decay))
- Soft-archive boolean flag — never hard delete (mirrors Phase 73 source-delete being the only hard path)
- Fire-and-forget post-search access bump via queueMicrotask
- Mutation-driven sweep trigger via module-level setter to avoid orchestrator ↔ library import cycle
- SSE comment-frame keepalive (": keepalive\n\n") — silently ignored by all conforming clients
- Boot + 24h cron + per-mutation sweep, with unref()d interval for clean test shutdown
- includeArchived opt-in flag threaded through all three retrieval legs
- User-tunable thresholds via helm Settings → liveConfig.knowledge.lifecycle
- Read-side lifecycle fields optional on KnowledgeChunk type so existing insertChunk callers compile unchanged

## Downstream
- Task C (auto chat → role knowledge candidates) — will read lifecycle stats
- Future knowledge prune / compaction UI — sweep + includeArchived plumbing ready
- Real LLM embedder swap — decay τ / α may need retune
- Per-role / per-kind decay coefficients (currently global) — config block ready to extend
- Sweep report telemetry surface — log already emits archival_sweep_completed

## Rules Applied
- Harness toolchain: task.md durable memory; Decisions block hidden from reviewer
- Phase 76 multipath retrieval unchanged when α=0 (decay collapses to identity)
- agentmemory-inspired access tracking + decay (no session-scope short-term layer)
- Soft state, never hard delete — hard removal stays gated behind drop_knowledge_source
- MCP layer exposes includeArchived as READ-only; no agent-callable mutations
- Migration NOT NULL DEFAULT for new columns; never backfill last_accessed_at
- unref() every Node interval/timeout
