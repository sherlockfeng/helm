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
 * Page template: T1 (single-action). helm-design PR 6 added <PageHeader/>
 * + <StatTile/> — the title row now lives in the shared primitive.
 */

import { useEffect } from 'react';
import { toast } from 'sonner';
import { helmApi } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';
import { Card } from '../components/Card.js';
import { PageHeader } from '../components/PageHeader.js';
import { StatTile } from '../components/StatTile.js';

export function PluginsPage() {
  const { data, loading, error, reload } = useApi(() => helmApi.listPlugins());

  // helm-design PR 9: load errors → toast.
  useEffect(() => {
    if (error) toast.error(`Plugins: ${error.message}`, { id: 'plugins-load' });
  }, [error]);

  // helm-design PR 6: stats summarize the load result. A failed
  // plugin is a hot pointer the user should resolve.
  const all = data?.plugins ?? [];
  const okCount = all.filter((p) => p.ok).length;
  const failedCount = all.length - okCount;

  return (
    <>
      <PageHeader
        title="Plugins"
        subtitle={<>Loaded storage plugins back role-bundle subscriptions. The built-in <code>file://</code> scheme is always available. External plugins (e.g. <code>helm-storage-tos</code>) load from <code>~/.helm/plugins/&lt;id&gt;/</code> when listed in <code>config.plugins.enabled</code>.</>}
        stats={<>
          <StatTile label="Loaded" value={okCount} tone={okCount > 0 ? 'live' : 'muted'} />
          <StatTile label="Failed" value={failedCount} tone={failedCount > 0 ? 'warn' : 'muted'} />
        </>}
      />

      <Card>
        <div style={{ marginBottom: 8 }}>
          <button type="button" onClick={() => reload()} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
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
      </Card>
    </>
  );
}
