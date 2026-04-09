import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Logs from './pages/Logs';
import Analytics from './pages/Analytics';
import AnalysisHistory from './pages/AnalysisHistory';
import Assistant from './pages/Assistant';
import Monitor from './pages/Monitor';
import Docker from './pages/Docker';
import Settings from './pages/Settings';
import Remote from './pages/Remote';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="logs" element={<Logs />} />
          <Route path="remote" element={<Remote />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="analysis-history" element={<AnalysisHistory />} />
          <Route path="assistant" element={<Assistant />} />
          <Route path="docker" element={<Docker />} />
          <Route path="monitor" element={<Monitor />} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
