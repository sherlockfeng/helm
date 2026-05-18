/* global React, Icons, Button, Card, Badge, StatTile, Tabs, IconButton, toast, Modal */
const { useState: useState_R } = React;

/**
 * Roles page — proposed redesign.
 *
 * Mirrors the actual helm Roles shape (see real screenshot 2026-05-17):
 *   - Page header w/ title + description + primary CTA inline ("+ Train a new role via chat")
 *   - Collapsible disclosure: train from CLI/IDE chat
 *   - List of role cards. Each card:
 *       row 1: BUILT-IN/CUSTOM · ROLE-ID (caps, mono, secondary)         · dot+chunk count   · Update? · Show
 *       row 2: Title (semibold 14)
 *       row 3: Description (2-line clamp, secondary)
 *
 * Detail (when a role is expanded via "Show") opens a rail+content view
 * inline below the card with the Chunks / Sources / Candidates / Archive tabs.
 */

const ROLES = [
  {
    id: 'developer',
    kind: 'built-in',
    name: 'Developer Agent',
    chunks: 0,
    candidates: 0,
    description: 'You are the Developer Agent in a vibe coding loop. Your role is to implement tasks assigned by the Product Agent. ## Your responsibilities …',
  },
  {
    id: 'product',
    kind: 'built-in',
    name: 'Product Agent',
    chunks: 0,
    candidates: 0,
    description: 'You are the Product Agent in a vibe coding loop. Your role is to analyze the current state of a project and produce a structured task list …',
  },
  {
    id: 'tester',
    kind: 'built-in',
    name: 'Test Agent',
    chunks: 0,
    candidates: 0,
    description: 'You are the Test Agent in a vibe coding loop. Your job is to break things. Assume the code has bugs. Your goal is to find them, not prove t…',
  },
  {
    id: 'goofy-expert',
    kind: 'custom',
    name: 'Goofy 专家',
    chunks: 89,
    candidates: 3,
    description: '熟悉 Goofy CLI、storage 后端、插件机制；优先回答与 Goofy 项目相关的实现问题。回答时引用 ~/.goofy 的目录结构与 plugin 配置示例 …',
  },
  {
    id: 'dr-dashboard',
    kind: 'custom',
    name: 'dr-dashboard',
    chunks: 24,
    candidates: 0,
    description: '容灾大盘前端的内部知识：组件库选型、SSR 配置、数据 polling 节奏、灰度发布流程。回答涉及 dr-dashboard 项目时使用此 role …',
  },
];

