/**
 * Helm renderer root — sets up the router; routes mount pages inside Layout.
 */

import { Navigate, Route, BrowserRouter as Router, Routes } from 'react-router-dom';
import { Layout } from './components/Layout.js';
import { ApprovalsPage } from './pages/Approvals.js';
import { ChatsPage } from './pages/Chats.js';
import { CampaignsPage } from './pages/Campaigns.js';
import { CycleDetailPage } from './pages/CycleDetail.js';
import { TaskDetailPage } from './pages/TaskDetail.js';
import { BindingsPage } from './pages/Bindings.js';
import { SettingsPage } from './pages/Settings.js';
import { RolesPage } from './pages/Roles.js';
import { RequirementsPage } from './pages/Requirements.js';
import { HarnessPage } from './pages/Harness.js';
import { SubscriptionsPage } from './pages/Subscriptions.js';
import { PluginsPage } from './pages/Plugins.js';

export default function App() {
  return (
    <Router>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/approvals" replace />} />
          <Route path="/approvals" element={<ApprovalsPage />} />
          <Route path="/chats" element={<ChatsPage />} />
          <Route path="/bindings" element={<BindingsPage />} />
          <Route path="/campaigns" element={<CampaignsPage />} />
          <Route path="/cycles/:cycleId" element={<CycleDetailPage />} />
          <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
          <Route path="/roles" element={<RolesPage />} />
          {/* helm-design PR 4: new Knowledge group routes. The page bodies
              are placeholder shells in PR 4; PR 5 lifts the real
              <RoleSubscriptionsCard> + <StoragePluginsCard> out of
              Settings into these modules. */}
          <Route path="/subscriptions" element={<SubscriptionsPage />} />
          <Route path="/plugins" element={<PluginsPage />} />
          <Route path="/requirements" element={<RequirementsPage />} />
          <Route path="/harness" element={<HarnessPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/approvals" replace />} />
        </Route>
      </Routes>
    </Router>
  );
}
