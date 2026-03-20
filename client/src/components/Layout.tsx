import { useState, useEffect } from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import { 
  LayoutDashboard, 
  FileText, 
  Brain, 
  Activity, 
  Settings,
  Menu,
  X,
  Terminal,
  Server
} from 'lucide-react';
import clsx from 'clsx';
import { DeviceProvider } from '../contexts/DeviceContext';
import GlobalStatusBar from './GlobalStatusBar';

const navItems = [
  { path: '/dashboard', icon: LayoutDashboard, label: '仪表盘' },
  { path: '/logs', icon: FileText, label: '日志流' },
  { path: '/remote', icon: Server, label: '远程服务器' },
  { path: '/analytics', icon: Brain, label: 'AI 分析' },
  { path: '/monitor', icon: Activity, label: '系统监控' },
  { path: '/settings', icon: Settings, label: '设置' },
];

function LayoutContent() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 768) {
        setSidebarOpen(false);
        setMobileOpen(false);
      } else {
        setSidebarOpen(true);
      }
    };
    
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <div className="flex min-h-screen bg-dark-950">
      {/* Desktop Sidebar */}
      <aside 
        className={clsx(
          'fixed left-0 top-0 z-40 h-screen transition-transform duration-300',
          'bg-dark-900 border-r border-dark-800',
          sidebarOpen ? 'w-64' : 'w-16',
          'hidden md:block'
        )}
      >
        <div className="flex flex-col h-full">
          {/* Logo */}
          <div className="flex items-center h-12 px-4 border-b border-dark-800">
            <Terminal className="w-8 h-8 text-accent-500 flex-shrink-0" />
            {sidebarOpen && (
              <span className="ml-3 font-semibold text-lg truncate">OpenLog</span>
            )}
          </div>
          
          {/* Navigation */}
          <nav className="flex-1 px-2 py-4 space-y-1">
            {navItems.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                className={({ isActive }) =>
                  clsx(
                    'flex items-center px-3 py-2.5 rounded-lg transition-all duration-200',
                    isActive
                      ? 'bg-accent-500/20 text-accent-400'
                      : 'text-dark-400 hover:bg-dark-800 hover:text-dark-200'
                  )
                }
              >
                <item.icon className="w-5 h-5 flex-shrink-0" />
                {sidebarOpen && <span className="ml-3">{item.label}</span>}
              </NavLink>
            ))}
          </nav>

          {/* Toggle Button */}
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="flex items-center justify-center h-12 border-t border-dark-800 text-dark-500 hover:text-dark-300 transition-colors"
          >
            <Menu className="w-5 h-5" />
          </button>
        </div>
      </aside>

      {/* Mobile Overlay */}
      {mobileOpen && (
        <div 
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Mobile Sidebar */}
      <aside 
        className={clsx(
          'fixed left-0 top-0 z-50 h-screen w-64 bg-dark-900 border-r border-dark-800 transition-transform duration-300 md:hidden',
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <div className="flex flex-col h-full">
          <div className="flex items-center justify-between h-12 px-4 border-b border-dark-800">
            <div className="flex items-center">
              <Terminal className="w-8 h-8 text-accent-500" />
              <span className="ml-3 font-semibold text-lg">OpenLog</span>
            </div>
            <button onClick={() => setMobileOpen(false)}>
              <X className="w-5 h-5 text-dark-400" />
            </button>
          </div>
          
          {/* Device Selector (mobile) - removed as per user request */}
          
          <nav className="flex-1 px-2 py-4 space-y-1">
            {navItems.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                onClick={() => setMobileOpen(false)}
                className={({ isActive }) =>
                  clsx(
                    'flex items-center px-3 py-2.5 rounded-lg transition-all duration-200',
                    isActive
                      ? 'bg-accent-500/20 text-accent-400'
                      : 'text-dark-400 hover:bg-dark-800 hover:text-dark-200'
                  )
                }
              >
                <item.icon className="w-5 h-5" />
                <span className="ml-3">{item.label}</span>
              </NavLink>
            ))}
          </nav>
        </div>
      </aside>

      {/* Main Content */}
      <main className={clsx(
        'flex-1 transition-all duration-300',
        sidebarOpen ? 'md:ml-64' : 'md:ml-16'
      )}>
        {/* Global Status Bar (desktop only) */}
        <GlobalStatusBar />
        
        {/* Mobile Header */}
        <header className="sticky top-0 z-30 flex items-center h-14 px-4 bg-dark-950/80 backdrop-blur border-b border-dark-800 md:hidden">
          <button 
            onClick={() => setMobileOpen(true)}
            className="p-2 -ml-2 text-dark-400 hover:text-dark-200"
          >
            <Menu className="w-6 h-6" />
          </button>
          <span className="ml-4 font-semibold">OpenLog</span>
        </header>

        {/* Page Content */}
        <div className="p-4 md:p-6 md:mt-14">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

export default function Layout() {
  return (
    <DeviceProvider>
      <LayoutContent />
    </DeviceProvider>
  );
}
