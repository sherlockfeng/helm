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
 *   - Knowledge    — Wiki identity, custom MCP providers
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
import { ApiError, helmApi } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';
import { CopyButton } from '../components/CopyButton.js';
import { toast } from 'sonner';
import { Button } from '../components/Button.js';
import { Card } from '../components/Card.js';
import { TrainViaCliPanel } from '../components/TrainViaCliPanel.js';
import { ConfirmDialog } from '../components/Dialog.js';
import { PageHeader } from '../components/PageHeader.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/Select.js';
import { CardSkeletonList } from '../components/Skeleton.js';
import type { HelmConfig } from '../api/types.js';

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

interface McpProviderUiConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  toolName?: string;
}

/** Render env map as KEY=VALUE lines for the paste-friendly textarea. */
function envToText(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n');
}

function textToEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

/** Split a pasted launch line into command + args (whitespace tokens). */
function commandLineToParts(line: string): { command: string; args: string[] } {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  return { command: tokens[0] ?? '', args: tokens.slice(1) };
}

function partsToCommandLine(cfg: McpProviderUiConfig): string {
  return [cfg.command ?? '', ...(cfg.args ?? [])].join(' ').trim();
}

// ── Section identifiers ──────────────────────────────────────────────

// B 类隐藏（知识生命周期之外的 relay 遗留）：Integrations(Lark)、
// Workflow(Doc-first/Harness)、Advanced(Approvals/Harness 入口) 区块
// 不再暴露；后端与 config 键保持不变，路由仍可直达。
const SECTIONS = [
  'general', 'engines', 'knowledge', 'diagnostics',
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
          and the Topics "Train via chat" modal. Takes effect on the next
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
          a topic. Cursor isn't an option — it's a GUI app helm can't
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
      <div style={{ marginTop: 20 }}>
        <h3 style={{ marginTop: 0 }}>从你的 CLI / IDE 训练 topic</h3>
        <p className="muted" style={{ marginTop: 0, marginBottom: 10, fontSize: 12 }}>
          一次性把 helm 的 <code>train_role</code> MCP 工具注册到 Claude Code / Cursor，
          之后在自己的终端聊天里就能把对话沉淀成 topic。
        </p>
        <TrainViaCliPanel />
      </div>
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
  const customMcp = draft.knowledge.providers
    .map((provider, index) => ({ provider, index }))
    .filter((e) => e.provider.kind === 'mcp-stdio');

  return (
    <>
      <Card>
        <h3 style={{ marginTop: 0 }}>Wiki identity</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
          Username for the chat-captured/&lt;user&gt;/ directory when
          promoted knowledge is written into a subscribed llm-wiki repo.
          This name appears in company-repo MRs — use your company
          account name (e.g. heyunfeng.feng). Leave empty to keep
          promotions DB-only.
        </p>
        <label className="helm-form-row">
          <div className="muted">Wiki username</div>
          <input
            type="text"
            placeholder="e.g. heyunfeng.feng"
            value={draft.knowledge.wikiUsername ?? ''}
            onChange={(e) => update((c) => {
              const v = e.target.value.trim();
              if (v) c.knowledge.wikiUsername = v;
              else delete c.knowledge.wikiUsername;
            })}
            style={{ width: 240 }}
          />
        </label>
        <p className="muted" style={{ marginTop: 14, marginBottom: 6, fontSize: 12 }}>
          Git push 命令（可选）：直接 push 到内网仓库不稳定时，可改用内网包装 CLI
          （如 <code>codebase git</code>）来推。留空即用普通 <code>git</code>。改动需重启 helm。
        </p>
        <label className="helm-form-row">
          <div className="muted">Git push 命令</div>
          <input
            type="text"
            placeholder="例如 codebase git（留空 = git）"
            value={draft.knowledge.gitPushCommand ?? ''}
            onChange={(e) => update((c) => {
              const v = e.target.value.trim();
              if (v) c.knowledge.gitPushCommand = v;
              else delete c.knowledge.gitPushCommand;
            })}
            style={{ width: 280 }}
          />
        </label>
        <p className="muted" style={{ marginTop: 14, marginBottom: 6, fontSize: 12 }}>
          MR 创建命令（可选）：托管平台不是 GitHub/GitLab（无 gh/glab）时，填一个能开 MR 的 CLI
          （如 <code>codebase mr create</code>）。helm 会在已 push 的分支上追加
          <code>--source/--target/--title/--body</code> 调用它。留空则按 gh/glab 自动识别。改动需重启。
        </p>
        <label className="helm-form-row">
          <div className="muted">MR 创建命令</div>
          <input
            type="text"
            placeholder="例如 codebase mr create（留空 = gh/glab）"
            value={draft.knowledge.mrCommand ?? ''}
            onChange={(e) => update((c) => {
              const v = e.target.value.trim();
              if (v) c.knowledge.mrCommand = v;
              else delete c.knowledge.mrCommand;
            })}
            style={{ width: 280 }}
          />
        </label>
      </Card>

      <Card>
        <h3 style={{ marginTop: 0 }}>自定义 MCP provider</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
          把任意知识平台的 MCP 用法贴进来即可：启动命令一行
          （如 npx -y @org/kb-mcp），环境变量每行一个 KEY=VALUE。
          helm 会按需拉起该进程并把检索结果并入 query_knowledge 聚合。
          配置只保存在本机 ~/.helm/config.json，不会进入代码仓库。
        </p>
        {customMcp.map(({ provider, index }) => {
          const cfg = (provider.config ?? {}) as McpProviderUiConfig;
          return (
            <div key={index} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 10, marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="text"
                  value={provider.id}
                  placeholder="provider id（如 my-kb）"
                  aria-label={`custom provider id ${index + 1}`}
                  onChange={(e) => update((c) => {
                    c.knowledge.providers[index] = { ...c.knowledge.providers[index]!, id: e.target.value };
                  })}
                  style={{ width: 160 }}
                />
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={provider.enabled}
                    onChange={(e) => update((c) => {
                      c.knowledge.providers[index] = { ...c.knowledge.providers[index]!, enabled: e.target.checked };
                    })}
                  />
                  Enabled
                </label>
                <span style={{ marginLeft: 'auto' }}>
                  <Button
                    type="button"
                    variant="danger-outline"
                    onClick={() => update((c) => {
                      c.knowledge.providers = c.knowledge.providers.filter((_, i) => i !== index);
                    })}
                  >Remove</Button>
                </span>
              </div>
              <label className="helm-form-row">
                <div className="muted">启动命令</div>
                <input
                  type="text"
                  value={partsToCommandLine(cfg)}
                  placeholder="npx -y @org/kb-mcp"
                  onChange={(e) => update((c) => {
                    const cur = (c.knowledge.providers[index]!.config ?? {}) as McpProviderUiConfig;
                    const parts = commandLineToParts(e.target.value);
                    cur.command = parts.command;
                    cur.args = parts.args;
                    c.knowledge.providers[index]!.config = cur as Record<string, unknown>;
                  })}
                />
              </label>
              <label className="helm-form-row">
                <div className="muted">环境变量（每行 KEY=VALUE）</div>
                <textarea
                  rows={3}
                  defaultValue={envToText(cfg.env)}
                  placeholder={'SPACE_ID=123\nENV=office'}
                  style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
                  onBlur={(e) => update((c) => {
                    const cur = (c.knowledge.providers[index]!.config ?? {}) as McpProviderUiConfig;
                    cur.env = textToEnv(e.target.value);
                    c.knowledge.providers[index]!.config = cur as Record<string, unknown>;
                  })}
                />
              </label>
              <label className="helm-form-row">
                <div className="muted">Tool 名（可选，留空自动探测）</div>
                <input
                  type="text"
                  value={cfg.toolName ?? ''}
                  placeholder="留空 = 自动选 server 暴露的检索工具"
                  onChange={(e) => update((c) => {
                    const cur = (c.knowledge.providers[index]!.config ?? {}) as McpProviderUiConfig;
                    if (e.target.value) cur.toolName = e.target.value;
                    else delete cur.toolName;
                    c.knowledge.providers[index]!.config = cur as Record<string, unknown>;
                  })}
                  style={{ width: 240 }}
                />
              </label>
            </div>
          );
        })}
        <Button
          type="button"
          variant="ghost"
          onClick={() => update((c) => {
            c.knowledge.providers.push({
              id: '', enabled: false, kind: 'mcp-stdio',
              config: { command: '', args: [], env: {} },
            });
          })}
        >+ 添加 provider</Button>
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
 * R-18 wire-up: install hooks button — calls the real backend
 * endpoint. Cursor has a complete installer (writes
 * `~/.cursor/hooks.json`). Claude Code routes through `setupMcp`
 * (its "hooks" are MCP notifications, not a separate file). Codex
 * returns 501 until that adapter's install path lands; the button
 * surfaces the message verbatim so the user knows it's a known gap.
 */
function InstallHooksButton({ agent }: { agent: 'cursor' | 'claude-code' | 'codex' }): ReactElement {
  const [busy, setBusy] = useState(false);
  const statusQuery = useApi(() => helmApi.getHostHooksStatus(agent), [agent]);
  const installed = statusQuery.data?.installed;

  const onClick = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await helmApi.installHostHooks(agent);
      const path = typeof result['hooksPath'] === 'string'
        ? ` (${result['hooksPath']})`
        : typeof result['location'] === 'string'
          ? ` (${result['location']})`
          : '';
      toast.success(`Installed${path}`, { duration: 6000 });
      statusQuery.reload();
    } catch (err) {
      if (err instanceof ApiError && err.status === 501) {
        const msg = typeof (err.body as Record<string, unknown>)?.['message'] === 'string'
          ? String((err.body as Record<string, unknown>)['message'])
          : 'Not yet implemented for this agent.';
        toast.message(msg, { duration: 8000 });
      } else {
        toast.error(`Install failed: ${err instanceof ApiError ? err.message : String(err)}`);
      }
    } finally { setBusy(false); }
  };

  const statusLine = installed === true
    ? <span className="muted" style={{ fontSize: 11, color: 'var(--success, #16a34a)' }}>· ✓ installed</span>
    : installed === false
      ? <span className="muted" style={{ fontSize: 11, color: 'var(--warning, #d97706)' }}>· not installed</span>
      : null;

  return (
    <div className="helm-form-row">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button type="button" onClick={onClick} disabled={busy} aria-busy={busy}>
          {busy ? 'Installing…' : installed === true ? 'Reinstall hooks' : 'Install hooks'}
        </Button>
        {statusLine}
      </div>
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
  // R-18 wire-up: reuse the same engine-health probe the Default
  // engine field uses, but only render the spawnable rows. Surfaces
  // "ready" / "not detected" inline so the user picks honestly.
  const { data, loading, error } = useApi(() => helmApi.engineHealth());
  const healths = data?.engines ?? [];
  const find = (id: 'claude' | 'codex'): { ready?: boolean; detail?: string; hint?: string } =>
    healths.find((h) => h.engine === id) ?? {};

  function RadioRow({ id, label }: { id: 'claude' | 'codex'; label: string }) {
    const h = find(id);
    const detail = loading
      ? 'detecting…'
      : error ? 'health unknown'
      : h.ready === true ? `ready (${h.detail ?? ''})`
      : h.ready === false ? (h.detail ?? 'not detected')
      : 'unknown';
    return (
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8 }}>
        <input
          type="radio"
          name="trainer-engine"
          value={id}
          checked={value === id}
          onChange={() => onChange(id)}
          style={{ marginTop: 3 }}
        />
        <span style={{ flex: 1 }}>
          <strong>{label}</strong>
          <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
            {h.ready === true ? '· ✓' : h.ready === false ? '· ⚠' : '·'} {detail}
          </span>
          {h.ready === false && h.hint && (
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
      <RadioRow id="codex" label="Codex" />
    </div>
  );
}
