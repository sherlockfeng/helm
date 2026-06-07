/**
 * Settings — R-18 sub-nav redesign.
 *
 * Layout: persistent left rail of section groups + right pane that
 * renders the active section. macOS-System-Settings-style. Each user
 * trip to Settings touches one knob then leaves; the rail keeps the
 * page from drowning in scroll-past-everything-irrelevant friction
 * that the long single-column layout had.
 *
 * IA groups (rail order):
 *   - General      — Default engine, Default trainer engine, HTTP port
 *   - Engines      — Cursor / Claude Code / Codex sub-tabs
 *   - Knowledge    — Lifecycle, Depscope provider
 *   - Integrations — Lark, Lark bindings link
 *   - Workflow     — Doc-first toggle, Harness conventions
 *   - Advanced     — Approvals / Harness / Bindings links (was /settings/advanced)
 *   - Diagnostics  — Export bundle
 *
 * Section state: persisted to localStorage
 * (`helm.settings.lastSection`) so a reopen lands on the same place
 * you left. URL deep-links into a specific section are deferred —
 * HashRouter + a colon-separated sub-path conflicts with React Router
 * param parsing; we'll wire proper sub-routes when there's a concrete
 * deep-link consumer.
 *
 * Save/Revert is pinned to the pane footer per active section. HTTP
 * port change wraps Save in a ConfirmDialog because that field needs
 * a helm restart to take effect — the user shouldn't be able to flip
 * it without acknowledging that.
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, helmApi } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';
import { CopyButton } from '../components/CopyButton.js';
import { toast } from 'sonner';
import { Button } from '../components/Button.js';
import { Card } from '../components/Card.js';
import { ConfirmDialog } from '../components/Dialog.js';
import { PageHeader } from '../components/PageHeader.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/Select.js';
import { CardSkeletonList } from '../components/Skeleton.js';
import type { HelmConfig, KnowledgeProviderConfig } from '../api/types.js';

/**
 * Curated Cursor models — shipped manually because Cursor doesn't
 * expose a "list models" endpoint. Add new ones here when Cursor
 * ships them; "auto" stays the default ("Cursor decides").
 */
const KNOWN_CURSOR_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'auto', label: 'auto (Cursor decides)' },
  { id: 'claude-4.7-opus', label: 'Claude Opus 4.7' },
  { id: 'claude-4.6-sonnet', label: 'Claude Sonnet 4.6' },
  { id: 'claude-4.5-haiku', label: 'Claude Haiku 4.5' },
  { id: 'gpt-5.1', label: 'GPT-5.1' },
  { id: 'gpt-5', label: 'GPT-5' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { id: 'grok-4-fast', label: 'Grok 4 Fast' },
];

/** R-18: Claude Code model list. Same models as Cursor, but stripped
 *  of "auto" framing — claude CLI's `--model` takes specific ids. */
const KNOWN_CLAUDE_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'auto', label: 'auto (Claude CLI decides)' },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
];

/** R-18: Codex model list. Kept minimal — Codex ships its own model
 *  router; we just need a "default" knob for the CLI's --model flag. */
const KNOWN_CODEX_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'auto', label: 'auto (Codex decides)' },
  { id: 'gpt-5.1', label: 'GPT-5.1' },
  { id: 'gpt-5', label: 'GPT-5' },
];

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

interface DepscopeConfig {
  endpoint?: string;
  authToken?: string;
  mappings?: Array<{ cwdPrefix: string; scmName: string }>;
  cacheTtlMs?: number;
  requestTimeoutMs?: number;
}

function findDepscope(config: HelmConfig): { provider: KnowledgeProviderConfig; index: number } | null {
  const idx = config.knowledge.providers.findIndex((p) => p.id === 'depscope');
  if (idx < 0) return null;
  return { provider: config.knowledge.providers[idx]!, index: idx };
}

function ensureDepscope(config: HelmConfig): { provider: KnowledgeProviderConfig; index: number } {
  const found = findDepscope(config);
  if (found) return found;
  config.knowledge.providers.push({
    id: 'depscope', enabled: false,
    config: { endpoint: '', mappings: [] },
  });
  return findDepscope(config)!;
}

// ── Section identifiers ──────────────────────────────────────────────

const SECTIONS = [
  'general', 'engines', 'knowledge', 'integrations',
  'workflow', 'advanced', 'diagnostics',
] as const;
type SectionId = typeof SECTIONS[number];
const ENGINE_TABS = ['cursor', 'claude-code', 'codex'] as const;
type EngineTab = typeof ENGINE_TABS[number];

const LAST_SECTION_KEY = 'helm.settings.lastSection';
const LAST_ENGINE_TAB_KEY = 'helm.settings.lastEngineTab';

