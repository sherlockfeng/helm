/* global React, Icons, Button, Card, Badge, StatTile */
function PluginsPage() {
  const plugins = [
    { id: 'p1', name: '@helm/tos-plugin', kind: 'storage', state: 'enabled' },
    { id: 'p2', name: '@helm/oss-plugin', kind: 'storage', state: 'disabled' },
    { id: 'p3', name: '@helm/lark-mirror', kind: 'IM',      state: 'enabled' },
  ];
  return (
    <main className="page">
      <header className="page-header">
        <div className="row1">
          <h1 className="page-title">Plugins</h1>
          <span className="page-sub">Pluggable storage + IM backends</span>
        </div>
      </header>
      <div className="page-body" style={{ maxWidth: 760, margin: '0 auto', width: '100%' }}>
        {plugins.map((p) => (
          <Card key={p.id}>
            <div className="row">
              <Icons.Plug size={16} className="muted" />
              <div className="col">
                <div style={{ fontWeight: 600 }}>{p.name}</div>
                <div className="tiny mono">{p.kind}</div>
              </div>
              <span className="spacer" />
              {p.state === 'enabled' ? <Badge tone="success" dot>enabled</Badge> : <Badge>disabled</Badge>}
              <Button size="sm">{p.state === 'enabled' ? 'Disable' : 'Enable'}</Button>
            </div>
          </Card>
        ))}
      </div>
    </main>
  );
}
window.PluginsPage = PluginsPage;
