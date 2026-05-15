# Archive — 2026-05-14-auto-capture-role-knowledge

> Auto-capture role-knowledge candidates from chat agent responses（splitter→双信号 scorer→dedup 候选表→Roles Candidates tab Accept/Reject/Edit）。MCP 只读，accept 复用 Phase 66 conflict-detection；reject 在 DB-level partial unique index 上是终态。

| field            | value |
| ---------------- | ----- |
| task_id          | 2026-05-14-auto-capture-role-knowledge |
| project_path     | /Users/bytedance/projects/helm |
| archived_at      | 2026-05-15T02:22:10.298Z |
| full_doc_pointer | .harness/archive/2026-05-14-auto-capture-role-knowledge.md |

## Entities
- knowledge_candidates
- CandidateStatus
- captureFromAgentResponse
- scoreSegment
- splitAgentResponse
- writeCandidateIfNew
- insertCandidateIfNew
- SQLITE_CONSTRAINT_UNIQUE
- partial unique index (role_id, text_hash) WHERE status IN (pending, rejected)
- CAPTURE_THRESHOLDS
- minEntityOverlap 2
- minCosine 0.6
- minSegmentChars 80
- kindFromSegment (code → example, else other)
- list_role_candidates
- POST /api/knowledge-chunks/:id/unarchive
- POST /api/knowledge-candidates/:id/accept
- POST /api/knowledge-candidates/:id/reject
- POST /api/knowledge-candidates/:id/edit-and-accept
- GET /api/roles/:id/candidates?status=…
- knowledge_candidate.created event
- scheduleCaptureFromResponse fire-and-forget
- capture_role_gone
- pendingCountsByRole
- migration v15
- RoleCandidates component

## Files Touched
- src/capture/index.ts
- src/capture/splitter.ts
- src/capture/scorer.ts
- src/capture/candidate-writer.ts
- src/storage/repos/knowledge-candidates.ts
- src/storage/migrations.ts
- src/storage/types.ts
- src/events/bus.ts
- src/app/orchestrator.ts
- src/api/server.ts
- src/mcp/server.ts
- web/src/api/types.ts
- web/src/api/client.ts
- web/src/pages/Roles.tsx
- tests/unit/capture/splitter.test.ts
- tests/unit/capture/scorer.test.ts
- tests/unit/capture/candidate-writer.test.ts
- tests/unit/storage/knowledge-candidates.test.ts
- tests/e2e/capture/happy.spec.ts
- tests/e2e/capture/dedup.spec.ts

## Modules
- src/capture
- src/storage/repos
- src/mcp
- src/app
- src/api
- src/events
- web/src/pages

## Patterns
- Splitter peels paragraphs + fenced code blocks (code bypasses minSegmentChars; unterminated fence degrades to paragraph)
- Dual signal OR'd: entity overlap >= 2 OR cosine >= 0.6; both scores stored for UI + back-testing
- Scorer cosine includes archived chunks (re-paraphrase of cold knowledge is known, not novel)
- Scorer entity leg queries knowledge_chunk_entities directly (no archived filter) to stay consistent with cosine leg
- DB-level dedup via partial unique index on (role_id, text_hash) WHERE status IN (pending, rejected) — accepted excluded so deleted chunks can be re-suggested
- insertCandidateIfNew swallows ONLY SQLITE_CONSTRAINT_UNIQUE; FK violations surface so capture pipeline can log + skip a deleted-mid-flight role
- Fire-and-forget capture from host_agent_response — slow embedder / DB write never blocks the RPC
- Accept routes through Phase 66 conflict-detection in updateRole — near-dupes still prompt the user
- Edit-then-Accept is one POST: updateCandidateText (partial unique catches collisions → 409) → accept flow
- MCP exposes only read-only list_role_candidates — no agent-callable accept/reject (防 agent 自批准自产候选)
- segmentEntities capped at 64 to bound IN-clause parameter count
- API status param validated against enum and 400s on typo (no silent empty result)
- pendingCountsByRole one-shot GROUP BY for the badge — no N+1 over roles list
- Renderer subscribes to knowledge_candidate.created event for real-time badge increment without polling
- Cross-role candidate dedup is OFF (same text can be knowledge for multiple roles)

## Downstream
- Real LLM embedder swap — capture cosine threshold may need retune; pseudo-embedder gives 0.5-0.9 for any English text (tests use thresholds: { minCosine: 0.99 } as sentinel)
- Phase 76 retrieval — accepted candidates become chunks immediately, participate in fusion + entity index via existing trigger
- Phase 77 lifecycle — accepted candidates start with access_count=0; decay falls back to createdAt so they aren't auto-archived for 90+ days
- Future "explain why captured" UI — both scores already in the row; just needs rendering
- Per-role threshold overrides — currently global CAPTURE_THRESHOLDS; Settings card could ship if real usage shows tuning need
- LLM-driven smart-extraction (v2) — replace splitter + scorer with a single LLM pass that returns "knowledge nuggets"; v1 heuristic surface stays as fallback
- Reject undo — currently terminal; if user complains we add an unreject path that deletes the rejected row to free the dedup hash
- Capture from user prompts (not just agent responses) — currently agent-only because user prompts aren't knowledge sources

## Rules Applied
- Harness toolchain: task.md durable memory; Decisions block hidden from reviewer (followed even though physical separation isn't enforced)
- Pre-implement forks locked by user before transition to implement; reviewer subagent received explicit instruction NOT to critique locked decisions
- Independent reviewer subagent caught 2 blockers + 4 should-fixes pre-commit; all addressed in same PR
- Fire-and-forget orchestration pattern: capture from host_agent_response mirrors the lifecycle sweep trigger; errors log + skip, never propagate
- MCP layer surfaces read tools only for any new mutation surface —防 agent 自批准 / 自删除 / 自归档
- DB-level constraints encode business rules where possible (partial unique index for dedup) instead of application-layer guards
- Test design: pseudo-embedder false-positive sentinel (thresholds: { minCosine: 0.99 }) documented so future maintainers don't debug "why does this test use the wrong threshold"
- Soft state, never hard delete: candidates archive into accepted/rejected/expired terminal states; no DELETE on the table
- unref() every Node interval/timeout (no new timers in this phase but the pattern is preserved)
