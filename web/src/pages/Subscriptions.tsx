/**
 * Subscriptions page (helm-design PR 5 — lifted out of Settings).
 *
 * Subscribe a role to a remote `.helmrole` bundle URL. Cron polls
 * every 15 min; the matching storage plugin handles the transport
 * (built-in `file://`, external `tos://`, etc — see /plugins).
 *
 * Diff lands as candidates in Roles → Candidates tab unless
 * `autoApply` is on. Use sparingly — trusted sources only.
 *
 * Page template: T1 (single-action). helm-design PR 6 added <PageHeader/>
 * + <StatTile/> — the title row now lives in the shared primitive.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { ApiError, helmApi } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';
import { Button } from '../components/Button.js';
import { Card } from '../components/Card.js';
import { ConfirmDialog } from '../components/Dialog.js';
import { PageHeader } from '../components/PageHeader.js';
import { StatTile } from '../components/StatTile.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/Select.js';

export function SubscriptionsPage() {
  const subs = useApi(() => helmApi.listSubscriptions());
  const roles = useApi(() => helmApi.roles());
  const [roleId, setRoleId] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [autoApply, setAutoApply] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // helm-design PR 3: themed ConfirmDialog replaces window.confirm.
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // helm-design PR 9: action errors / successes → toasts (was inline <p>).
  function reportError(e: unknown): void {
    toast.error(e instanceof ApiError ? e.message : (e as Error).message);
  }

  async function add(): Promise<void> {
    if (!roleId || !sourceUrl) { toast.error('Select role + paste URL'); return; }
    setBusy(true);
    try {
      await helmApi.createSubscription({ roleId, sourceUrl, autoApply });
      setRoleId(''); setSourceUrl(''); setAutoApply(false);
      toast.success('Subscription added');
      subs.reload();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  }

  async function syncNow(id: string): Promise<void> {
    setBusyId(id);
    try {
      await helmApi.syncSubscriptionNow(id);
      subs.reload();
    } catch (e) {
      reportError(e);
    } finally {
      setBusyId(null);
    }
  }
  async function togglePaused(id: string, currentlyPaused: boolean): Promise<void> {
    setBusyId(id);
    try {
      await helmApi.setSubscriptionPaused(id, !currentlyPaused);
      subs.reload();
    } catch (e) {
      reportError(e);
    } finally {
      setBusyId(null);
    }
  }
  async function del(id: string): Promise<void> {
    setBusyId(id);
    try {
      await helmApi.deleteSubscription(id);
      toast.success('Subscription deleted');
      subs.reload();
    } catch (e) {
      reportError(e);
    } finally {
      setBusyId(null);
      setDeleteConfirm(null);
    }
  }

  // Phase 80 (PR C): conflict resolution. `use_remote` re-fetches the
  // bundle and writes candidates regardless of autoApply (a divergence
  // deserves human review). `keep_local` re-fetches just to learn the
  // current remote version and bumps last_pulled_version without
  // applying — explicit "I know remote changed, I don't want it".
  async function resolveConflict(id: string, strategy: 'use_remote' | 'keep_local'): Promise<void> {
    setBusyId(id);
    try {
      const r = await helmApi.resolveSubscriptionConflict(id, strategy);
      if (strategy === 'use_remote') {
        const n = r.candidatesCreated ?? 0;
        toast.success(n > 0 ? `Pulled remote — ${n} new candidates for review` : 'Pulled remote — no new chunks');
      } else {
        toast.success(`Marked resolved — local kept (acked remote v${r.pulledVersion ?? '?'})`);
      }
      subs.reload();
    } catch (e) {
      reportError(e);
    } finally {
      setBusyId(null);
    }
  }

  // helm-design PR 6: stats summarize what's been wired up. Errored
  // count flags subscriptions whose last sync failed so the user can
  // jump straight to the broken one.
  const allSubs = subs.data?.subscriptions ?? [];
  // PR C: errored counts only rows with status='error' (lastError is
  // also set on 'conflict' rows but those have their own tile).
  const erroredCount = allSubs.filter((s) => s.status === 'error').length;
  const pausedCount = allSubs.filter((s) => s.status === 'paused').length;
  const conflictCount = allSubs.filter((s) => s.status === 'conflict').length;

  return (
    <>
      <PageHeader
        title="Subscriptions"
        subtitle={<>Subscribe a role to a remote <code>.helmrole</code> bundle URL. Cron polls every 15 min; matching plugin handles the transport. Diff lands as candidates in the Roles → Candidates tab unless <em>auto-apply</em> is on (use sparingly — trusted sources only).</>}
        stats={<>
          <StatTile label="Active" value={allSubs.length - pausedCount - conflictCount - erroredCount} tone={allSubs.length - pausedCount - conflictCount - erroredCount > 0 ? 'live' : 'muted'} />
          <StatTile label="Paused" value={pausedCount} tone={pausedCount > 0 ? 'info' : 'muted'} />
          <StatTile label="Conflict" value={conflictCount} tone={conflictCount > 0 ? 'warn' : 'muted'} />
          <StatTile label="Errored" value={erroredCount} tone={erroredCount > 0 ? 'warn' : 'muted'} />
        </>}
      />

      <Card>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <Select value={roleId} onValueChange={setRoleId}>
            <SelectTrigger style={{ minWidth: 180 }}>
              {/* helm-design hotfix: Radix Select's <SelectValue> tracks
                  the selected item's ItemText via an internal registry
                  that doesn't refresh reliably when `value` changes
                  against async-loaded items (the role list comes from
                  /api/roles). Compute the display text from the current
                  roleId ourselves — children override Radix's default
                  rendering and re-evaluate on every render. */}
              <SelectValue placeholder="— role —">
                {roleId
                  ? ((roles.data?.roles ?? []).find((r) => r.id === roleId)?.name ?? roleId)
                  : undefined}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(roles.data?.roles ?? []).map((r) => (
                <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
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

        {subs.data && subs.data.subscriptions.length === 0 && (
          <p className="muted" style={{ fontSize: 12 }}>No subscriptions yet.</p>
        )}
        {subs.data && (
          <ul style={{ padding: 0, margin: 0, listStyle: 'none' }}>
            {subs.data.subscriptions.map((s) => (
              <li key={s.id} style={{
                marginBottom: 8, padding: 8,
                border: '1px solid var(--border)', borderRadius: 4,
                // PR C: tint the row when in conflict so it stands out
                // even before the user reads the status text.
                background: s.status === 'conflict' ? 'color-mix(in srgb, var(--warn, #f59e0b) 6%, var(--bg-elev))' : undefined,
                borderColor: s.status === 'conflict' ? 'var(--warn, #f59e0b)' : 'var(--border)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {/* helm-design hotfix: show the role's display name
                      instead of the raw role_id (e.g. "Developer Agent"
                      instead of "developer"). Fall back to the id when
                      the roles list hasn't loaded yet or the role was
                      deleted out from under this subscription. */}
                  <strong>
                    {(roles.data?.roles ?? []).find((r) => r.id === s.roleId)?.name ?? s.roleId}
                  </strong>
                  <span className="muted" style={{ fontSize: 11 }}>
                    · {s.sourceType}://… · <span style={{
                      color: s.status === 'conflict' ? 'var(--warn, #f59e0b)' : undefined,
                      fontWeight: s.status === 'conflict' ? 600 : 'normal',
                    }}>{s.status}</span>
                  </span>
                  <span style={{ flex: 1 }} />
                  {s.status === 'conflict' ? (
                    // PR C: replace the standard action row with resolve buttons
                    // when in conflict. Pause/Delete still useful as escape hatches.
                    <>
                      <button
                        disabled={busyId === s.id}
                        onClick={() => { void resolveConflict(s.id, 'use_remote'); }}
                        title="Re-fetch remote and write its chunks as candidates for review."
                      >
                        Use remote
                      </button>
                      <button
                        disabled={busyId === s.id}
                        onClick={() => { void resolveConflict(s.id, 'keep_local'); }}
                        title="Acknowledge remote without applying. Local stays as-is."
                      >
                        Keep local
                      </button>
                      <button
                        disabled={busyId === s.id}
                        onClick={() => setDeleteConfirm(s.id)}
                        style={{ color: 'var(--danger)' }}
                      >
                        Delete
                      </button>
                    </>
                  ) : (
                    <>
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
                    </>
                  )}
                </div>
                <div className="muted" style={{ fontSize: 11, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  <code>{s.sourceUrl}</code>
                </div>
                <div className="muted" style={{ fontSize: 11 }}>
                  {s.autoApply ? 'auto-apply on · ' : ''}
                  {s.lastSyncAt ? `synced ${s.lastSyncAt}` : 'never synced'}
                  {s.lastPulledVersion !== undefined && (
                    <> · last pulled v{s.lastPulledVersion}</>
                  )}
                  {s.lastError && (
                    <span style={{ color: s.status === 'conflict' ? 'var(--warn, #f59e0b)' : 'var(--danger)' }}>
                      {' '}· {s.status === 'conflict' ? '' : 'error: '}{s.lastError}
                    </span>
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
      </Card>
    </>
  );
}
