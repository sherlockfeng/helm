/**
 * Settings — edit `~/.helm/config.json` from the desktop UI.
 *
 * Sections:
 *   - HTTP API: port (restart required)
 *   - Lark integration: enable + cliCommand
 *   - Knowledge providers: Depscope (enable + endpoint + authToken + mappings)
 *   - Diagnostics: export bundle button
 *
 * Save sends PUT /api/config which validates server-side; field errors
 * surface as a banner. Phase 27 (D4) added knowledge-provider hot-reload —
 * the orchestrator drops + re-registers configured providers on save, so
 * Depscope mapping/endpoint changes take effect on the next session_start
 * without a restart. The HTTP-port change still needs a restart (the bound
 * server can't rebind without one). Save success banner auto-dismisses
 * after 4s (P1-8).
 */

import { useEffect, useRef, useState } from 'react';
import { ApiError, helmApi } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';
import { CopyButton } from '../components/CopyButton.js';
import { Button } from '../components/Button.js';
import { ConfirmDialog } from '../components/Dialog.js';
import type { HelmConfig, KnowledgeProviderConfig } from '../api/types.js';

/**
 * Curated list of Cursor models surfaced in the Settings dropdown. Cursor
 * doesn't publish a programmatic "list available models" endpoint, so this
 * is maintained manually — when Cursor ships a new model, add it here.
 *
 * `auto` (the default) lets Cursor pick per request. Listing the others
 * gives users a 1-click choice for the common cases without locking out
 * anything else: the dropdown has a "Custom…" escape hatch that flips
 * back to a free-text input.
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

export function SettingsPage() {
  const { data, loading, error, reload } = useApi(() => helmApi.getConfig());
  const [draft, setDraft] = useState<HelmConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const okTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (data && !draft) setDraft(clone(data));
  }, [data, draft]);

  useEffect(() => () => {
    if (okTimerRef.current) clearTimeout(okTimerRef.current);
  }, []);

  if (loading) return <p className="muted">Loading…</p>;
  if (error) return <p className="muted" style={{ color: 'var(--danger)' }}>{error.message}</p>;
  if (!draft) return null;

  const depscope = findDepscope(draft);
  const depscopeCfg: DepscopeConfig = (depscope?.provider.config ?? {}) as DepscopeConfig;

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

  async function save(): Promise<void> {
    if (!draft) return;
    setSaveError(null);
    setSaveOk(null);
    try {
      const saved = await helmApi.saveConfig(draft);
      setDraft(clone(saved));
      setDirty(false);
      setSaveOk('Saved. Knowledge provider changes apply immediately; HTTP port change requires a restart.');
      // P1-8: auto-dismiss after 4 seconds
      if (okTimerRef.current) clearTimeout(okTimerRef.current);
      okTimerRef.current = setTimeout(() => setSaveOk(null), 4000);
      reload();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setSaveError(msg);
    }
  }

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
    <>
      <h2>Settings</h2>
      <p className="muted">
        Lives in <code>~/.helm/config.json</code>. Knowledge-provider changes apply immediately on save;
        HTTP port changes require a Helm restart.
      </p>

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

      {/* Phase 68: global default engine. Drives summarizer / Harness
          reviewer / Roles training-chat. Placed at the top of Settings
          because the rest of the page mostly tunes engine-specific knobs
          (Cursor mode/key, Harness conventions). */}
      <h3>Default engine</h3>
      <article className="helm-card">
        <DefaultEngineField
          value={draft.engine?.default ?? 'claude'}
          onChange={(id) => update((c) => {
            if (!c.engine) c.engine = { default: id };
            else c.engine.default = id;
          })}
        />
        <p className="muted" style={{ fontSize: 11, marginTop: 8, marginBottom: 0 }}>
          Picks which LLM engine drives the Campaign summarizer, the
          Harness reviewer subprocess, and the Roles "Train via chat"
          modal. Settings save takes effect on the next request — no
          restart needed. Switching engines does NOT migrate already-saved
          summaries or review reports.
        </p>
      </article>

      {/* P1-3: section headings outside cards, max-width container */}
      <h3>HTTP API</h3>
      <article className="helm-card">
        <label className="helm-form-row">
          <div className="muted">Port</div>
          <input
            type="number"
            min={1}
            max={65535}
            value={draft.server.port}
            onChange={(e) => update((c) => { c.server.port = Number(e.target.value); })}
            style={{ width: 120 }}
          />
        </label>
        <p className="muted" style={{ fontSize: 11, marginTop: 8, marginBottom: 0 }}>
          Bound to 127.0.0.1 only. Change requires a Helm restart.
        </p>
      </article>

      <h3>Lark integration</h3>
      <article className="helm-card">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={draft.lark.enabled}
            onChange={(e) => update((c) => { c.lark.enabled = e.target.checked; })}
          />
          Enable Lark channel
        </label>
        <label className="helm-form-row">
          <div className="muted">lark-cli command (path or name on PATH)</div>
          <input
            type="text"
            value={draft.lark.cliCommand ?? ''}
            placeholder="auto (uses LARK_CLI_COMMAND env or bundled binary)"
            onChange={(e) => update((c) => { c.lark.cliCommand = e.target.value || undefined; })}
          />
        </label>
      </article>

      <h3>Doc-first workflow</h3>
      <article className="helm-card">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={draft.docFirst.enforce}
            onChange={(e) => update((c) => { c.docFirst.enforce = e.target.checked; })}
          />
          Enforce <code>update_doc_first</code> before completing dev tasks
        </label>
        <p className="muted" style={{ fontSize: 11, marginTop: 8, marginBottom: 0 }}>
          When on, dev tasks need a fresh docAuditToken to complete. Disable for
          casual / one-off Cursor sessions where the doc-first cadence isn't
          worth the friction. Takes effect on the next task completion — no
          restart required.
        </p>
      </article>

      <h3>Cursor (campaign summarization)</h3>
      <article className="helm-card">
        <label className="helm-form-row">
          <div className="muted">Mode</div>
          <select
            value={draft.cursor.mode}
            onChange={(e) => update((c) => { c.cursor.mode = e.target.value as 'local' | 'cloud'; })}
            style={{ width: 200 }}
          >
            <option value="local">local (use Cursor app auth)</option>
            <option value="cloud">cloud (CURSOR_API_KEY required)</option>
          </select>
        </label>
        <CursorModelField
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
        <p className="muted" style={{ fontSize: 11, marginTop: 8, marginBottom: 0 }}>
          Powers the Summarize button on Campaigns. <strong>local</strong> mode
          reuses your Cursor app's auth — no extra key needed when you have
          Cursor installed. <strong>cloud</strong> needs a Cursor API key
          (here or via <code>CURSOR_API_KEY</code> env). Settings save takes
          effect on the next click; no restart needed.
        </p>
      </article>

      <h3>Harness Conventions</h3>
      <article className="helm-card">
        <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
          Free-form project conventions injected into every Harness review subprocess.
          The reviewer sees this text alongside Intent, Structure, and the diff —
          but never the implementer's Decisions or Stage Log (information isolation).
          Edit here, save, and the next review picks up the change.
        </p>
        <label className="helm-form-row" style={{ display: 'block' }}>
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
        </label>
      </article>

      {/* Phase 77: knowledge lifecycle thresholds. Background sweep + decay
          re-rank read these on every tick / search. Defaults preserved when
          fields are blank (backend zod schema fills them in). */}
      <h3>Knowledge lifecycle</h3>
      <article className="helm-card">
        <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
          Controls when stale role-knowledge chunks get soft-archived (hidden
          from search by default) and how strongly recent access biases the
          retrieval ranking. Changes apply to the next sweep / next search —
          no restart needed.
        </p>
        <label className="helm-form-row">
          <div className="muted">Archive after (days)</div>
          <input
            type="number"
            min={1}
            value={draft.knowledge.lifecycle?.archiveAfterDays ?? 90}
            onChange={(e) => update((c) => {
              if (!c.knowledge.lifecycle) {
                c.knowledge.lifecycle = {
                  archiveAfterDays: 90,
                  archiveBelowAccessCount: 3,
                  decayTauDays: 30,
                  decayAlpha: 0.3,
                };
              }
              c.knowledge.lifecycle.archiveAfterDays = Math.max(1, Number(e.target.value) || 90);
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
              if (!c.knowledge.lifecycle) {
                c.knowledge.lifecycle = {
                  archiveAfterDays: 90,
                  archiveBelowAccessCount: 3,
                  decayTauDays: 30,
                  decayAlpha: 0.3,
                };
              }
              c.knowledge.lifecycle.archiveBelowAccessCount = Math.max(0, Number(e.target.value) || 0);
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
              if (!c.knowledge.lifecycle) {
                c.knowledge.lifecycle = {
                  archiveAfterDays: 90,
                  archiveBelowAccessCount: 3,
                  decayTauDays: 30,
                  decayAlpha: 0.3,
                };
              }
              c.knowledge.lifecycle.decayTauDays = Math.max(1, Number(e.target.value) || 30);
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
              if (!c.knowledge.lifecycle) {
                c.knowledge.lifecycle = {
                  archiveAfterDays: 90,
                  archiveBelowAccessCount: 3,
                  decayTauDays: 30,
                  decayAlpha: 0.3,
                };
              }
              c.knowledge.lifecycle.decayAlpha = Math.min(1, Math.max(0, Number(e.target.value) || 0));
            })}
            style={{ width: 120 }}
          />
        </label>
        <p className="muted" style={{ fontSize: 11, marginTop: 8, marginBottom: 0 }}>
          Defaults: 90d / access&lt;3 / τ=30d / α=0.3. A chunk is archived only
          when BOTH "older than archive-after" AND "fewer accesses than
          threshold" are true. α=0 disables the decay re-rank entirely
          (Phase 76 fusion runs unchanged).
        </p>
      </article>

      <h3>Depscope (knowledge provider)</h3>
      <article className="helm-card">
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
      </article>

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <Button variant="primary" disabled={!dirty} onClick={() => { void save(); }}>
          Save
        </Button>
        <button
          disabled={!dirty}
          onClick={() => {
            setDraft(data ? clone(data) : null);
            setDirty(false);
            setSaveError(null);
            setSaveOk(null);
          }}
        >
          Revert
        </button>
      </div>

      {/* Phase 79: storage plugins (read-only) + role subscriptions.
          Lives between Depscope (knowledge provider config) and
          Diagnostics — logical grouping with "things that fetch
          knowledge into helm". */}
      <h3>Storage plugins</h3>
      <StoragePluginsCard />

      <h3>Role subscriptions</h3>
      <RoleSubscriptionsCard />

      <h3>Diagnostics</h3>
      <article className="helm-card">
        <p className="muted" style={{ marginTop: 0 }}>
          Export a bundle of recent logs + redacted config + schema version + bridge state to
          attach to a bug report. Saved under <code>~/.helm/</code>.
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
      </article>
    </>
  );
}

