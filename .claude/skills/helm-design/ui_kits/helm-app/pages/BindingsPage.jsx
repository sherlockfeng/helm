/* global React, Icons, Button, Card, Badge, StatTile, IconButton, toast, Modal */
const { useState: useState_B } = React;

/**
 * Bindings — proposed redesign.
 *
 * Real-code shape (helm/web/src/pages/Bindings.tsx):
 *   - h2 "Bindings" + description paragraph
 *   - h3 "Pending" + cards. Each pending card shows: channel name, code (mono),
 *     optional external chat/thread, expires-in warn pill, a `<select>` of
 *     active Cursor chats + Bind + Cancel buttons.
 *   - h3 "Active" + cards. Each active card shows: channel · label, chat label,
 *     cwd · session shortId, optional externalChat/thread, Unbind button.
 *
 * Redesign deltas:
 *   - PageHeader with title + description + stat strip (4 tiles).
 *   - `<select>` for chat picker → searchable Combobox (cmdk).
 *   - `window.confirm` for Cancel pending → Dialog primitive.
 *   - Pending cards get `variant="warn"` (left accent bar).
 *   - Card variants stay default for Active rows.
 */

const PENDING = [
  {
    code: 'BIND-7F4A',
    channel: 'lark',
    externalChat: 'oc_a7c…helm-cockpit',
    externalThread: 'om_4128',
    expiresIn: '6m',
  },
  {
    code: 'BIND-2C19',
    channel: 'lark',
    externalChat: 'oc_b91…dr-dashboard',
    externalThread: null,
    expiresIn: '54s',
    expiring: true,
  },
];

const ACTIVE = [
  {
    id: 'b1',
    channel: 'lark',
    label: '0.79 release',
    chatLabel: 'helm subscriptions',
    cwd: '~/code/helm',
    sessionShort: 'c7a9b3e0d4f1…',
    externalChat: 'oc_a7c…helm-cockpit',
    externalThread: 'om_4128',
  },
  {
    id: 'b2',
    channel: 'lark',
    label: 'refactor',
    chatLabel: 'dr-dashboard refactor',
    cwd: '~/code/dr-dashboard',
    sessionShort: 'f0b1c5e2a8d3…',
    externalChat: 'oc_b91…dr-dashboard',
    externalThread: null,
  },
];

const CURSOR_CHATS = [
  { id: 'cs-1', label: 'helm subscriptions', cwd: '~/code/helm' },
  { id: 'cs-2', label: 'dr-dashboard refactor', cwd: '~/code/dr-dashboard' },
  { id: 'cs-3', label: 'goofy export bundle', cwd: '~/code/goofy' },
];

