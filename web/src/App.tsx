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

// Primary surfaces (new IA)
import { ConversationsPage } from './pages/Conversations.js';
import { KnowledgeLibraryPage } from './pages/KnowledgeLibrary.js';
import { KnowledgeReviewPage } from './pages/KnowledgeReview.js';
import { KnowledgeSourcesPage } from './pages/KnowledgeSources.js';
import { VerificationCasesPage } from './pages/VerificationCases.js';
import { VerificationRunsPage } from './pages/VerificationRuns.js';
import { VerificationCoveragePage } from './pages/VerificationCoverage.js';
import { SettingsPage } from './pages/Settings.js';
import { SettingsAdvancedPage } from './pages/SettingsAdvanced.js';

// Advanced + legacy surfaces (kept for back-compat + Settings › Advanced)
import { ApprovalsPage } from './pages/Approvals.js';
import { BindingsPage } from './pages/Bindings.js';
import { CampaignsPage } from './pages/Campaigns.js';
import { CycleDetailPage } from './pages/CycleDetail.js';
import { TaskDetailPage } from './pages/TaskDetail.js';
import { RequirementsPage } from './pages/Requirements.js';
import { HarnessPage } from './pages/Harness.js';
import { PluginsPage } from './pages/Plugins.js';

export default function App() {
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
          <Route path="/knowledge" element={<Navigate to="/knowledge/library" replace />} />
          <Route path="/knowledge/library" element={<KnowledgeLibraryPage />} />
          <Route path="/knowledge/review" element={<KnowledgeReviewPage />} />
          <Route path="/knowledge/sources" element={<KnowledgeSourcesPage />} />
          <Route path="/verification" element={<Navigate to="/verification/cases" replace />} />
          <Route path="/verification/cases" element={<VerificationCasesPage />} />
          <Route path="/verification/runs" element={<VerificationRunsPage />} />
          <Route path="/verification/coverage" element={<VerificationCoveragePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/advanced" element={<SettingsAdvancedPage />} />

          {/* Back-compat: old paths redirect to new ones. */}
          <Route path="/chats" element={<Navigate to="/conversations" replace />} />
          <Route path="/roles" element={<Navigate to="/knowledge/library" replace />} />
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
          <Route path="/plugins" element={<PluginsPage />} />

          <Route path="*" element={<Navigate to="/conversations" replace />} />
        </Route>
      </Routes>
    </Router>
  );
}