function readInitialSection(): { section: SectionId; engineTab: EngineTab } {
  if (typeof window === 'undefined') return { section: 'general', engineTab: 'cursor' };
  const stored = window.localStorage?.getItem(LAST_SECTION_KEY);
  const storedTab = window.localStorage?.getItem(LAST_ENGINE_TAB_KEY);
  return {
    section: stored && (SECTIONS as readonly string[]).includes(stored)
      ? (stored as SectionId) : 'general',
    engineTab: storedTab && (ENGINE_TABS as readonly string[]).includes(storedTab)
      ? (storedTab as EngineTab) : 'cursor',
  };
}

function persistSection(section: SectionId, engineTab: EngineTab): void {
  if (typeof window === 'undefined') return;
  window.localStorage?.setItem(LAST_SECTION_KEY, section);
  window.localStorage?.setItem(LAST_ENGINE_TAB_KEY, engineTab);
}

// ── Page shell ───────────────────────────────────────────────────────

export function SettingsPage(): ReactElement | null {
  const { data, loading, error, reload } = useApi(() => helmApi.getConfig());
  const [draft, setDraft] = useState<HelmConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState<string | null>(null);
  const [portConfirm, setPortConfirm] = useState<{ from: number; to: number } | null>(null);
  const okTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const initial = useMemo(() => readInitialSection(), []);
  const [activeSection, setActiveSection] = useState<SectionId>(initial.section);
  const [engineTab, setEngineTab] = useState<EngineTab>(initial.engineTab);

  useEffect(() => {
    if (data && !draft) setDraft(clone(data));
  }, [data, draft]);

  useEffect(() => () => {
    if (okTimerRef.current) clearTimeout(okTimerRef.current);
  }, []);

  useEffect(() => {
    persistSection(activeSection, engineTab);
  }, [activeSection, engineTab]);

  if (loading) return <CardSkeletonList n={4} />;
  if (error) {
    toast.error(`Settings: ${error.message}`, { id: 'settings-load' });
    return null;
  }
  if (!draft || !data) return null;

  function update(mutator: (c: HelmConfig) => void): void {
    setDraft((cur) => {
      if (!cur) return cur;
      const next = clone(cur);
      mutator(next);
      setDirty(true);
      setSaveOk(null);
      return next;
    });
  }

  async function doSave(): Promise<void> {
    if (!draft) return;
    setSaveError(null);
    setSaveOk(null);
    try {
      const saved = await helmApi.saveConfig(draft);
      setDraft(clone(saved));
      setDirty(false);
      setSaveOk('Saved. Most changes apply immediately; HTTP port change requires a restart.');
      if (okTimerRef.current) clearTimeout(okTimerRef.current);
      okTimerRef.current = setTimeout(() => setSaveOk(null), 4000);
      reload();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setSaveError(msg);
    }
  }

  function onSaveClick(): void {
    if (!draft || !data) return;
    // R-18.4: HTTP-port change requires explicit confirmation. We only
    // gate on the port field because it's the one knob that can't take
    // effect without a helm restart — silently saving it without that
    // signal is what made the long-form Settings page confusing.
    if (draft.server.port !== data.server.port) {
      setPortConfirm({ from: data.server.port, to: draft.server.port });
      return;
    }
    void doSave();
  }

  function onRevert(): void {
    if (data) setDraft(clone(data));
    setDirty(false);
    setSaveError(null);
    setSaveOk(null);
  }

  return (
    <div className="helm-page">
      <PageHeader
        title="Settings"
        subtitle={<>Lives in <code>~/.helm/config.json</code>.</>}
      />
      <div className="helm-settings-layout">
        <SectionRail
          active={activeSection}
          onPick={(s) => setActiveSection(s)}
        />
        <div className="helm-settings-pane">
          {saveOk && (
            <div className="helm-banner ok" role="status" aria-live="polite">
              <span className="helm-status ok"><span className="dot" /></span>
              {saveOk}
            </div>
          )}
          {saveError && (
            <div className="helm-banner err" role="alert">
              <span className="helm-status err"><span className="dot" /></span>
              {saveError}
            </div>
          )}

          {activeSection === 'general' && (
            <GeneralSection draft={draft} update={update} />
          )}
          {activeSection === 'engines' && (
            <EnginesSection
              draft={draft} update={update}
              tab={engineTab} onTabChange={setEngineTab}
            />
          )}
          {activeSection === 'knowledge' && (
            <KnowledgeSection draft={draft} update={update} />
          )}
          {activeSection === 'integrations' && (
            <IntegrationsSection draft={draft} update={update} />
          )}
          {activeSection === 'workflow' && (
            <WorkflowSection draft={draft} update={update} />
          )}
          {activeSection === 'advanced' && <AdvancedSection />}
          {activeSection === 'diagnostics' && <DiagnosticsSection />}

          {/* Pinned Save/Revert footer — every section that mutates
              config shares one footer so the user always knows where
              to commit. Advanced + Diagnostics don't dirty draft, but
              the footer stays visible at disabled state for layout
              stability. */}
          <div className="helm-settings-footer">
            <Button variant="primary" disabled={!dirty} onClick={onSaveClick}>
              Save
            </Button>
            <button disabled={!dirty} onClick={onRevert}>Revert</button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={portConfirm !== null}
        onOpenChange={(open) => { if (!open) setPortConfirm(null); }}
        title="Restart required"
        description={
          portConfirm
            ? `Changing the HTTP port from ${portConfirm.from} to ${portConfirm.to} takes effect only after you restart helm. The current server stays bound until then.`
            : ''
        }
        confirmLabel="Save anyway"
        tone="primary"
        onConfirm={() => { setPortConfirm(null); void doSave(); }}
      />
    </div>
  );
}

