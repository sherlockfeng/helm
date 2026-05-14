/**
 * Knowledge lifecycle — decay re-rank + archival sweep (Phase 77).
 *
 * Why this module is separate from `hybrid-search.ts`:
 *
 *   hybrid-search answers "given the corpus, which chunks are relevant to
 *   THIS query?". lifecycle answers "given the corpus, which chunks
 *   deserve to stay alive at all?". They share the same data, but their
 *   concerns are orthogonal — mixing them buries a system-wide policy
 *   (decay weights, archive thresholds) inside what should be a stateless
 *   ranker.
 *
 * Two concrete responsibilities here:
 *
 *   1. `scoreDecay(lastAccessedAt, createdAt, now, tauDays)` — exponential
 *      "age factor" in [0, 1]. New + recently-accessed → ~1.0. Old + never
 *      touched → near zero. The fusion path multiplies its RRF score by
 *      `(1 + α * decay)` to gently bias toward warm chunks without
 *      hard-filtering anything.
 *
 *   2. `runArchivalSweep(db, roleId, opts)` — find chunks that are both
 *      old AND under-accessed, flip their `archived = 1`. Idempotent;
 *      re-running the sweep with the same data archives nothing new.
 *
 * Constants (`DECAY_PARAMS`, `ARCHIVAL_THRESHOLD`) are exported so tests
 * + Settings can override them. Defaults match the task doc's locked
 * Decisions §3 + §6.
 */

import type Database from 'better-sqlite3';
import {
  archiveChunks,
  findArchiveCandidates,
  listRoleIdsWithChunks,
} from '../storage/repos/roles.js';

/** Default decay time-constant (days) — Decision §6. */
export const DEFAULT_DECAY_TAU_DAYS = 30;
/** Default max boost / penalty α — Decision §6. */
export const DEFAULT_DECAY_ALPHA = 0.3;
/** Default chunk age (days) before archive becomes eligible — Decision §3. */
export const DEFAULT_ARCHIVE_AFTER_DAYS = 90;
/** Default max access_count for a chunk to still count as "cold" — Decision §3. */
export const DEFAULT_ARCHIVE_BELOW_ACCESS_COUNT = 3;

/**
 * Bundled defaults — convenience export so the orchestrator can pass a
 * single object through to the sweep without unpacking each field.
 */
