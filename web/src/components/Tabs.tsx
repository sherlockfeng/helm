/**
 * helm-design PR 8 — Tabs primitive.
 *
 * Wraps @radix-ui/react-tabs. Styled as a Mac-feel "segmented control":
 * inactive triggers are transparent, the active trigger is an elevated
 * white pill (light) / raised surface (dark). Underline / border-bottom
 * stripped — segmented controls own the visual state.
 *
 * Radix gives us keyboard arrow navigation, role=tablist / tabpanel
 * wiring, and roving-focus semantics for free. We only own theming +
 * the segmented look.
 *
 * Usage:
 *
 *   <Tabs defaultValue="chunks">
 *     <TabsList>
 *       <TabsTrigger value="chunks">Chunks</TabsTrigger>
 *       <TabsTrigger value="candidates">Candidates</TabsTrigger>
 *     </TabsList>
 *     <TabsContent value="chunks">…</TabsContent>
 *     <TabsContent value="candidates">…</TabsContent>
 *   </Tabs>
 *
 * For controlled tabs, pass `value` + `onValueChange` instead of
 * `defaultValue` (Roles.tsx uses this so the existing `activeTab`
 * useState can stay).
 */

import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '../lib/cn.js';

export const Tabs = TabsPrimitive.Root;

export const TabsList = forwardRef<
  ElementRef<typeof TabsPrimitive.List>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(function TabsList({ className, ...props }, ref) {
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn('helm-tabs-list', className)}
      {...props}
    />
  );
});

export const TabsTrigger = forwardRef<
  ElementRef<typeof TabsPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(function TabsTrigger({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn('helm-tabs-trigger', className)}
      {...props}
    />
  );
});

export const TabsContent = forwardRef<
  ElementRef<typeof TabsPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(function TabsContent({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Content
      ref={ref}
      className={cn('helm-tabs-content', className)}
      {...props}
    />
  );
});
