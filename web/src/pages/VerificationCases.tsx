/**
 * Verification › Cases — placeholder for PR 1.
 *
 * In PR 5/6 this lists BenchmarkCase rows with last-run sha, recall,
 * alignment, drift badges. For PR 1 it's a routed shell.
 */

import { EmptyState } from '../components/EmptyState.js';
import { PageHeader } from '../components/PageHeader.js';

export function VerificationCasesPage() {
  return (
    <div className="helm-page">
      <PageHeader
        title="Verification cases"
        subtitle="Benchmark cases that exercise your knowledge collections."
      />
      <EmptyState
        title="No cases yet."
        hint={
          <>
            Cases land here once you subscribe to a KnowledgeRepo that ships
            them (e.g. <code>llm-wiki</code>) or accept knowledge edits that
            trigger case proposals. Backend wiring arrives in PR 5.
          </>
        }
      />
    </div>
  );
}
