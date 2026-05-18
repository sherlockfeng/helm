/**
 * helm-design PR 2 — Badge primitive.
 *
 * Renders `<span class="badge">` matching the new generic `.badge`
 * rule in app.css. Tone variants tint background + border using the
 * PR 1 semantic-tint tokens. Optional leading `dot` for live-status
 * surfaces (e.g. "synced", "live").
 *
 * Sidebar-scoped badges (`<span class="badge">` inside `.helm-nav`)
 * still match their existing nav-only style — the new generic rule
 * is additive, not a rewrite. Outside the nav, this primitive is the
 * canonical surface.
 */

import { forwardRef, type HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn.js';

const badgeVariants = cva('badge', {
  variants: {
    tone: {
      default: '',
      accent: 'accent',
      success: 'success',
      warn: 'warn',
      danger: 'danger',
    },
  },
  defaultVariants: {
    tone: 'default',
  },
});

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  /** When true, render a leading 6 px dot in the tone's color. */
  dot?: boolean;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { className, tone, dot, children, ...rest },
  ref,
) {
  return (
    <span ref={ref} className={cn(badgeVariants({ tone }), className)} {...rest}>
      {dot ? <span className="dot" /> : null}
      {children}
    </span>
  );
});