export interface LifecycleThresholds {
  archiveAfterDays: number;
  archiveBelowAccessCount: number;
  decayTauDays: number;
  decayAlpha: number;
}
export const DEFAULT_LIFECYCLE_THRESHOLDS: LifecycleThresholds = {
  archiveAfterDays: DEFAULT_ARCHIVE_AFTER_DAYS,
  archiveBelowAccessCount: DEFAULT_ARCHIVE_BELOW_ACCESS_COUNT,
  decayTauDays: DEFAULT_DECAY_TAU_DAYS,
  decayAlpha: DEFAULT_DECAY_ALPHA,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Exponential decay multiplier in (0, 1].
 *
 *   factor = exp(-Δt / τ)    where Δt is in days.
 *
 * `lastAccessedAt` falls back to `createdAt` when undefined / null — a
 * freshly-trained chunk that's never been queried should be treated as
 * fresh, not as "infinitely old". Without this fallback the sweep would
 * archive new chunks before they ever got a chance to be searched.
 *
 * Inputs are ISO strings (matching how we store them); invalid / unparseable
 * timestamps fall back to "treat as new" (factor = 1) rather than throwing —
 * a malformed row shouldn't crash search.
 */
export function scoreDecay(
  lastAccessedAt: string | undefined,
  createdAt: string,
  now: Date,
  tauDays: number = DEFAULT_DECAY_TAU_DAYS,
): number {
  const anchor = lastAccessedAt ?? createdAt;
  const anchorTs = Date.parse(anchor);
  if (!Number.isFinite(anchorTs)) return 1;
  const ageMs = Math.max(0, now.getTime() - anchorTs);
  const ageDays = ageMs / MS_PER_DAY;
  // tau=0 would mean instant decay; clamp at a tiny positive value so the
  // formula stays well-defined under accidental config of `decayTauDays: 0`.
  const tau = Math.max(1e-6, tauDays);
  return Math.exp(-ageDays / tau);
}

/**
 * Apply the decay multiplier to a base RRF score.
 *
 *   final = rrf * (1 + α * decay)
 *
 * With α=0.3 this caps the boost at +30% for "perfectly fresh" chunks and
 * pulls "stale" chunks down by very little (close to zero decay means the
 * multiplier approaches 1.0 + α * 0 = 1.0 — i.e. no penalty applied,
 * matching Decision §2: decay is a BOOST, not a penalty). The formula
 * mostly tilts ranking; archive does the heavy lifting on truly cold data.
 */
export function applyDecayBoost(
  rrfScore: number,
  decayFactor: number,
  alpha: number = DEFAULT_DECAY_ALPHA,
): number {
  return rrfScore * (1 + alpha * decayFactor);
}

export interface ArchivalSweepResult {
  /** Number of chunks scanned across all roles considered. */
  scanned: number;
  /** Number of chunks the sweep flipped to archived = 1. */
  archived: number;
  /** Number of chunks that matched the candidate filter but were already archived (rare race). */
  skipped: number;
  /** Wall-clock duration of the sweep in ms. */
  durationMs: number;
  /** Per-role counts so callers can log a breakdown. */
  byRole: Array<{ roleId: string; archived: number; scanned: number }>;
}

export interface RunArchivalSweepOptions {
  /** Restrict the sweep to one role. When omitted, sweeps every role with chunks. */
  roleId?: string;
  /** Override the default thresholds — sourced from helm Settings in production. */
  thresholds?: Partial<LifecycleThresholds>;
  /** Inject a fixed clock for testing. Defaults to `new Date()`. */
  now?: Date;
}

/**
 * Run one archival pass and return what changed.
 *
 * Two phases (intentionally NOT a single SQL statement):
 *
 *   1. For each candidate role, find the chunk ids that meet the
 *      "old + cold" criteria via the repo helper.
 *   2. Flip `archived = 1` on them in one transaction per role.
 *
 * Splitting these phases keeps the candidate-discovery side query-friendly
 * (we can re-use the same filter for the Roles UI's "show archive
 * candidates preview" feature later) and bounds each transaction to one
 * role so a sweep over a large corpus doesn't hold a long write lock.
 *
 * The function is safe to call repeatedly — already-archived chunks are
 * excluded from the candidate filter, so the second call after a recent
 * sweep is a near no-op (just the scan cost).
 */
export function runArchivalSweep(
  db: Database.Database,
  opts: RunArchivalSweepOptions = {},
): ArchivalSweepResult {
  const startedAt = Date.now();
  const now = opts.now ?? new Date();
  const thresholds: LifecycleThresholds = {
    ...DEFAULT_LIFECYCLE_THRESHOLDS,
    ...opts.thresholds,
  };

  const roleIds = opts.roleId
    ? [opts.roleId]
    : listRoleIdsWithChunks(db);

  const cutoffMs = now.getTime() - thresholds.archiveAfterDays * MS_PER_DAY;
  const cutoff = new Date(cutoffMs).toISOString();

  const byRole: ArchivalSweepResult['byRole'] = [];
  let scanned = 0;
  let archived = 0;
  let skipped = 0;

  for (const roleId of roleIds) {
    const candidates = findArchiveCandidates(
      db,
      roleId,
      cutoff,         // created_at <= cutoff
      cutoff,         // last_accessed_at <= cutoff (NULL also matches)
      thresholds.archiveBelowAccessCount,
    );
    scanned += candidates.length;
    if (candidates.length === 0) {
      byRole.push({ roleId, archived: 0, scanned: 0 });
      continue;
    }
    const flipped = archiveChunks(db, candidates);
    archived += flipped;
    skipped += candidates.length - flipped;
    byRole.push({ roleId, archived: flipped, scanned: candidates.length });
  }

  return {
    scanned,
    archived,
    skipped,
    durationMs: Date.now() - startedAt,
    byRole,
  };
}
