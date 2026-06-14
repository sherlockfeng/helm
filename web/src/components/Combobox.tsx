/**
 * helm-design PR 8 — Combobox primitive (cmdk inside Radix Popover).
 *
 * Replaces the "+ Add role" `<select>` in Chats.tsx. Native <select>
 * doesn't search; with ~50 roles for power users, typing the first
 * letters of a role name should narrow the list immediately.
 *
 * Composition:
 *   - Radix Popover gives us the portal-rendered popup + focus trap +
 *     click-outside-to-close.
 *   - cmdk (the Command palette library) gives us the search input,
 *     filtering, keyboard arrow nav, and "no results" state.
 *
 * The popup width matches the trigger via Radix's --radix-popover-
 * trigger-width CSS var so the dropdown lines up under the button.
 *
 * Usage:
 *
 *   <Combobox
 *     value={roleId}
 *     onValueChange={setRoleId}
 *     placeholder="+ Add role"
 *     items={[{ value: 'goofy', label: 'Goofy' }, ...]}
 *   />
 *
 * Theming lives in app.css under .helm-combobox-* selectors.
 */

import { useState, type ReactNode } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Command } from 'cmdk';
import { Check, ChevronDown, Search } from './Icons.js';
import { cn } from '../lib/cn.js';

export interface ComboboxItem {
  value: string;
  label: string;
  /** Optional inline description displayed beneath the label. */
  description?: ReactNode;
  /** Defaults to false; render greyed-out + unselectable when true. */
  disabled?: boolean;
}

export interface ComboboxProps {
  /** Controlled value — pass empty string when nothing is selected. */
  value: string;
  onValueChange: (value: string) => void;
  items: ComboboxItem[];
  /** Trigger button label when value is empty. */
  placeholder: string;
  /** Optional className on the trigger so callers can size it. */
  triggerClassName?: string;
  /** Disables the entire combobox. */
  disabled?: boolean;
  /** "No results" copy. Default "No matches." */
  emptyMessage?: string;
}

export function Combobox({
  value, onValueChange, items, placeholder,
  triggerClassName, disabled, emptyMessage = 'No matches.',
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const selected = items.find((i) => i.value === value);

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger
        type="button"
        className={cn('helm-combobox-trigger', triggerClassName)}
        disabled={disabled}
        aria-label={placeholder}
      >
        <span className={cn('helm-combobox-label', !selected && 'helm-combobox-placeholder')}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown width={14} height={14} aria-hidden="true" />
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={4}
          collisionPadding={8}
          className="helm-combobox-content"
          /* Anchor to the trigger's right edge (these triggers sit on the
             right of their row) and give the popup a readable min width —
             tiny triggers like "+ topic" otherwise force a clipped,
             off-screen dropdown. */
          style={{ minWidth: 'max(240px, var(--radix-popover-trigger-width))' }}
        >
          <Command label={placeholder} className="helm-combobox-command">
            <div className="helm-combobox-input-row">
              <Search width={14} height={14} aria-hidden="true" />
              <Command.Input
                placeholder="Search…"
                className="helm-combobox-input"
                autoFocus
              />
            </div>
            <Command.List className="helm-combobox-list">
              <Command.Empty className="helm-combobox-empty">{emptyMessage}</Command.Empty>
              {items.map((item) => (
                <Command.Item
                  key={item.value}
                  value={`${item.label} ${item.value}` /* search by label + id */}
                  disabled={item.disabled}
                  onSelect={() => {
                    if (item.disabled) return;
                    onValueChange(item.value);
                    setOpen(false);
                  }}
                  className="helm-combobox-item"
                >
                  <div className="helm-combobox-item-body">
                    <span>{item.label}</span>
                    {item.description && (
                      <span className="helm-combobox-item-description">{item.description}</span>
                    )}
                  </div>
                  {item.value === value && (
                    <Check width={14} height={14} aria-hidden="true" />
                  )}
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
