/* global React, Icons, Button, Card, Badge, StatTile, Tabs, toast */
const { useState: useState_H } = React;

function HarnessPage() {
  const tasks = {
    new_feature: [
      { id: 't1', title: 'subscriptions: surface bundle versions in row', meta: 'no chat bound', age: '2 d' },
      { id: 't2', title: 'roles: combobox for "+ Add role"', meta: 'bound · helm subscriptions', age: '4 h' },
    ],
    implement: [
      { id: 't3', title: 'approvals: card variants + accent bar', meta: 'bound · approvals UI', age: '6 h' },
    ],
    archived: [
      { id: 't4', title: 'sidebar: KNOWLEDGE group', meta: 'shipped 0.79', age: '3 d' },
    ],
  };
  const [stage, setStage] = useState_H('new_feature');
  const list = tasks[stage];

  return (
    <main className="page">
      <header className="page-header">
        <div className="row1">
          <h1 className="page-title">Harness</h1>
          <span className="page-sub">Local task workflow</span>
          <div className="page-actions">
            <Button variant="default" icon={Icons.Play}>Run review</Button>
            <Button variant="primary" icon={Icons.Plus}>New task</Button>
          </div>
        </div>
        <div className="stat-strip">
          <StatTile label="new_feature" value="2" />
          <StatTile label="implement" value="1" delta="bound · cursor" />
          <StatTile label="archived" value="1" />
          <StatTile label="Reviews today" value="3" delta="all passed" deltaTone="up" />
        </div>
      </header>
      <div className="page-body" style={{ maxWidth: 880, margin: '0 auto', width: '100%' }}>
        <Tabs
          value={stage}
          onChange={setStage}
          items={[
            { value: 'new_feature', label: 'new_feature', count: tasks.new_feature.length },
            { value: 'implement',   label: 'implement',   count: tasks.implement.length },
            { value: 'archived',    label: 'archived',    count: tasks.archived.length },
          ]}
        />
        <div className="col" style={{ gap: 10, marginTop: 14 }}>
          {list.map((t) => (
            <Card key={t.id} interactive>
              <div className="row">
                <Icons.FileText size={14} className="muted" />
                <div className="col" style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{t.title}</div>
                  <div className="tiny mono">.harness/tasks/{t.id}/task.md · {t.meta}</div>
                </div>
                <Badge>{t.age}</Badge>
                <Button size="sm" variant="default" icon={Icons.Play} onClick={() => toast({ tone: 'success', title: 'Review spawned', body: t.title })}>Review</Button>
                <Button size="sm" variant="default" icon={Icons.Link2}>Bind chat</Button>
              </div>
            </Card>
          ))}
          {list.length === 0 && <EmptyState title="No tasks at this stage" body="New tasks created in .harness/tasks/ appear here." />}
        </div>
      </div>
    </main>
  );
}

window.HarnessPage = HarnessPage;
