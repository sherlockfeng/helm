/**
 * Settings — edit `~/.helm/config.json` from the desktop UI.
 *
 * Three sections:
 *   - Server: HTTP port (read-only hint; restart required to change)
 *   - Lark: enable + cliCommand
 *   - Knowledge providers: enable + endpoint + authToken + cwd→scmName mappings
 *     (depscope only for now; future providers register the same way)
 *
 * Save sends PUT /api/config which validates server-side; field errors
 * surface as a banner. Provider hot-reload is a future refinement; for now
 * we tell the user "restart Helm to apply provider changes".
 */

import { useEffect, useState } from 'react';
import { ApiError, helmApi } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';
import type { HelmConfig, KnowledgeProviderConfig } from '../api/types.js';

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

  useEffect(() => {
    if (data && !draft) setDraft(clone(data));
  }, [data, draft]);

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
      setSaveOk('Saved. Provider changes apply on next Helm restart.');
      reload();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setSaveError(msg);
    }
  }

  async function exportBundle(): Promise<void> {
    setDiagnostics(null);
    try {
      const r = await helmApi.exportDiagnostics();
      setDiagnostics(r.bundleDir);
    } catch (err) {
      setDiagnostics(`failed: ${(err as Error).message}`);
    }
  }

  return (
    <>
      <h2>Settings</h2>
      <p className="muted">
        Lives in <code>~/.helm/config.json</code>. Provider hot-reload is not yet wired; restart
        Helm after enabling a new provider for it to take effect.
      </p>

      {saveOk && (
        <div className="helm-card" style={{ borderColor: 'var(--success)' }}>
          <span className="helm-status ok"><span className="dot" />{saveOk}</span>
        </div>
      )}
      {saveError && (
        <div className="helm-card" style={{ borderColor: 'var(--danger)' }}>
          <span className="helm-status err"><span className="dot" />{saveError}</span>
        </div>
      )}

      <article className="helm-card">
        <div className="label">HTTP API</div>
        <label style={{ display: 'block', marginTop: 8 }}>
          Port&nbsp;
          <input
            type="number"
            min={1}
            max={65535}
            value={draft.server.port}
            onChange={(e) => update((c) => { c.server.port = Number(e.target.value); })}
            style={{ width: 100 }}
          />
        </label>
        <p className="muted" style={{ fontSize: 11, marginTop: 6, marginBottom: 0 }}>
          Bound to 127.0.0.1 only. Change requires a Helm restart.
        </p>
      </article>

      <article className="helm-card">
        <div className="label">Lark integration</div>
        <label style={{ display: 'block', marginTop: 8 }}>
          <input
            type="checkbox"
            checked={draft.lark.enabled}
            onChange={(e) => update((c) => { c.lark.enabled = e.target.checked; })}
          />{' '}
          Enable Lark channel
        </label>
        <label style={{ display: 'block', marginTop: 8 }}>
          <div className="muted" style={{ marginBottom: 4 }}>lark-cli command (path or name on PATH)</div>
          <input
            type="text"
            value={draft.lark.cliCommand ?? ''}
            placeholder="auto (uses LARK_CLI_COMMAND env or bundled binary)"
            onChange={(e) => update((c) => { c.lark.cliCommand = e.target.value || undefined; })}
            style={{ width: '100%', padding: '4px 8px' }}
          />
        </label>
      </article>

      <article className="helm-card">
        <div className="label">Depscope (knowledge provider)</div>
        <label style={{ display: 'block', marginTop: 8 }}>
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
          />{' '}
          Enabled
        </label>
        <label style={{ display: 'block', marginTop: 8 }}>
          <div className="muted" style={{ marginBottom: 4 }}>Endpoint URL</div>
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
            style={{ width: '100%', padding: '4px 8px' }}
          />
        </label>
        <label style={{ display: 'block', marginTop: 8 }}>
          <div className="muted" style={{ marginBottom: 4 }}>Auth token</div>
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
            style={{ width: '100%', padding: '4px 8px' }}
          />
        </label>

        <div className="label" style={{ marginTop: 14 }}>cwd → scmName mappings</div>
        {(depscopeCfg.mappings ?? []).map((m, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <input
              type="text"
              value={m.cwdPrefix}
              placeholder="~/proj/foo"
              onChange={(e) => update((c) => {
                const found = ensureDepscope(c);
                const cfg = (found.provider.config ?? {}) as DepscopeConfig;
                cfg.mappings = (cfg.mappings ?? []).map((mm, idx) => idx === i ? { ...mm, cwdPrefix: e.target.value } : mm);
                found.provider.config = cfg as Record<string, unknown>;
              })}
              style={{ flex: 1, padding: '4px 8px' }}
            />
            <input
              type="text"
              value={m.scmName}
              placeholder="org/repo"
              onChange={(e) => update((c) => {
                const found = ensureDepscope(c);
                const cfg = (found.provider.config ?? {}) as DepscopeConfig;
                cfg.mappings = (cfg.mappings ?? []).map((mm, idx) => idx === i ? { ...mm, scmName: e.target.value } : mm);
                found.provider.config = cfg as Record<string, unknown>;
              })}
              style={{ flex: 1, padding: '4px 8px' }}
            />
            <button
              className="danger"
              onClick={() => update((c) => {
                const found = ensureDepscope(c);
                const cfg = (found.provider.config ?? {}) as DepscopeConfig;
                cfg.mappings = (cfg.mappings ?? []).filter((_, idx) => idx !== i);
                found.provider.config = cfg as Record<string, unknown>;
              })}
              style={{ padding: '4px 10px' }}
            >Remove</button>
          </div>
        ))}
        <button
          style={{ marginTop: 8 }}
          onClick={() => update((c) => {
            const found = ensureDepscope(c);
            const cfg = (found.provider.config ?? {}) as DepscopeConfig;
            cfg.mappings = [...(cfg.mappings ?? []), { cwdPrefix: '', scmName: '' }];
            found.provider.config = cfg as Record<string, unknown>;
          })}
        >+ Add mapping</button>
      </article>

      <div className="actions" style={{ display: 'flex', gap: 8 }}>
        <button className="primary" disabled={!dirty} onClick={() => { void save(); }}>
          Save
        </button>
        <button disabled={!dirty} onClick={() => { setDraft(data ? clone(data) : null); setDirty(false); setSaveError(null); setSaveOk(null); }}>
          Revert
        </button>
      </div>

      <h3 style={{ marginTop: 32, fontSize: 14, fontWeight: 600 }}>Diagnostics</h3>
      <article className="helm-card">
        <p className="muted" style={{ marginTop: 0 }}>
          Export a bundle of recent logs + redacted config + schema version + bridge state to
          attach to a bug report. Saved under <code>~/.helm/</code>.
        </p>
        <button onClick={() => { void exportBundle(); }}>Export diagnostics bundle</button>
        {diagnostics && (
          <p className="muted" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
            Bundle: <code>{diagnostics}</code>
          </p>
        )}
      </article>
    </>
  );
}
