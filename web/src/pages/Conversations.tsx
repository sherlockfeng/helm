/**
 * Conversations — R-8 (reviewer follow-up): real onboarding hero.
 *
 * Previously this was a bare re-export of ChatsPage, which meant a
 * first-time user landed on "No active Cursor chats. Start one and Helm
 * will pick it up automatically." — no path to actually configure the
 * hooks, subscribe to a knowledge repo, or even know what to do next.
 *
 * The new shell injects an onboarding hero whenever there are zero
 * active chats: three actionable steps that drive the new-user flow
 * (install Cursor hooks → subscribe a seed → start a chat). When a
 * chat exists, we render ChatsPage unchanged so existing users see
 * no regression.
 */

import { useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ApiError, helmApi } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';
import { Button } from '../components/Button.js';
import { Card } from '../components/Card.js';
import { PageHeader } from '../components/PageHeader.js';
import { ChatsPage } from './Chats.js';

export function ConversationsPage(): ReactElement {
  const chatsQuery = useApi(() => helmApi.activeChats(), []);
  const chats = chatsQuery.data?.chats ?? [];

  if (chatsQuery.loading || chats.length > 0) {
    return <ChatsPage />;
  }

  return (
    <div className="helm-page">
      <PageHeader
        title="Conversations"
        subtitle="Live chats from Cursor / Claude Code / Codex. None yet — pick a step below to get started."
      />
      <OnboardingHero />
    </div>
  );
}

function OnboardingHero(): ReactElement {
  const seedsQuery = useApi(() => helmApi.listKnowledgeRepoSeeds(), []);
  const [enrolling, setEnrolling] = useState(false);
  const llmWikiSeed = seedsQuery.data?.seeds.find((s) => s.id === 'llm-wiki')
    ?? seedsQuery.data?.seeds[0];

  const enrollSeed = async (): Promise<void> => {
    if (!llmWikiSeed) return;
    setEnrolling(true);
    try {
      await helmApi.subscribeKnowledgeRepoSeed(llmWikiSeed.id);
      toast.success(`${llmWikiSeed.label} subscribed.`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast.success(`${llmWikiSeed.label} is already subscribed.`);
      } else {
        toast.error(`Enroll failed: ${err instanceof ApiError ? err.message : String(err)}`);
      }
    } finally { setEnrolling(false); }
  };

  return (
    <Card>
      <h3 style={{ marginTop: 0 }}>Get helm to see your chats in 3 steps</h3>
      <ol style={{ paddingLeft: 18, marginBottom: 4 }}>
        <li style={{ marginBottom: 14 }}>
          <strong>Install the Cursor hooks.</strong>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
            Tells Cursor to forward prompt/response events to the local helm
            HTTP API. Without this, helm can't see your chats.
          </div>
          <Link to="/settings"><Button>Open Settings → install hooks</Button></Link>
        </li>
        <li style={{ marginBottom: 14 }}>
          <strong>Subscribe to a knowledge repo.</strong>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
            One-click enroll for the curated <code>llm-wiki</code> repo so the
            first chat already has knowledge to inject. You can subscribe more
            from <Link to="/knowledge/sources">Knowledge › Sources</Link>.
          </div>
          {llmWikiSeed ? (
            <Button
              onClick={() => { void enrollSeed(); }}
              disabled={enrolling}
              aria-busy={enrolling}
              variant="primary"
            >
              {enrolling ? 'Subscribing…' : `Subscribe ${llmWikiSeed.label}`}
            </Button>
          ) : (
            <span className="muted" style={{ fontSize: 12 }}>
              {seedsQuery.loading ? 'Loading seeds…' : 'No seeds available.'}
            </span>
          )}
        </li>
        <li>
          <strong>Start a chat in Cursor.</strong>
          <div className="muted" style={{ fontSize: 12 }}>
            Hit ⌘L in Cursor and ask anything. The conversation will show up
            here within a second of your first prompt.
          </div>
        </li>
      </ol>
    </Card>
  );
}
