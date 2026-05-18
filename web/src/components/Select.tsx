/**
 * helm-design PR 8 — Select primitive.
 *
 * Wraps @radix-ui/react-select. Replaces native <select> sites where
 * we want themed dark-mode rendering (native <select> popups follow
 * OS chrome — fine for Settings dropdowns, but visually inconsistent
 * inside the helm window). Radix gives us full keyboard navigation,
 * type-ahead, focus management, scroll-locked viewport, and the
 * portal-rendered popup that doesn't get clipped by ancestor overflow.
 *
 * Usage:
 *
 *   <Select value={value} onValueChange={setValue}>
 *     <SelectTrigger>
 *       <SelectValue placeholder="Pick one" />
 *     </SelectTrigger>
 *     <SelectContent>
 *       <SelectItem value="a">Apple</SelectItem>
 *       <SelectItem value="b">Banana</SelectItem>
 *     </SelectContent>
 *   </Select>
 *
 * Theming lives in app.css under .helm-select-* selectors. The dark-
 * mode rendering must visually match the existing native <select>
 * styling (HANDOFF §8 acceptance: "Cursor-model select dark mode
 * renders identically").
 */

import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from './Icons.js';
import { cn } from '../lib/cn.js';

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;
export const SelectGroup = SelectPrimitive.Group;

export const SelectTrigger = forwardRef<
  ElementRef<typeof SelectPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(function SelectTrigger({ className, children, ...props }, ref) {
  return (
    <SelectPrimitive.Trigger
      ref={ref}
      className={cn('helm-select-trigger', className)}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown width={14} height={14} aria-hidden="true" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
});

export const SelectContent = forwardRef<
  ElementRef<typeof SelectPrimitive.Content>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(function SelectContent({ className, children, position = 'popper', ...props }, ref) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        position={position}
        // sideOffset 4 — popup sits a hair below the trigger so the
        // chevron doesn't visually merge with the first item border.
        sideOffset={4}
        className={cn('helm-select-content', className)}
        {...props}
      >
        <SelectPrimitive.Viewport className="helm-select-viewport">
          {children}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
});

export const SelectItem = forwardRef<
  ElementRef<typeof SelectPrimitive.Item>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(function SelectItem({ className, children, ...props }, ref) {
  return (
    <SelectPrimitive.Item
      ref={ref}
      className={cn('helm-select-item', className)}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="helm-select-item-indicator">
        <Check width={14} height={14} aria-hidden="true" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
});
