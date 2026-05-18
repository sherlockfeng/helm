# helm — UI design brief

_Self-contained brief written for a design pass (e.g. claude-design / claude /design-critique). The reader has no prior context._

---

## 1. What helm is

**helm is a macOS desktop control panel that sits between AI coding agents (Cursor, Claude Code) and the developer.** It runs locally as an Electron app, owns a small SQLite DB, and exposes an HTTP + MCP surface that the coding agents call into.

Concretely, helm does six things:

1. **Auto-injects role knowledge into chats.** The user trains "roles" (Goofy expert, dr-dashboard expert, etc.) by uploading markdown docs. When a Cursor chat starts, helm injects the role's system prompt + relevant knowledge chunks. Knowledge auto-decays (90d unused → archived) and auto-captures (agent says something role-relevant → user reviews candidates).
2. **Approves risky agent actions.** Cursor/Claude Code call helm before running tools. helm shows a queue of pending approvals; user clicks Allow / Deny. Same approval can also flow through Lark (the Bytedance IM) for remote review.
3. **Mirrors chats to Lark.** Bind a Cursor chat to a Lark thread; user messages go from Lark → Cursor, agent responses go from Cursor → Lark.
4. **Runs a Harness workflow.** A lightweight project-task system: each task lives as `.harness/tasks/<id>/task.md` on disk + an indexed DB row. Three stages (new_feature → implement → archived). helm renders the list, lets user trigger reviews (claude-CLI subprocess).
5. **Subscribes roles to remote bundles.** Phase 79: roles can be exported as `.helmrole` JSON bundles, uploaded to TOS (ByteDance internal object storage) via a plugin, and other helm installs subscribe + auto-sync.
6. **Owns the config.** Everything (Lark, engine selection, Cursor mode, knowledge lifecycle thresholds, plugins, storage backends) is editable in a Settings page that writes `~/.helm/config.json`.

**Audience**: solo developers using Cursor/Claude Code on a personal Mac. Not a team product. Not a CLI-first product (a sibling Bytedance project called AKM/AgentManager is CLI-first; helm is the GUI-first counterpart).

**Mental model the user holds**: "helm is the cockpit for my AI agents — I can see what they're doing, what they know, and what they're asking permission to do."

---

## 2. Tech stack constraints

**Don't change these without strong reason** — the brief is asking for a visual / UX overhaul, not a re-platform.

