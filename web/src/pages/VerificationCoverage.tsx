/**
 * Verification › Coverage — placeholder for PR 1.
 *
 * Surfaces which collections / points lack benchmark protection.
 * Wires up in PR 6 alongside case-proposal flow.
 */

import { EmptyState } from '../components/EmptyState.js';
import { PageHeader } from '../components/PageHeader.js';

export function VerificationCoveragePage() {
  return (
    <div className="helm-page">
      <PageHeader
        title="Verification coverage"
        subtitle="Which knowledge collections lack benchmark protection."
      />
      <EmptyState
        title="Coverage view arrives in PR 6."
        hint={
          <>
            Once Verification cases land you will see, per collection, how
            many points are covered by at least one confirmed benchmark case.
          </>
        }
      />
    </div>
  );
}
