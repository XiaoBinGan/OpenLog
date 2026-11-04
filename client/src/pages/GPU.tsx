import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { usePolling } from '../utils/usePolling';
import {
  Cpu, MemoryStick, Thermometer, RefreshCw, Wifi, AlertCircle, Loader, Server, Monitor,
} from 'lucide-react';
import { useRemote } from '../contexts/RemoteContext';
import { useDevice } from '../contexts/DeviceContext';
import { apiFetch } from '../api/client';

/** nvidia-smi 的数字字段在旧格式下可能是字符串，统一走 Number() 转换。 */
type Numeric = number | string;

interface GpuPayload {
  index?: number;
  name?: string;
  util?: Numeric;
  memUsed?: Numeric;
  memTotal?: Numeric;
  temp?: Numeric;
  processes?: { pid: number; name: string; usedMemory: number }[];
}

interface RemoteGpuStats {
  error?: string;
  offline?: boolean;
  gpus?: GPUDevice[];
}

interface GPUDevice {
  index: number;
  name: string;
  util: number;
  memUsed: number;
  memTotal: number;
  temp: number;
  processes?: { pid: number; name: string; usedMemory: number }[];
}

/** 单引擎 MFU 结果（同一台机器上可能同时有 vLLM / Strata 等多个引擎） */
interface MfuEngine {
  engine: string;
  available: boolean;
  model?: string | null;
  mfu?: number;
  gpuIndexes?: number[];
  peakTflops?: number;
  paramsB?: number | null;
  tokensPerSec?: number;
  windowSec?: number;
  method?: string;
  reason?: string;
  endpoint?: string;
  sampledAt?: string;
}

/** 某张卡的 MFU（服务端已经按引擎进程/型号把引擎映射到显卡） */
interface GpuMfuEntry {
  mfu: number;
  engine: string;
  model?: string | null;
  windowSec?: number;
}

interface ServerMfu {
  available: boolean;
  engines?: MfuEngine[];
  gpuMfu?: Record<string, GpuMfuEntry>;
  reason?: string | null;
}

interface ServerGPU {
  serverId: string;
  serverName: string;
  serverHost: string;
  devices: GPUDevice[];
  summary: { total: number; utilAvg: number; memUsedAvg: number; memTotalAvg: number; tempAvg: number } | null;
  mfu?: ServerMfu | null;
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

  /** 把一条快照条目转成页面用的 ServerGPU */
  const toServerGPU = useCallback((entry: any, server: typeof connectedServers[0] | undefined): ServerGPU => {
    const rawGpus = entry?.gpus ?? entry?.stats?.gpus ?? [];
    const gpus: GPUDevice[] = (rawGpus as any[]).map((g: any) => ({
      index: g.index ?? 0,
      name: g.name || 'GPU',
      util: Number(g.util) || 0,
      memUsed: Number(g.memUsed) || 0,
      memTotal: Number(g.memTotal) || 0,
      temp: Number(g.temp) || 0,
      processes: g.processes || [],
    }));
    const summary = gpus.length > 0 ? {
      total: gpus.length,
      utilAvg: gpus.reduce((s: number, g) => s + g.util, 0) / gpus.length,
      memUsedAvg: gpus.reduce((s: number, g) => s + g.memUsed, 0) / gpus.length,
      memTotalAvg: gpus.reduce((s: number, g) => s + g.memTotal, 0) / gpus.length,
      tempAvg: gpus.reduce((s: number, g) => s + g.temp, 0) / gpus.length,
    } : null;
    return {
      serverId: entry?.serverId || server?.id || '',
      serverName: entry?.serverName || server?.name || '服务器',
      serverHost: server?.host || '',
      devices: gpus,
      summary,
      mfu: entry?.mfu ?? null,
      loading: false,
      ...(entry?.statsError ? { error: entry.statsError } : {}),
    };
  }, []);

