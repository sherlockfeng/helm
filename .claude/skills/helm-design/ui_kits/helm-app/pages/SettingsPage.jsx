/* global React, Icons, Button, Card, Badge, IconButton, toast, Modal */
const { useState: useState_S } = React;

/**
 * Settings — proposed redesign.
 *
 * Real-code shape (helm/web/src/pages/Settings.tsx, 877 lines).
 * Actual h3 sections in order:
 *   1. Default engine
 *   2. HTTP API
 *   3. Lark integration
 *   4. Doc-first workflow
 *   5. Cursor (campaign summarization)
 *   6. Harness Conventions
 *   7. Knowledge lifecycle
 *   8. Depscope (knowledge provider)
 *   9. Storage plugins           ← LIFTED OUT in PR 5 → pages/Plugins.tsx
 *  10. Role subscriptions        ← LIFTED OUT in PR 5 → pages/Subscriptions.tsx
 *  11. Diagnostics
 *
 * Redesign deltas:
 *   - Move section nav into a left rail (T4 template); content max-width 640.
 *   - Auto-dismiss save banner already shipped (P1-8); reuse via Toaster.
 *   - "Storage plugins" + "Role subscriptions" sections replaced with a single
 *     breadcrumb card pointing at Knowledge → Plugins / Subscriptions.
 *   - Diagnostics: Copy button + Exporting… state already exist; ported here.
 *   - window.confirm for "Delete subscription" → moves to Subscriptions page (PR 5),
 *     uses Dialog primitive there.
 */

const KNOWN_CURSOR_MODELS = [
  { id: 'auto', label: 'auto (Cursor decides)' },
  { id: 'claude-4.7-opus', label: 'Claude Opus 4.7' },
  { id: 'claude-4.6-sonnet', label: 'Claude Sonnet 4.6' },
  { id: 'claude-4.5-haiku', label: 'Claude Haiku 4.5' },
  { id: 'gpt-5.1', label: 'GPT-5.1' },
];

const SECTIONS = [
  { id: 'engine',     label: 'Default engine' },
  { id: 'http',       label: 'HTTP API' },
  { id: 'lark',       label: 'Lark integration' },
  { id: 'docfirst',   label: 'Doc-first workflow' },
  { id: 'cursor',     label: 'Cursor' },
  { id: 'harness',    label: 'Harness conventions' },
  { id: 'knowledge',  label: 'Knowledge lifecycle' },
  { id: 'depscope',   label: 'Depscope' },
  { id: 'moved',      label: 'Plugins · Subscriptions' },
  { id: 'diag',       label: 'Diagnostics' },
];

