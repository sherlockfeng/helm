/**
 * helm-design PR 3 — Dialog primitive.
 *
 * Themed Radix Dialog wrapper. Focus trap, ESC-to-close, scroll-lock,
 * portal — all free from Radix. We only own theming + composition.
 *
 * Two composition paths:
 *
 *   1. `<Dialog>` + `<DialogContent>` — direct Radix surface for
 *      arbitrary modal content (forms, multi-step wizards, etc.).
 *      Use this for the Mirror-to-Lark + Train-via-chat conversions.
 *
 *   2. `<ConfirmDialog>` — convenience for "title-as-question + body
 *      + Cancel + destructive primary" pattern. Replaces every
 *      `window.confirm()` in the codebase. Title is a question, body
 *      states the side effect, primary button is danger-tone.
 *
 * Both routes use `.helm-dialog-overlay` + `.helm-dialog-content`
 * (defined in app.css). No tailwindcss-animate dependency — Radix
 * data-state attributes drive opacity/scale via plain CSS transition.
 */

import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from '../lib/cn.js';
import { Button } from './Button.js';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

export const DialogOverlay = forwardRef<
  ElementRef<typeof DialogPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(function DialogOverlay({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn('helm-dialog-overlay', className)}
      {...props}
    />
  );
});

export interface DialogContentProps
  extends ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  /** Default 420 px (matches HANDOFF §2 T5). Pass 640 for form-heavy modals. */
  width?: number;
}

export const DialogContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(function DialogContent({ className, children, width = 420, style, ...props }, ref) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn('helm-dialog-content', className)}
        style={{ width, ...style }}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});

/**
 * Render this inside <DialogContent> for the standard "h2 title +
 * caption description" header. Description is optional.
 */
export function DialogHeader({ title, description }: { title: ReactNode; description?: ReactNode }) {
  return (
    <header className="helm-dialog-header">
      <DialogTitle className="helm-dialog-title">{title}</DialogTitle>
      {description ? (
        <DialogDescription className="helm-dialog-description">{description}</DialogDescription>
      ) : null}
    </header>
  );
}

/** Right-aligned action row, gap 8 — Cancel left, primary right. */
export function DialogFooter({ children }: { children: ReactNode }) {
  return <footer className="helm-dialog-footer">{children}</footer>;
}

// ─── ConfirmDialog — controlled destructive confirm pattern ──────────

export interface ConfirmDialogProps {
  /** Set true to show the dialog; false to hide. Parent owns the state. */
  open: boolean;
  /** Called when the user dismisses (esc, scrim click, Cancel). */
  onOpenChange: (open: boolean) => void;
  /** Question form per HANDOFF §6. E.g. "Delete this chat?". */
  title: ReactNode;
  /** Body explaining the side effect. E.g. "Bindings and queued messages will be removed." */
  description: ReactNode;
  /** Primary button text (the destructive verb). E.g. "Delete", "Cancel code", "Drop". */
  confirmLabel: string;
  /** Secondary text. Default "Cancel". */
  cancelLabel?: string;
  /** Tone of the primary button. Default "danger" (filled red) for the destructive path. */
  tone?: 'danger' | 'primary';
  /** Called when the user clicks confirm. Caller closes the dialog. */
  onConfirm: () => void | Promise<void>;
  /** Disables both buttons + shows the confirm in busy state. */
  busy?: boolean;
}

export function ConfirmDialog({
  open, onOpenChange, title, description,
  confirmLabel, cancelLabel = 'Cancel',
  tone = 'danger', onConfirm, busy,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader title={title} description={description} />
        <DialogFooter>
          <Button
            variant="default"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            onClick={() => { void onConfirm(); }}
            disabled={busy}
            aria-busy={busy}
            autoFocus={false /* default cancel focus per macOS HIG for destructive */}
          >
            {busy ? `${confirmLabel}…` : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