/**
 * Model picker for Cursor: dropdown of KNOWN_CURSOR_MODELS + a "Custom…"
 * option that flips back to a free-text input. The free-text mode is
 * sticky for the current edit session — once the user picks Custom we
 * keep showing the text input until they switch back to a known model
 * via the dropdown.
 */
function CursorModelField({
  value,
  onChange,
}: {
  value: string;
  onChange: (model: string) => void;
}) {
  const isKnown = KNOWN_CURSOR_MODELS.some((m) => m.id === value);
  const [showCustom, setShowCustom] = useState(!isKnown);

  const useCustom = showCustom || !isKnown;

  return (
    <label className="helm-form-row">
      <div className="muted">Model</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          value={useCustom ? '__custom__' : value}
          onChange={(e) => {
            if (e.target.value === '__custom__') {
              setShowCustom(true);
              return;
            }
            setShowCustom(false);
            onChange(e.target.value);
          }}
          style={{ minWidth: 220 }}
        >
          {KNOWN_CURSOR_MODELS.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
          <option value="__custom__">Custom…</option>
        </select>
        {useCustom && (
          <input
            type="text"
            value={value}
            placeholder="model id (e.g. cursor-fast)"
            onChange={(e) => onChange(e.target.value)}
            style={{ flex: 1, minWidth: 180 }}
          />
        )}
      </div>
    </label>
  );
}

/**
 * Default-engine picker (Phase 68). Renders two radio rows — one per
 * engine — alongside a "ready / missing" status line fetched from
 * `/api/engine/health`. The status line includes the actionable hint
 * ("Run `claude login`" / "Install cursor-agent CLI") when ready=false,
 * so the user can fix the issue without leaving Settings.
 */
function DefaultEngineField({
  value,
  onChange,
}: {
  value: 'cursor' | 'claude';
  onChange: (id: 'cursor' | 'claude') => void;
}) {
  const { data, loading, error } = useApi(() => helmApi.engineHealth());
  const healths = data?.engines ?? [];
  const find = (id: 'cursor' | 'claude') => healths.find((h) => h.engine === id);

  function RadioRow({ id, label }: { id: 'cursor' | 'claude'; label: string }) {
    const h = find(id);
    const detailMissing = loading
      ? 'detecting…'
      : error
        ? 'health unknown'
        : h
          ? (h.ready ? `ready (${h.detail})` : h.detail)
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

// ── Phase 79: Storage plugins + Role subscriptions ────────────────────

function StoragePluginsCard() {
  const { data, loading, error, reload } = useApi(() => helmApi.listPlugins());
  return (
    <article className="helm-card">
      <p className="muted" style={{ marginTop: 0 }}>
        Loaded storage plugins back role-bundle subscriptions. The
        built-in <code>file://</code> scheme is always available. External
        plugins (e.g. <code>helm-storage-tos</code>) load from{' '}
        <code>~/.helm/plugins/&lt;id&gt;/</code> when listed in{' '}
        <code>config.plugins.enabled</code>.
      </p>
      <div style={{ marginBottom: 8 }}>
        <button type="button" onClick={() => reload()} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      {error && <p style={{ color: 'var(--danger)' }}>{error.message}</p>}
      {data && data.plugins.length === 0 && (
        <p className="muted" style={{ fontSize: 12 }}>No plugins reported by helm.</p>
      )}
      {data && (
        <ul style={{ padding: 0, margin: 0, listStyle: 'none' }}>
          {data.plugins.map((p) => (
            <li key={p.id} style={{
              marginBottom: 6,
              padding: 6,
              border: '1px solid var(--border)',
              borderRadius: 4,
            }}>
              {p.ok ? (
                <>
                  <strong>{p.id}</strong>
                  <span className="muted" style={{ marginLeft: 8, fontSize: 11 }}>
                    scheme=<code>{p.scheme}</code> · v{p.version} · apiVersion={p.apiVersion}
                  </span>
                  <div className="muted" style={{ fontSize: 11 }}>{p.loadedFrom}</div>
                </>
              ) : (
                <>
                  <strong style={{ color: 'var(--danger)' }}>{p.id} — failed</strong>
                  <div className="muted" style={{ fontSize: 11 }}>{p.reason}</div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function RoleSubscriptionsCard() {
  const subs = useApi(() => helmApi.listSubscriptions());
  const roles = useApi(() => helmApi.roles());
  const [roleId, setRoleId] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [autoApply, setAutoApply] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // helm-design PR 3: replace window.confirm with themed ConfirmDialog.
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  async function add(): Promise<void> {
    if (!roleId || !sourceUrl) { setErr('Select role + paste URL'); return; }
    setBusy(true); setErr(null);
    try {
      await helmApi.createSubscription({ roleId, sourceUrl, autoApply });
      setRoleId(''); setSourceUrl(''); setAutoApply(false);
      subs.reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function syncNow(id: string): Promise<void> {
    setBusyId(id); setErr(null);
    try {
      await helmApi.syncSubscriptionNow(id);
      subs.reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusyId(null);
    }
  }
  async function togglePaused(id: string, currentlyPaused: boolean): Promise<void> {
    setBusyId(id); setErr(null);
    try {
      await helmApi.setSubscriptionPaused(id, !currentlyPaused);
      subs.reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusyId(null);
    }
  }
  async function del(id: string): Promise<void> {
    setBusyId(id); setErr(null);
    try {
      await helmApi.deleteSubscription(id);
      subs.reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusyId(null);
      setDeleteConfirm(null);
    }
  }

  return (
    <article className="helm-card">
      <p className="muted" style={{ marginTop: 0 }}>
        Subscribe a role to a remote <code>.helmrole</code> bundle URL.
        Cron polls every 15 min; matching plugin handles the transport.
        Diff lands as candidates in the Roles → Candidates tab unless
        <em> auto-apply</em> is on (use sparingly — trusted sources only).
      </p>

      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <select
          value={roleId}
          onChange={(e) => setRoleId(e.target.value)}
          style={{ minWidth: 180 }}
        >
          <option value="">— role —</option>
          {(roles.data?.roles ?? []).map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
        <input
          type="text"
          value={sourceUrl}
          placeholder="tos://bucket/roles/goofy.helmrole or file:///abs/path/goofy.helmrole"
          onChange={(e) => setSourceUrl(e.target.value)}
          style={{ flex: 1 }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={autoApply}
            onChange={(e) => setAutoApply(e.target.checked)}
          />
          auto-apply
        </label>
        <Button variant="primary" onClick={() => { void add(); }} disabled={busy}>
          {busy ? 'Adding…' : 'Add'}
        </Button>
      </div>

      {err && <p style={{ color: 'var(--danger)' }}>{err}</p>}

      {subs.data && subs.data.subscriptions.length === 0 && (
        <p className="muted" style={{ fontSize: 12 }}>No subscriptions yet.</p>
      )}
      {subs.data && (
        <ul style={{ padding: 0, margin: 0, listStyle: 'none' }}>
          {subs.data.subscriptions.map((s) => (
            <li key={s.id} style={{
              marginBottom: 8, padding: 8,
              border: '1px solid var(--border)', borderRadius: 4,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <strong>{s.roleId}</strong>
                <span className="muted" style={{ fontSize: 11 }}>
                  · {s.sourceType}://… · {s.status}
                </span>
                <span style={{ flex: 1 }} />
                <button
                  disabled={busyId === s.id}
                  onClick={() => { void syncNow(s.id); }}
                >
                  {busyId === s.id ? '…' : 'Sync now'}
                </button>
                <button
                  disabled={busyId === s.id}
                  onClick={() => { void togglePaused(s.id, s.status === 'paused'); }}
                >
                  {s.status === 'paused' ? 'Resume' : 'Pause'}
                </button>
                <button
                  disabled={busyId === s.id}
                  onClick={() => setDeleteConfirm(s.id)}
                  style={{ color: 'var(--danger)' }}
                >
                  Delete
                </button>
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                <code>{s.sourceUrl}</code>
              </div>
              <div className="muted" style={{ fontSize: 11 }}>
                {s.autoApply ? 'auto-apply on · ' : ''}
                {s.lastSyncAt ? `synced ${s.lastSyncAt}` : 'never synced'}
                {s.lastError && (
                  <span style={{ color: 'var(--danger)' }}> · error: {s.lastError}</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={deleteConfirm !== null}
        onOpenChange={(o) => { if (!o) setDeleteConfirm(null); }}
        title="Delete this subscription?"
        description="Accepted chunks stay in the role; only the sync stops."
        confirmLabel="Delete"
        onConfirm={() => { if (deleteConfirm) void del(deleteConfirm); }}
        busy={busyId !== null && busyId === deleteConfirm}
      />
    </article>
  );
}
