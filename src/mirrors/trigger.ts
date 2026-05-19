/**
 * Mirror sync trigger (Phase 80 / helm-design PR B).
 *
 * Module-level setter that decouples role mutation paths from the
 * MirrorRunner. The orchestrator installs the runner's `triggerSync`
 * callback at boot; mutation sites (trainRole / updateRole /
 * deleteChunkById / deleteSource) call `fireMirrorSync(roleId)`
 * fire-and-forget after a successful version bump.
 *
 * No bus, no async — same pattern as `setLifecycleSweepTrigger` from
 * Phase 77. Tests that drive the mutation paths directly without an
 * orchestrator see a no-op trigger (no global state to clean up).
 */

type MirrorSyncTrigger = (roleId: string) => void;

let mirrorSyncTrigger: MirrorSyncTrigger | null = null;

export function setMirrorSyncTrigger(trigger: MirrorSyncTrigger | null): void {
  mirrorSyncTrigger = trigger;
}

export function fireMirrorSync(roleId: string): void {
  if (!mirrorSyncTrigger) return;
  try {
    mirrorSyncTrigger(roleId);
  } catch (err) {
    // Triggers are fire-and-forget — a runner that throws while
    // scheduling a debounce must never break the underlying
    // train / update / drop call.
    // eslint-disable-next-line no-console
    console.warn('[mirrors/trigger] mirror sync trigger threw:', (err as Error).message);
  }
}
