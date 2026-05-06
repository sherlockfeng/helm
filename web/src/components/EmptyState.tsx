/**
 * Standardized empty-state block — first line is the empty fact, second line
 * is the next-action hint. Replaces the inconsistent inline messages each
 * page used to write. See docs/design/2026-05-06-polish-pass.md P1-2.
 */

import type { ReactNode } from 'react';

export function EmptyState({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="helm-empty">
      <strong>{title}</strong>
      {hint && <p className="helm-empty-hint">{hint}</p>}
    </div>
  );
}