// ── Section rail ─────────────────────────────────────────────────────

function SectionRail({
  active, onPick,
}: { active: SectionId; onPick: (s: SectionId) => void }): ReactElement {
  return (
    <aside className="helm-settings-rail" aria-label="Settings sections">
      {SECTIONS.map((id) => (
        <button
          key={id}
          type="button"
          aria-current={active === id ? 'page' : undefined}
          className={`helm-settings-rail-item${active === id ? ' is-active' : ''}`}
          onClick={() => onPick(id)}
        >
          {LABEL_FOR[id]}
        </button>
      ))}
    </aside>
  );
}

const LABEL_FOR: Record<SectionId, string> = {
  general: 'General',
  engines: 'Engines',
  knowledge: 'Knowledge',
  integrations: 'Integrations',
  workflow: 'Workflow',
  advanced: 'Advanced',
  diagnostics: 'Diagnostics',
};

// ── General section ──────────────────────────────────────────────────

function GeneralSection({
  draft, update,
}: { draft: HelmConfig; update: (m: (c: HelmConfig) => void) => void }): ReactElement {
  return (
    <>
      <Card>
        <h3 style={{ marginTop: 0 }}>Default engine</h3>
        <DefaultEngineField
          value={draft.engine?.default ?? 'claude'}
          onChange={(id) => update((c) => {
            if (!c.engine) c.engine = { default: id, trainerDefault: 'claude' };
            else c.engine.default = id;
          })}
        />
        <p className="muted" style={{ fontSize: 11, marginBottom: 0 }}>
          Drives the Campaign summarizer, the Harness reviewer subprocess,
          and the Roles "Train via chat" modal. Takes effect on the next
          request — no restart.
        </p>
      </Card>

      <Card>
        <h3 style={{ marginTop: 0 }}>Default trainer engine</h3>
        <TrainerEngineField
          value={draft.engine?.trainerDefault ?? 'claude'}
          onChange={(id) => update((c) => {
            if (!c.engine) c.engine = { default: 'claude', trainerDefault: id };
            else c.engine.trainerDefault = id;
          })}
        />
        <p className="muted" style={{ fontSize: 11, marginBottom: 0 }}>
          Which CLI agent helm spawns when you click "Train via chat" on
          a role. Cursor isn't an option — it's a GUI app helm can't
          spawn as a subprocess. Set the trainer's own model under
          Engines › Claude Code / Codex.
        </p>
      </Card>

      <Card>
        <h3 style={{ marginTop: 0 }}>HTTP API port</h3>
        <label className="helm-form-row">
          <div className="muted">Port</div>
          <input
            type="number"
            min={1}
            max={65535}
            value={draft.server.port}
            onChange={(e) => update((c) => { c.server.port = Number(e.target.value); })}
            style={{ width: 120 }}
            aria-label="HTTP API port"
          />
        </label>
        <p className="muted" style={{ fontSize: 11, marginBottom: 0 }}>
          Bound to 127.0.0.1 only. Save asks for confirmation because
          the change needs a helm restart to take effect.
        </p>
      </Card>
    </>
  );
}

// ── Engines section (Cursor / Claude Code / Codex sub-tabs) ──────────

function EnginesSection({
  draft, update, tab, onTabChange,
}: {
  draft: HelmConfig;
  update: (m: (c: HelmConfig) => void) => void;
  tab: EngineTab;
  onTabChange: (t: EngineTab) => void;
}): ReactElement {
  return (
    <>
      <div className="helm-settings-tabs" role="tablist" aria-label="Engine">
        {ENGINE_TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={`helm-settings-tab${tab === t ? ' is-active' : ''}`}
            onClick={() => onTabChange(t)}
          >
            {t === 'cursor' ? 'Cursor' : t === 'claude-code' ? 'Claude Code' : 'Codex'}
          </button>
        ))}
      </div>
      {tab === 'cursor' && <CursorPane draft={draft} update={update} />}
      {tab === 'claude-code' && <ClaudeCodePane draft={draft} update={update} />}
      {tab === 'codex' && <CodexPane draft={draft} update={update} />}
    </>
  );
}

