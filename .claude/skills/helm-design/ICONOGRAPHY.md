# ICONOGRAPHY

helm uses **[lucide](https://lucide.dev)** as the single icon system. No emoji, no PNG icons, no hand-rolled SVG except the brand wordmark and glyph.

## Why lucide

- AKM (the sibling project) already uses lucide; staying consistent makes cross-pollination of components painless.
- Pairs natively with shadcn / Radix, which the brief opens the door to.
- 1.75 px stroke matches macOS HIG glyphs in spirit (SF Symbols use a similar weight at small sizes).
- Tree-shakable via `lucide-react`; one ESM-only dependency.

## Installation

```bash
npm i lucide-react
```

```tsx
import { Check, X, MoreHorizontal, Settings, Plus } from 'lucide-react';
```

CDN (for slides, mocks, prototypes — not production):
```
https://unpkg.com/lucide-static@latest/icons/<icon-name>.svg
```

## Rules

| Rule | Value |
|---|---|
| Stroke width | 1.75 (lucide default at 16 px) |
| Sizes | 14 (inline meta), 16 (buttons, list rows), 18 (sidebar nav), 20 (page header), 80 (empty-state mascot — uses glyph, not lucide) |
| Color | inherits `currentColor`. Default to `--text-secondary` in nav, `--text` in primary buttons, semantic tone where it carries meaning |
| Padding | 16 × 16 icon in a 28 × 28 hit area on icon-only buttons |
| Alignment | Always vertically centered with the adjacent text label, never above/below |

## Where icons go

| Surface | Icons | Notes |
|---|---|---|
| Sidebar nav rows | 18 px, leading | Every nav row gets one. `--text-secondary` default, `--accent` when selected. |
| Sidebar group headings (CHATS, KNOWLEDGE) | none | Section headings are text-only. |
| Buttons | 16 px, leading | Optional for primary actions, mandatory for icon-only (kebab, close, copy). |
| Stat tiles | 16 px, trailing or none | Used to mark trend / state, not decoration. |
| Inline metadata (timestamps, paths) | 14 px, leading | Helps scanning long meta rows. |
| Empty states | 80 px helm **glyph** (not lucide) | A lucide icon at 80 px feels thin. |
| Toasts | 16 px, leading, semantic tone | `Check` (success), `AlertTriangle` (warn), `X` (error). |
| Form field affordances | 14 px, inside the input | Search → `Search`, password reveal → `Eye` / `EyeOff`. |

## Canonical mapping

| helm concept | lucide icon | Notes |
|---|---|---|
| Active Chats (nav) | `MessagesSquare` | |
| Bindings (nav) | `Link2` | |
| Approvals (nav) | `ShieldCheck` | |
| Roles (nav) | `BookOpen` | "knowledge" |
| Subscriptions (nav) | `Cloud` | Remote bundles |
| Plugins (nav) | `Plug` | |
| Harness (nav) | `Workflow` | |
| Settings (nav) | `Settings` | |
| Brand glyph | helm wheel SVG (`assets/glyph.svg`) | Not in lucide |
| Allow | `Check` | `--success` color only in toasts; in buttons inherits text |
| Deny | `X` | `--danger` only in deny buttons |
| Run review | `Play` | |
| Train | `Sparkles` | One of very few "AI-feeling" icons; used sparingly |
| Mirror to Lark | `ArrowLeftRight` | |
| Open task.md | `FileText` | |
| Drop / delete | `Trash2` | `--danger` only inside destructive confirms |
| Copy | `Copy` | |
| External link | `ArrowUpRight` | Not `ExternalLink` — that one's noisier |
| Search | `Search` | |
| Filter | `SlidersHorizontal` | |
| Kebab menu | `MoreHorizontal` | Always horizontal, never vertical (Mac-feel) |
| Caret expand | `ChevronDown` | Selects, accordion |
| Status: bound | `CircleDot` filled at 8 px | Or a colored dot, not the lucide glyph |
| Status: expired | `CircleAlert` | `--danger` |
| Status: pending | `Clock` | `--warn` |

When you need a glyph that's not in this list, pick the closest **outline** lucide icon and add it to this table in your PR description. Don't reach for filled icons unless you're indicating a "selected" or "active" state.

## Brand glyph

`assets/glyph.svg` — a ship's helm wheel (hub + ring + 8 spokes + 8 outer handles + center pivot). Strictly monochrome. Renders at 20 px in the sidebar header; 80 px in empty states.

`assets/logo.svg` — the glyph + lowercase **helm** wordmark, side by side.

> **Note on the glyph + wordmark.** These were drawn fresh for this design system from the brief alone. If helm already has an established mark, **replace both files** — the rest of the system references them via `currentColor` and will pick up the new artwork automatically.

## No emoji policy

| Forbidden | Use instead |
|---|---|
| ✅ | `Check` (lucide) |
| ❌ | `X` (lucide) |
| ⚠️ | `AlertTriangle` (lucide) + `--warn` |
| 🔒 | `Lock` (lucide) |
| 🚀 | none — rephrase the copy |
| 🎉 | none — rephrase the copy |
| 🤖 | none — helm is "AI for adults"; don't lean on robot faces |

Two extremely narrow exceptions:
- Inside a **role's training markdown**, emoji authored by the user pass through verbatim (it's their content, not helm's UI).
- Inside **chat content** mirrored from Lark — same rationale.
