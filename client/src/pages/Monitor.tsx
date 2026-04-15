import { useState, useEffect } from 'react';
import { 
  Cpu, 
  HardDrive, 
  Network, 
  Server, 
  RefreshCw,
  MemoryStick,
  AlertCircle
} from 'lucide-react';
import { 
  LineChart, 
  Line, 
  AreaChart, 
  Area, 
  XAxis, 
  YAxis, 
  Tooltip, 
  ResponsiveContainer
} from 'recharts';
import { useDevice } from '../contexts/DeviceContext';
import type { MonitorStats, MonitorHistory, RemoteServer } from '../types';

export default function Monitor() {
  const { selectedDevice, isRemote } = useDevice();
  const [stats, setStats] = useState<MonitorStats | null>(null);
  const [history, setHistory] = useState<MonitorHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      setError(null);
      setLoading(true);
      
      try {
        if (isRemote) {
          // 远程服务器：API 直接返回 MonitorStats 结构
          const res = await fetch(`/api/remote/servers/${selectedDevice.id}/stats`);
          const data = await res.json();
          
          console.log('[Monitor] remote stats response:', JSON.stringify(data));
          
          if (data.error) {
            throw new Error(data.error);
          }
          
          setStats({
            ...data,
            disk: Array.isArray(data.disk) ? data.disk : [],
            network: Array.isArray(data.network) ? data.network : [],
            processes: Array.isArray(data.processes) ? data.processes : [],
          } as MonitorStats);
          
          // 追加到历史（仅 CPU/内存/磁盘/GPU，网络和进程不追踪历史）
          const now = Date.now();
          const memPct = data.memory ? (data.memory.used / (data.memory.total || 1)) * 100 : 0;
          const gpuUtil = Array.isArray(data.gpus) && data.gpus.length > 0 ? (data.gpus[0].util ?? 0) : 0;
          const last = history[history.length - 1];
          setHistory(prev => {
            const next = [...prev, {
              id: Date.now(),
              timestamp: new Date().toISOString(),
              cpu: data.cpu?.load ?? 0,
              memory: memPct,
              disk: data.disk?.[0]?.usePercent ?? 0,
              network: Array.isArray(data.network) && data.network[0] ? (data.network[0].rx + data.network[0].tx) : 0,
              gpuUtil,
            }];
            return next.slice(-60);
          });
          
        } else {
          // 本地设备
          const [statsData, historyData] = await Promise.all([
            fetch('/api/monitor/stats').then(r => r.json()),
            fetch('/api/monitor/history?limit=60').then(r => r.json())
          ]);
          
          setStats(statsData);
          setHistory(historyData);
        }
      } catch (err) {
        console.error('Failed to fetch monitor data:', err);
        setError(err instanceof Error ? err.message : '获取监控数据失败');
      }
      
      setLoading(false);
    };

    fetchData();
    
    // Auto refresh every 5 seconds
    const interval = setInterval(fetchData, 5000);
    
    return () => clearInterval(interval);
  }, [selectedDevice.id, isRemote]);

  const formatBytes = (bytes: number) => {
    if (!bytes || bytes === 0 || isNaN(bytes)) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatNumber = (num: number) => {
    if (num >= 1000000000) return (num / 1000000000).toFixed(1) + 'G';
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toFixed(1);
  };

  const formatPercent = (val: number | undefined | null) => {
    if (val === undefined || val === null || isNaN(val)) return '0.0';
    return val.toFixed(1);
  };

  if (loading && !stats) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-8 h-8 text-accent-500 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-red-400">
        <AlertCircle className="w-12 h-12 mb-4" />
        <p className="text-lg font-medium">获取监控数据失败</p>
        <p className="text-sm text-dark-400 mt-2">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-3">
            <Server className="w-7 h-7 text-accent-500" />
            系统监控
          </h1>
          <p className="text-dark-400">
            {isRemote ? `远程服务器: ${selectedDevice.name}` : '本地设备实时资源使用情况'}
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm text-dark-400">
          <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          实时更新中
        </div>
      </div>

      {/* CPU Section */}
      <div className="glass rounded-xl p-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Cpu className="w-5 h-5 text-accent-500" />
            CPU 使用率
          </h2>
          <span className="text-2xl font-bold text-accent-400">
            {stats?.cpu?.load?.toFixed(1) || 0}%
          </span>
        </div>
        
        {/* CPU Cores - only for local */}
        {!isRemote && stats?.cpu?.cores && stats.cpu.cores.length > 0 && (
          <div className="grid grid-cols-4 md:grid-cols-8 gap-2 mb-4">
            {stats.cpu.cores.map((load, idx) => (
              <div key={idx} className="text-center">
                <div className="h-16 bg-dark-900 rounded-lg relative overflow-hidden">
                  <div 
                    className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-accent-600 to-accent-400 transition-all duration-500"
                    style={{ height: `${load}%` }}
                  />
                </div>
                <div className="text-xs text-dark-500 mt-1">#{idx + 1}</div>
                <div className="text-xs font-medium">{load.toFixed(0)}%</div>
              </div>
            ))}
          </div>
        )}
        
        {/* CPU History Chart */}
        <div className="h-40">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={history}>
              <defs>
                <linearGradient id="cpuGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#0ea5e9" stopOpacity={0.3}/>
                  <stop offset="95%" stopColor="#0ea5e9" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <XAxis dataKey="timestamp" hide />
              <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} stroke="#5c5c66" fontSize={12} />
              <Tooltip 
                contentStyle={{ background: '#1e1e26', border: '1px solid #32323a', borderRadius: '8px' }}
                labelFormatter={(v) => new Date(v).toLocaleTimeString()}
                formatter={(v: number) => [`${v.toFixed(1)}%`, 'CPU']}
              />
              <Area type="monotone" dataKey="cpu" stroke="#0ea5e9" fill="url(#cpuGrad)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Memory & Disk */}
      <div className="grid md:grid-cols-2 gap-6">
        {/* Memory */}
        <div className="glass rounded-xl p-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <MemoryStick className="w-5 h-5 text-purple-500" />
              内存使用
            </h2>
            <span className="text-2xl font-bold text-purple-400">
              {formatPercent(stats?.memory ? (stats.memory.used / (stats.memory.total || 1)) * 100 : null)}%
            </span>
          </div>
          
          <div className="mb-4">
            <div className="h-4 bg-dark-900 rounded-full overflow-hidden">
              <div 
                className="h-full bg-gradient-to-r from-purple-600 to-purple-400 transition-all duration-500"
                style={{ width: `${stats?.memory ? (stats.memory.used / (stats.memory.total || 1)) * 100 : 0}%` }}
              />
            </div>
            <div className="flex justify-between mt-2 text-sm text-dark-400">
              <span>已用: {stats?.memory ? formatBytes(stats.memory.used ?? 0) : '0 B'}</span>
              <span>总计: {stats?.memory ? formatBytes(stats.memory.total ?? 1) : '0 B'}</span>
            </div>
          </div>
          
          {/* Memory History */}
          <div className="h-40">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={history}>
                <defs>
                  <linearGradient id="memGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#a855f7" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#a855f7" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <XAxis dataKey="timestamp" hide />
                <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} stroke="#5c5c66" fontSize={12} />
                <Tooltip 
                  contentStyle={{ background: '#1e1e26', border: '1px solid #32323a', borderRadius: '8px' }}
                  labelFormatter={(v) => new Date(v).toLocaleTimeString()}
                  formatter={(v: number) => [`${v.toFixed(1)}%`, '内存']}
                />
                <Area type="monotone" dataKey="memory" stroke="#a855f7" fill="url(#memGrad)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Disk */}
        <div className="glass rounded-xl p-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <HardDrive className="w-5 h-5 text-orange-500" />
              磁盘使用
            </h2>
          </div>
          
          <div className="space-y-3">
            {stats?.disk?.map((disk, idx) => (
              <div key={idx}>
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-dark-300">{disk.name}</span>
                  <span className="text-dark-400">
                    {formatBytes(disk.used)} / {formatBytes(disk.total)}
                  </span>
                </div>
                <div className="h-2 bg-dark-900 rounded-full overflow-hidden">
                  <div 
                    className={`h-full transition-all duration-500 ${
                      disk.usePercent > 90 ? 'bg-red-500' : 
                      disk.usePercent > 70 ? 'bg-yellow-500' : 
                      'bg-gradient-to-r from-orange-500 to-orange-400'
                    }`}
                    style={{ width: `${disk.usePercent}%` }}
                  />
                </div>
              </div>
            ))}
            
            {(!stats?.disk || stats.disk.length === 0) && (
              <div className="text-center py-8 text-dark-500">
                暂无磁盘数据
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Network */}
      <div className="glass rounded-xl p-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Network className="w-5 h-5 text-green-500" />
            网络流量
          </h2>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          {stats?.network?.slice(0, 2).map((net, idx) => (
            <div key={idx} className="bg-dark-900 rounded-lg p-3">
              <div className="text-sm text-dark-400 mb-2">{net.iface}</div>
              <div className="flex justify-between">
                <div>
                  <div className="text-xs text-dark-500">下载</div>
                  <div className="text-lg font-semibold text-green-400">
                    {formatBytes(net.rx)}/s
                  </div>
                </div>
                <div>
                  <div className="text-xs text-dark-500">上传</div>
                  <div className="text-lg font-semibold text-blue-400">
                    {formatBytes(net.tx)}/s
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Network History */}
        <div className="h-40 mt-4">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={history}>
              <XAxis dataKey="timestamp" hide />
              <YAxis tickFormatter={formatNumber} stroke="#5c5c66" fontSize={12} />
              <Tooltip
                contentStyle={{ background: '#1e1e26', border: '1px solid #32323a', borderRadius: '8px' }}
                labelFormatter={(v) => new Date(v).toLocaleTimeString()}
                formatter={(v: number) => [formatBytes(v) + '/s', '流量']}
              />
              <Line type="monotone" dataKey="network" stroke="#22c55e" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* GPU Section */}
      {stats?.gpus && stats.gpus.length > 0 && (
        <div className="glass rounded-xl p-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Cpu className="w-5 h-5 text-emerald-500" />
              GPU 监控
            </h2>
            <span className="text-sm text-dark-400">
              {stats.gpus.length} 张显卡
            </span>
          </div>

          {/* GPU Cards */}
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            {stats.gpus.map((gpu) => {
              const memPct = gpu.memTotal > 0 ? (gpu.memUsed / gpu.memTotal) * 100 : 0;
              return (
                <div key={gpu.index} className="bg-dark-900/60 rounded-xl p-4 space-y-4">
                  {/* GPU Name & Temp */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-emerald-500" />
                      <span className="font-medium text-sm truncate max-w-[180px]">{gpu.name}</span>
                    </div>
                    <span className={`text-sm font-bold ${
                      gpu.temp > 80 ? 'text-red-400' : gpu.temp > 60 ? 'text-yellow-400' : 'text-emerald-400'
                    }`}>
                      {gpu.temp}°C
                    </span>
                  </div>

                  {/* GPU Util */}
                  <div>
                    <div className="flex justify-between text-xs text-dark-400 mb-1.5">
                      <span>算力占用</span>
                      <span className="font-medium text-dark-200">{gpu.util.toFixed(1)}%</span>
                    </div>
                    <div className="h-3 bg-dark-800 rounded-full overflow-hidden">
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
                    <div className="flex justify-between text-xs text-dark-400 mb-1.5">
                      <span>显存占用</span>
                      <span className="font-medium text-dark-200">
                        {gpu.memUsed.toFixed(0)} / {gpu.memTotal.toFixed(0)} MB
                      </span>
                    </div>
                    <div className="h-3 bg-dark-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all duration-500 ${
                          memPct > 90 ? 'bg-red-500' : memPct > 70 ? 'bg-yellow-500' : 'bg-cyan-500'
                        }`}
                        style={{ width: `${memPct}%` }}
                      />
                    </div>
                    <div className="flex justify-between mt-1">
                      <span className="text-xs text-cyan-400">{memPct.toFixed(1)}% 已用</span>
                      <span className="text-xs text-dark-500">{gpu.memUsed.toFixed(0)} MB</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* GPU History Chart (uses first GPU util) */}
          {stats.gpus.length > 0 && (
            <div className="h-40 mt-4">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={history}>
                  <defs>
                    <linearGradient id="gpuGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="timestamp" hide />
                  <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} stroke="#5c5c66" fontSize={12} />
                  <Tooltip
                    contentStyle={{ background: '#1e1e26', border: '1px solid #32323a', borderRadius: '8px' }}
                    labelFormatter={(v) => new Date(v).toLocaleTimeString()}
                    formatter={(v: number) => [`${v.toFixed(1)}%`, 'GPU 算力']}
                  />
                  <Area type="monotone" dataKey="gpuUtil" stroke="#10b981" fill="url(#gpuGrad)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}

      {/* Top Processes */}
      {stats?.processes && stats.processes.length > 0 && (
        <div className="glass rounded-xl p-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Server className="w-5 h-5 text-pink-500" />
              Top 进程
            </h2>
          </div>
          
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left text-xs text-dark-400 border-b border-dark-800">
                  <th className="pb-2 font-medium">PID</th>
                  <th className="pb-2 font-medium">进程名</th>
                  <th className="pb-2 font-medium text-right">CPU %</th>
                  <th className="pb-2 font-medium text-right">内存 %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-dark-800/50">
                {stats.processes.map((proc) => (
                  <tr key={proc.pid} className="hover:bg-dark-800/30">
                    <td className="py-2 text-dark-500 font-mono">{proc.pid}</td>
                    <td className="py-2 text-dark-300">{proc.name}</td>
                    <td className="py-2 text-right">
                      <span className={proc.cpu > 50 ? 'text-red-400' : proc.cpu > 20 ? 'text-yellow-400' : 'text-dark-300'}>
                        {proc.cpu.toFixed(1)}%
                      </span>
                    </td>
                    <td className="py-2 text-right">
                      <span className={proc.mem > 50 ? 'text-red-400' : proc.mem > 20 ? 'text-yellow-400' : 'text-dark-300'}>
                        {proc.mem.toFixed(1)}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
