/**
 * Click-to-copy button. Wraps `navigator.clipboard.writeText` with a 1.5s
 * "Copied" confirmation. See docs/design/2026-05-06-polish-pass.md P1-6.
 */

import { useEffect, useRef, useState } from 'react';

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Some Electron contexts haven't granted clipboard permission yet —
      // fall back silently. The user can still cmd+C from the displayed value.
    }
  }

  return (
    <button
      type="button"
      className="ghost"
      onClick={() => { void copy(); }}
      aria-label={copied ? 'Copied' : `${label} ${value}`}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}