function CursorPane({
  draft, update,
}: { draft: HelmConfig; update: (m: (c: HelmConfig) => void) => void }): ReactElement {
  return (
    <Card>
      <h3 style={{ marginTop: 0 }}>Cursor</h3>
      <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
        GUI app — helm receives prompt/response events via Cursor hooks.
        No binary path knob here because helm never spawns Cursor.
      </p>
      <InstallHooksButton agent="cursor" />
      <label className="helm-form-row">
        <div className="muted">Mode</div>
        <Select
          value={draft.cursor.mode}
          onValueChange={(v) => update((c) => { c.cursor.mode = v as 'local' | 'cloud'; })}
        >
          <SelectTrigger style={{ width: 280 }}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="local">local (use Cursor app auth)</SelectItem>
            <SelectItem value="cloud">cloud (CURSOR_API_KEY required)</SelectItem>
          </SelectContent>
        </Select>
      </label>
      <ModelField
        label="Model"
        models={KNOWN_CURSOR_MODELS}
        value={draft.cursor.model}
        onChange={(model) => update((c) => { c.cursor.model = model; })}
      />
      {draft.cursor.mode === 'cloud' && (
        <label className="helm-form-row">
          <div className="muted">API key</div>
          <input
            type="password"
            value={draft.cursor.apiKey ?? ''}
            placeholder="(or set CURSOR_API_KEY env var)"
            onChange={(e) => update((c) => { c.cursor.apiKey = e.target.value || undefined; })}
          />
        </label>
      )}
      <McpAutoRegisterField
        value={draft.cursor.mcpAutoRegister ?? false}
        onChange={(v) => update((c) => { c.cursor.mcpAutoRegister = v; })}
        helpText="Writes helm's MCP server entry into ~/.cursor/mcp.json so train_role + read_lark_doc etc. are callable from inside Cursor."
      />
    </Card>
  );
}

function ClaudeCodePane({
  draft, update,
}: { draft: HelmConfig; update: (m: (c: HelmConfig) => void) => void }): ReactElement {
  const cc = draft.claudeCode ?? { model: 'auto', trainerModel: 'auto', mcpAutoRegister: false };
  return (
    <Card>
      <h3 style={{ marginTop: 0 }}>Claude Code</h3>
      <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
        CLI tool — helm spawns <code>claude</code> as the trainer
        subprocess and watches its hooks. Auth is whatever
        <code> claude login </code> set up.
      </p>
      <InstallHooksButton agent="claude-code" />
      <label className="helm-form-row">
        <div className="muted">Binary path (override)</div>
        <input
          type="text"
          value={cc.binaryPath ?? ''}
          placeholder="(auto — uses $PATH)"
          onChange={(e) => update((c) => {
            c.claudeCode = { ...cc, binaryPath: e.target.value || undefined };
          })}
        />
      </label>
      <ModelField
        label="Default model"
        models={KNOWN_CLAUDE_MODELS}
        value={cc.model}
        onChange={(model) => update((c) => { c.claudeCode = { ...cc, model }; })}
      />
      <ModelField
        label="Trainer model"
        models={KNOWN_CLAUDE_MODELS}
        value={cc.trainerModel}
        onChange={(trainerModel) => update((c) => { c.claudeCode = { ...cc, trainerModel }; })}
        helpText="Used when helm spawns claude as the train-via-chat subprocess. Often a smarter / slower model than the day-to-day default."
      />
      <McpAutoRegisterField
        value={cc.mcpAutoRegister}
        onChange={(v) => update((c) => { c.claudeCode = { ...cc, mcpAutoRegister: v }; })}
        helpText="Writes helm's MCP entry into ~/.claude/settings.json so its tools are callable from any claude session."
      />
    </Card>
  );
}

