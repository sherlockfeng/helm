/**
 * Plugins page (helm-design PR 5 — lifted out of Settings).
 *
 * Lists the storage plugins helm has loaded. The built-in `file://`
 * scheme is always available; external plugins (e.g. `helm-storage-tos`)
 * load from `~/.helm/plugins/<id>/` when listed in
 * `config.plugins.enabled`.
 *
 * Currently read-only — enable/disable still happens by editing
 * `~/.helm/config.json` under the Settings → general view. A future PR
 * may add inline toggles here.
 *
 * Page template: T1 (single-action). PR 6 will introduce <PageHeader/>;
 * until then we render a bare <h2> so the route works.
 */

import { helmApi } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';

export function PluginsPage() {
  const { data, loading, error, reload } = useApi(() => helmApi.listPlugins());
  return (
    <>
      <h2>Plugins</h2>
      <p className="muted">
        Loaded storage plugins back role-bundle subscriptions. The built-in{' '}
        <code>file://</code> scheme is always available. External plugins
        (e.g. <code>helm-storage-tos</code>) load from{' '}
        <code>~/.helm/plugins/&lt;id&gt;/</code> when listed in{' '}
        <code>config.plugins.enabled</code>.
      </p>

      <article className="helm-card">
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
    </>
  );
}
