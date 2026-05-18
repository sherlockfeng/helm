/**
 * helm-design PR 2 — IconButton primitive.
 *
 * A square `<Button>` with a single lucide icon, wrapped in a Radix
 * Tooltip (200 ms hover delay per HANDOFF.md §6 spec). Replaces all
 * the `<button title="…"><Icon/></button>` sites scattered through
 * the pages (~12 instances per CODEBASE-NOTES.md).
 *
 * a11y: `label` is the source of truth — set as both the visible
 * tooltip content AND the button's aria-label. Keyboard users hear
 * the same description screen-reader users do.
 */

import { forwardRef, type ComponentType, type MouseEventHandler } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './Tooltip.js';
import { Button, type ButtonProps } from './Button.js';
import { cn } from '../lib/cn.js';

export interface IconButtonProps
  extends Omit<ButtonProps, 'children' | 'icon' | 'aria-label'> {
  /** Lucide icon component. Rendered at 14 px (16 px when size="default"). */
  icon: ComponentType<{ size?: number; className?: string }>;
  /** Tooltip text + accessible name. Always required. */
  label: string;
  /** Optional: skip the tooltip wrap (e.g. when inside a button group that
   *  already documents itself). Defaults to false — tooltip on. */
  noTooltip?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, noTooltip, className, variant = 'ghost', size, ...rest },
  ref,
) {
  const iconSize = size === 'sm' ? 12 : 14;
  const button = (
    <Button
      ref={ref}
      variant={variant}
      size={size}
      aria-label={label}
      className={cn('btn-icon', className)}
      {...rest}
    >
      <Icon size={iconSize} />
    </Button>
  );
  if (noTooltip) return button;
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});
