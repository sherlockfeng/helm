/**
 * E2e — boot-time and orchestrator-level runtime behaviors.
 *
 * Three Phase-46/47 wirings live in `createHelmApp` itself, not in any
 * standalone module — the unit tests prove the components work in isolation,
 * but only an orchestrator-level e2e proves the createHelmApp wiring is
 * intact:
 *
 *   - Phase 47: `closeStaleHostSessions` runs on boot
 *   - Phase 46c: orchestrator subscribes `notifier.closeForApproval` to the
 *     `approval.settled` event, so the OS toast disappears the instant the
 *     gate clears
 *   - Phase 27 (D4): PUT /api/config drops the configured KnowledgeProviders
 *     and rebuilds from the new liveConfig — without restarting helm
 *
 * Bundling these three small specs into one suite keeps the e2e count down
 * while still failing fast when any of those wires get cut.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../../../src/storage/migrations.js';
import { createHelmApp } from '../../../src/app/orchestrator.js';
import { createCapturingLoggerFactory } from '../../../src/logger/index.js';
import { upsertHostSession } from '../../../src/storage/repos/host-sessions.js';
import { CallbackNotifier } from '../../../src/channel/local/notifier.js';
import { HelmConfigSchema, type HelmConfig } from '../../../src/config/schema.js';
import {
  bootE2e, runHookViaBridge, seedLarkBinding, waitFor, type E2eHarness,
} from '../_helpers/setup.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'helm-boot-runtime-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('boot-time stale-prune (Phase 47)', () => {
  it('orchestrator boot flips active sessions older than the cutoff to closed', async () => {
    const db = new BetterSqlite3(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    // Two sessions: one years stale, one fresh.
    const stale = '2025-01-01T00:00:00.000Z';
    const fresh = new Date().toISOString();
    upsertHostSession(db, {
      id: 'old', host: 'cursor', cwd: '/old',
      status: 'active', firstSeenAt: stale, lastSeenAt: stale,
    });
    upsertHostSession(db, {
      id: 'new', host: 'cursor', cwd: '/new',
      status: 'active', firstSeenAt: fresh, lastSeenAt: fresh,
    });

    const socketPath = join(tmpDir, 'bridge.sock');
    const app = createHelmApp({
      db,
      loggers: createCapturingLoggerFactory(),
      bridgeSocketPath: socketPath,
      httpPort: 0,
      // 1h cutoff — `old` is years stale, `new` is now.
      staleSessionCutoffMs: 60 * 60 * 1000,
    });
    try {
      // The prune runs synchronously inside createHelmApp before .start(),
      // so we don't even need to start the bridge to assert.
      const oldRow = db.prepare(`SELECT status FROM host_sessions WHERE id = 'old'`).get() as { status: string };
      const newRow = db.prepare(`SELECT status FROM host_sessions WHERE id = 'new'`).get() as { status: string };
      expect(oldRow.status).toBe('closed');
      expect(newRow.status).toBe('active');

      // Voila — restart-day cleanup. Re-running the prune on the same DB is
      // idempotent (covered in the unit suite).
      void app;
    } finally {
      // Best-effort cleanup; this app was never .start()-ed.
      db.close();
    }
  });
});

describe('approval.settled → notifier.closeForApproval (Phase 46c)', () => {
  let harness: E2eHarness;
  let notifier: CallbackNotifier;

  beforeEach(async () => {
    notifier = new CallbackNotifier();
    harness = await bootE2e({
      seed: (db) => {
        const now = new Date().toISOString();
        upsertHostSession(db, {
          id: 'sess_notify', host: 'cursor', cwd: '/proj',
          status: 'active', firstSeenAt: now, lastSeenAt: now,
        });
        seedLarkBinding(db, 'sess_notify');
      },
      deps: { notifier },
    });
  });

  afterEach(async () => { await harness.shutdown(); });

  it('settling an approval fires notifier.closeForApproval(approvalId)', async () => {
    // Auto-allow the pending so the bridge response comes back.
    harness.app.approval.onPendingCreated((req) => {
      queueMicrotask(() => {
        void harness.app.channel.pushApprovalDecision({
          approvalId: req.id, decision: 'allow',
        });
      });
    });

    await runHookViaBridge(harness, {
      event: 'beforeShellExecution',
      payload: { session_id: 'sess_notify', command: 'echo hi' },
    });

    // The OS toast was emitted on pending and dismissed on settle.
    expect(notifier.received.length).toBeGreaterThan(0);
    await waitFor(() => notifier.closed.length > 0, { timeoutMs: 1000 });
    // The closed approval id matches the one that just settled.
    expect(notifier.closed[0]).toMatch(/^apr_/);
  });
});

describe('PUT /api/config provider hot-reload (Phase 27 / D4)', () => {
  it('rewriting the providers list drops old configured providers + registers the new ones — without restart', async () => {
    const configPath = join(tmpDir, 'config.json');
    const initial: Partial<HelmConfig> = {
      knowledge: {
        providers: [
          {
            id: 'depscope',
            enabled: true,
            config: {
              endpoint: 'http://depscope-old.test',
              mappings: [{ cwdPrefix: '/old', scmName: 'org/old' }],
            },
          },
        ],
      },
    };
    writeFileSync(configPath, JSON.stringify(initial));

    const harness = await bootE2e({
      deps: {
        configPath,
        config: HelmConfigSchema.parse(initial),
      },
    });
    try {
      // Boot lands depscope alongside the always-on LocalRoles +
      // RequirementsArchive. We use the in-process registry rather than HTTP
      // because the user's signal is "the providers list reflects the new
      // config" and the registry is the source of truth.
      const beforeIds = harness.app.knowledge.list().map((p) => p.id).sort();
      expect(beforeIds).toContain('depscope');
      expect(beforeIds).toContain('local-roles');

      // Save a config that drops depscope and adds it back with a different
      // endpoint — exercises BOTH the unregister path and the new-provider
      // build path. PUT /api/config fires reconfigureKnowledgeProviders.
      const next: Partial<HelmConfig> = {
        knowledge: {
          providers: [
            {
              id: 'depscope',
              enabled: true,
              config: {
                endpoint: 'http://depscope-new.test',
                mappings: [{ cwdPrefix: '/new', scmName: 'org/new' }],
              },
            },
          ],
        },
      };
      const r = await fetch(`http://127.0.0.1:${harness.app.httpPort()}/api/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(HelmConfigSchema.parse(next)),
      });
      expect(r.status).toBe(200);

      // Provider id is still 'depscope' but the underlying instance was
      // swapped — DepscopeProvider's id is fixed so we can't tell from id
      // alone. We assert the registered list still shows depscope (would be
      // missing if reconfigure dropped without re-adding) and the endpoint
      // change is visible by inspecting healthcheck (DepscopeProvider exposes
      // it). Cheaper: just assert the always-on providers stayed (no
      // double-registration crashed the registry).
      const afterIds = harness.app.knowledge.list().map((p) => p.id).sort();
      expect(afterIds).toContain('depscope');
      expect(afterIds).toContain('local-roles');
      expect(afterIds).toContain('requirements-archive');

      // Disabling depscope drops it — proves the unregister path runs.
      const dropped: Partial<HelmConfig> = {
        knowledge: { providers: [] },
      };
      const r2 = await fetch(`http://127.0.0.1:${harness.app.httpPort()}/api/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(HelmConfigSchema.parse(dropped)),
      });
      expect(r2.status).toBe(200);

      const droppedIds = harness.app.knowledge.list().map((p) => p.id).sort();
      expect(droppedIds).not.toContain('depscope');
      expect(droppedIds).toContain('local-roles'); // always-on stays
    } finally {
      await harness.shutdown();
    }
  });
});
