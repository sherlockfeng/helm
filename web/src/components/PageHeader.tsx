/**
 * helm-design PR 6 — PageHeader primitive.
 *
 * Replaces the repeated `<h2>Title</h2> + <p className="muted">…</p>`
 * pattern that every page reinvents slightly differently. Built around
 * the existing `.helm-rail-header` layout (left: title + subtitle;
 * right: stat strip + actions) so Active Chats — the page that already
 * had this shape since Phase 79 — ports over without a visual diff.
 *
 * Slots:
 *   - title:     h2 text (required)
 *   - subtitle:  one-line muted caption beneath the title (optional)
 *   - stats:     array of StatTile elements, right side (optional)
 *   - actions:   right-side buttons/links — sits below stats so the
 *                eye scans title → caption → stats → CTAs (optional)
 *
 * The header sits inside the page fragment, NOT inside a workspace
 * rail. Pages that use the 2-col rail layout (Roles, Harness) put
 * <PageHeader/> above the <div className="helm-rail-layout"> wrapper.
 */

import type { ReactNode } from 'react';

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Right-side stat tiles. Pass `<StatTile/>` instances. */
  stats?: ReactNode;
  /** Right-side actions row. Sits beneath stats. */
  actions?: ReactNode;
}

export function PageHeader({ title, subtitle, stats, actions }: PageHeaderProps) {
  return (
    <header className="helm-page-header">
      <div className="helm-page-header-titles">
        <h2 className="helm-page-header-title">{title}</h2>
        {subtitle && (
          <p className="helm-page-header-subtitle muted">{subtitle}</p>
        )}
      </div>
      {(stats || actions) && (
        <div className="helm-page-header-aside">
          {stats && (
            <div className="helm-rail-stats" role="status" aria-label={`${typeof title === 'string' ? title : 'Page'} stats`}>
              {stats}
            </div>
          )}
          {actions && (
            <div className="helm-page-header-actions">{actions}</div>
          )}
        </div>
      )}
    </header>
  );
}
