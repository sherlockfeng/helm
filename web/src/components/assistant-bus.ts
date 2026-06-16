/**
 * Tiny module-level bus so anywhere in the app can pop open the global
 * AssistantWidget — optionally pre-seeded with a first user message (e.g. a
 * topic card's "让助手整理" button). The widget registers a single listener on
 * mount; callers fire `openAssistant(seed?)`. Deliberately not a Context so
 * non-React call sites (and deep page components) can trigger it without
 * threading props.
 */
type OpenListener = (seed?: string) => void;

let listener: OpenListener | null = null;

/** Open the assistant. If `seed` is given, it's sent as the first user turn. */
export function openAssistant(seed?: string): void {
  listener?.(seed);
}

/** Widget registers here on mount; returns an unsubscribe. */
export function onOpenAssistant(fn: OpenListener): () => void {
  listener = fn;
  return () => { if (listener === fn) listener = null; };
}
