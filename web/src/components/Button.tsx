/**
 * helm-design PR 2 — Button primitive.
 *
 * Pure API wrapper over the existing button CSS rules in app.css.
 * Emits the SAME DOM as today's `<button className="primary">` — the
 * class list is identical, so this PR has zero screenshot diff.
 *
 * Variant → class mapping:
 *   default          → (bare <button>; helm's base button rule applies)
 *   primary          → "primary"
 *   ghost            → "ghost"
 *   danger           → "danger"
 *   danger-outline   → "danger-outline"
 *
 * Sizes: `default` (no class) or `sm` (`btn-sm` — new in PR 2).
 *
 * Optional leading icon comes from lucide-react. Icon component is
 * passed as-is (not instantiated) so callers don't need to wire size:
 *     <Button variant="primary" icon={Save}>Save</Button>
 */

import { forwardRef, type ButtonHTMLAttributes, type ComponentType } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn.js';

const buttonVariants = cva('', {
  variants: {
    variant: {
      // `default` deliberately empty — the bare button[...] rules in app.css
      // (line ~178) style every `<button>` element regardless of class.
      default: '',
      primary: 'primary',
      ghost: 'ghost',
      danger: 'danger',
      'danger-outline': 'danger-outline',
    },
    size: {
      default: '',
      sm: 'btn-sm',
    },
  },
  defaultVariants: {
    variant: 'default',
    size: 'default',
  },
});

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Optional lucide-react icon component. Rendered at 14 px before the label. */
  icon?: ComponentType<{ size?: number; className?: string }>;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, icon: Icon, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      {...rest}
    >
      {Icon ? (
        <Icon
          size={14}
          // Inline gap with text — `.btn-sm` is dense enough that the
          // icon needs a slight visual breathing room when present.
          className={cn(children ? 'mr-1.5' : undefined)}
        />
      ) : null}
      {children}
    </button>
  );
});
