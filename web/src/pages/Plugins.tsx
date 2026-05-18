/**
 * Plugins page — placeholder shell (helm-design PR 4).
 *
 * The functional <StoragePluginsCard> currently lives in Settings.tsx.
 * PR 5 moves the real implementation here verbatim and replaces this
 * stub. For now this page exists only so the /plugins route resolves
 * and the new sidebar entry doesn't dead-link.
 */

export function PluginsPage() {
  return (
    <>
      <h2>Plugins</h2>
      <p className="muted">
        Helm's pluggable transports — Lark relay, TOS storage, dependency
        knowledge providers, etc. Moving here from Settings in the next PR.
      </p>
      <p className="muted">
        For now, manage plugins under <a href="/settings">Settings</a>.
      </p>
    </>
  );
}
