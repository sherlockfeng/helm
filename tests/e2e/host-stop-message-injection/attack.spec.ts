/**
 * E2e attacks for host-stop-message-injection.
 *
 * Verifies the long-poll's failure modes: timeout when nothing arrives,
 * unrelated-binding events don't trigger spurious wakeups, and an empty-text
 * queue entry isn't injected as a blank prompt.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootE2e, runHookViaBridge, type E2eHarness } from '../_helpers/setup.js';
import { upsertHostSession } from '../../../src/storage/repos/host-sessions.js';
import {
  enqueueMessage,
  insertChannelBinding,
} from '../../../src/storage/repos/channel-bindings.js';

let harness: E2eHarness;
const SESSION_ID = 'sess_stop_atk';

beforeEach(async () => {
  harness = await bootE2e({
    deps: { waitPollMs: 200 },
    seed: (db) => {
      const now = new Date().toISOString();
      upsertHostSession(db, {
        id: SESSION_ID, host: 'cursor', cwd: '/proj',
        status: 'active', firstSeenAt: now, lastSeenAt: now,
      });
    },
  });
});

afterEach(async () => { await harness.shutdown(); });

function bindAChannel(sessionId = SESSION_ID): string {
  const bindingId = randomUUID();
  insertChannelBinding(harness.db, {
    id: bindingId,
    channel: 'lark',
    hostSessionId: sessionId,
    externalChat: `oc_${bindingId}`,
    externalThread: `om_${bindingId}`,
    waitEnabled: true,
    createdAt: new Date().toISOString(),
  });
  return bindingId;
}

describe('host-stop-message-injection attacks', () => {
  it('attack: poll budget exhausted with no message → empty response, no spurious followup', async () => {
    bindAChannel();

    const start = Date.now();
    const r = await runHookViaBridge(harness, {
      event: 'stop',
      payload: { session_id: SESSION_ID },
    }) as Record<string, unknown>;
    const elapsed = Date.now() - start;

    expect(r['followup_message']).toBeUndefined();
    // Slept the full budget (200 ms ± slack) before timing out.
    expect(elapsed).toBeGreaterThanOrEqual(180);
  });

  it('attack: enqueue against an UNRELATED session does not wake our hook', async () => {
    bindAChannel(); // for our session

    // A second session with its own binding receives a message — must not
    // bleed into our long-poll.
    const otherSessionId = 'sess_other';
    const now = new Date().toISOString();
    upsertHostSession(harness.db, {
      id: otherSessionId, host: 'cursor', cwd: '/other',
      status: 'active', firstSeenAt: now, lastSeenAt: now,
    });
    const otherBinding = randomUUID();
    insertChannelBinding(harness.db, {
      id: otherBinding,
      channel: 'lark',
      hostSessionId: otherSessionId,
      externalChat: 'oc_other',
      externalThread: 'om_other',
      waitEnabled: true,
      createdAt: now,
    });

    const responseP = runHookViaBridge(harness, {
      event: 'stop',
      payload: { session_id: SESSION_ID },
    }) as Promise<Record<string, unknown>>;

    setTimeout(() => {
      enqueueMessage(harness.db, {
        bindingId: otherBinding, text: 'should not reach session_x',
        createdAt: new Date().toISOString(),
      });
      harness.app.events.emit({
        type: 'channel.message_enqueued', bindingId: otherBinding, messageId: 99,
      });
    }, 30);

    const start = Date.now();
    const r = await responseP;
    const elapsed = Date.now() - start;

    // No followup — the other session's event was correctly filtered out.
    expect(r['followup_message']).toBeUndefined();
    expect(elapsed).toBeGreaterThanOrEqual(180);
  });

  it('attack: empty-text queue entries are skipped — no blank followup_message', async () => {
    const bindingId = bindAChannel();
    enqueueMessage(harness.db, {
      bindingId, text: '', createdAt: new Date().toISOString(),
    });

    const r = await runHookViaBridge(harness, {
      event: 'stop',
      payload: { session_id: SESSION_ID },
    }) as Record<string, unknown>;

    // After draining the only queued item (which had empty text), there's
    // nothing to inject; handler returns no followup_message.
    expect(r['followup_message']).toBeUndefined();
  });
});