function BindingsPage() {
  const [bindOpen, setBindOpen] = useState_B(null);     // pending code being bound
  const [cancelOpen, setCancelOpen] = useState_B(null); // pending code being cancelled
  const [unbindOpen, setUnbindOpen] = useState_B(null); // active binding id being unbound

  return (
    <main className="page">
      <header className="page-header">
        <div className="row1">
          <h1 className="page-title">Bindings</h1>
          <span className="page-sub">Cursor chats ↔ Lark threads</span>
        </div>
        <p style={{ margin: '0 0 14px', color: 'var(--text-secondary)', maxWidth: 720 }}>
          Connect a Cursor chat to a remote channel thread. Send <span className="mono" style={{ color: 'var(--text)' }}>@bot bind chat</span> in
          Lark to generate a code, then pick the chat to mirror here.
        </p>
        <div className="stat-strip">
          <StatTile label="Active" value={ACTIVE.length} />
          <StatTile label="Pending" value={PENDING.length} delta={PENDING.some(p => p.expiring) ? '1 expiring' : '—'} deltaTone={PENDING.some(p => p.expiring) ? 'warn' : 'muted'} />
          <StatTile label="Mirrored msgs" value="142" delta="today" />
          <StatTile label="Last mirror" value="4 s" />
        </div>
      </header>
      <div className="page-body" style={{ maxWidth: 720, margin: '0 auto', width: '100%' }}>
        {/* Pending section */}
        <div className="h3" style={{ marginTop: 4 }}>Pending</div>
        {PENDING.length === 0 ? (
          <Card><div className="muted">No pending bind codes. Send <span className="mono">@bot bind chat</span> in a Lark thread.</div></Card>
        ) : (
          PENDING.map((p) => (
            <Card key={p.code} variant="warn">
              <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
                <div className="col" style={{ minWidth: 0, flex: 1 }}>
                  <div className="t-mono caps" style={{
                    font: '500 11px/14px var(--font-mono)',
                    color: 'var(--text-secondary)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    marginBottom: 4,
                  }}>{p.channel}</div>
                  <div style={{ fontWeight: 600, fontSize: 14, fontFamily: 'var(--font-mono)' }}>{p.code}</div>
                  {p.externalChat && (
                    <div className="tiny mono" style={{ marginTop: 6 }}>
                      chat {p.externalChat}{p.externalThread ? ` / thread ${p.externalThread}` : ''}
                    </div>
                  )}
                </div>
                <Badge tone="warn" dot>expires in {p.expiresIn}</Badge>
              </div>
              <div className="row" style={{ marginTop: 12, gap: 8 }}>
                <Button variant="primary" icon={Icons.Link2} onClick={() => setBindOpen(p)}>
                  Bind to chat…
                </Button>
                <Button variant="danger" icon={Icons.X} onClick={() => setCancelOpen(p)}>
                  Cancel
                </Button>
              </div>
            </Card>
          ))
        )}

        {/* Active section */}
        <div className="h3" style={{ marginTop: 24 }}>Active</div>
        {ACTIVE.length === 0 ? (
          <Card><div className="muted">No active bindings.</div></Card>
        ) : (
          ACTIVE.map((b) => (
            <Card key={b.id}>
              <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
                <div className="col" style={{ minWidth: 0, flex: 1 }}>
                  <div className="t-mono caps" style={{
                    font: '500 11px/14px var(--font-mono)',
                    color: 'var(--text-secondary)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    marginBottom: 4,
                  }}>
                    {b.channel}{b.label ? ` · "${b.label}"` : ''}
                  </div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{b.chatLabel}</div>
                  <div className="tiny mono" style={{ marginTop: 6 }}>
                    {b.cwd} · session <span style={{ color: 'var(--text)' }}>{b.sessionShort}</span>
                  </div>
                  <div className="tiny mono" style={{ marginTop: 4 }}>
                    {b.channel}: {b.externalChat}{b.externalThread ? ` / ${b.externalThread}` : ''}
                  </div>
                </div>
                <Badge tone="success" dot>bound</Badge>
                <Button variant="danger" icon={Icons.X} onClick={() => setUnbindOpen(b)}>
                  Unbind
                </Button>
              </div>
            </Card>
          ))
        )}
      </div>

      {/* Bind-to-chat modal */}
      <Modal
        open={!!bindOpen}
        onClose={() => setBindOpen(null)}
        title={`Bind ${bindOpen?.code} to a Cursor chat`}
        actions={<>
          <Button onClick={() => setBindOpen(null)}>Cancel</Button>
          <Button variant="primary" icon={Icons.Link2} onClick={() => {
            setBindOpen(null);
            toast({ tone: 'success', title: 'Bound', body: `${bindOpen.code} → helm subscriptions` });
          }}>Bind</Button>
        </>}
      >
        <p>helm will mirror messages between this Lark thread and the selected Cursor chat.</p>
        <div className="h3" style={{ marginTop: 14, marginBottom: 6 }}>Cursor chat</div>
        <input className="field" placeholder="Search chats…" autoFocus />
        <div style={{ marginTop: 8, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
          {CURSOR_CHATS.map((c, i) => (
            <div
              key={c.id}
              className={`list-row${i === 0 ? ' active' : ''}`}
              style={{ borderRadius: 0, padding: '8px 10px' }}
            >
              <Icons.MessagesSquare size={14} />
              <div className="col">
                <div style={{ fontWeight: 500 }}>{c.label}</div>
                <div className="tiny mono">{c.cwd}</div>
              </div>
            </div>
          ))}
        </div>
      </Modal>

      {/* Cancel-pending modal (replaces window.confirm at Bindings.tsx:100) */}
      <Modal
        open={!!cancelOpen}
        onClose={() => setCancelOpen(null)}
        title={`Cancel pending bind code ${cancelOpen?.code}?`}
        actions={<>
          <Button onClick={() => setCancelOpen(null)}>Keep</Button>
          <Button variant="danger" onClick={() => {
            setCancelOpen(null);
            toast({ tone: 'warn', title: 'Cancelled', body: cancelOpen.code });
          }}>Discard code</Button>
        </>}
      >
        <p>This discards the code without binding. The user will need to send <span className="mono">@bot bind chat</span> again to get a new one.</p>
      </Modal>

      {/* Unbind modal */}
      <Modal
        open={!!unbindOpen}
        onClose={() => setUnbindOpen(null)}
        title="Unbind this binding?"
        actions={<>
          <Button onClick={() => setUnbindOpen(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => {
            setUnbindOpen(null);
            toast({ tone: 'warn', title: 'Unbound', body: unbindOpen.chatLabel });
          }}>Unbind</Button>
        </>}
      >
        <p>Messages will stop mirroring. The chat and Lark thread both stay; you can re-bind later with a new code.</p>
      </Modal>
    </main>
  );
}

window.BindingsPage = BindingsPage;