function CodexPane({
  draft, update,
}: { draft: HelmConfig; update: (m: (c: HelmConfig) => void) => void }): ReactElement {
  const cx = draft.codex ?? { model: 'auto', trainerModel: 'auto', mcpAutoRegister: false };
  return (
    <Card>
      <h3 style={{ marginTop: 0 }}>Codex</h3>
      <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
        CLI tool — same shape as Claude Code. Auth is whatever the
        codex CLI's own login configured.
      </p>
      <InstallHooksButton agent="codex" />
      <label className="helm-form-row">
        <div className="muted">Binary path (override)</div>
        <input
          type="text"
          value={cx.binaryPath ?? ''}
          placeholder="(auto — uses $PATH)"
          onChange={(e) => update((c) => {
            c.codex = { ...cx, binaryPath: e.target.value || undefined };
          })}
        />
      </label>
      <ModelField
        label="Default model"
        models={KNOWN_CODEX_MODELS}
        value={cx.model}
        onChange={(model) => update((c) => { c.codex = { ...cx, model }; })}
      />
      <ModelField
        label="Trainer model"
        models={KNOWN_CODEX_MODELS}
        value={cx.trainerModel}
        onChange={(trainerModel) => update((c) => { c.codex = { ...cx, trainerModel }; })}
        helpText="Used when helm spawns codex as the train-via-chat subprocess."
      />
      <McpAutoRegisterField
        value={cx.mcpAutoRegister}
        onChange={(v) => update((c) => { c.codex = { ...cx, mcpAutoRegister: v }; })}
        helpText="Writes helm's MCP entry into the codex MCP config."
      />
    </Card>
  );
}

// ── Knowledge section ────────────────────────────────────────────────

function KnowledgeSection({
  draft, update,
}: { draft: HelmConfig; update: (m: (c: HelmConfig) => void) => void }): ReactElement {
  const depscope = findDepscope(draft);
  const depscopeCfg: DepscopeConfig = (depscope?.provider.config ?? {}) as DepscopeConfig;

  return (
    <>
      <Card variant="danger">
        <h3 style={{ marginTop: 0 }}>Lifecycle</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
          When stale chunks soft-archive (hidden from search) and how
          strongly recent access biases retrieval. Applies to the next
          sweep / search — no restart.
        </p>
        <label className="helm-form-row">
          <div className="muted">Archive after (days)</div>
          <input
            type="number"
            min={1}
            value={draft.knowledge.lifecycle?.archiveAfterDays ?? 90}
            onChange={(e) => update((c) => {
              c.knowledge.lifecycle = {
                archiveAfterDays: Math.max(1, Number(e.target.value) || 90),
                archiveBelowAccessCount: c.knowledge.lifecycle?.archiveBelowAccessCount ?? 3,
                decayTauDays: c.knowledge.lifecycle?.decayTauDays ?? 30,
                decayAlpha: c.knowledge.lifecycle?.decayAlpha ?? 0.3,
              };
            })}
            style={{ width: 120 }}
          />
        </label>
        <label className="helm-form-row">
          <div className="muted">Archive below access count</div>
          <input
            type="number"
            min={0}
            value={draft.knowledge.lifecycle?.archiveBelowAccessCount ?? 3}
            onChange={(e) => update((c) => {
              c.knowledge.lifecycle = {
                archiveAfterDays: c.knowledge.lifecycle?.archiveAfterDays ?? 90,
                archiveBelowAccessCount: Math.max(0, Number(e.target.value) || 0),
                decayTauDays: c.knowledge.lifecycle?.decayTauDays ?? 30,
                decayAlpha: c.knowledge.lifecycle?.decayAlpha ?? 0.3,
              };
            })}
            style={{ width: 120 }}
          />
        </label>
        <label className="helm-form-row">
          <div className="muted">Decay τ (days)</div>
          <input
            type="number"
            min={1}
            value={draft.knowledge.lifecycle?.decayTauDays ?? 30}
            onChange={(e) => update((c) => {
              c.knowledge.lifecycle = {
                archiveAfterDays: c.knowledge.lifecycle?.archiveAfterDays ?? 90,
                archiveBelowAccessCount: c.knowledge.lifecycle?.archiveBelowAccessCount ?? 3,
                decayTauDays: Math.max(1, Number(e.target.value) || 30),
                decayAlpha: c.knowledge.lifecycle?.decayAlpha ?? 0.3,
              };
            })}
            style={{ width: 120 }}
          />
        </label>
        <label className="helm-form-row">
          <div className="muted">Decay α (boost cap)</div>
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={draft.knowledge.lifecycle?.decayAlpha ?? 0.3}
            onChange={(e) => update((c) => {
              c.knowledge.lifecycle = {
                archiveAfterDays: c.knowledge.lifecycle?.archiveAfterDays ?? 90,
                archiveBelowAccessCount: c.knowledge.lifecycle?.archiveBelowAccessCount ?? 3,
                decayTauDays: c.knowledge.lifecycle?.decayTauDays ?? 30,
                decayAlpha: Math.min(1, Math.max(0, Number(e.target.value) || 0)),
              };
            })}
            style={{ width: 120 }}
          />
        </label>
        <p className="muted" style={{ fontSize: 11, marginBottom: 0 }}>
          Defaults: 90d / access&lt;3 / τ=30d / α=0.3. A chunk is
          archived only when BOTH "older than archive-after" AND
          "fewer accesses than threshold" are true. α=0 disables the
          decay re-rank entirely.
        </p>
      </Card>

      <Card>
        <h3 style={{ marginTop: 0 }}>Depscope provider</h3>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={depscope?.provider.enabled ?? false}
            onChange={(e) => update((c) => {
              const found = ensureDepscope(c);
              c.knowledge.providers[found.index] = {
                ...found.provider,
                enabled: e.target.checked,
              };
            })}
          />
          Enabled
        </label>
        <label className="helm-form-row">
          <div className="muted">Endpoint URL</div>
          <input
            type="text"
            value={depscopeCfg.endpoint ?? ''}
            placeholder="http://depscope.example.com"
            onChange={(e) => update((c) => {
              const found = ensureDepscope(c);
              const cfg = (found.provider.config ?? {}) as DepscopeConfig;
              cfg.endpoint = e.target.value;
              found.provider.config = cfg as Record<string, unknown>;
            })}
          />
        </label>
        <label className="helm-form-row">
          <div className="muted">Auth token</div>
          <input
            type="password"
            value={depscopeCfg.authToken ?? ''}
            placeholder="Bearer token (optional)"
            onChange={(e) => update((c) => {
              const found = ensureDepscope(c);
              const cfg = (found.provider.config ?? {}) as DepscopeConfig;
              cfg.authToken = e.target.value || undefined;
              found.provider.config = cfg as Record<string, unknown>;
            })}
          />
        </label>
        <div className="label" style={{ marginTop: 16 }}>cwd → scmName mappings</div>
        {(depscopeCfg.mappings ?? []).map((m, i) => (
          <div key={i} className="helm-mapping-row">
            <input
              type="text"
              value={m.cwdPrefix}
              placeholder="~/proj/foo"
              aria-label={`cwd prefix for mapping ${i + 1}`}
              onChange={(e) => update((c) => {
                const found = ensureDepscope(c);
                const cfg = (found.provider.config ?? {}) as DepscopeConfig;
                cfg.mappings = (cfg.mappings ?? []).map((mm, idx) => idx === i ? { ...mm, cwdPrefix: e.target.value } : mm);
                found.provider.config = cfg as Record<string, unknown>;
              })}
            />
            <input
              type="text"
              value={m.scmName}
              placeholder="org/repo"
              aria-label={`scm name for mapping ${i + 1}`}
              onChange={(e) => update((c) => {
                const found = ensureDepscope(c);
                const cfg = (found.provider.config ?? {}) as DepscopeConfig;
                cfg.mappings = (cfg.mappings ?? []).map((mm, idx) => idx === i ? { ...mm, scmName: e.target.value } : mm);
                found.provider.config = cfg as Record<string, unknown>;
              })}
            />
            <Button
              type="button"
              variant="danger-outline"
              aria-label={`Remove mapping for ${m.cwdPrefix || '(unset prefix)'}`}
              onClick={() => update((c) => {
                const found = ensureDepscope(c);
                const cfg = (found.provider.config ?? {}) as DepscopeConfig;
                cfg.mappings = (cfg.mappings ?? []).filter((_, idx) => idx !== i);
                found.provider.config = cfg as Record<string, unknown>;
              })}
            >Remove</Button>
          </div>
        ))}
        <Button
          type="button"
          variant="ghost"
          style={{ marginTop: 10 }}
          onClick={() => update((c) => {
            const found = ensureDepscope(c);
            const cfg = (found.provider.config ?? {}) as DepscopeConfig;
            cfg.mappings = [...(cfg.mappings ?? []), { cwdPrefix: '', scmName: '' }];
            found.provider.config = cfg as Record<string, unknown>;
          })}
        >+ Add mapping</Button>
      </Card>
    </>
  );
}

