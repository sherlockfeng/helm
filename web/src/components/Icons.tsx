/**
 * helm-design PR 4 — Icons re-export.
 *
 * Single source of truth for the lucide-react icons helm uses. Importing
 * from this module instead of `lucide-react` directly keeps the canonical
 * mapping (see `.claude/skills/helm-design/ICONOGRAPHY.md`) visible in
 * code and makes future renames (e.g. swapping `ArrowLeftRight` for a
 * branded "mirror" glyph) a one-line change.
 *
 * Rules baked in here:
 *   - 1.75 px stroke (lucide default at 16)
 *   - sizes: 14 inline meta, 16 buttons/lists, 18 nav, 20 page header
 *   - color: inherits `currentColor`
 *
 * Add a new icon? Add it to the table in ICONOGRAPHY.md first; this
 * file should never list anything the iconography doc doesn't bless.
 */

export {
  // ─── Sidebar nav ────────────────────────────────────────────────
  // PR 1 (conversations-knowledge IA):
  MessagesSquare,    // Conversations (was Active Chats)
  BookOpen,          // Knowledge › Library
  Inbox,             // Knowledge › Review (candidates)
  Cloud,             // Knowledge › Sources (subscriptions + mirrors)
  ListChecks,        // Verification › Cases
  History,           // Verification › Runs
  Target,            // Verification › Coverage
  Settings,          // Settings
  // Advanced (opt-in via Settings):
  Link2,             // Bindings
  ShieldCheck,       // Approvals
  Plug,              // Plugins
  Workflow,          // Harness

  // ─── Action verbs ───────────────────────────────────────────────
  Check,             // Allow / success
  X,                 // Deny / close
  Play,              // Run review
  Sparkles,          // Train (sparingly — only AI-feeling icon)
  ArrowLeftRight,    // Mirror to Lark
  FileText,          // Open task.md
  Trash2,            // Drop / delete (danger color in destructive confirms)
  Copy,              // Copy
  ArrowUpRight,      // External link

  // ─── Inputs + meta ──────────────────────────────────────────────
  Search,            // Search field
  SlidersHorizontal, // Filter
  MoreHorizontal,    // Kebab menu (always horizontal — Mac-feel)
  ChevronDown,       // Selects, accordions

  // ─── Status ─────────────────────────────────────────────────────
  CircleDot,         // Bound (filled dot at 8 px)
  CircleAlert,       // Expired (danger)
  AlertTriangle,     // Warn (toasts, banners)
  Clock,             // Pending (warn)
  Lock,              // Locked / private
  Plus,              // Add
} from 'lucide-react';
