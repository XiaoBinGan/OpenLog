import { useState, useEffect } from 'react';
import { 
  Activity, 
  Cpu, 
  HardDrive, 
  Network, 
  AlertTriangle, 
  CheckCircle,
  Clock,
  Zap,
  Monitor,
  Server,
  ChevronDown,
  Loader
} from 'lucide-react';
import { LineChart, Line, AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { useDevice } from '../contexts/DeviceContext';

import type { MonitorStats, MonitorHistory, Log, RemoteServer } from '../types';

export default function Dashboard() {
  const { selectedDevice, isRemote } = useDevice();

  const [stats, setStats] = useState<MonitorStats | null>(null);
  const [history, setHistory] = useState<MonitorHistory[]>([]);
  const [recentLogs, setRecentLogs] = useState<Log[]>([]);
  const [loading, setLoading] = useState(false);
  const [ws, setWs] = useState<WebSocket | null>(null);

  // 设备切换时重新加载数据
  useEffect(() => {
    // 关闭之前的 WebSocket
    if (ws) {
      ws.close();
    }
    
    // 重置状态
    setStats(null);
    setHistory([]);
    setRecentLogs([]);
    setLoading(true);
    
    const fetchDeviceData = async () => {
      try {
        if (!isRemote) {
          // 本地设备
          const [statsData, historyData, logsData] = await Promise.all([
            fetch('/api/monitor/stats').then(r => r.json()),
            fetch('/api/monitor/history?limit=30').then(r => r.json()),
            fetch('/api/logs?limit=10').then(r => r.json())
          ]);
          setStats(statsData);
          setHistory(historyData);
          setRecentLogs(logsData.logs || []);
          
          // 连接 WebSocket
          const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
          const wsInstance = new WebSocket(`${protocol}//${window.location.host}/ws`);
          
          wsInstance.onmessage = (event) => {
            const data = JSON.parse(event.data);
            
            if (data.type === 'monitor') {
              // WS 推送的是简化格式，转换为 HTTP API 格式
              const raw = data.data;
              const formatted = {
                cpu: typeof raw.cpu === 'number' ? { load: raw.cpu, cores: [] } : raw.cpu,
                memory: typeof raw.memory === 'number' ? { used: raw.memory, total: 100, free: 0 } : raw.memory,
                disk: typeof raw.disk === 'number' ? [{ name: '/', used: 0, total: 1, usePercent: raw.disk }] : raw.disk,
                network: raw.network !== undefined ? [{ iface: 'en0', rx: raw.network / 2, tx: raw.network / 2 }] : [],
                processes: stats?.processes || []
              };
              setStats(formatted);
              setHistory(prev => {
                const newHistory = [...prev, data.data];
                return newHistory.slice(-60);
              });
            } else if (data.type === 'log') {
              setRecentLogs(prev => [data.data, ...prev].slice(0, 20));
            }
          };
          
          setWs(wsInstance);
        } else {
          // 远程已连接，走 stats API
          const [statsData] = await Promise.all([
            fetch(`/api/remote/servers/${selectedDevice.id}/stats`).then(r => r.json())
          ]);
          
          // 解析远程统计数据为统一格式
          // statsData 已经是结构化对象：{ cpu: {load, cores}, memory: {used,total,free}, disk: [{name,used,total,usePercent}], gpus: [{index,name,util,memUsed,memTotal,temp}] }
          const remoteStats: MonitorStats & { gpus?: { index: number; name: string; util: number; memUsed: number; memTotal: number; temp: number }[] } = {
            cpu: { load: 0, cores: [] },
            memory: { used: 0, total: 1, free: 0 },
            disk: [],
            network: [],
            processes: []
          };

          // CPU
          if (typeof statsData.cpu === 'object' && statsData.cpu) {
            remoteStats.cpu.load = statsData.cpu.load ?? 0;
            remoteStats.cpu.cores = Array.isArray(statsData.cpu.cores) ? statsData.cpu.cores : [];
          }

          // 内存
          if (typeof statsData.memory === 'object' && statsData.memory) {
            remoteStats.memory = {
              used: statsData.memory.used ?? 0,
              total: statsData.memory.total ?? 1,
              free: statsData.memory.free ?? 0
            };
          }

          // 磁盘
          if (Array.isArray(statsData.disk)) {
            remoteStats.disk = statsData.disk.map((d: any) => ({
              name: d.name ?? '/',
              used: d.used ?? 0,
              total: d.total ?? 1,
              usePercent: d.usePercent ?? 0
            }));
          }

          // 网络
          if (Array.isArray(statsData.network)) {
            remoteStats.network = statsData.network;
          }

          // GPU（API 扩展字段）
          if (Array.isArray(statsData.gpus)) {
            remoteStats.gpus = statsData.gpus;
          }
          
          setStats(remoteStats);
          
          // 远程设备没有实时 WebSocket，创建模拟历史数据
          const now = Date.now();
          const remoteNetworkBps = Array.isArray(statsData.network) && statsData.network[0]
            ? statsData.network[0].rx + statsData.network[0].tx
            : 0;
          const mockHistory: MonitorHistory[] = Array.from({ length: 30 }, (_, i) => ({
            id: i,
            timestamp: new Date(now - (29 - i) * 5000).toISOString(),
            cpu: remoteStats.cpu.load * (0.8 + Math.random() * 0.4),
            memory: (remoteStats.memory.used / remoteStats.memory.total) * 100 * (0.9 + Math.random() * 0.2),
            disk: remoteStats.disk[0]?.usePercent || 0,
            network: remoteNetworkBps
          }));
          setHistory(mockHistory);
          
          // 加载远程日志
          try {
            const remoteServer = selectedDevice as RemoteServer;
            const res = await fetch(`/api/remote/servers/${selectedDevice.id}/files?path=${encodeURIComponent(remoteServer.logPath || '/var/log')}`);
            const filesData = await res.json();
            const logFile = filesData.files?.find((f: any) => f.isLog);
            if (logFile) {
              const logsRes = await fetch(`/api/remote/servers/${selectedDevice.id}/logs?file=${encodeURIComponent(logFile.path)}&lines=10`);
              const logsData = await logsRes.json();
              setRecentLogs(logsData.logs || []);
            }
          } catch (err) {
            console.error('Failed to load remote logs:', err);
          }
        }
      } catch (err) {
        console.error('Failed to fetch device data:', err);
      }
      setLoading(false);
    };
    
    fetchDeviceData();
    
    return () => {
      if (ws) {
        ws.close();
      }
    };
  }, [selectedDevice.id, isRemote]);

  const formatPercent = (val: number | undefined | null) => {
    if (val === undefined || val === null || isNaN(val)) return '0.0';
    return val.toFixed(1);
  };

  const formatBytes = (bytes: number) => {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const getLevelColor = (level: string) => {
    const l = level.toUpperCase();
    if (l === 'ERROR' || l === 'FATAL') return 'text-red-500';
    if (l === 'WARN' || l === 'WARNING') return 'text-yellow-500';
    if (l === 'DEBUG' || l === 'TRACE') return 'text-purple-500';
    return 'text-blue-400';
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">仪表盘</h1>
          <p className="text-dark-400">
            {isRemote ? `远程服务器: ${selectedDevice.name}` : '本地设备实时状态概览'}
          </p>
        </div>
        
        {/* 状态指示 */}
        {loading ? (
          <span className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-yellow-500/20 text-yellow-400 text-sm">
            <Loader className="w-3 h-3 animate-spin" />
            加载中
          </span>
        ) : (
          <span className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-green-500/20 text-green-400 text-sm">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            {isRemote ? '远程已连接' : '系统正常'}
          </span>
        )}
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {/* CPU */}
        <div className="glass rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <Cpu className="w-5 h-5 text-accent-500" />
            <span className="text-xs text-dark-400">CPU</span>
          </div>
          <div className="text-2xl font-bold">
            {formatPercent(stats?.cpu?.load)}%
          </div>
          <div className="mt-2 h-1 bg-dark-800 rounded-full overflow-hidden">
            <div 
              className={`h-full transition-all duration-500 ${
                (stats?.cpu?.load ?? 0) > 80 ? 'bg-red-500' : 
                (stats?.cpu?.load ?? 0) > 50 ? 'bg-yellow-500' : 
                'bg-gradient-to-r from-accent-500 to-accent-400'
              }`}
              style={{ width: `${stats?.cpu?.load ?? 0}%` }}
            />
          </div>
        </div>

        {/* Memory */}
        <div className="glass rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <Activity className="w-5 h-5 text-purple-500" />
            <span className="text-xs text-dark-400">内存</span>
          </div>
          <div className="text-2xl font-bold">
            {formatPercent(stats?.memory ? (stats.memory.used / (stats.memory.total || 1)) * 100 : null)}%
          </div>
          <div className="mt-2 h-1 bg-dark-800 rounded-full overflow-hidden">
            <div 
              className={`h-full transition-all duration-500 ${
                (stats?.memory ? (stats.memory.used / (stats.memory.total || 1)) * 100 : 0) > 80 ? 'bg-red-500' : 
                (stats?.memory ? (stats.memory.used / (stats.memory.total || 1)) * 100 : 0) > 50 ? 'bg-yellow-500' : 
                'bg-gradient-to-r from-purple-500 to-purple-400'
              }`}
              style={{ width: `${stats?.memory ? (stats.memory.used / (stats.memory.total || 1)) * 100 : 0}%` }}
            />
          </div>
        </div>

        {/* Disk */}
        <div className="glass rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <HardDrive className="w-5 h-5 text-orange-500" />
            <span className="text-xs text-dark-400">磁盘</span>
          </div>
          <div className="text-2xl font-bold">
            {stats?.disk?.[0]?.usePercent?.toFixed(1) || 0}%
          </div>
          <div className="mt-2 h-1 bg-dark-800 rounded-full overflow-hidden">
            <div 
              className={`h-full transition-all duration-500 ${
                (stats?.disk?.[0]?.usePercent || 0) > 90 ? 'bg-red-500' : 
                (stats?.disk?.[0]?.usePercent || 0) > 70 ? 'bg-yellow-500' : 
                'bg-gradient-to-r from-orange-500 to-orange-400'
              }`}
              style={{ width: `${stats?.disk?.[0]?.usePercent || 0}%` }}
            />
          </div>
        </div>

        {/* Network */}
        <div className="glass rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <Network className="w-5 h-5 text-green-500" />
            <span className="text-xs text-dark-400">网络</span>
          </div>
          <div className="text-2xl font-bold">
            {stats?.network?.[0] 
              ? formatBytes(stats.network[0].rx + stats.network[0].tx) + '/s'
              : isRemote ? 'N/A' : '0 B/s'}
          </div>
          {!isRemote && (
            <div className="mt-2 text-xs text-dark-500">
              ↑ {stats?.network?.[0] ? formatBytes(stats.network[0].tx) + '/s' : '0 B/s'}
            </div>
          )}
        </div>
      </div>

      {/* GPU Cards */}
      {stats?.gpus && stats.gpus.length > 0 && (
        <div className="glass rounded-xl p-4">
          <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Cpu className="w-5 h-5 text-emerald-500" />
            GPU 监控
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {stats.gpus.map((gpu) => (
              <div key={gpu.index} className="bg-dark-900/50 rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="font-medium text-sm truncate flex-1">{gpu.name}</div>
                  <span className={`text-xs font-medium ml-2 ${
                    gpu.temp > 80 ? 'text-red-400' : gpu.temp > 60 ? 'text-yellow-400' : 'text-emerald-400'
                  }`}>
                    {gpu.temp}°C
                  </span>
                </div>

                {/* GPU Util */}
                <div>
                  <div className="flex justify-between text-xs text-dark-400 mb-1">
                    <span>GPU 利用率</span>
                    <span>{gpu.util}%</span>
                  </div>
                  <div className="h-2 bg-dark-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all duration-500 ${
                        gpu.util > 90 ? 'bg-red-500' : gpu.util > 70 ? 'bg-yellow-500' : 'bg-emerald-500'
                      }`}
                      style={{ width: `${gpu.util}%` }}
                    />
                  </div>
                </div>

                {/* GPU Memory */}
                <div>
                  <div className="flex justify-between text-xs text-dark-400 mb-1">
                    <span>显存</span>
                    <span>{gpu.memUsed} / {gpu.memTotal} MB</span>
                  </div>
                  <div className="h-2 bg-dark-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-cyan-500 to-cyan-400 transition-all duration-500"
                      style={{ width: `${Math.min((gpu.memUsed / gpu.memTotal) * 100, 100)}%` }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Charts */}
      <div className="grid md:grid-cols-2 gap-6">
        {/* CPU & Memory Chart */}
        <div className="glass rounded-xl p-4">
          <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Zap className="w-5 h-5 text-accent-500" />
            CPU & 内存使用率
          </h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={history}>
                <defs>
                  <linearGradient id="cpuGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#0ea5e9" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#0ea5e9" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="memGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#a855f7" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#a855f7" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <XAxis dataKey="timestamp" hide />
                <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} stroke="#5c5c66" fontSize={12} />
                <Tooltip 
                  contentStyle={{ background: '#1e1e26', border: '1px solid #32323a', borderRadius: '8px' }}
                  labelFormatter={(v) => new Date(v).toLocaleTimeString()}
                  formatter={(v: number) => [`${v.toFixed(1)}%`]}
                />
                <Area type="monotone" dataKey="cpu" stroke="#0ea5e9" fill="url(#cpuGradient)" strokeWidth={2} name="CPU" />
                <Area type="monotone" dataKey="memory" stroke="#a855f7" fill="url(#memGradient)" strokeWidth={2} name="内存" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Network Chart */}
        <div className="glass rounded-xl p-4">
          <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Network className="w-5 h-5 text-green-500" />
            网络流量
          </h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={history}>
                <XAxis dataKey="timestamp" hide />
                <YAxis tickFormatter={(v) => formatBytes(v)} stroke="#5c5c66" fontSize={12} />
                <Tooltip 
                  contentStyle={{ background: '#1e1e26', border: '1px solid #32323a', borderRadius: '8px' }}
                  labelFormatter={(v) => new Date(v).toLocaleTimeString()}
                  formatter={(v: number) => [formatBytes(v) + '/s']}
                />
                <Line type="monotone" dataKey="network" stroke="#22c55e" strokeWidth={2} dot={false} name="流量" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Recent Logs */}
      <div className="glass rounded-xl p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Clock className="w-5 h-5 text-blue-500" />
            最近日志
          </h3>
          <a href="/logs" className="text-sm text-accent-500 hover:text-accent-400">查看全部 →</a>
        </div>
        
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {recentLogs.length === 0 ? (
            <div className="text-center py-8 text-dark-500">
              暂无日志数据
            </div>
          ) : (
            recentLogs.slice(0, 10).map((log) => (
              <div 
                key={log.id}
                className="flex items-start gap-3 p-2 rounded-lg bg-dark-900/50 hover:bg-dark-800/50 transition-colors font-mono text-sm"
              >
                <span className="text-dark-500 text-xs whitespace-nowrap">
                  {new Date(log.timestamp).toLocaleTimeString()}
                </span>
                <span className={`text-xs font-semibold ${getLevelColor(log.level)}`}>
                  {log.level}
                </span>
                <span className="text-dark-300 flex-1 truncate">
                  {log.message}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Quick Stats */}
      <div className="grid md:grid-cols-3 gap-4">
        <div className="glass rounded-xl p-4 flex items-center gap-4">
          <div className="p-3 rounded-lg bg-red-500/20">
            <AlertTriangle className="w-6 h-6 text-red-500" />
          </div>
          <div>
            <div className="text-2xl font-bold">
              {recentLogs.filter(l => l.level === 'ERROR').length}
            </div>
            <div className="text-sm text-dark-400">错误日志</div>
          </div>
        </div>
        
        <div className="glass rounded-xl p-4 flex items-center gap-4">
          <div className="p-3 rounded-lg bg-yellow-500/20">
            <AlertTriangle className="w-6 h-6 text-yellow-500" />
          </div>
          <div>
            <div className="text-2xl font-bold">
              {recentLogs.filter(l => l.level === 'WARN' || l.level === 'WARNING').length}
            </div>
            <div className="text-sm text-dark-400">警告日志</div>
          </div>
        </div>
        
        <div className="glass rounded-xl p-4 flex items-center gap-4">
          <div className="p-3 rounded-lg bg-green-500/20">
            <CheckCircle className="w-6 h-6 text-green-500" />
          </div>
          <div>
            <div className="text-2xl font-bold">
              {recentLogs.filter(l => l.level === 'INFO').length}
            </div>
            <div className="text-sm text-dark-400">正常日志</div>
          </div>
        </div>
      </div>
    </div>
  );
}
