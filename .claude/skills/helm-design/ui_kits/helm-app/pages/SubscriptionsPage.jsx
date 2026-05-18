/* global React, Icons, Button, Card, Badge, StatTile, toast, IconButton */
function SubscriptionsPage() {
  const subs = [
    { id: 's1', name: 'dr-dashboard@bundle.tos', version: 'v0.4.2', state: 'synced', last: '2 min ago' },
    { id: 's2', name: 'Goofy@bundle.tos', version: 'v1.12.0', state: 'syncing', last: 'now' },
    { id: 's3', name: 'helm-core@bundle.tos', version: 'v0.79',  state: 'failed', last: '12 s ago' },
  ];
  return (
    <main className="page">
      <header className="page-header">
        <div className="row1">
          <h1 className="page-title">Subscriptions</h1>
          <span className="page-sub">Roles imported from TOS bundles</span>
          <div className="page-actions">
            <Button icon={Icons.Plus} variant="primary">Subscribe</Button>
          </div>
        </div>
        <div className="stat-strip">
          <StatTile label="Subscribed" value="3" />
          <StatTile label="Synced" value="1" delta="2 stale" />
          <StatTile label="Last poll" value="34 s" />
          <StatTile label="Storage" value="TOS" delta="via @helm/tos-plugin" />
        </div>
      </header>
      <div className="page-body" style={{ maxWidth: 760, margin: '0 auto', width: '100%' }}>
        {subs.map((s) => (
          <Card key={s.id} variant={s.state === 'failed' ? 'danger' : null}>
            <div className="row">
              <Icons.Cloud size={16} className="muted" />
              <div className="col" style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{s.name}</div>
                <div className="tiny mono">{s.version} · last sync {s.last}</div>
              </div>
              <span className="spacer" />
              {s.state === 'synced'  ? <Badge tone="success" dot>synced</Badge> :
               s.state === 'syncing' ? <Badge tone="accent">syncing…</Badge> :
                                       <Badge tone="danger" dot>failed</Badge>}
              <Button size="sm">Resync</Button>
              <IconButton icon={Icons.Trash2} label="Unsubscribe" />
            </div>
          </Card>
        ))}
      </div>
    </main>
  );
}
window.SubscriptionsPage = SubscriptionsPage;
