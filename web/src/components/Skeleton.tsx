/**
 * helm-design PR 9 — Skeleton primitive.
 *
 * Loading placeholder. Replaces `<p className="muted">Loading…</p>`
 * across the app so first paint shows something structurally similar
 * to the real content (rather than a one-line text shrug). Animated
 * via a CSS shimmer keyframe; gets paused under
 * `prefers-reduced-motion: reduce`.
 *
 * Two convenience layouts on top of the bare <Skeleton>:
 *
 *   - <CardSkeleton/>      — one stand-in for a typical helm card
 *                            (label line + title line + meta line).
 *   - <CardSkeletonList n> — repeat <CardSkeleton/> n times, gap 12.
 *
 * Drop <CardSkeletonList n={3}/> in place of the loading text and
 * the page feels like it's about to render — not stuck.
 */

import { cn } from '../lib/cn.js';

export interface SkeletonProps {
  /** Width in px or any CSS length. Default 100%. */
  width?: number | string;
  /** Height in px or any CSS length. Default 14 (one text line). */
  height?: number | string;
  /** Border radius. Default var(--radius-sm). */
  radius?: number | string;
  className?: string;
}

export function Skeleton({ width = '100%', height = 14, radius, className }: SkeletonProps) {
  return (
    <div
      className={cn('helm-skeleton', className)}
      style={{
        width,
        height,
        borderRadius: radius,
      }}
      aria-hidden="true"
    />
  );
}

/**
 * Stand-in for one helm-card. Matches the typical
 * label / title / meta vertical rhythm so the page doesn't lurch
 * once real data arrives.
 */
export function CardSkeleton() {
  return (
    <div className="helm-skeleton-card" role="status" aria-busy="true" aria-label="Loading…">
      <Skeleton width={72} height={10} />
      <Skeleton width="60%" height={16} />
      <Skeleton width="40%" height={11} />
    </div>
  );
}

/** Repeats <CardSkeleton/> n times with gap 12. */
export function CardSkeletonList({ n = 3 }: { n?: number }) {
  return (
    <div className="helm-skeleton-list">
      {Array.from({ length: n }, (_, i) => <CardSkeleton key={i} />)}
    </div>
  );
}
