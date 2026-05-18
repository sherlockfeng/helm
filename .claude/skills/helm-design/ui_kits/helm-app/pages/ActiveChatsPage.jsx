/* global React, Icons, Button, Card, Badge, StatTile, IconButton, Tabs, toast, Modal */
const { useState: useState_AC } = React;

/**
 * Active Chats — proposed redesign.
 *
 * Real-code shape (helm/web/src/pages/Chats.tsx, 802 lines):
 *   - PageHeader: title, description, 3 stats (Chats / Queued msgs / Lark mirrored)
 *   - 2-col `.helm-rail-layout` (rail + content)
 *   - Detail pane shows:
 *       - host label (caps mono) + editable chat title + cwd · session shortId
 *       - last-seen status pill + optional queued-msg badge
 *       - Roles row: chips with ✕ remove, "+ Add role" <select>
 *       - Actions row: Mirror to Lark · Close · Delete (cascade)
 *
 * Redesign deltas:
 *   - 3rd column: Inspector (knowledge + recent approvals for this chat).
 *   - "+ Add role" <select> → searchable Combobox.
 *   - window.confirm for Close/Delete → Dialog primitive (one combined dialog
 *     with two action variants: "Close (history kept)" + "Delete (cascade)").
 *   - Mirror to Lark inline modal → Dialog primitive.
 *   - Queued-msg badge → Badge tone="warn" (drop the 📨 emoji per ICONOGRAPHY).
 */

const CHATS = [
  {
    id: 'c1',
    host: 'cursor',
    label: 'dr-dashboard refactor',
    cwd: '~/code/dr-dashboard',
    sessionShort: 'a4d9c2f1e8b3…',
    roles: ['dr-dashboard'],
    larkBound: true,
    larkThread: 'om_4128',
    queued: 0,
    lastSeen: '4s',
  },
  {
    id: 'c2',
    host: 'cursor',
    label: 'helm subscriptions',
    cwd: '~/code/helm',
    sessionShort: 'c7a9b3e0d4f1…',
    roles: ['helm-core', 'Goofy 专家'],
    larkBound: false,
    queued: 2,
    lastSeen: '12s',
  },
  {
    id: 'c3',
    host: 'cursor',
    label: 'goofy export bundle',
    cwd: '~/code/goofy',
    sessionShort: 'd0b1e7c3a9f4…',
    roles: ['Goofy 专家'],
    larkBound: false,
    queued: 0,
    lastSeen: '34m',
  },
];
const ALL_ROLES = ['helm-core', 'Goofy 专家', 'dr-dashboard', 'developer', 'product', 'tester'];

