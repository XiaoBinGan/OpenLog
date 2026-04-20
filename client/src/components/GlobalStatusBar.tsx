import { Monitor, Server, Activity, HardDrive, Cpu, ChevronDown } from 'lucide-react';
import { useDevice } from '../contexts/DeviceContext';
import { useState, useEffect } from 'react';

interface QuickStats {
  cpu: number;
  memory: number;
  disk: number;
}

export default function GlobalStatusBar() {
  const { selectedDevice, setSelectedDevice, devices, isRemote, getDeviceStatusColor, refreshDevices } = useDevice();
  const [stats, setStats] = useState<QuickStats>({ cpu: 0, memory: 0, disk: 0 });
  const [showDropdown, setShowDropdown] = useState(false);

  // 获取快速统计
  useEffect(() => {
    if (!selectedDevice) return;
    const fetchStats = async () => {
      try {
        if (isRemote) {
          const res = await fetch(`/api/remote/servers/${selectedDevice.id}/stats`);
          if (!res.ok) {
            console.error('Stats request failed:', res.status);
            return;
          }
          const data = await res.json();

          // 解析远程统计 - 新结构化格式
          let cpu = 0, memory = 0, disk = 0;

          if (data.cpu) {
            // 新格式: {load: 0.2, cores: []} 或旧格式: "0.1"
            // data.cpu.load 可能是 null（如服务器未连接时），用 ?? 0 保底
            cpu = typeof data.cpu === 'object' ? (data.cpu.load ?? 0) : parseFloat(String(data.cpu).match(/([\d.]+)/)?.[1] || '0');
          }

          if (data.memory) {
            // 新格式: {used: ..., total: ...} 或旧格式: "12950.0/128568.0 MB (10.1%)"
            if (typeof data.memory === 'object') {
              memory = (data.memory.used / (data.memory.total || 1)) * 100;
            } else {
              const match = String(data.memory).match(/\(([\d.]+)%\)/);
              if (match) memory = parseFloat(match[1]);
            }
          }

          if (data.disk) {
            // 新格式: [{usePercent: 23}] 或旧格式: "388G/1.8T (23%)"
            if (Array.isArray(data.disk)) {
              const totalUsed = data.disk.reduce((s: number, d: any) => s + (d.used || 0), 0);
              const totalAll = data.disk.reduce((s: number, d: any) => s + (d.total || 0), 0);
              disk = totalAll > 0 ? (totalUsed / totalAll) * 100 : 0;
            } else {
              const match = String(data.disk).match(/(\d+)%/);
              if (match) disk = parseFloat(match[1]);
            }
          }

          setStats({ cpu, memory, disk });
        } else {
          const res = await fetch('/api/monitor/stats');
          if (!res.ok) {
            console.error('Monitor stats request failed:', res.status);
            return;
          }
          const data = await res.json();
          setStats({
            cpu: data.cpu?.load || 0,
            memory: data.memory ? (data.memory.used / (data.memory.total || 1)) * 100 : 0,
            disk: data.disk?.length > 0 ? (() => {
              const totalUsed = data.disk.reduce((s: any, d: any) => s + (d.used || 0), 0);
              const totalAll = data.disk.reduce((s: any, d: any) => s + (d.total || 0), 0);
              return totalAll > 0 ? (totalUsed / totalAll) * 100 : 0;
            })() : 0,
          });
        }
      } catch (err) {
        console.error('Failed to fetch quick stats:', err);
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 5000);
    return () => clearInterval(interval);
  }, [selectedDevice?.id, isRemote]);

  // 刷新设备列表
  useEffect(() => {
    refreshDevices();
    const interval = setInterval(refreshDevices, 30000);
    return () => clearInterval(interval);
  }, [refreshDevices]);

  return (
    <div className="fixed top-0 left-0 right-0 h-14 bg-dark-900/95 backdrop-blur border-b border-dark-800 z-30 hidden md:flex items-center px-6 gap-8">
      {/* Logo / Title - 左侧 */}
      <div className="flex items-center gap-2 text-sm font-bold text-accent-400">
        <span>📊</span>
        <span>OpenLog</span>
      </div>

      {/* 快速统计 - 中间 */}
      <div className="flex items-center gap-6 text-sm ml-auto">
        <div className="flex items-center gap-1.5">
          <Cpu className={`w-4 h-4 ${stats.cpu > 80 ? 'text-red-400' : stats.cpu > 50 ? 'text-yellow-400' : 'text-accent-400'}`} />
          <span className="text-dark-400">CPU:</span>
          <span className={`font-mono font-semibold ${stats.cpu > 80 ? 'text-red-400' : stats.cpu > 50 ? 'text-yellow-400' : 'text-dark-200'}`}>
            {stats.cpu.toFixed(1)}%
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <Activity className={`w-4 h-4 ${stats.memory > 80 ? 'text-red-400' : stats.memory > 50 ? 'text-yellow-400' : 'text-purple-400'}`} />
          <span className="text-dark-400">内存:</span>
          <span className={`font-mono font-semibold ${stats.memory > 80 ? 'text-red-400' : stats.memory > 50 ? 'text-yellow-400' : 'text-dark-200'}`}>
            {stats.memory.toFixed(1)}%
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <HardDrive className={`w-4 h-4 ${stats.disk > 90 ? 'text-red-400' : stats.disk > 70 ? 'text-yellow-400' : 'text-orange-400'}`} />
          <span className="text-dark-400">磁盘:</span>
          <span className={`font-mono font-semibold ${stats.disk > 90 ? 'text-red-400' : stats.disk > 70 ? 'text-yellow-400' : 'text-dark-200'}`}>
            {stats.disk.toFixed(1)}%
          </span>
        </div>
      </div>

      {/* 分隔线 */}
      <div className="w-px h-8 bg-dark-700" />

      {/* 设备选择器 - 右侧 */}
      <div className="relative">
        <button
          onClick={() => setShowDropdown(!showDropdown)}
          className="flex items-center gap-2.5 px-4 py-2 rounded-lg bg-gradient-to-r from-accent-600/20 to-accent-500/20 hover:from-accent-600/30 hover:to-accent-500/30 border border-accent-500/30 transition-all"
        >
          {selectedDevice.id === 'local' ? (
            <Monitor className="w-4 h-4 text-accent-400" />
          ) : (
            <Server className="w-4 h-4 text-green-400" />
          )}
          <span className="text-sm font-semibold text-accent-100">{selectedDevice.name}</span>
          <span className={`w-2.5 h-2.5 rounded-full ${getDeviceStatusColor(selectedDevice)} animate-pulse`} />
          <ChevronDown className={`w-4 h-4 text-accent-400 transition-transform duration-200 ${showDropdown ? 'rotate-180' : ''}`} />
        </button>

        {showDropdown && (
          <>
            {/* 背景遮罩 */}
            <div
              className="fixed inset-0 z-40"
              onClick={() => setShowDropdown(false)}
            />

            {/* 下拉菜单 */}
            <div className="absolute top-full mt-3 right-0 min-w-[280px] bg-dark-900 border border-dark-700 rounded-xl shadow-2xl z-50 overflow-hidden animate-scale-in">
              <div className="px-4 py-3 bg-dark-800/50 border-b border-dark-700">
                <p className="text-xs font-semibold text-accent-400 uppercase tracking-wide">📡 选择监控设备</p>
              </div>

              <div className="py-1 max-h-[400px] overflow-y-auto">
                {devices.map((device) => (
                  <button
                    key={device.id}
                    onClick={() => {
                      setSelectedDevice(device);
                      setShowDropdown(false);
                    }}
                    className={`w-full flex items-center gap-3 px-4 py-3 transition-all border-l-2 ${
                      selectedDevice.id === device.id
                        ? 'bg-accent-500/15 border-l-accent-500 text-accent-100'
                        : 'border-l-transparent text-dark-300 hover:bg-dark-800/50'
                    }`}
                  >
                    {device.id === 'local' ? (
                      <Monitor className="w-4 h-4 flex-shrink-0 text-blue-400" />
                    ) : (
                      <Server className="w-4 h-4 flex-shrink-0 text-green-400" />
                    )}

                    <div className="flex-1 text-left">
                      <p className="text-sm font-medium">{device.name}</p>
                      {device.id !== 'local' && (
                        <p className="text-xs text-dark-500 mt-0.5">
                          {(device as any).host || 'Remote Server'}
                        </p>
                      )}
                    </div>

                    <span className={`w-2 h-2 rounded-full ${getDeviceStatusColor(device)} flex-shrink-0`} />
                  </button>
                ))}
              </div>

              {devices.length === 1 && (
                <div className="px-4 py-4 text-xs text-dark-500 text-center border-t border-dark-800 bg-dark-800/30">
                  💡 暂无远程服务器连接
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
