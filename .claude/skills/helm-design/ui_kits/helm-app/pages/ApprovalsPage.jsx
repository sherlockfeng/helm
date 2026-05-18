/* global React, Icons, Button, Card, Badge, StatTile, toast, IconButton, Modal */
const { useState } = React;

function ApprovalsPage() {
  const [items, setItems] = useState([
    { id: 'a1', tool: 'run_shell_command', host: 'cursor', cmd: 'git push origin main --force-with-lease', ageS: 4, ttlS: 26, tone: 'warn' },
    { id: 'a2', tool: 'write_file',        host: 'cursor', cmd: 'web/src/styles/app.css (1.4 KB)',           ageS: 12, ttlS: 48 },
    { id: 'a3', tool: 'run_shell_command', host: 'claude-code', cmd: 'rm -rf node_modules/.vite', ageS: 22, ttlS: 8, tone: 'danger' },
  ]);
  const decide = (id, verdict) => {
    setItems((xs) => xs.filter((x) => x.id !== id));
    toast({ tone: verdict === 'allow' ? 'success' : 'warn', title: verdict === 'allow' ? 'Allowed' : 'Denied', body: `Approval ${id}` });
  };

  return (
    <main className="page">
      <header className="page-header">
        <div className="row1">
          <h1 className="page-title">Approvals</h1>
          <span className="page-sub">{items.length} pending</span>
          <div className="page-actions">
            <Button variant="default" icon={Icons.Settings}>Approval rules</Button>
          </div>
        </div>
        <div className="stat-strip">
          <StatTile label="Pending" value={items.length} delta={items.some(i => i.tone === 'warn') ? '1 expiring' : '—'} deltaTone="warn" />
          <StatTile label="Allowed today" value="14" delta="+3 since 9 AM" deltaTone="up" />
          <StatTile label="Denied today" value="2" delta="last 12 min ago" />
          <StatTile label="Auto-policies" value="6" delta="2 commands · 4 paths" />
        </div>
      </header>
      <div className="page-body" style={{ maxWidth: 760, margin: '0 auto', width: '100%' }}>
        {items.length === 0 ? (
          <div style={{ marginTop: 40 }}>
            <EmptyState
              title="Nothing waiting."
              body="Approvals appear here when an agent asks before running a tool."
            />
          </div>
        ) : (
          items.map((it) => (
            <Card key={it.id} variant={it.tone}>
              <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                <Badge tone="accent">{it.host}</Badge>
                <div className="col" style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{it.host} → {it.tool}</div>
                  <pre className="code" style={{ marginTop: 6 }}>{it.cmd}</pre>
                  <div className="tiny" style={{ marginTop: 8 }}>
                    requested <span className="mono">{it.ageS} s</span> ago · expires in{' '}
                    <span className="mono" style={{ color: it.tone === 'danger' ? 'var(--danger)' : it.tone === 'warn' ? 'var(--warn)' : 'var(--text-secondary)' }}>{it.ttlS} s</span>
                  </div>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <Button variant="default" icon={Icons.X} onClick={() => decide(it.id, 'deny')}>Deny</Button>
                  <Button variant="primary" icon={Icons.Check} onClick={() => decide(it.id, 'allow')}>Allow</Button>
                </div>
              </div>
            </Card>
          ))
        )}
      </div>
    </main>
  );
}

window.ApprovalsPage = ApprovalsPage;
