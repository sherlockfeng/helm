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
            <button
              type="button"
              className="danger-outline"
              aria-label={`Remove mapping for ${m.cwdPrefix || '(unset prefix)'}`}
              onClick={() => update((c) => {
                const found = ensureDepscope(c);
                const cfg = (found.provider.config ?? {}) as DepscopeConfig;
                cfg.mappings = (cfg.mappings ?? []).filter((_, idx) => idx !== i);
                found.provider.config = cfg as Record<string, unknown>;
              })}
            >Remove</button>
          </div>
        ))}
        <button
          type="button"
          className="ghost"
          style={{ marginTop: 10 }}
          onClick={() => update((c) => {
            const found = ensureDepscope(c);
            const cfg = (found.provider.config ?? {}) as DepscopeConfig;
            cfg.mappings = [...(cfg.mappings ?? []), { cwdPrefix: '', scmName: '' }];
            found.provider.config = cfg as Record<string, unknown>;
          })}
        >+ Add mapping</button>
      </article>

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button className="primary" disabled={!dirty} onClick={() => { void save(); }}>
          Save
        </button>
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
 *
 * The component derives "is custom" from whether the saved value is in
 * KNOWN_CURSOR_MODELS, plus a local override the user can toggle. That
 * way an existing config with model="some-future-cursor-thing" naturally
 * renders in custom mode without losing the value.
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
              // Don't clobber the existing model string — let the user edit it.
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