function ActiveChatsPage() {
  const [activeId, setActiveId] = useState_AC('c2');
  const [titleEdit, setTitleEdit] = useState_AC(false);
  const [closeOpen, setCloseOpen] = useState_AC(false);
  const [mirrorOpen, setMirrorOpen] = useState_AC(false);
  const [addRoleOpen, setAddRoleOpen] = useState_AC(false);
  const chat = CHATS.find((c) => c.id === activeId);
  const addable = chat ? ALL_ROLES.filter((r) => !chat.roles.includes(r)) : [];

  return (
    <main className="page">
      <header className="page-header">
        <div className="row1">
          <h1 className="page-title">Active Chats</h1>
          <span className="page-sub">Cursor sessions Helm is observing</span>
        </div>
        <p style={{ margin: '0 0 14px', color: 'var(--text-secondary)', maxWidth: 720 }}>
          Bind a role to inject its prompt + knowledge on the next session start.
        </p>
        <div className="stat-strip">
          <StatTile label="Chats" value={CHATS.length} delta="+1 today" deltaTone="up" />
          <StatTile label="Queued msgs" value="2" delta="from Lark" deltaTone="warn" />
          <StatTile label="Lark mirrored" value="1" delta="of 3 chats" />
          <StatTile label="Last activity" value="4 s" delta="cursor responded" />
        </div>
      </header>
      <div className="page-body workspace with-inspector">
        {/* Rail */}
        <aside className="rail">
          <div className="h3" style={{ marginBottom: 8 }}>Chats</div>
          {CHATS.map((c) => (
            <Card
              key={c.id}
              interactive
              selected={activeId === c.id}
              onClick={() => setActiveId(c.id)}
              style={{ padding: '10px 12px' }}
            >
              <div style={{ fontWeight: 600, fontSize: 13 }}>{c.label}</div>
              <div className="tiny mono" style={{ marginTop: 2 }}>{c.cwd}</div>
              <div className="row" style={{ marginTop: 8, gap: 6, flexWrap: 'wrap' }}>
                {c.larkBound ? <Badge tone="success" dot>Lark</Badge> : null}
                {c.queued > 0 ? <Badge tone="warn">{c.queued} queued</Badge> : null}
                <span className="tiny mono" style={{ marginLeft: 'auto', color: 'var(--text-tertiary)' }}>{c.lastSeen}</span>
              </div>
            </Card>
          ))}
        </aside>

        {/* Content */}
        <section className="content">
          {chat ? (
            <>
              <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
                <div className="col" style={{ minWidth: 0, flex: 1 }}>
                  <div className="t-mono caps" style={{
                    font: '500 11px/14px var(--font-mono)',
                    color: 'var(--text-secondary)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    marginBottom: 4,
                  }}>{chat.host}</div>
                  {titleEdit ? (
                    <input
                      className="field"
                      defaultValue={chat.label}
                      autoFocus
                      onBlur={() => setTitleEdit(false)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') setTitleEdit(false); }}
                      style={{ maxWidth: 360, fontWeight: 600, fontSize: 14 }}
                    />
                  ) : (
                    <div className="row" style={{ gap: 4 }}>
                      <span style={{ fontWeight: 600, fontSize: 14 }}>{chat.label}</span>
                      <IconButton icon={Icons.Sparkles} label="Rename" onClick={() => setTitleEdit(true)} />
                    </div>
                  )}
                  <div className="tiny mono" style={{ marginTop: 6 }}>
                    {chat.cwd} · session <span style={{ color: 'var(--text)' }}>{chat.sessionShort}</span>
                  </div>
                </div>
                <div className="col" style={{ alignItems: 'flex-end', gap: 6 }}>
                  <Badge tone="success" dot>last seen {chat.lastSeen}</Badge>
                  {chat.queued > 0 && <Badge tone="warn">{chat.queued} queued from Lark</Badge>}
                </div>
              </div>
              <div className="divider" />

              {/* Roles section */}
              <div className="row" style={{ marginBottom: 8 }}>
                <div className="h3" style={{ margin: 0 }}>Roles</div>
                <span className="spacer" />
              </div>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                {chat.roles.length === 0 ? (
                  <span className="muted tiny">(none — no auto-inject on next session_start)</span>
                ) : chat.roles.map((r) => (
                  <Badge key={r} tone="accent">
                    {r}
                    <Icons.X size={11} style={{ marginLeft: 4, cursor: 'pointer', opacity: 0.7 }} />
                  </Badge>
                ))}
                {addable.length > 0 && (
                  <Button size="sm" variant="ghost" icon={Icons.Plus} onClick={() => setAddRoleOpen(true)}>
                    Add role
                  </Button>
                )}
              </div>

              <div className="divider" />

              {/* Lark mirror section */}
              <div className="row" style={{ marginBottom: 8 }}>
                <div className="h3" style={{ margin: 0 }}>Lark mirror</div>
                <span className="spacer" />
                {chat.larkBound
                  ? <Badge tone="success" dot>bound · thread {chat.larkThread}</Badge>
                  : <Badge>not bound</Badge>}
              </div>
              <Card variant={!chat.larkBound ? null : null}>
                <div className="row">
                  <Icons.ArrowLeftRight size={14} className="muted" />
                  <div className="col">
                    <div style={{ fontWeight: 500 }}>
                      {chat.larkBound ? 'Messages flow both directions' : 'Mirror to a Lark thread to review remotely'}
                    </div>
                    <div className="tiny mono">
                      {chat.larkBound
                        ? `${chat.larkThread} · cursor → lark and lark → cursor`
                        : 'Cursor responses + role injections will be posted to the bound thread.'}
                    </div>
                  </div>
                  <span className="spacer" />
                  <Button variant={chat.larkBound ? 'default' : 'primary'} icon={Icons.ArrowLeftRight} onClick={() => setMirrorOpen(true)}>
                    {chat.larkBound ? 'Edit mirror' : 'Mirror to Lark…'}
                  </Button>
                </div>
              </Card>

              {/* Actions row */}
              <div className="divider" />
              <div className="row" style={{ gap: 8 }}>
                <span className="spacer" />
                <Button variant="default" icon={Icons.X} onClick={() => setCloseOpen('close')}>Close</Button>
                <Button variant="danger" icon={Icons.Trash2} onClick={() => setCloseOpen('delete')}>Delete</Button>
              </div>
            </>
          ) : <div className="empty"><Icons.Glyph size={48} /><div className="title">Pick a chat</div></div>}
        </section>

        {/* Inspector — proposed NEW column */}
        <aside className="inspector">
          <div className="h3">Knowledge in this chat</div>
          {chat?.roles.map((r) => (
            <div className="list-row" key={r} style={{ padding: '6px 8px' }}>
              <Icons.BookOpen size={14} />
              <div className="col">
                <div style={{ fontWeight: 500 }}>{r}</div>
                <div className="tiny mono">8 chunks · used 4 h ago</div>
              </div>
            </div>
          ))}
          <div className="divider" />
          <div className="h3">Recent approvals</div>
          <div className="list-row" style={{ padding: '6px 8px' }}>
            <span className="dot" style={{ background: 'var(--success)' }} />
            <div className="col">
              <div>Allowed <span className="mono">git status</span></div>
              <div className="tiny mono">2 min ago</div>
            </div>
          </div>
          <div className="list-row" style={{ padding: '6px 8px' }}>
            <span className="dot" style={{ background: 'var(--danger)' }} />
            <div className="col">
              <div>Denied <span className="mono">rm -rf .vite</span></div>
              <div className="tiny mono">8 min ago</div>
            </div>
          </div>
        </aside>
      </div>

      {/* Close / Delete modal — replaces window.confirm at Chats.tsx:148 */}
      <Modal
        open={!!closeOpen}
        onClose={() => setCloseOpen(false)}
        title={closeOpen === 'delete' ? 'Permanently delete this chat?' : 'Close this chat?'}
        actions={<>
          <Button onClick={() => setCloseOpen(false)}>Cancel</Button>
          <Button
            variant="danger"
            onClick={() => {
              const verb = closeOpen === 'delete' ? 'Deleted' : 'Closed';
              setCloseOpen(false);
              toast({ tone: 'warn', title: verb, body: chat?.label });
            }}
          >
            {closeOpen === 'delete' ? 'Delete (cascade)' : 'Close'}
          </Button>
        </>}
      >
        <p>
          {closeOpen === 'delete'
            ? 'The session row, its bindings, and any queued Lark messages will be removed.'
            : "It'll disappear from this list but the row + bindings stay for history."}
        </p>
      </Modal>

      {/* Mirror to Lark modal — replaces the inline modal at Chats.tsx:~358 */}
      <Modal
        open={mirrorOpen}
        onClose={() => setMirrorOpen(false)}
        title="Mirror to a Lark thread"
        actions={<>
          <Button onClick={() => setMirrorOpen(false)}>Cancel</Button>
          <Button variant="primary" icon={Icons.ArrowLeftRight} onClick={() => {
            setMirrorOpen(false);
            toast({ tone: 'success', title: 'Bind code generated', body: 'BIND-9F3C · send to your Lark thread' });
          }}>Generate code</Button>
        </>}
      >
        <p>helm will issue a 6-letter bind code. Paste it into the Lark thread you want this chat to mirror to.</p>
        <div className="h3" style={{ marginTop: 14, marginBottom: 6 }}>Optional annotation</div>
        <input className="field" placeholder='e.g. "0.79 release"' />
        <p className="muted tiny" style={{ marginTop: 6 }}>Stored on the binding so you can recognize it in the Bindings list.</p>
      </Modal>

      {/* Add role combobox */}
      <Modal
        open={addRoleOpen}
        onClose={() => setAddRoleOpen(false)}
        title="Add a role"
        actions={<>
          <Button onClick={() => setAddRoleOpen(false)}>Cancel</Button>
        </>}
      >
        <p>Bound roles inject on the next <span className="mono">session_start</span>.</p>
        <input className="field" placeholder="Search roles…" autoFocus style={{ marginTop: 12 }} />
        <div style={{ marginTop: 8, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
          {addable.map((r, i) => (
            <div
              key={r}
              className={`list-row${i === 0 ? ' active' : ''}`}
              style={{ borderRadius: 0, padding: '8px 10px' }}
              onClick={() => { setAddRoleOpen(false); toast({ tone: 'success', title: 'Role added', body: r }); }}
            >
              <Icons.BookOpen size={14} />
              <span style={{ fontWeight: 500 }}>{r}</span>
              <span className="spacer" />
              <span className="tiny mono">8 chunks</span>
            </div>
          ))}
        </div>
      </Modal>
    </main>
  );
}

window.ActiveChatsPage = ActiveChatsPage;