// ── Integrations section ─────────────────────────────────────────────

function IntegrationsSection({
  draft, update,
}: { draft: HelmConfig; update: (m: (c: HelmConfig) => void) => void }): ReactElement {
  return (
    <>
      <Card>
        <h3 style={{ marginTop: 0 }}>Lark integration</h3>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={draft.lark.enabled}
            onChange={(e) => update((c) => { c.lark.enabled = e.target.checked; })}
          />
          Enable Lark channel
        </label>
        <label className="helm-form-row">
          <div className="muted">lark-cli command</div>
          <input
            type="text"
            value={draft.lark.cliCommand ?? ''}
            placeholder="auto (uses LARK_CLI_COMMAND env or bundled binary)"
            onChange={(e) => update((c) => { c.lark.cliCommand = e.target.value || undefined; })}
          />
        </label>
      </Card>
      <Card>
        <h3 style={{ marginTop: 0 }}>Lark bindings</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
          Per-chat Lark channel binding management lives on a dedicated
          page — too much detail (queue depth, expiry, manual rebind)
          for a Settings card.
        </p>
        <Link to="/bindings"><Button>Open Lark bindings ↗</Button></Link>
      </Card>
    </>
  );
}

// ── Workflow section ─────────────────────────────────────────────────

function WorkflowSection({
  draft, update,
}: { draft: HelmConfig; update: (m: (c: HelmConfig) => void) => void }): ReactElement {
  return (
    <>
      <Card>
        <h3 style={{ marginTop: 0 }}>Doc-first enforcement</h3>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={draft.docFirst.enforce}
            onChange={(e) => update((c) => { c.docFirst.enforce = e.target.checked; })}
          />
          Require <code>update_doc_first</code> before completing dev tasks
        </label>
        <p className="muted" style={{ fontSize: 11, marginBottom: 0 }}>
          When on, dev tasks need a fresh docAuditToken to complete.
          Disable for casual / one-off sessions where the doc-first
          cadence isn't worth the friction.
        </p>
      </Card>
      <Card>
        <h3 style={{ marginTop: 0 }}>Harness conventions</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
          Injected into every Harness review subprocess. The reviewer
          sees this text alongside Intent, Structure, and the diff —
          but never the implementer's Decisions or Stage Log.
        </p>
        <textarea
          value={draft.harness?.conventions ?? ''}
          placeholder={'e.g.\n- All new SQL tables must include created_at/updated_at TEXT NOT NULL.\n- HTTP handlers go through `send(res, ...)`; never `res.write` directly.'}
          rows={8}
          style={{ width: '100%', fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}
          onChange={(e) => update((c) => {
            if (!c.harness) c.harness = { conventions: '' };
            c.harness.conventions = e.target.value;
          })}
        />
      </Card>
    </>
  );
}

// ── Advanced section (replaces /settings/advanced) ───────────────────

function AdvancedSection(): ReactElement {
  return (
    <>
      <Card>
        <h3 style={{ marginTop: 0 }}>Approvals queue</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
          Tool-use approval queue for Cursor hooks. Lives behind its own
          page because it's a real-time interactive surface.
        </p>
        <Link to="/approvals"><Button>Open Approvals ↗</Button></Link>
      </Card>
      <Card>
        <h3 style={{ marginTop: 0 }}>Harness</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
          Multi-stage feature-development workflow. Most users won't
          touch this; it's here as an opt-in surface for teams running
          the Harness loop.
        </p>
        <Link to="/harness"><Button>Open Harness ↗</Button></Link>
      </Card>
    </>
  );
}

// ── Diagnostics section ──────────────────────────────────────────────

function DiagnosticsSection(): ReactElement {
  const [diagnostics, setDiagnostics] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  async function exportBundle(): Promise<void> {
    setDiagnostics(null);
    setExporting(true);
    try {
      const r = await helmApi.exportDiagnostics();
      setDiagnostics(r.bundleDir);
    } catch (err) {
      setDiagnostics(`failed: ${(err as Error).message}`);
    } finally {
      setExporting(false);
    }
  }

  return (
    <Card>
      <h3 style={{ marginTop: 0 }}>Diagnostics bundle</h3>
      <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
        Bundles recent logs + redacted config + schema version +
        bridge state for a bug report. Saved under <code>~/.helm/</code>.
      </p>
      <button
        type="button"
        disabled={exporting}
        aria-busy={exporting}
        onClick={() => { void exportBundle(); }}
      >
        {exporting ? 'Exporting…' : 'Export diagnostics bundle'}
      </button>
      {diagnostics && (
        <p className="muted" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
          Bundle:{' '}
          <span className="helm-copy-row">
            <code>{diagnostics}</code>
            <CopyButton value={diagnostics} />
          </span>
        </p>
      )}
    </Card>
  );
}

// ── Shared field components ──────────────────────────────────────────

function ModelField({
  label, models, value, onChange, helpText,
}: {
  label: string;
  models: ReadonlyArray<{ id: string; label: string }>;
  value: string;
  onChange: (model: string) => void;
  helpText?: string;
}): ReactElement {
  const isKnown = models.some((m) => m.id === value);
  const [showCustom, setShowCustom] = useState(!isKnown);
  const useCustom = showCustom || !isKnown;

  return (
    <label className="helm-form-row">
      <div className="muted">{label}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', width: '100%' }}>
        <Select
          value={useCustom ? '__custom__' : value}
          onValueChange={(v) => {
            if (v === '__custom__') { setShowCustom(true); return; }
            setShowCustom(false);
            onChange(v);
          }}
        >
          <SelectTrigger style={{ minWidth: 220 }}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {models.map((m) => (
              <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>
            ))}
            <SelectItem value="__custom__">Custom…</SelectItem>
          </SelectContent>
        </Select>
        {useCustom && (
          <input
            type="text"
            value={value}
            placeholder="model id"
            onChange={(e) => onChange(e.target.value)}
            style={{ flex: 1, minWidth: 180 }}
            aria-label={`${label} (custom)`}
          />
        )}
      </div>
      {helpText && (
        <p className="muted" style={{ fontSize: 11, marginTop: 4, marginBottom: 0 }}>
          {helpText}
        </p>
      )}
    </label>
  );
}

function McpAutoRegisterField({
  value, onChange, helpText,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  helpText: string;
}): ReactElement {
  return (
    <div className="helm-form-row">
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="checkbox"
          checked={value}
          onChange={(e) => onChange(e.target.checked)}
        />
        Auto-register helm's MCP server
      </label>
      <p className="muted" style={{ fontSize: 11, marginTop: 4, marginBottom: 0 }}>
        {helpText}
      </p>
    </div>
  );
}

/**
 * R-18: install hooks button — symmetric across all three engines.
 * The actual install for each agent is gated behind a backend endpoint
 * that the orchestrator owns (writes the hook config into the agent's
 * settings file). Until the per-agent install endpoint lands, the
 * button shows the path the user can copy and an info message.
 */
function InstallHooksButton({ agent }: { agent: 'cursor' | 'claude-code' | 'codex' }): ReactElement {
  const [busy, setBusy] = useState(false);
  const onClick = async (): Promise<void> => {
    setBusy(true);
    try {
      // The endpoint isn't wired yet for all three agents; surface the
      // current install instructions instead so users don't hit a
      // confusing no-op. Real wiring lands when the per-host adapters
      // expose install().
      const docs = {
        'cursor': 'Cursor hooks live in ~/.cursor/hooks/. helm ships the prompt/response forwarder at /Applications/helm.app/Contents/Resources/hooks/. Copy or symlink into ~/.cursor/hooks/.',
        'claude-code': 'Claude Code hooks live in ~/.claude/settings.json. Add the helm MCP server + hooks block; full snippet under helm docs/install/claude-code.md.',
        'codex': 'Codex hooks: TBD — adapter scaffold exists but install path needs the codex CLI conventions. Watch the helm releases for an automated install button.',
      };
      toast.info(docs[agent], { duration: 8000 });
    } finally { setBusy(false); }
  };
  return (
    <div className="helm-form-row">
      <Button type="button" onClick={onClick} disabled={busy}>
        Install hooks
      </Button>
      <p className="muted" style={{ fontSize: 11, marginTop: 4, marginBottom: 0 }}>
        Wires the agent's prompt/response events into helm's local HTTP
        API. Required for helm to see this agent's chats.
      </p>
    </div>
  );
}

function DefaultEngineField({
  value, onChange,
}: {
  value: 'cursor' | 'claude';
  onChange: (id: 'cursor' | 'claude') => void;
}): ReactElement {
  const { data, loading, error } = useApi(() => helmApi.engineHealth());
  const healths = data?.engines ?? [];
  const find = (id: 'cursor' | 'claude') => healths.find((h) => h.engine === id);

  function RadioRow({ id, label }: { id: 'cursor' | 'claude'; label: string }) {
    const h = find(id);
    const detailMissing = loading
      ? 'detecting…'
      : error ? 'health unknown'
      : h ? (h.ready ? `ready (${h.detail})` : h.detail)
      : 'unknown';
    return (
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8 }}>
        <input
          type="radio"
          name="default-engine"
          value={id}
          checked={value === id}
          onChange={() => onChange(id)}
          style={{ marginTop: 3 }}
        />
        <span style={{ flex: 1 }}>
          <strong>{label}</strong>
          <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
            {h?.ready ? '· ✓' : '· ⚠'} {detailMissing}
          </span>
          {h && !h.ready && h.hint && (
            <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
              <em>→ {h.hint}</em>
            </div>
          )}
        </span>
      </label>
    );
  }
  return (
    <div>
      <RadioRow id="claude" label="Claude Code" />
      <RadioRow id="cursor" label="Cursor" />
    </div>
  );
}

function TrainerEngineField({
  value, onChange,
}: {
  value: 'claude' | 'codex';
  onChange: (id: 'claude' | 'codex') => void;
}): ReactElement {
  // Trainer engine doesn't probe health (the model running the
  // training has its own per-spawn checks); just show the two
  // spawnable CLI agents as radios.
  return (
    <div>
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8 }}>
        <input
          type="radio"
          name="trainer-engine"
          value="claude"
          checked={value === 'claude'}
          onChange={() => onChange('claude')}
          style={{ marginTop: 3 }}
        />
        <span><strong>Claude Code</strong></span>
      </label>
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <input
          type="radio"
          name="trainer-engine"
          value="codex"
          checked={value === 'codex'}
          onChange={() => onChange('codex')}
          style={{ marginTop: 3 }}
        />
        <span><strong>Codex</strong></span>
      </label>
    </div>
  );
}
