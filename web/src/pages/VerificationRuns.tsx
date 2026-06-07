/**
 * Verification › Runs — placeholder for PR 1.
 *
 * History of benchmark runs, each tagged with the knowledgeStateSha
 * that produced the score. PR 6 wires the data + bisect/revert
 * actions per design §5.7.
 */

import { EmptyState } from '../components/EmptyState.js';
import { PageHeader } from '../components/PageHeader.js';

export function VerificationRunsPage() {
  return (
    <div className="helm-page">
      <PageHeader
        title="Verification runs"
        subtitle="Historical benchmark runs, each tied to the knowledge state hash that produced the score."
      />
      <EmptyState
        title="No runs yet."
        hint={<>Runs appear here once a case is executed.</>}
      />
    </div>
  );
}