| Constraint | Note |
|---|---|
| React 19 + react-router-dom 7 | Existing |
| Vite 6 build | Existing |
| TypeScript strict | Existing |
| Tailwind v4 + `@tailwindcss/vite` | **Just landed** (PR #83). Theme tokens declared via `@theme inline` block in `web/src/styles/app.css`, mapped to existing CSS vars (see §3). |
| No preflight | Tailwind preflight is **intentionally not imported** — helm has its own form / button resets. Keep this; don't propose reset changes. |
| Mac-native feel | SF Pro font stack, `prefers-color-scheme: dark`, `-webkit-app-region: drag` on sidebar so the OS title bar follows. Apple HIG cues (subtle borders, soft shadows, restrained color). |
| Electron desktop only | No mobile breakpoint. Min viewport ~1100×700. |
| No state library | useState + a tiny useApi hook + EventSource SSE for live updates. No Redux/Zustand. |
| No design framework | Currently zero shadcn / Mantine / Chakra. Existing components are 3 files (`Layout`, `EmptyState`, `CopyButton`). The brief MAY propose introducing shadcn primitives (Dialog, Tooltip, Tabs, DropdownMenu, Badge) — implementer is fine with that. |

---

## 3. Current design tokens (CSS vars + Tailwind)

Defined in `web/src/styles/app.css`. Both light + dark mode work via `@media (prefers-color-scheme: dark)`.

**Surface colors:**
```
--bg            : #f5f5f7 light / #1c1c1e dark      (app canvas)
--bg-elev       : #ffffff light / #2c2c2e dark      (cards, dropdowns)
--bg-sidebar    : #f0f0f3 light / #141416 dark      (sidebar)
--bg-input      : #ffffff light / #1c1c1e dark
--bg-pre        : #fafafc light / rgba(0,0,0,0.30)  (code blocks)
--border        : #d2d2d7 light / #3a3a3c dark
--border-strong : #b0b0b8 light / #545458 dark
--hover         : #e5e5ea light / rgba(255,255,255,0.06)
--selected      : #d8e4ff light / rgba(255,255,255,0.08)
```

**Foreground:**
```
--text           : #1d1d1f light / #f5f5f7 dark
--text-secondary : #6e6e73 light / #a1a1a6 dark
--selected-text  : #003d99 light / #f5f5f7 dark
```

**Semantic:**
```
--accent  : #007aff (system blue)
--danger  : #ff3b30 (system red)
--warn    : #ff9500 (system orange)
--success : #34c759 (system green)
```

**Sizing:**
```
--radius-sm : 6px
--radius-md : 10px
font-size   : 13px body, 22px h2, 13px h3 (uppercase)
container   : 720px max width on content pane
```

**Tailwind utilities exposed via @theme:** `bg-bg`, `bg-surface`, `bg-sidebar`, `text-text`, `text-secondary`, `border-border`, `text-accent`, etc.

---

## 4. Current information architecture (sidebar)

```
HELM (brand)
├─ CHATS                       ← group
│   ├─ Active                  /chats         (rail + detail layout)
│   ├─ Bindings                /bindings      (flat list of Lark bindings)
│   └─ Approvals               /approvals     (pending queue)
├─ Roles                       /roles         (role library + train form)
├─ Harness                     /harness       (task list grouped by stage)
└─ Settings                    /settings      (all config in one big page)

Hidden but routable (deprecated UX experiments, kept for backcompat):
   /campaigns, /requirements
```

**My problem analysis (to be validated by the designer):**

- Settings is 876 lines, holds ~10 unrelated sections including Storage Plugins + Role Subscriptions which feel like role-knowledge management, not config.
- "Roles" sits as a single nav item but the related discoverability surfaces (Subscriptions, Plugins) are buried in Settings.
- Harness is a single item but the underlying data has Tasks + Reviews + ArchiveCards — only Tasks has UI today.

**Proposed restructure I drafted (not locked, designer is welcome to revise):**

```
HELM
├─ CHATS
│   ├─ Active / Bindings / Approvals
├─ KNOWLEDGE                   ← new group
│   ├─ Roles
│   ├─ Subscriptions           ← lifted out of Settings
│   └─ Plugins                 ← lifted out of Settings
├─ Harness
└─ Settings (slimmer)
```

---

## 5. Per-page detail

Sized by source LOC so the designer knows where the complexity lives.

| Page | LOC | Current shape | Key data shown | Key actions |
|---|---|---|---|---|
| **Approvals** | 210 | Stack of "helm-card" articles | tool / command / host_session / time-to-expire | Allow (primary blue) / Deny (red outline) |
| **Active Chats** | 801 | 2-col rail+detail (just rebuilt PR #82) | chat label, cwd, roles bound, Lark status, queued msg count | Inline rename, +Add role chip select, Close, Delete, Mirror to Lark modal |
| **Bindings** | 319 | Two sections (Pending / Active), flat lists | Lark chat/thread, helm chat ref, label | Bind to chat (modal), Cancel pending, Unbind |
| **Roles** | 1060 | Role list cards → expandable detail with Chunks/Sources/Candidates tabs (hand-rolled tabs), Train form | systemPrompt, chunk count, badge of new candidates, sources list, archived collapse | Train via files, Train via chat (claude subprocess), Update via chat, Drop source, Unarchive chunk, Accept/Reject/Edit candidate, Export bundle |
| **Harness** | 286 | Cards grouped by stage (new_feature / implement / archived) | task id, title, current stage, host_session binding, last log entry | Open task.md, Bind chat, Run review (spawns subprocess), Open archive card |
| **Settings** | 876 | 10+ vertical sections, all in one page | Engine / HTTP API port / Lark / Doc-first / Cursor (mode/model/API key) / Harness conventions / Knowledge lifecycle thresholds / Storage plugins / Role subscriptions / Depscope / Diagnostics | Save (PUT /api/config), various inline edits |

---

## 6. UI debt — quantified

Inventory based on grep over `web/src/`:

| # | Issue | Quantity | Evidence |
|---|---|---|---|
| 1 | `window.confirm()` for destructive confirm | 5 places | Settings (delete subscription), Bindings (cancel pending), Roles (drop source), Chats (close+delete twice) |
| 2 | `title="..."` as tooltip (browser native, 500ms delay) | 18 places | Mostly icon buttons + truncated paths needing hover-reveal |
| 3 | Inline `style={{...}}` | 302 occurrences | Visual consistency hand-maintained — significant structural debt |
| 4 | `<select>` as picker | 7 places | "+ Add role" / Cursor model / kind selector — all single-select, no search, no grouping |
| 5 | Hand-rolled Tabs | 1 page (Roles) | `aria-pressed` only; no keyboard arrow nav; no animation |
| 6 | Inline modal components | 2 pages (Roles, Chats) | No focus trap (best-effort), no shared dialog primitive |
| 7 | Zero iconography | All nav + buttons | Text-only; scanning is slow |
| 8 | Single card variant | Everywhere | All `.helm-card` looks identical — no semantic differentiation for "warning" / "success" / "interactive" |
| 9 | Loading state is one line | 8+ pages | `<p className="muted">Loading…</p>` — no skeleton, no shimmer, no placeholder shape |
| 10 | No empty state library | Each page rolls own | One `<EmptyState>` component exists but only used in 2 places |
| 11 | No toast / non-blocking notification | Errors render as inline red `<p>` | API failures buried inside the card that failed |

---

## 7. Visual hierarchy critique

Honest read of the screenshots-in-my-head:

- **Page templates are all "h2 + helm-card list"**. There's no contextual header (stats / filter / actions), no breadcrumbs, no contextual chrome. Active Chats just got a stat strip in PR #82 — that's the only page with one.
- **Typography lacks rhythm**. Only 2 distinct sizes (13px body, 22px h2). No mid-size headers, no caption text, no display sizes. AKM uses 4-5 sizes coherently.
- **Cards feel templatey**. Same border + shadow + radius regardless of content type. A "danger destructive section" looks identical to "data overview card".
- **Color is muted but underused**. The 4 semantic colors (accent / danger / warn / success) appear only on buttons and status dots. Tone-colored borders, left-bar accents, subtle tinted backgrounds are absent.
- **Density is uneven**. Some cards are sparse (3 lines of content + 60px padding), some are crammed (Active Chats card with 6 sections of metadata). No density rhythm.
- **No motion**. Hover states are color flips at 80ms. No layout transitions, no list re-order animations, no enter/exit. Feels static next to AKM / Linear.

---

## 8. Reference targets

Visual / interaction inspiration (not blueprints to copy):

- **AKM** (Bytedance internal AgentManager — sibling project). 3-col `WorkspaceShell` (rail / content / inspector). Stat tiles in header bars. Color-coded rail rows. Heavy use of Radix + shadcn + lucide. URL: code.byted.org/tiktok/AgentManager.
- **Linear** — content density done right; subtle motion; tone-coded badges; cmd-k command palette.
- **macOS System Settings** (the recent redesigned one) — sidebar nav with icons + grouped sections; per-detail-page sub-nav patterns.
- **Apple HIG** — restrained color, soft shadows, typography rhythm, depth via subtle elevation rather than borders.

What helm is NOT trying to be: Linear-cool / Vercel-marketing / shadcn-template-default. helm is a Mac system app.

---

## 9. What's locked / out of scope for the design

- Don't propose changes to: feature inventory, MCP tool surface, backend APIs, data model.
- Don't propose removing existing features (Lark mirror, Harness, Approvals, etc.).
- Don't propose mobile responsive — Electron desktop only.
- Don't propose dark-mode-only or light-mode-only — both must keep working via existing CSS var override pattern.
- Don't propose dropping Tailwind v4 wiring (just landed).

## 10. What's open and welcomed

- Sidebar IA — any restructure, including nested 2-level groups, collapsible sections, footer affordances.
- Page-by-page layout — including switching from "single column of cards" to multi-pane workspaces (rail + content + inspector), tabbed surfaces, modal sub-flows, side sheets.
- Component primitive choices — recommend specific shadcn / Radix components to commit to (Dialog, Tooltip, Tabs, DropdownMenu, Badge, Card variants, Toast, Sheet, Select, Combobox).
- Iconography — pick an icon set (lucide-react is the natural choice given AKM uses it and it pairs with shadcn) and propose where icons go.
- Typography scale — propose a clean 5-size scale.
- Loading / empty / error state patterns — design a coherent set.
- Color usage — propose where tone (warn / info / success / danger) gets used beyond buttons (e.g. card accent bars, subtle backgrounds).
- Motion principles — propose what should animate (page transitions? rail row hover? toast enter? list reorder?) and the duration scale.

---

## 11. Deliverables hoped for

In a form an implementer can act on:

1. **Sidebar IA** — final tree of groups + items, with iconography assignments.
2. **Per-page layout patterns** — 4-5 templates (list/detail / workspace / setting / wizard / single-action). Sketches or descriptions sufficient; don't need pixel-perfect mocks.
3. **Component primitive list** — which shadcn / Radix components to commit to, with rationale for each. Replacement mapping (e.g. "this hand-rolled tab → shadcn Tabs").
4. **Typography + spacing scale** — explicit values.
5. **Color usage map** — where each semantic color is allowed to appear.
6. **State pattern set** — loading skeleton, empty state, error fallback, success confirmation, async pending.
7. **Motion principles** — what animates + durations.
8. **Migration plan** — proposed order: which pages get redesigned first, what can be deferred. Helps the implementer (me) chunk into PRs.

The implementer (Claude Code, me) will then turn this into a sequence of small, reviewable PRs. Designer doesn't need to think about PR boundaries — just sequence the work.

---

## 12. Practical context the designer should know

- The implementer can introduce dependencies (within reason) — shadcn / Radix / lucide / cva / clsx / tailwind-merge are all fair game.
- The implementer can NOT swap React → another framework, drop Vite, or migrate state management.
- The implementer can NOT touch the backend in this design pass.
- The implementer ships work in incremental PRs per page or per primitive — not big-bang.
- helm has ~1500 unit tests + ~160 e2e tests passing. Visual regressions are caught by hand (no Percy / Chromatic) — designer should call out anywhere a fundamental layout shift could break a flow.
- helm uses CSS vars for theme tokens. The designer SHOULD propose any new color tokens in CSS-var form (e.g. `--surface-warn-tinted: rgba(255, 149, 0, 0.08)`) so they slot into the existing system cleanly.

---

_End of brief. Total reading time: 8-10 min. The designer's response can be conversational + structured; an implementer-ready spec doesn't need to be pixel-perfect, just decisive about IA, patterns, and primitive choices._
