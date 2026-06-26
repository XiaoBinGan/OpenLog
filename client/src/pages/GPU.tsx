import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Cpu, MemoryStick, Thermometer, RefreshCw, Wifi, AlertCircle, Loader, Server, Monitor,
} from 'lucide-react';
import { useRemote } from '../contexts/RemoteContext';
import { useDevice } from '../contexts/DeviceContext';

interface GPUDevice {
  index: number;
  name: string;
  util: number;
  memUsed: number;
  memTotal: number;
  temp: number;
  processes?: { pid: number; name: string; usedMemory: number }[];
}

interface ServerGPU {
  serverId: string;
  serverName: string;
  serverHost: string;
  devices: GPUDevice[];
  summary: { total: number; utilAvg: number; memUsedAvg: number; memTotalAvg: number; tempAvg: number } | null;
  error?: string;
  loading: boolean;
}

export default function GPU() {
  // 从 RemoteContext 获取已连接的远程服务器（memoize 避免无限渲染）
  const { servers: remoteServers } = useRemote();
  const connectedServers = useMemo(
    () => remoteServers.filter(s => s.status === 'connected'),
    [remoteServers]
  );

  // 从 DeviceContext 获取当前选中设备
  const { selectedDevice, isRemote } = useDevice();

  const [serverGPUs, setServerGPUs] = useState<ServerGPU[]>([]);
  const [globalLoading, setGlobalLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  // 追踪是否已经尝试过本机 GPU 回退，避免反复 fetch
  const localFallbackTriedRef = useRef(false);

  const fetchServerGPU = useCallback(async (server: typeof connectedServers[0]): Promise<ServerGPU> => {
    try {
      const res = await fetch(`/api/remote/servers/${server.id}/stats`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (data.offline) throw new Error('服务器未连接');
      // Monitor stats 已经包含 gpus 数组（含 processes）
      const gpus = data.gpus || [];
      const summary = gpus.length > 0 ? {
        total: gpus.length,
        utilAvg: gpus.reduce((s: number, g: any) => s + (Number(g.util) || 0), 0) / gpus.length,
        memUsedAvg: gpus.reduce((s: number, g: any) => s + (Number(g.memUsed) || 0), 0) / gpus.length,
        memTotalAvg: gpus.reduce((s: number, g: any) => s + (Number(g.memTotal) || 0), 0) / gpus.length,
        tempAvg: gpus.reduce((s: number, g: any) => s + (Number(g.temp) || 0), 0) / gpus.length,
      } : null;
      return {
        serverId: server.id,
        serverName: server.name,
        serverHost: server.host,
        devices: gpus,
        summary,
        loading: false,
      };
    } catch (err) {
      return {
        serverId: server.id,
        serverName: server.name,
        serverHost: server.host,
        devices: [],
        summary: null,
        error: err instanceof Error ? err.message : '查询失败',
        loading: false,
      };
    }
  }, []);

  // 本机 GPU 获取：先尝试本地 /api/monitor/stats，无 GPU 时回退到同 host 远程连接
  const fetchLocalGPU = useCallback(async (): Promise<ServerGPU | null> => {
    try {
      // 1) 尝试本机 monitor API
      const res = await fetch('/api/monitor/stats');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const gpus: GPUDevice[] = (data.gpus || []).map((g: any) => ({
        index: g.index ?? 0,
        name: g.name || 'GPU',
        util: Number(g.util) || 0,
        memUsed: Number(g.memUsed) || 0,
        memTotal: Number(g.memTotal) || 0,
        temp: Number(g.temp) || 0,
        processes: g.processes || [],
      }));

      if (gpus.length > 0) {
        // 本机有 GPU，直接返回
        const summary = {
          total: gpus.length,
          utilAvg: gpus.reduce((s, g) => s + g.util, 0) / gpus.length,
          memUsedAvg: gpus.reduce((s, g) => s + g.memUsed, 0) / gpus.length,
          memTotalAvg: gpus.reduce((s, g) => s + g.memTotal, 0) / gpus.length,
          tempAvg: gpus.reduce((s, g) => s + g.temp, 0) / gpus.length,
        };
        return {
          serverId: 'local',
          serverName: '本机设备',
          serverHost: 'localhost',
          devices: gpus,
          summary,
          loading: false,
        };
      }

      // 2) 本机无 GPU → 从 connectedServers 中找 host 为 localhost 的服务器
      const localhostServers = connectedServers.filter(
        s => s.host === 'localhost' || s.host === '127.0.0.1' || s.host === '::1'
      );

      if (localhostServers.length > 0 && !localFallbackTriedRef.current) {
        localFallbackTriedRef.current = true;
        // 取第一个 localhost 服务器获取 GPU 数据
        const fallbackServer = localhostServers[0];
        const remoteGPU = await fetchServerGPU(fallbackServer);
        if (remoteGPU.devices.length > 0) {
          // 用本机设备的名义展示远程 GPU 数据
          return {
            ...remoteGPU,
            serverId: 'local',
            serverName: `本机设备 (via ${fallbackServer.name})`,
            serverHost: 'localhost',
          };
        }
      }

      return null;
    } catch (err) {
      console.error('[GPU] 本机 GPU 获取失败:', err);
      return null;
    }
  }, [connectedServers, fetchServerGPU]);

  const fetchAllGPUs = useCallback(async () => {
    // 构建要查询的源：远程服务器列表 + 本机（如果选中）
    const isFirstLoad = serverGPUs.length === 0;

    if (isFirstLoad) {
      setGlobalLoading(true);
    }

    const results: ServerGPU[] = [];

    // 本机设备
    if (!isRemote) {
      const localGPU = await fetchLocalGPU();
      if (localGPU && localGPU.devices.length > 0) {
        results.push(localGPU);
      }
    }

    // 远程服务器
    if (connectedServers.length > 0) {
      const remoteResults = await Promise.all(connectedServers.map(s => fetchServerGPU(s)));
      results.push(...remoteResults.filter(r => r.devices.length > 0 || r.error));
    }

    setServerGPUs(results);
    if (isFirstLoad) {
      setGlobalLoading(false);
    }
    setLastRefresh(new Date());
  }, [connectedServers, fetchServerGPU, fetchLocalGPU, isRemote]);

  useEffect(() => {
    fetchAllGPUs();
    const interval = setInterval(fetchAllGPUs, 30000);
    return () => clearInterval(interval);
  }, [fetchAllGPUs]);

  const totalGPUs = serverGPUs.reduce((s, sv) => s + sv.devices.length, 0);
  const avgUtil = serverGPUs.length > 0
    ? serverGPUs.reduce((s, sv) => s + (Number(sv.summary?.utilAvg) || 0), 0) / serverGPUs.length
    : 0;
  const totalMemUsed = serverGPUs.reduce((s, sv) => s + sv.devices.reduce((m, d) => m + (Number(d.memUsed) || 0), 0), 0);
  const totalMemTotal = serverGPUs.reduce((s, sv) => s + sv.devices.reduce((m, d) => m + (Number(d.memTotal) || 0), 0), 0);

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Cpu className="w-6 h-6 text-emerald-500" />
          <div>
            <h1 className="text-xl font-semibold text-dark-100">算力监控</h1>
            <p className="text-xs text-dark-400 mt-0.5">
              {serverGPUs.length > 0
                ? `${serverGPUs.length} 台设备 · ${totalGPUs} 张 GPU`
                : '等待 GPU 数据...'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {lastRefresh && (
            <span className="text-xs text-dark-500">
              上次刷新: {lastRefresh.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={fetchAllGPUs}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-dark-900 border border-dark-800 rounded-lg text-sm text-dark-400 hover:text-dark-200 transition-all"
          >
            <RefreshCw className={`w-4 h-4 ${globalLoading ? 'animate-spin' : ''}`} />
            刷新
          </button>
        </div>
      </div>

      {/* No GPU data at all */}
      {serverGPUs.length === 0 && !globalLoading && (
        <div className="glass rounded-xl p-12 text-center">
          <Server className="w-12 h-12 mx-auto mb-3 text-dark-600" />
          <p className="text-dark-400">没有检测到 GPU 数据</p>
          <p className="text-xs text-dark-500 mt-1">
            {isRemote
              ? '请检查远程服务器是否配置了 NVIDIA 驱动'
              : '本机未检测到 GPU。如有已连接的远程服务器，请切换到远程设备查看'}
          </p>
        </div>
      )}

      {/* Global Overview */}
      {totalGPUs > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <div className="glass rounded-xl p-4">
            <div className="text-xs text-dark-400 mb-1">GPU 总数</div>
            <div className="text-2xl font-bold text-dark-100">{totalGPUs}</div>
          </div>
          <div className="glass rounded-xl p-4">
            <div className="text-xs text-dark-400 mb-1">算力利用率</div>
            <div className="text-2xl font-bold text-emerald-400">{avgUtil.toFixed(1)}%</div>
          </div>
          <div className="glass rounded-xl p-4">
            <div className="text-xs text-dark-400 mb-1">总显存占用</div>
            <div className="text-2xl font-bold text-cyan-400">{totalMemUsed.toFixed(0)}</div>
            <div className="text-xs text-dark-500">/ {totalMemTotal.toFixed(0)} MB</div>
          </div>
          <div className="glass rounded-xl p-4">
            <div className="text-xs text-dark-400 mb-1">设备数</div>
            <div className="text-2xl font-bold text-purple-400">{serverGPUs.length}</div>
          </div>
        </div>
      )}

      {/* Loading */}
      {globalLoading && (
        <div className="flex items-center justify-center h-64">
          <Loader className="w-6 h-6 animate-spin text-emerald-400" />
          <span className="ml-2 text-dark-400">正在查询 GPU 数据...</span>
        </div>
      )}

      {/* Per-server GPU sections */}
      {!globalLoading && serverGPUs.map(sv => (
        <div key={sv.serverId} className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <div className="flex items-center gap-1.5 px-2.5 py-1 bg-dark-800 rounded-lg">
              {sv.serverId === 'local' ? (
                <Monitor className="w-3.5 h-3.5 text-accent-500" />
              ) : (
                <Wifi className="w-3.5 h-3.5 text-green-400" />
              )}
              <span className="text-sm font-medium text-dark-200">{sv.serverName}</span>
              <span className="text-xs text-dark-500">{sv.serverHost}</span>
            </div>
            {sv.summary && (
              <span className="text-xs text-dark-500">
                {sv.devices.length} GPU · 均用 {(sv.summary?.utilAvg ?? 0).toFixed(1)}% · 均温 {(sv.summary?.tempAvg ?? 0).toFixed(0)}°C
              </span>
            )}
          </div>

          {sv.error ? (
            <div className="glass rounded-xl p-4 border border-red-500/30">
              <div className="flex items-center gap-2 text-red-400 text-sm">
                <AlertCircle className="w-4 h-4" />
                {sv.error}
              </div>
            </div>
          ) : sv.devices.length === 0 ? (
            <div className="glass rounded-xl p-6 text-center text-dark-500 text-sm">
              该设备未检测到 GPU
            </div>
          ) : (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {sv.devices.map(gpu => {
                const memPct = gpu.memTotal > 0 ? (gpu.memUsed / gpu.memTotal) * 100 : 0;
                return (
                  <div key={gpu.index} className="glass rounded-xl p-4 space-y-3">
                    {/* Name & Temp */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" />
                        <span className="font-medium text-sm truncate">{gpu.name}</span>
                      </div>
                      <span className={`text-sm font-bold flex-shrink-0 ml-2 ${
                        gpu.temp > 80 ? 'text-red-400' : gpu.temp > 60 ? 'text-yellow-400' : 'text-emerald-400'
                      }`}>
                        {gpu.temp}°C
                      </span>
                    </div>

                    {/* Util */}
                    <div>
                      <div className="flex justify-between text-xs text-dark-400 mb-1">
                        <span>算力</span>
                        <span className="text-dark-200">{(gpu.util ?? 0).toFixed(1)}%</span>
                      </div>
                      <div className="h-2.5 bg-dark-800 rounded-full overflow-hidden">
                        <div className={`h-full transition-all ${
                          gpu.util > 90 ? 'bg-red-500' : gpu.util > 70 ? 'bg-yellow-500' : 'bg-emerald-500'
                        }`} style={{ width: `${gpu.util}%` }} />
                      </div>
                    </div>

                    {/* Memory */}
                    <div>
                      <div className="flex justify-between text-xs text-dark-400 mb-1">
                        <span>显存</span>
                        <span className="text-dark-200">{(gpu.memUsed ?? 0).toFixed(0)} / {gpu.memTotal.toFixed(0)} MB</span>
                      </div>
                      <div className="h-2.5 bg-dark-800 rounded-full overflow-hidden">
                        <div className={`h-full transition-all ${
                          memPct > 90 ? 'bg-red-500' : memPct > 70 ? 'bg-yellow-500' : 'bg-cyan-500'
                        }`} style={{ width: `${memPct}%` }} />
                      </div>
                      <div className="flex justify-between mt-1">
                        <span className="text-[10px] text-cyan-400">{memPct.toFixed(1)}%</span>
                        <span className="text-[10px] text-dark-500">{(gpu.memUsed ?? 0).toFixed(0)} MB</span>
                      </div>
                    </div>

                    {/* Temp bar */}
                    <div>
                      <div className="flex justify-between text-xs text-dark-400 mb-1">
                        <span>温度</span>
                        <span className="text-dark-200">{gpu.temp}°C</span>
                      </div>
                      <div className="h-2 bg-dark-800 rounded-full overflow-hidden">
                        <div className={`h-full transition-all ${
                          gpu.temp > 80 ? 'bg-red-500' : gpu.temp > 60 ? 'bg-yellow-500' : 'bg-emerald-500'
                        }`} style={{ width: `${Math.min(gpu.temp, 100)}%` }} />
                      </div>
                    </div>

                    {/* Processes */}
                    {gpu.processes && gpu.processes.length > 0 && (
                      <div className="pt-1 border-t border-dark-800">
                        <div className="text-[10px] text-dark-500 mb-1">进程</div>
                        {gpu.processes.slice(0, 5).map((p, i) => (
                          <div key={i} className="flex items-center justify-between text-[11px]">
                            <span className="text-dark-500 text-[10px] w-16 flex-shrink-0">PID {p.pid}</span>
                            <span className="text-dark-300 truncate max-w-[100px]">{p.name}</span>
                            <span className="text-dark-500 ml-auto">{p.usedMemory} MB</span>
                          </div>
                        ))}
                        {gpu.processes.length > 5 && (
                          <div className="text-[10px] text-dark-500">+{gpu.processes.length - 5} 更多</div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