function SettingsPage() {
  const [active, setActive] = useState_S('engine');
  const [exporting, setExporting] = useState_S(false);

  return (
    <main className="page">
      <header className="page-header">
        <div className="row1">
          <h1 className="page-title">Settings</h1>
          <span className="page-sub mono">~/.helm/config.json</span>
          <div className="page-actions">
            <Button>Revert</Button>
            <Button variant="primary" icon={Icons.Check} onClick={() => toast({ tone: 'success', title: 'Saved', body: 'Provider changes apply immediately; HTTP port needs a restart.' })}>Save</Button>
          </div>
        </div>
        <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
          Knowledge-provider changes apply immediately on save; HTTP port changes require a Helm restart.
        </p>
      </header>
      <div className="page-body workspace">
        <aside className="rail">
          {SECTIONS.map((s) => (
            <div
              key={s.id}
              className={`list-row${active === s.id ? ' active' : ''}`}
              onClick={() => setActive(s.id)}
            >
              {s.label}
              {s.id === 'moved' && <Badge tone="accent" style={{ marginLeft: 'auto' }}>moved</Badge>}
            </div>
          ))}
        </aside>
        <section className="content" style={{ maxWidth: 640 }}>
          {active === 'engine' && (
            <Card>
              <div className="h3">Default engine</div>
              <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
                Drives the Campaign summarizer, Harness reviewer, and Roles "Train via chat" modal.
                Takes effect on the next request — no restart.
              </p>
              <div className="row" style={{ gap: 8, marginTop: 8 }}>
                <select className="field" defaultValue="claude" style={{ maxWidth: 220 }}>
                  <option value="claude">claude</option>
                  <option value="gpt">gpt</option>
                </select>
              </div>
            </Card>
          )}
          {active === 'http' && (
            <Card>
              <div className="h3">HTTP API</div>
              <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
                Cursor + Claude Code talk to Helm via this port. Change requires a Helm restart.
              </p>
              <div className="row" style={{ gap: 8, marginTop: 8 }}>
                <input className="field" defaultValue="17317" style={{ maxWidth: 120, fontFamily: 'var(--font-mono)' }} />
                <Badge tone="success" dot>listening</Badge>
              </div>
            </Card>
          )}
          {active === 'lark' && (
            <Card>
              <div className="h3">Lark integration</div>
              <label className="row" style={{ marginTop: 6 }}>
                <input type="checkbox" defaultChecked /> Enable Lark mirror
              </label>
              <div className="h3" style={{ marginTop: 12, fontSize: 11 }}>CLI command</div>
              <input className="field mono" defaultValue="lark" style={{ marginTop: 4 }} />
              <p className="muted tiny" style={{ marginTop: 6 }}>Path or name; helm spawns this as a subprocess to send messages.</p>
            </Card>
          )}
          {active === 'docfirst' && (
            <Card>
              <div className="h3">Doc-first workflow</div>
              <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
                Helm rejects code edits until a <span className="mono">task.md</span> exists in <span className="mono">.harness/</span>.
              </p>
              <label className="row" style={{ marginTop: 6 }}>
                <input type="checkbox" defaultChecked /> Enabled
              </label>
            </Card>
          )}
          {active === 'cursor' && (
            <Card>
              <div className="h3">Cursor (campaign summarization)</div>
              <div className="h3" style={{ marginTop: 10, fontSize: 11 }}>Model</div>
              <select className="field" defaultValue="auto">
                {KNOWN_CURSOR_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                <option value="custom">Custom…</option>
              </select>
              <div className="h3" style={{ marginTop: 12, fontSize: 11 }}>API key</div>
              <input className="field" type="password" placeholder="sk-…" />
            </Card>
          )}
          {active === 'harness' && (
            <Card>
              <div className="h3">Harness conventions</div>
              <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>Stage names + task-id pattern. Persisted to <span className="mono">~/.helm/config.json</span>.</p>
              <div className="h3" style={{ marginTop: 12, fontSize: 11 }}>Stages</div>
              <input className="field mono" defaultValue="new_feature, implement, archived" />
            </Card>
          )}
          {active === 'knowledge' && (
            <Card>
              <div className="h3">Knowledge lifecycle</div>
              <div className="h3" style={{ marginTop: 10, fontSize: 11 }}>Auto-archive unused chunks after</div>
              <div className="row" style={{ gap: 6 }}>
                <input className="field" type="number" defaultValue="90" style={{ maxWidth: 90 }} />
                <span className="muted">days</span>
              </div>
              <div className="h3" style={{ marginTop: 12, fontSize: 11 }}>Candidate capture threshold</div>
              <select className="field" defaultValue="confident">
                <option value="aggressive">aggressive (more captures)</option>
                <option value="confident">confident</option>
                <option value="strict">strict (fewer captures)</option>
              </select>
            </Card>
          )}
          {active === 'depscope' && (
            <Card>
              <div className="h3">Depscope (knowledge provider)</div>
              <label className="row" style={{ marginTop: 6 }}>
                <input type="checkbox" /> Enable Depscope provider
              </label>
              <div className="h3" style={{ marginTop: 12, fontSize: 11 }}>Endpoint</div>
              <input className="field mono" placeholder="https://depscope.internal/api" />
              <div className="h3" style={{ marginTop: 12, fontSize: 11 }}>Mappings</div>
              <p className="muted tiny" style={{ marginTop: 0 }}>cwd prefix → SCM scope</p>
              <div className="row" style={{ gap: 6, marginTop: 6 }}>
                <input className="field mono" placeholder="~/code/tt-web" />
                <input className="field mono" placeholder="tiktok-web" />
                <IconButton icon={Icons.Trash2} label="Remove mapping" />
              </div>
              <Button size="sm" variant="ghost" icon={Icons.Plus} style={{ marginTop: 8 }}>Add mapping</Button>
            </Card>
          )}
          {active === 'moved' && (
            <>
              <Card variant="success">
                <div className="row">
                  <Icons.Cloud size={14} className="muted" />
                  <div className="col">
                    <div style={{ fontWeight: 600 }}>Role subscriptions moved</div>
                    <div className="muted tiny">Now lives under Knowledge → Subscriptions.</div>
                  </div>
                  <span className="spacer" />
                  <Button size="sm" icon={Icons.ArrowUpRight}>Open Subscriptions</Button>
                </div>
              </Card>
              <Card variant="success">
                <div className="row">
                  <Icons.Plug size={14} className="muted" />
                  <div className="col">
                    <div style={{ fontWeight: 600 }}>Storage plugins moved</div>
                    <div className="muted tiny">Now lives under Knowledge → Plugins.</div>
                  </div>
                  <span className="spacer" />
                  <Button size="sm" icon={Icons.ArrowUpRight}>Open Plugins</Button>
                </div>
              </Card>
              <p className="muted tiny" style={{ marginTop: 14 }}>
                These sections were lifted out of Settings in PR 5 because they're knowledge-management surfaces, not config.
                Bookmarks pointing at <span className="mono">/settings#subscriptions</span> still resolve to this page.
              </p>
            </>
          )}
          {active === 'diag' && (
            <Card>
              <div className="h3">Diagnostics</div>
              <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
                Export the structured log bundle for a bug report. Contains the last 24 h of logs, config (redacted), and DB schema.
              </p>
              <div className="row" style={{ gap: 8, marginTop: 8 }}>
                <Button
                  variant="primary"
                  icon={Icons.ArrowUpRight}
                  disabled={exporting}
                  onClick={() => {
                    setExporting(true);
                    setTimeout(() => { setExporting(false); toast({ tone: 'success', title: 'Bundle exported', body: '~/.helm/diagnostics-2026-05-17.tgz' }); }, 1200);
                  }}
                >
                  {exporting ? 'Exporting…' : 'Export bundle'}
                </Button>
              </div>
              <div className="h3" style={{ marginTop: 14, fontSize: 11 }}>Bundle path</div>
              <div className="row" style={{ gap: 6 }}>
                <span className="mono" style={{ fontSize: 12 }}>~/.helm/diagnostics-2026-05-17.tgz</span>
                <IconButton icon={Icons.Copy} label="Copy path" onClick={() => toast({ tone: 'success', title: 'Copied' })} />
              </div>
            </Card>
          )}
        </section>
      </div>
    </main>
  );
}

window.SettingsPage = SettingsPage;