  const fetchServerGPU = useCallback(async (server: typeof connectedServers[0]): Promise<ServerGPU> => {
    try {
      // 单台按需查询（批量快照没覆盖到时兜底）
      const mfuPromise = apiFetch<ServerMfu>(`/api/remote/servers/${server.id}/mfu`).catch(() => null);
      const data = await apiFetch<RemoteGpuStats>(`/api/remote/servers/${server.id}/stats`);
      const mfu = await mfuPromise;
      if (data.error) throw new Error(data.error);
      if (data.offline) throw new Error('服务器未连接');
      return toServerGPU({ serverId: server.id, serverName: server.name, stats: data, mfu }, server);
    } catch (err) {
      return {
        serverId: server.id,
        serverName: server.name,
        serverHost: server.host,
        devices: [],
        summary: null,
        mfu: null,
        error: err instanceof Error ? err.message : '查询失败',
        loading: false,
      };
    }
  }, [toServerGPU]);

  // 本机 GPU 获取：先尝试本地 /api/monitor/stats，无 GPU 时回退到同 host 远程连接
  const fetchLocalGPU = useCallback(async (): Promise<ServerGPU | null> => {
    try {
      // 1) 尝试本机 monitor API
      const data = await apiFetch<{ gpus?: GpuPayload[] }>('/api/monitor/stats');
      const gpus: GPUDevice[] = (data.gpus || []).map((g) => ({
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

    // 本地算力暂不展示，也不参与统计；算力监控仅统计已连接的远程服务器。
    // if (!isRemote) {
    //   const localGPU = await fetchLocalGPU();
    //   if (localGPU && localGPU.devices.length > 0) {
    //     results.push(localGPU);
    //   }
    // }

    // 远程服务器：一次拉服务端聚合快照。
    // 旧实现是 Promise.all 对每台服务器各发 2 个请求（stats + mfu），
    // 1000 台 = 每 30s 2000 个并发请求，浏览器和服务端都会被打满。
    if (connectedServers.length > 0) {
      try {
        const snap = await apiFetch<{
          servers?: Array<{ serverId: string; serverName: string; gpus?: any[]; stats?: any; statsError?: string | null; mfu?: ServerMfu | null }>;
        }>('/api/remote/servers/stats?fields=gpu');
        const byId = new Map(connectedServers.map(s => [s.id, s]));
        const entries = snap.servers || [];
        const remoteResults = entries.map(entry => toServerGPU(entry, byId.get(entry.serverId)));
        // 快照里没有的（极少：刚好断连）单独兜底查询，避免整块缺失
        const missing = connectedServers.filter(s => !entries.some(e => e.serverId === s.id));
        if (missing.length > 0 && missing.length <= 20) {
          const fallback = await Promise.all(missing.map(s => fetchServerGPU(s)));
          remoteResults.push(...fallback);
        }
        results.push(...remoteResults.filter(r => r.devices.length > 0 || r.error));
      } catch {
        // 聚合接口失败时退回逐台查询（保持可用），但限制数量避免把服务端打爆
        const subset = connectedServers.slice(0, 20);
        const remoteResults = await Promise.all(subset.map(s => fetchServerGPU(s)));
        results.push(...remoteResults.filter(r => r.devices.length > 0 || r.error));
      }
    }

    setServerGPUs(results);
    if (isFirstLoad) {
      setGlobalLoading(false);
    }
    setLastRefresh(new Date());
  }, [connectedServers, fetchServerGPU, fetchLocalGPU, isRemote, toServerGPU]);

  // 30s 刷新（页面隐藏时暂停；GPU 查询要连服务器跑 nvidia-smi，后台轮询纯浪费）
  usePolling(fetchAllGPUs, 30000, [fetchAllGPUs]);

  const totalGPUs = serverGPUs.reduce((s, sv) => s + sv.devices.length, 0);
  const avgUtil = serverGPUs.length > 0
    ? serverGPUs.reduce((s, sv) => s + (Number(sv.summary?.utilAvg) || 0), 0) / serverGPUs.length
    : 0;
  const totalMemUsed = serverGPUs.reduce((s, sv) => s + sv.devices.reduce((m, d) => m + (Number(d.memUsed) || 0), 0), 0);
  const totalMemTotal = serverGPUs.reduce((s, sv) => s + sv.devices.reduce((m, d) => m + (Number(d.memTotal) || 0), 0), 0);

  // 全局 MFU：按「算出 MFU 的显卡」平均；同时给出覆盖率，避免把不可用的算成 0
  const mfuCards: GpuMfuEntry[] = serverGPUs.flatMap(sv => Object.values(sv.mfu?.gpuMfu || {}));
  const avgMfu = mfuCards.length > 0
    ? mfuCards.reduce((s, e) => s + (Number(e.mfu) || 0), 0) / mfuCards.length
    : null;
  const mfuEngineNames = [...new Set(serverGPUs
    .flatMap(sv => sv.mfu?.engines || [])
    .filter(e => e.available)
    .map(e => e.engine))];

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
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
          <div className="glass rounded-xl p-4">
            <div className="text-xs text-dark-400 mb-1">GPU 总数</div>
            <div className="text-2xl font-bold text-dark-100">{totalGPUs}</div>
          </div>
          <div className="glass rounded-xl p-4">
            <div className="text-xs text-dark-400 mb-1">算力利用率</div>
            <div className="text-2xl font-bold text-emerald-400">{avgUtil.toFixed(1)}%</div>
          </div>
          <div className="glass rounded-xl p-4">
            <div className="text-xs text-dark-400 mb-1" title="MFU = 模型实际 FLOPs/s ÷ GPU 峰值算力（FP16/BF16 稠密）&#10;按引擎所在显卡平均；窗口约 30s">
              模型 MFU
            </div>
            <div className="text-2xl font-bold text-amber-400">
              {avgMfu === null ? '—' : `${avgMfu.toFixed(1)}%`}
            </div>
            <div className="text-xs text-dark-500">
              {avgMfu === null
                ? '未检测到推理引擎指标'
                : `${mfuCards.length} 张卡${mfuEngineNames.length ? ` · ${mfuEngineNames.join(' + ')}` : ''}`}
            </div>
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
            {(sv.mfu?.engines || []).filter(e => e.available).map(e => (
              <span
                key={e.engine}
                className="px-2 py-0.5 bg-amber-500/10 border border-amber-500/30 rounded-lg text-xs text-amber-400"
                title={[
                  `MFU（模型算力利用率）= 模型实际 FLOPs/s ÷ GPU 峰值算力`,
                  `引擎：${e.engine}`,
                  e.model ? `模型：${e.model}` : null,
                  e.paramsB ? `激活参数：${e.paramsB}B` : null,
                  e.peakTflops ? `峰值：${e.peakTflops} TFLOPS（FP16/BF16 稠密）` : null,
                  typeof e.tokensPerSec === 'number' ? `窗口吞吐：${e.tokensPerSec} tok/s（近 ${e.windowSec ?? '?'}s）` : null,
                  e.endpoint ? `指标源：${e.endpoint}` : null,
                ].filter(Boolean).join('\n')}
              >
                {e.engine} MFU {typeof e.mfu === 'number' ? `${e.mfu.toFixed(1)}%` : '—'}
              </span>
            ))}
            {!sv.mfu?.available && sv.mfu?.reason && (
              <span className="text-xs text-dark-600" title={sv.mfu.reason}>MFU —</span>
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
                // 服务端已把每个引擎映射到显卡：gpuMfu[卡号]
                const gpuMfuEntry = sv.mfu?.gpuMfu?.[String(gpu.index)] || null;
                const gpuMfuValue = gpuMfuEntry && typeof gpuMfuEntry.mfu === 'number' ? gpuMfuEntry.mfu : null;
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

                    {/* MFU（模型算力利用率）——服务端按引擎进程/型号映射到这张卡时显示 */}
                    {gpuMfuValue !== null && gpuMfuEntry && (
                      <div>
                        <div
                          className="flex justify-between text-xs text-dark-400 mb-1"
                          title={[
                            'MFU（模型算力利用率）= 模型实际 FLOPs/s ÷ GPU 峰值算力',
                            `引擎：${gpuMfuEntry.engine}`,
                            gpuMfuEntry.model ? `模型：${gpuMfuEntry.model}` : null,
                            typeof gpuMfuEntry.windowSec === 'number' ? `采样窗口：近 ${gpuMfuEntry.windowSec}s` : null,
                          ].filter(Boolean).join('\n')}
                        >
                          <span>MFU <span className="text-dark-600">({gpuMfuEntry.engine})</span></span>
                          <span className="text-amber-400 font-medium">{gpuMfuValue.toFixed(1)}%</span>
                        </div>
                        <div className="h-2 bg-dark-800 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-amber-500 transition-all"
                            style={{ width: `${Math.min(100, Math.max(0, gpuMfuValue))}%` }}
                          />
                        </div>
                      </div>
                    )}

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
