/**
 * E2e — host_stop with channel-message followup injection (Phase 30 / C2).
 *
 * Drives §8.2 host_stop long-poll: when the Cursor turn ends, helm checks
 * each channel binding for queued messages and replies with a
 * `followup_message` so Cursor injects it as the next prompt without the
 * user having to retype.
 *
 * Two flavors:
 *   - drain-on-arrival: a message already sitting in the queue is returned
 *     immediately (no waiting).
 *   - long-poll wakeup: an empty queue at hook time, but a message arriving
 *     mid-poll triggers an immediate resolve via the `channel.message_enqueued`
 *     EventBus event.
 *
 * Multiple queued messages collapse into one `followup_message` joined by
 * blank lines so Cursor sees a single prompt-injection block.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootE2e, runHookViaBridge, type E2eHarness } from '../_helpers/setup.js';
import { upsertHostSession } from '../../../src/storage/repos/host-sessions.js';
import {
  enqueueMessage,
  insertChannelBinding,
  pendingMessageCount,
} from '../../../src/storage/repos/channel-bindings.js';

let harness: E2eHarness;
const SESSION_ID = 'sess_stop_e2e';

beforeEach(async () => {
  harness = await bootE2e({
    // Dial the long-poll budget down so the "no message" path resolves fast
    // without making the spec sit on the wall clock.
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

function bindAChannel(): string {
  const bindingId = randomUUID();
  insertChannelBinding(harness.db, {
    id: bindingId,
    channel: 'lark',
    hostSessionId: SESSION_ID,
    externalChat: 'oc_chat_x',
    externalThread: 'om_thread_x',
    waitEnabled: true,
    createdAt: new Date().toISOString(),
  });
  return bindingId;
}

describe('host-stop-message-injection happy', () => {
  it('drain-on-arrival: queued message returns immediately as followup_message', async () => {
    const bindingId = bindAChannel();
    enqueueMessage(harness.db, {
      bindingId,
      text: 'please also fix the typo in README',
      createdAt: new Date().toISOString(),
    });

    const start = Date.now();
    const r = await runHookViaBridge(harness, {
      event: 'stop',
      payload: { session_id: SESSION_ID },
    }) as { followup_message?: string };
    const elapsed = Date.now() - start;

    expect(r.followup_message).toBe('please also fix the typo in README');
    // Drains synchronously — should be way under the 200 ms poll budget.
    expect(elapsed).toBeLessThan(200);
    // Message marked consumed.
    expect(pendingMessageCount(harness.db, bindingId)).toBe(0);
  });

  it('multiple queued messages collapse into one followup_message joined by blank lines', async () => {
    const bindingId = bindAChannel();
    const now = new Date().toISOString();
    enqueueMessage(harness.db, { bindingId, text: 'first thing', createdAt: now });
    enqueueMessage(harness.db, { bindingId, text: 'second thing', createdAt: now });
    enqueueMessage(harness.db, { bindingId, text: 'third thing', createdAt: now });

    const r = await runHookViaBridge(harness, {
      event: 'stop',
      payload: { session_id: SESSION_ID },
    }) as { followup_message?: string };

    expect(r.followup_message).toBe('first thing\n\nsecond thing\n\nthird thing');
    expect(pendingMessageCount(harness.db, bindingId)).toBe(0);
  });

  it('long-poll wakeup: empty queue at hook time, message arrives mid-poll, resolves immediately', async () => {
    const bindingId = bindAChannel();

    // Fire the hook; the bridge handler will start waiting for an event.
    const responseP = runHookViaBridge(harness, {
      event: 'stop',
      payload: { session_id: SESSION_ID },
    }) as Promise<{ followup_message?: string }>;

    // A short delay then enqueue + emit the event the long-poll listens for.
    setTimeout(() => {
      enqueueMessage(harness.db, {
        bindingId, text: 'late arrival',
        createdAt: new Date().toISOString(),
      });
      harness.app.events.emit({
        type: 'channel.message_enqueued', bindingId, messageId: 1,
      });
    }, 30);

    const start = Date.now();
    const r = await responseP;
    const elapsed = Date.now() - start;

    expect(r.followup_message).toBe('late arrival');
    // Resolved well before the 200 ms poll budget thanks to the event-driven wakeup.
    expect(elapsed).toBeLessThan(180);
  });

  it('no bindings on the session → resolves with empty response (no followup_message)', async () => {
    // Note: SESSION_ID exists but has zero bindings. The handler short-circuits.
    const r = await runHookViaBridge(harness, {
      event: 'stop',
      payload: { session_id: SESSION_ID },
    }) as Record<string, unknown>;
    expect(r['followup_message']).toBeUndefined();
  });
});
