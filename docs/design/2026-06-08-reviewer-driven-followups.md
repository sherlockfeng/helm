# 2026-06-08 · Reviewer-Driven Follow-ups

> Source: independent tech + product + test reviews of the conversation-knowledge redesign work.
> Owner: helm core · Status: scoped for implementation

## P0 — Data integrity & safety (must fix before product launch)

| # | Requirement | Origin |
|---|---|---|
| **R-1** | `KnowledgeRepoManager.withRepoLock` must be a real FIFO chain so concurrent calls on the same `repoId` actually queue, not run in parallel. The current implementation lets a third concurrent call interleave because each `await pending` chains independently. | tech-1 |
| **R-2** | After every `publish()` (success or failure), the working tree must be returned to `repo.branch` — preferably by doing the publish in a `git worktree add` ephemeral subtree so the user-facing clone never sees the publish state. Today the next `importNow` reads stale content. | tech-2 |
| **R-3** | `recordCostDelta` must be called inside `runCase` after `insertRun` (every successful run accrues calls + USD into `benchmark_cost_audit`). A new `checkCostCap` precheck refuses to start a run when today's spend already exceeds the configured cap. | tech-3, prod-5 |
| **R-4** | `runCase` must refuse to run a `BenchmarkCase` whose `status !== 'confirmed'` (R-5 enforcement from the design doc). Direct `/api/verification/cases/:id/run` API path currently bypasses the check. | tech-8 |
| **R-5** | Per-case lock in `enqueueAffectedRuns` so two concurrent triggers against the same case can't both read empty baseline history and miss the regression alert. | tech-7 |

## P1 — Headline UX gaps (the product story doesn't work without these)

| # | Requirement | Origin |
|---|---|---|
| **R-6** | Knowledge › Sources page becomes the real git-repo manager: URL input → repo list with `synced / conflict / fetching` badges → Fetch / Import / Publish row actions → seed catalogue picker → merge-conflict resolver modal. Backend is done; this is one focused page. | prod-1 |
| **R-7** | Chunk-level visibility toggle (Internal / Public) in Library → KnowledgePoint detail. Confirmation dialog on flip to public. Without this the R-0 publish gate is a 403 wall the user can't recover from. | prod-2 |
| **R-8** | Conversations empty-state hero card: 1) Install Cursor hooks (button), 2) Subscribe to a seed knowledge repo (one-click), 3) Start a Cursor chat. Wires the `/api/knowledge-repos/seeds` endpoint that's already live. | prod-3 |
| **R-9** | LLM-proposal notification path: when a case lands as `proposed`, surface a toast / banner that points at the proposed-cases queue, plus per-role "1 case proposed" chip in Library. Today only the merged sidebar badge nudges the user. | prod-4 |

## P2 — Quality + test coverage (catches the next class of bugs)

| # | Requirement | Origin |
|---|---|---|
| **R-10** | Importer enriches each upserted chunk with embedding + entity index rows so retrieval cosine and entity legs treat imported content as first-class. Today imported chunks are muted in retrieval. | tech-5 |
| **R-11** | Serializer round-trips `visibility`, `source` (provenance), and `versionExt` so publish → fetch → import preserves the field set. | tech-4 |
| **R-12** | E2e `tests/e2e/knowledge-repo-loop/` — boot a real local `git init --bare` repo, clone via the real `GitRunner`, edit a chunk, publish, mutate remote, re-import. Three attack variants: non-fast-forward push rejection, mid-transfer kill, concurrent same-point publishes. | test-1, test-5 |
| **R-13** | E2e closed-loop integration test: train role → capture from synthetic agent response → accept candidate → publish to temp git repo → boot a fresh HelmApp → subscribe to that repo URL → sync → assert chunks present → run a verification case against the synced role. Catches contract drift between subsystems. | test-2 |
| **R-14** | Renderer e2e interactivity: extend the Electron suite to actually click buttons (Verification Run, candidate Accept, settings save), submit forms, and assert post-state. Today the suite is screenshot-only with zero `.click()` calls. | test-3 |
| **R-15** | Real `attack.spec.ts` for `verification-run/` and `auto-trigger/` that exercise the runner + trigger machinery (not just mock-runner SQL inserts). | test-4, test-5 |
| **R-16** | Migration backfill test against a populated pre-v20 fixture DB (≥1000 chunks + 100 candidates) so the `knowledge_point_roles` backfill is asserted on realistic data + idempotent on re-run. | test-7 |
| **R-17** | CI lint that fails the build when any `tests/e2e/<dir>/` has `happy.spec.ts` but no `attack.spec.ts`, AND when an `attack.spec.ts`'s only assertions are HTTP 400/404/409 on single-shot requests. | test-meta |

## P3 — Polish & coherence (nice but not blocking)

| # | Requirement | Origin |
|---|---|---|
| **R-18** | Settings page reorganization: section anchors / sub-nav; move Harness / Doc-first / Cursor-model picker out to Advanced; delete the "Moved" card. | prod-6 |
| **R-19** | Translate the train-via-chat greeting to English with Chinese fallback. | prod-7 |
| **R-20** | "+ New verification case" form gets pickers for golden points + target roles (combobox, not CSV text). | prod-8 |
| **R-21** | Replace `console.error` calls in leaf modules with the injected `logger` so production failures surface to the renderer's log surface. | tech-10 |

## Implementation plan

| PR | Bundle | Issues |
|---|---|---|
| **#1** | P0 backend fixes (race + worktree + cost cap + R-5 + per-case lock) | R-1 … R-5 |
| **#2** | Sources git-repo UI + visibility toggle | R-6, R-7 |
| **#3** | Onboarding + proposal notifications | R-8, R-9 |
| **#4** | Importer enrichment + serializer round-trip | R-10, R-11 |
| **#5** | Knowledge-repo e2e + closed-loop integration | R-12, R-13 |
| **#6** | Renderer interactive e2e + real attacks | R-14, R-15 |
| **#7** | Migration fixture + CI attack lint | R-16, R-17 |
| **#8** | P3 polish (settings, i18n, pickers, logger) | R-18 … R-21 |

Each PR ships with the existing AGENTS.md discipline: doc-first audit token, unit + e2e tests, structured logs.