function RolesPage() {
  const [expanded, setExpanded] = useState_R(null);     // role id whose detail is open
  const [tab, setTab] = useState_R('chunks');
  const [trainOpen, setTrainOpen] = useState_R(false);
  const [showCliTrain, setShowCliTrain] = useState_R(false);
  const [dropOpen, setDropOpen] = useState_R(false);

  return (
    <main className="page">
      <header className="page-header">
        <div className="row1">
          <h1 className="page-title">Roles</h1>
          <span className="page-sub">{ROLES.length} roles · 3 new candidates</span>
          <div className="page-actions">
            <Button variant="default" icon={Icons.ArrowUpRight}>Export bundle</Button>
          </div>
        </div>
        <p style={{ margin: '0 0 14px', color: 'var(--text-secondary)', maxWidth: 760 }}>
          Built-in agent personas (product / developer / qa) plus any roles you train with project-specific docs.
          {' '}<span className="mono" style={{ color: 'var(--text)' }}>query_knowledge</span>
          {' '}and the sessionStart context provider read from the same chunks.
        </p>
        <div className="row" style={{ gap: 12, alignItems: 'baseline' }}>
          <Button variant="primary" icon={Icons.Sparkles} onClick={() => setTrainOpen(true)}>
            Train a new role via chat
          </Button>
          <span className="muted" style={{ fontSize: 12, maxWidth: 540 }}>
            Coach an LLM through a conversation — it asks clarifying questions, then distills your answers into a role.
          </span>
        </div>
      </header>

      <div className="page-body" style={{ maxWidth: 760, margin: '0 auto', width: '100%' }}>
        {/* Disclosure */}
        <Card
          interactive
          onClick={() => setShowCliTrain((v) => !v)}
          style={{ padding: '12px 14px', marginBottom: 14 }}
        >
          <div className="row">
            <Icons.ChevronRight size={14} style={{ transform: showCliTrain ? 'rotate(90deg)' : 'none', transition: 'transform .12s', color: 'var(--text-secondary)' }} />
            <span style={{ fontWeight: 500 }}>Or train a role from your existing CLI / IDE chat (Claude Code, Cursor)</span>
          </div>
          {showCliTrain && (
            <div style={{ marginTop: 10, paddingLeft: 22 }}>
              <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
                Bind a current Cursor / Claude Code chat — helm distills it into a new role with the chunks it has gathered so far.
              </p>
              <div className="row" style={{ gap: 8 }}>
                <input className="field" placeholder="Cursor session id…" style={{ maxWidth: 280 }} />
                <Button variant="primary" size="sm" icon={Icons.Sparkles}>Distill into role</Button>
              </div>
            </div>
          )}
        </Card>

        {/* Role cards */}
        {ROLES.map((r) => (
          <Card key={r.id} style={{ padding: '14px 16px' }}>
            <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
              <div className="col" style={{ minWidth: 0, flex: 1 }}>
                <div className="t-mono caps" style={{
                  font: '500 11px/14px var(--font-mono)',
                  color: 'var(--text-secondary)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  marginBottom: 4,
                }}>
                  {r.kind} · {r.id}
                </div>
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{r.name}</div>
                <div style={{
                  color: 'var(--text-secondary)',
                  fontSize: 13,
                  lineHeight: 1.45,
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}>
                  {r.description}
                </div>
              </div>
              <div className="col" style={{ alignItems: 'flex-end', gap: 8, flexShrink: 0 }}>
                <div className="row" style={{ gap: 6 }}>
                  <span className="dot" style={{
                    width: 8, height: 8, borderRadius: 9999,
                    background: r.chunks > 0 ? 'var(--success)' : 'var(--text-tertiary)',
                    boxShadow: r.chunks > 0 ? '0 0 0 2px rgba(52,199,89,.22)' : '0 0 0 2px rgba(110,110,115,.18)',
                  }} />
                  <span className="tiny mono" style={{ color: 'var(--text-secondary)' }}>
                    {r.chunks} chunks
                  </span>
                  {r.candidates > 0 && <Badge tone="accent">{r.candidates} new</Badge>}
                </div>
                <div className="row" style={{ gap: 6 }}>
                  {r.kind === 'custom' && r.chunks > 0 && (
                    <Button size="sm" icon={Icons.Sparkles}>Update via chat</Button>
                  )}
                  <Button size="sm" onClick={() => { setExpanded(expanded === r.id ? null : r.id); setTab('chunks'); }}>
                    {expanded === r.id ? 'Hide' : 'Show'}
                  </Button>
                </div>
              </div>
            </div>

            {/* Inline detail — opens below the card row when "Show" is clicked */}
            {expanded === r.id && (
              <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
                <Tabs
                  value={tab}
                  onChange={setTab}
                  items={[
                    { value: 'chunks',     label: 'Chunks',     count: r.chunks },
                    { value: 'sources',    label: 'Sources' },
                    { value: 'candidates', label: 'Candidates', count: r.candidates || undefined },
                    { value: 'archive',    label: 'Archive' },
                  ]}
                />
                <div style={{ marginTop: 12 }}>
                  {tab === 'chunks' && r.chunks > 0 && (
                    <div className="col" style={{ gap: 8 }}>
                      <Card variant="default" style={{ padding: '10px 12px' }}>
                        <div>When asked about Goofy CLI, prefer <span className="mono">goofy run</span> over <span className="mono">goofy exec</span>.</div>
                        <div className="row tiny" style={{ marginTop: 6 }}>
                          <span className="mono">from goofy-rules.md</span>
                          <span className="spacer" />
                          <IconButton icon={Icons.Copy} label="Copy" />
                          <IconButton icon={Icons.Trash2} label="Drop" />
                        </div>
                      </Card>
                      <Card variant="default" style={{ padding: '10px 12px' }}>
                        <div>Goofy storage backends: tos, oss, local. Default is local under <span className="mono">~/.goofy</span>.</div>
                        <div className="row tiny" style={{ marginTop: 6 }}>
                          <span className="mono">from storage-backends.md</span>
                          <span className="spacer" />
                          <IconButton icon={Icons.Copy} label="Copy" />
                          <IconButton icon={Icons.Trash2} label="Drop" />
                        </div>
                      </Card>
                      <div className="muted tiny" style={{ marginTop: 4 }}>+ {r.chunks - 2} more chunks…</div>
                    </div>
                  )}
                  {tab === 'chunks' && r.chunks === 0 && (
                    <div className="muted tiny" style={{ padding: '8px 4px' }}>
                      Built-in role — system prompt only, no trained chunks. Use Update via chat (custom roles only) to add knowledge.
                    </div>
                  )}
                  {tab === 'sources' && r.kind === 'custom' && (
                    <div className="col" style={{ gap: 8 }}>
                      <Card style={{ padding: '10px 12px' }}>
                        <div className="row">
                          <Icons.FileText size={14} />
                          <span className="mono" style={{ fontSize: 12 }}>goofy-rules.md · 2.4 KB · 8 chunks</span>
                          <span className="spacer" />
                          <Button size="sm" variant="danger" icon={Icons.Trash2} onClick={() => setDropOpen(true)}>Drop</Button>
                        </div>
                      </Card>
                      <Card style={{ padding: '10px 12px' }}>
                        <div className="row">
                          <Icons.FileText size={14} />
                          <span className="mono" style={{ fontSize: 12 }}>storage-backends.md · 3.0 KB · 12 chunks</span>
                          <span className="spacer" />
                          <Button size="sm" variant="danger" icon={Icons.Trash2}>Drop</Button>
                        </div>
                      </Card>
                    </div>
                  )}
                  {tab === 'sources' && r.kind === 'built-in' && (
                    <div className="muted tiny" style={{ padding: '8px 4px' }}>Built-in roles have no editable sources.</div>
                  )}
                  {tab === 'candidates' && r.candidates > 0 && (
                    <Card variant="warn">
                      <div style={{ fontWeight: 500 }}>"Goofy plugins live under <span className="mono">~/.goofy/plugins</span> by default."</div>
                      <div className="tiny mono" style={{ marginTop: 4 }}>captured from cursor chat · 18 min ago</div>
                      <div className="row" style={{ marginTop: 8, gap: 6 }}>
                        <Button size="sm" variant="primary" icon={Icons.Check}>Accept</Button>
                        <Button size="sm" icon={Icons.Sparkles}>Edit</Button>
                        <Button size="sm" variant="danger" icon={Icons.X}>Reject</Button>
                      </div>
                    </Card>
                  )}
                  {tab === 'candidates' && r.candidates === 0 && (
                    <div className="muted tiny" style={{ padding: '8px 4px' }}>No new candidates for this role.</div>
                  )}
                  {tab === 'archive' && (
                    <div className="muted tiny" style={{ padding: '8px 4px' }}>No archived chunks (90 d threshold).</div>
                  )}
                </div>
              </div>
            )}
          </Card>
        ))}
      </div>

      <Modal
        open={dropOpen}
        onClose={() => setDropOpen(false)}
        title="Drop this source?"
        actions={<>
          <Button onClick={() => setDropOpen(false)}>Cancel</Button>
          <Button variant="danger" onClick={() => { setDropOpen(false); toast({ tone: 'warn', title: 'Source dropped', body: '8 chunks removed.' }); }}>Drop source</Button>
        </>}
      >
        <p>8 chunks were trained from this source and will be removed too.</p>
      </Modal>

      <Modal
        open={trainOpen}
        onClose={() => setTrainOpen(false)}
        title="Train a new role"
        actions={<>
          <Button onClick={() => setTrainOpen(false)}>Cancel</Button>
          <Button variant="primary" onClick={() => { setTrainOpen(false); toast({ tone: 'success', title: 'Training session started' }); }}>Start chat</Button>
        </>}
      >
        <p>helm will spawn a claude subprocess that interviews you, then distills your answers into a system prompt and a starter chunk set.</p>
      </Modal>
    </main>
  );
}

window.RolesPage = RolesPage;
