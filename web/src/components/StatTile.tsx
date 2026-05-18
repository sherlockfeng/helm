/**
 * helm-design PR 6 — StatTile primitive.
 *
 * The 70 × 40-ish box that lives in the right side of a page header
 * (Active Chats has 3 of them today: Chats / Queued / Lark mirrored).
 * Lifted from the inline `Stat` helper inside Chats.tsx so every page
 * can drop a stat strip into its <PageHeader/> without copy-pasting.
 *
 * Tone reads as: live (success, non-zero healthy), warn (amber,
 * non-zero attention), info (blue, non-zero informational), muted
 * (gray, zero or n/a). Default is `muted` so a fresh tile reads as
 * "nothing yet" without thinking.
 *
 * CSS lives at `.helm-rail-stat` + `.helm-rail-stat-{value,label}` +
 * `.helm-rail-stat.tone-{live,warn,info,muted}` in app.css. Kept those
 * class names to avoid a churn-only rename — they were already in
 * production via Active Chats.
 */

import type { ReactNode } from 'react';

export type StatTone = 'live' | 'warn' | 'info' | 'muted';

export interface StatTileProps {
  /** Big number / short string shown on top. */
  value: ReactNode;
  /** SHOUTY uppercase label shown beneath. */
  label: string;
  /** Default `muted`. Pick a non-muted tone only when the value > 0. */
  tone?: StatTone;
}

export function StatTile({ value, label, tone = 'muted' }: StatTileProps) {
  return (
    <div className={`helm-rail-stat tone-${tone}`}>
      <div className="helm-rail-stat-value">{value}</div>
      <div className="helm-rail-stat-label">{label}</div>
    </div>
  );
}
