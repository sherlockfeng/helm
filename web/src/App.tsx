/**
 * Helm renderer root — sets up the router; routes mount pages inside Layout.
 *
 * PR 1 reshapes the IA per docs/design/2026-06-06-conversation-knowledge-
 * redesign.md §2. Primary entries: Conversations / Knowledge / Verification
 * / Settings. The old paths (/chats, /roles, /subscriptions, /approvals,
 * /bindings, /harness, /campaigns, /requirements) are kept for direct-link
 * back-compat and now also reachable from Settings › Advanced (which the
 * user can re-enable in the sidebar via a toggle there).
 */

// helm-design hotfix: HashRouter instead of BrowserRouter. In Electron's
// file:// context, BrowserRouter rewrites pathname (e.g. /approvals) into
// the file:// URL — reload then tries to `file:///approvals` and 404s
// (white screen). HashRouter keeps the route in the URL fragment so the
// underlying file load is always index.html.
import { HashRouter as Router, Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import { Layout } from './components/Layout.js';
import { useProposalBootToast } from './lib/proposal-notifications.js';

// Primary surfaces (new IA)
import { ConversationsPage } from './pages/Conversations.js';
import { ExpertsPage, CollectionsPage } from './pages/Roles.js';
import { KnowledgePromotePage } from './pages/KnowledgePromote.js';
import { KnowledgeSourcesPage } from './pages/KnowledgeSources.js';
import { VerificationCasesPage } from './pages/VerificationCases.js';
import { VerificationRunsPage } from './pages/VerificationRuns.js';
import { VerificationCoveragePage } from './pages/VerificationCoverage.js';
import { SettingsPage } from './pages/Settings.js';
// R-18: SettingsAdvancedPage retired — Advanced is now a sub-nav
// section inside the main Settings page.

// Advanced + legacy surfaces (kept for back-compat + Settings › Advanced)
import { ApprovalsPage } from './pages/Approvals.js';
import { BindingsPage } from './pages/Bindings.js';
import { CampaignsPage } from './pages/Campaigns.js';
import { CycleDetailPage } from './pages/CycleDetail.js';
import { TaskDetailPage } from './pages/TaskDetail.js';
import { RequirementsPage } from './pages/Requirements.js';
import { HarnessPage } from './pages/Harness.js';

export default function App() {
  // R-9: once-per-session toast if proposed verification cases exist.
  useProposalBootToast();
  return (
    <Router>
      {/* helm-design PR 9: bottom-right toaster. Inherits CSS-var
          theming from .helm-toaster rules in app.css so the toasts
          match helm's elevated surface (light + dark). */}
      <Toaster
        position="bottom-right"
        richColors
        closeButton
        duration={4500}
      />
      <Routes>
        <Route element={<Layout />}>
          {/* Landing → Conversations */}
          <Route index element={<Navigate to="/conversations" replace />} />

          {/* Primary IA */}
          <Route path="/conversations" element={<ConversationsPage />} />
          <Route path="/knowledge" element={<Navigate to="/knowledge/experts" replace />} />
          <Route path="/knowledge/experts" element={<ExpertsPage />} />
          <Route path="/knowledge/collections" element={<CollectionsPage />} />
          <Route path="/knowledge/promote" element={<KnowledgePromotePage />} />
          <Route path="/knowledge/sources" element={<KnowledgeSourcesPage />} />
          {/* Back-compat: Library split into Experts/知识集; Review folded
              into the Conversations detail (提取的知识 section). */}
          <Route path="/knowledge/library" element={<Navigate to="/knowledge/experts" replace />} />
          <Route path="/knowledge/review" element={<Navigate to="/conversations" replace />} />
          <Route path="/verification" element={<Navigate to="/verification/cases" replace />} />
          <Route path="/verification/cases" element={<VerificationCasesPage />} />
          <Route path="/verification/runs" element={<VerificationRunsPage />} />
          <Route path="/verification/cases/:caseId/runs" element={<VerificationRunsPage />} />
          <Route path="/verification/coverage" element={<VerificationCoveragePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          {/* R-18: legacy /settings/advanced route just lands on
              Settings; the Advanced sub-nav section opens automatically
              from localStorage memory or stays on whatever the user
              last viewed. */}
          <Route path="/settings/advanced" element={<Navigate to="/settings" replace />} />

          {/* Back-compat: old paths redirect to new ones. */}
          <Route path="/chats" element={<Navigate to="/conversations" replace />} />
          <Route path="/roles" element={<Navigate to="/knowledge/experts" replace />} />
          <Route path="/subscriptions" element={<Navigate to="/knowledge/sources" replace />} />

          {/* Advanced + legacy surfaces — routes resolve regardless of
              sidebar toggle so deep links never break. */}
          <Route path="/approvals" element={<ApprovalsPage />} />
          <Route path="/bindings" element={<BindingsPage />} />
          <Route path="/harness" element={<HarnessPage />} />
          <Route path="/campaigns" element={<CampaignsPage />} />
          <Route path="/cycles/:cycleId" element={<CycleDetailPage />} />
          <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
          <Route path="/requirements" element={<RequirementsPage />} />

          <Route path="*" element={<Navigate to="/conversations" replace />} />
        </Route>
      </Routes>
    </Router>
  );
}
