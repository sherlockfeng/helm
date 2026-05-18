/* global React, Icons */
function Sidebar({ route, onNavigate, counts }) {
  const rows = [
    { group: 'Chats' },
    { key: 'chats',         label: 'Active',       icon: Icons.MessagesSquare, count: counts.chats },
    { key: 'bindings',      label: 'Bindings',     icon: Icons.Link2,          count: counts.bindings },
    { key: 'approvals',     label: 'Approvals',    icon: Icons.ShieldCheck,    count: counts.approvals },
    { group: 'Knowledge' },
    { key: 'roles',         label: 'Roles',        icon: Icons.BookOpen,       count: counts.roles },
    { key: 'subscriptions', label: 'Subscriptions',icon: Icons.Cloud,          count: counts.subscriptions },
    { key: 'plugins',       label: 'Plugins',      icon: Icons.Plug },
    { group: 'Work' },
    { key: 'harness',       label: 'Harness',      icon: Icons.Workflow,       count: counts.harness },
    { spacer: true },
    { key: 'settings',      label: 'Settings',     icon: Icons.Settings },
  ];
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="word">Helm</div>
      </div>
      {rows.map((r, i) => {
        if (r.group) return <div className="group" key={`g${i}`}>{r.group}</div>;
        if (r.spacer) return <div className="spacer" key={`s${i}`} />;
        const Ic = r.icon;
        const active = route === r.key;
        return (
          <div
            key={r.key}
            className={`nav-row${active ? ' active' : ''}`}
            onClick={() => onNavigate(r.key)}
            role="link"
            tabIndex={0}
          >
            <Ic size={16} className="ic" />
            {r.label}
            {r.count != null ? <span className="count">{r.count}</span> : null}
          </div>
        );
      })}
      <div className="foot">
        <span className="mono">v0.79</span>
        <span className="spacer" />
        <span className="mono">∙ local</span>
      </div>
    </aside>
  );
}

window.Sidebar = Sidebar;
