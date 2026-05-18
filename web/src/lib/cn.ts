/**
 * `cn` — class-name joiner used by every UI primitive in this repo.
 *
 *   - `clsx` flattens conditional class lists ({foo: true, bar: 0} → 'foo')
 *   - `twMerge` reconciles conflicting Tailwind utilities (`px-2 px-4` → `px-4`)
 *
 * The combination is the de-facto standard pattern in shadcn / Radix
 * ecosystems. Keep this file tiny and unopinionated — primitives import
 * `cn`, callers don't.
 */

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
