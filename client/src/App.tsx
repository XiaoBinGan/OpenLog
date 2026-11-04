import { lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import { RemoteProvider } from './contexts/RemoteContext';
import { DeviceProvider } from './contexts/DeviceContext';
import { ToastProvider } from './contexts/ToastContext';
import { AnalysisProvider } from './contexts/AnalysisContext';

/**
 * 路由级懒加载。
 *
 * 之前所有页面静态 import，首次访问要下载 1.04MB 单包（含 recharts、recharts 依赖、
 * 每个页面的 liucide 图标、Docker/设置页的大表单）—— 内网/离线机首屏要等好几秒。
 * 拆开之后首屏只加载 shell（Layout + 当前页），其它页按需拉。
 *
 * 保留 Layout 静态引入：它是外壳（含顶栏/侧边栏/WS/通知中心），首屏必须立刻有。
 */
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Logs = lazy(() => import('./pages/Logs'));
const Analytics = lazy(() => import('./pages/Analytics'));
const AnalysisHistory = lazy(() => import('./pages/AnalysisHistory'));
const Assistant = lazy(() => import('./pages/Assistant'));
const Monitor = lazy(() => import('./pages/Monitor'));
const Docker = lazy(() => import('./pages/Docker'));
const Settings = lazy(() => import('./pages/Settings'));
const Remote = lazy(() => import('./pages/Remote'));
const Skills = lazy(() => import('./pages/Skills'));
const GPU = lazy(() => import('./pages/GPU'));

/** 页面切换时的占位（放在 Layout 的 Outlet 里，外壳不闪） */

function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <DeviceProvider>
          <RemoteProvider>
            <AnalysisProvider>
              <Routes>
                <Route path="/" element={<Layout />}>
                  <Route index element={<Navigate to="/monitor" replace />} />
                  <Route path="dashboard" element={<Dashboard />} />
                  <Route path="logs" element={<Logs />} />
                  <Route path="remote" element={<Remote />} />
                  <Route path="docker" element={<Docker />} />
                  <Route path="analytics" element={<Analytics />} />
                  <Route path="analysis-history" element={<AnalysisHistory />} />
                  <Route path="assistant" element={<Assistant />} />
                  <Route path="skills" element={<Skills />} />
                  <Route path="monitor" element={<Monitor />} />
                  <Route path="gpu" element={<GPU />} />
                  <Route path="settings" element={<Settings />} />
                </Route>
              </Routes>
            </AnalysisProvider>
          </RemoteProvider>
        </DeviceProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}

export default App;
