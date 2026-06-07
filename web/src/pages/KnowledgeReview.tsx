/**
 * Knowledge › Review — placeholder for PR 1.
 *
 * Surfaces pending knowledge candidates extracted from chat captures.
 * In PR 4 this becomes the full Review inbox per design §5.3. For now
 * it's a routed shell so the IA reorg can ship without coupling to the
 * candidate-ranker upgrade.
 */

import { EmptyState } from '../components/EmptyState.js';
import { PageHeader } from '../components/PageHeader.js';

export function KnowledgeReviewPage() {
  return (
    <div className="helm-page">
      <PageHeader
        title="Review"
        subtitle="Candidates extracted from your conversations, waiting for your judgement."
      />
      <EmptyState
        title="No candidates pending."
        hint={
          <>
            When a chat with a bound knowledge collection mentions something
            worth keeping, it will land here. Bulk review and source-chat
            deep links arrive in PR 4.
          </>
        }
      />
    </div>
  );
}
