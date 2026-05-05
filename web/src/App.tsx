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

export default function App() {
  return (
    <Router>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/approvals" replace />} />
          <Route path="/approvals" element={<ApprovalsPage />} />
          <Route path="/chats" element={<ChatsPage />} />
          <Route path="/campaigns" element={<CampaignsPage />} />
          <Route path="/cycles/:cycleId" element={<CycleDetailPage />} />
          <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
          <Route path="*" element={<Navigate to="/approvals" replace />} />
        </Route>
      </Routes>
    </Router>
  );
}
