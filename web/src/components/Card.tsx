/**
 * helm-design PR 7 — Card primitive.
 *
 * Replaces `<article className="helm-card">` (~30 sites). Adds a
 * `variant` prop that drives a 3 px left accent bar + tinted
 * background gradient for semantic states:
 *
 *   - default     : the existing card (no accent)
 *   - interactive : hover lifts + cursor:pointer (use for clickable cards)
 *   - selected    : accent left bar + raised background (use for the
 *                   currently-focused row in rail+detail layouts)
 *   - warn        : amber left bar + tinted gradient (use for cards
 *                   the user should attend to but isn't broken)
 *   - danger      : red left bar + tinted gradient (use for the
 *                   destructive sections in Settings + expired Approvals)
 *   - success     : green left bar (use sparingly — "this worked" cards)
 *
 * Card forwards every prop to <article> so existing className overrides
 * (custom margins on individual cards, etc.) keep working. Use cva so
 * the variant token also surfaces in the DOM via a stable className for
 * future styling / testing hooks.
 */

import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn.js';

const cardVariants = cva('helm-card', {
  variants: {
    variant: {
      default: '',
      interactive: 'helm-card--interactive',
      selected: 'helm-card--selected',
      warn: 'helm-card--warn',
      danger: 'helm-card--danger',
      success: 'helm-card--success',
    },
  },
  defaultVariants: { variant: 'default' },
});

export type CardVariant = NonNullable<VariantProps<typeof cardVariants>['variant']>;

export interface CardProps extends ComponentPropsWithoutRef<'article'> {
  variant?: CardVariant;
}

export const Card = forwardRef<HTMLElement, CardProps>(
  function Card({ className, variant, ...props }, ref) {
    return (
      <article
        ref={ref}
        className={cn(cardVariants({ variant }), className)}
        {...props}
      />
    );
  },
);
