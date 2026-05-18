/**
 * helm-design PR 2 — Tooltip primitive.
 *
 * Thin themed wrapper over @radix-ui/react-tooltip. Default hover
 * delay 200 ms per HANDOFF.md §6 (matches macOS Settings tooltip
 * feel — fast enough to feel responsive, slow enough to dodge
 * accidental triggers).
 *
 * Re-exports the Radix surface (Root / Trigger / Content / Provider)
 * so callers can compose advanced cases without re-importing Radix
 * directly. The themed default Content uses helm's popover shadow +
 * elevated surface.
 */

import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '../lib/cn.js';

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = forwardRef<
  ElementRef<typeof TooltipPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(function TooltipContent({ className, sideOffset = 4, ...props }, ref) {
  return (
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn('helm-tooltip-content', className)}
      {...props}
    />
  );
});
