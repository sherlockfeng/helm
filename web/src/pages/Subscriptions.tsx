/**
 * Subscriptions page — placeholder shell (helm-design PR 4).
 *
 * The functional <RoleSubscriptionsCard> currently lives in Settings.tsx.
 * PR 5 moves the real implementation here verbatim and replaces this
 * stub. For now this page exists only so the /subscriptions route
 * resolves and the new sidebar entry doesn't dead-link.
 */

export function SubscriptionsPage() {
  return (
    <>
      <h2>Subscriptions</h2>
      <p className="muted">
        Remote <code>.helmrole</code> bundles that polled cron syncs into
        role candidates. Moving here from Settings in the next PR.
      </p>
      <p className="muted">
        For now, manage subscriptions under <a href="/settings">Settings</a>.
      </p>
    </>
  );
}
