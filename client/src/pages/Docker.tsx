/**
 * Docker 容器管理页（薄壳）。
 *
 * 拆分说明（#19 docker-split）：页面级 state 与共享 handler 全部留在这里，
 * 渲染细节下沉到 ./docker/*：
 *   docker/DockerRow.tsx        容器行（React.memo 的卡片）
 *   docker/ContainerActions.tsx 行内操作按钮组
 *   docker/LiveLogPanel.tsx     实时日志流面板
 *   docker/TerminalPanel.tsx    容器内命令面板
 *   docker/DiagnosisPanel.tsx   AI 诊断面板
 *   docker/BatchAnalysis.tsx    联合会诊结果面板
 *   docker/DockerHeader.tsx     标题 / 设备选择 / 联合会诊 / 刷新
 *   docker/DockerFilters.tsx    搜索 / 状态过滤 / 重置排序
 *   docker/useDiagnosis.tsx     诊断请求 + SSE 解析（刚修过的 bug，逐字保留）
 *   docker/useLiveLogStream.tsx 实时日志 WebSocket（带 wsProtocols 鉴权）
 *   docker/types.ts, utils.ts   共享类型与纯函数
 *
 * 为什么 terminalOpen / containerLogs / cmdInput / diagnose* / liveLog* 这些
 * 「行级」数据仍在页面这一层：它们本来就有跨行语义（多行共享同一份 cmdInput、
 * 诊断与日志流同一时刻只有一个容器可见），下沉到行组件会导致搜索过滤把行卸载
 * 时丢失已开的终端输出 —— 那是行为变化，拆分不允许。
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { withWsToken, wsProtocols } from '../api/auth';
import { AlertCircle, Loader } from 'lucide-react';
import { useDevice } from '../contexts/DeviceContext';
import { useToast } from '../contexts/ToastContext';
import { apiFetch, apiJson } from '../api/client';
import type { ContainerInfo, ContainerRowItem, ContainerSource, TermLine, TraceResult } from './docker/types';
import { EMPTY_CMDS, EMPTY_LOGS, EMPTY_LIVE_LINES } from './docker/utils';
import { useDiagnosis } from './docker/useDiagnosis';
import { useLiveLogStream } from './docker/useLiveLogStream';
import DockerHeader from './docker/DockerHeader';
import DockerFilters from './docker/DockerFilters';
import BatchAnalysis from './docker/BatchAnalysis';
import DockerRow from './docker/DockerRow';

export default function Docker() {
  const { selectedDevice, isRemote } = useDevice();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [sources, setSources] = useState<ContainerSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState('all');
  const [selected, setSelected] = useState<{ sourceId: string; container: ContainerInfo }[]>([]);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('list');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [containerLogs, setContainerLogs] = useState<Record<string, any[]>>({});
  const [loadingLogs, setLoadingLogs] = useState<Set<string>>(new Set());
  const [traceResults, setTraceResults] = useState<Record<string, TraceResult>>({});
  const [traceLoading, setTraceLoading] = useState<Set<string>>(new Set());
  const [batchAnalysis, setBatchAnalysis] = useState(false);
  const [batchResult, setBatchResult] = useState<any>(null);
  const [batchLogs, setBatchLogs] = useState<any[]>([]);
  const [batchAnalyzing, setBatchAnalyzing] = useState(false);

  // AI 诊断（同一时刻只有一个容器可见，state 归页面）
  const {
    diagnoseKey,
    diagnoseContainerName,
    diagnoseLoading,
    diagnoseText,
    diagnoseCopied,
    diagnoseContainer,
    closeDiagnose,
    copyDiagnose,
  } = useDiagnosis();

  // 实时日志流（ws 连接与暂停/清空逻辑在 hook 内）
  const {
    liveLogKey,
    liveLogLines,
    liveLogPaused,
    liveLogConnecting,
    toggleLiveLog,
    pauseLiveLog,
    resumeLiveLog,
    clearLiveLog,
  } = useLiveLogStream();

  // 拖拽排序
  const [containerOrder, setContainerOrder] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem('docker-container-order');
      return stored ? JSON.parse(stored) : [];
    } catch { return []; }
  });
  const [dragKey, setDragKey] = useState<string | null>(null);

  // 终端执行
  const [terminalOpen, setTerminalOpen] = useState<Set<string>>(new Set());
  const [terminalCmds, setTerminalCmds] = useState<Record<string, TermLine[]>>({});
  const [cmdInput, setCmdInput] = useState('');
  const [execLoading, setExecLoading] = useState<Set<string>>(new Set());

  // 操作中状态
  const [opLoading, setOpLoading] = useState<Set<string>>(new Set());

  const toggleTerminal = useCallback((key: string) => {
    setTerminalOpen(prev => {
      const s = new Set(prev);
      s.has(key) ? s.delete(key) : s.add(key);
      return s;
    });
  }, []);

  const clearTerminal = useCallback((key: string) => {
    setTerminalCmds(prev => ({ ...prev, [key]: [] }));
  }, []);

  const runCmd = useCallback(async (sourceId: string, containerId: string, key: string, cmd: string) => {
    if (!cmd.trim()) return;
    setExecLoading(prev => new Set([...prev, key]));
    try {
      const data = await apiJson<{ output?: string; error?: string }>(`/api/docker/${sourceId}/${containerId}/exec`, 'POST', { command: cmd.trim() });
      setTerminalCmds(prev => ({ ...prev, [key]: [...(prev[key] || []), { cmd, output: data.output || data.error || '', time: Date.now() }] }));
    } catch (e: any) {
      setTerminalCmds(prev => ({ ...prev, [key]: [...(prev[key] || []), { cmd, output: 'Error: ' + e.message, time: Date.now() }] }));
    }
    setExecLoading(prev => { const s = new Set(prev); s.delete(key); return s; });
    setCmdInput('');
  }, []);

  /**
   * 拉取容器列表。
   *
   * silent=true 用于「操作后的数据同步」：不置 loading，因此不会把整张
   * 列表替换成「加载中…」再重建（停一个容器导致整页闪一下，很不安）。
   * 列表行的 key 是稳定的 `sourceId:containerId`，React 会原地复用 DOM，
   * 只有真正变化的那一行更新，滚动位置也不丢。数据仍然来自服务端，
   * 不做本地近似回填（status / exitType 这些字段派生自 Docker 原始状态）。
   */
  const fetchContainers = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    if (!silent) setLoading(true);
    try {
      const data = await apiFetch<{ sources?: any[] }>('/api/docker/containers');
      let sources = data.sources || [];

      // 远程设备：只显示属于该设备的 Docker 源。
      // TCP/Socket 源按 host 匹配；via(SSH) 源自身没有 host，
      // 按被桥接的 serverId 匹配更稳（同一 host 可能配了多台服务器）。
      const device = selectedDevice as { id?: string; host?: string };
      if (isRemote && device.host) {
        const remoteHost = device.host;
        sources = sources.filter((s: any) =>
          s.host === remoteHost || (s.serverId && s.serverId === device.id));
      }
      setSources(sources);
    } catch (err) {
      console.error(err);
    }
    if (!silent) setLoading(false);
  }, [isRemote, selectedDevice.id]);

  const doOp = useCallback(async (sourceId: string, containerId: string, op: string, key: string) => {
    setOpLoading(prev => new Set([...prev, key]));
    try {
      await apiFetch(`/api/docker/${sourceId}/${containerId}/${op}`, { method: 'POST' });
      // 只同步数据，不整页刷新 —— 见 fetchContainers 的 silent 说明。
      // await：让这一行的「执行中」一直转到数据真正更新，反馈才连贯。
      await fetchContainers({ silent: true });
    } catch (e: any) {
      // 原实现是 `catch {}` —— 操作失败时界面毫无反应，用户只会反复点。
      toast.error(`操作失败：${e?.message || '未知错误'}`);
    }
    setOpLoading(prev => { const s = new Set(prev); s.delete(key); return s; });
  }, [fetchContainers, toast]);

  useEffect(() => { fetchContainers(); }, [fetchContainers]);

  const allContainers = useMemo<ContainerRowItem[]>(
    () => sources.flatMap(s => s.containers.map(c => ({ ...c, _sourceId: s.sourceId, _sourceName: s.sourceName }))),
    [sources],
  );

  const toggleExpand = useCallback(async (sourceId: string, container: ContainerRowItem) => {
    const key = `${sourceId}:${container.id}`;
    if (expanded.has(key)) {
      setExpanded(prev => { const s = new Set(prev); s.delete(key); return s; });
      return;
    }
    setExpanded(prev => new Set([...prev, key]));

    if (!containerLogs[key]) {
      setLoadingLogs(prev => new Set([...prev, key]));
      try {
        const data = await apiFetch<{ logs?: any[] }>(`/api/docker/containers/${sourceId}/${container.id}/logs?tail=50`);
        setContainerLogs(prev => ({ ...prev, [key]: data.logs || [] }));
      } catch {}
      setLoadingLogs(prev => { const s = new Set(prev); s.delete(key); return s; });
    }
  }, [expanded, containerLogs]);

  // 告警 toast「查看日志 →」深链：/docker?sourceId=..&containerId=..&openLog=1
  // 等容器列表加载完成后，自动展开该容器并打开实时日志流。
  const deepLinkHandled = useRef(false);
  useEffect(() => {
    if (deepLinkHandled.current) return;
    const sourceId = searchParams.get('sourceId');
    const containerId = searchParams.get('containerId');
    if (!sourceId || !containerId || sources.length === 0) return;
    const hit = allContainers.find(c =>
      (c._sourceId === sourceId || searchParams.get('sourceId') === c._sourceId)
      && (c.id === containerId || c.shortId === containerId || c.id.startsWith(containerId)));
    if (!hit) return;
    deepLinkHandled.current = true;
    (async () => {
      await toggleExpand(hit._sourceId, hit);
      toggleLiveLog(hit._sourceId, hit.id);
      // 消费掉 query，避免刷新/返回时重复打开
      const next = new URLSearchParams(searchParams);
      next.delete('sourceId'); next.delete('containerId'); next.delete('openLog');
      setSearchParams(next, { replace: true });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources, searchParams]);

  // 按自定义顺序排序（localStorage），新容器自动追加到末尾
  const sortContainers = useCallback((containers: ContainerRowItem[]) => {
    return [...containers].sort((a, b) => {
      const keyA = `${a._sourceId}:${a.id}`;
      const keyB = `${b._sourceId}:${b.id}`;
      const idxA = containerOrder.indexOf(keyA);
      const idxB = containerOrder.indexOf(keyB);
      if (idxA === -1 && idxB === -1) return 0;
      if (idxA === -1) return 1;
      if (idxB === -1) return -1;
      return idxA - idxB;
    });
  }, [containerOrder]);

  const sortedContainers = useMemo(() => sortContainers(allContainers), [sortContainers, allContainers]);

  // ─── 拖拽处理器 ─────────────────────────────────────────────
  const handleDragStart = useCallback((e: React.DragEvent, key: string) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', key);
    setDragKey(key);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).classList.add('ring-1', 'ring-blue-400/30');
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    (e.currentTarget as HTMLElement).classList.remove('ring-1', 'ring-blue-400/30');
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetKey: string) => {
    e.preventDefault();
    const sourceKey = e.dataTransfer.getData('text/plain');
    if (!sourceKey || sourceKey === targetKey) {
      setDragKey(null);
      return;
    }

    // 用 allContainers 的真实顺序计算插入位置（不受 containerOrder 影响）
    const allKeys = allContainers.map(c => `${c._sourceId}:${c.id}`);
    const sourceIdx = allKeys.indexOf(sourceKey);
    const targetIdx = allKeys.indexOf(targetKey);
    if (sourceIdx === -1 || targetIdx === -1) return;

    const newOrder = containerOrder.includes(sourceKey)
      ? [...containerOrder]
      : [...containerOrder, sourceKey];

    // 从当前顺序中移除源
    const orderSourceIdx = newOrder.indexOf(sourceKey);
    if (orderSourceIdx !== -1) newOrder.splice(orderSourceIdx, 1);

    // 找到目标在当前 newOrder 中的位置来插入
    const orderTargetIdx = newOrder.indexOf(targetKey);
    const insertIdx = orderTargetIdx === -1 ? newOrder.length : orderTargetIdx;
    newOrder.splice(insertIdx, 0, sourceKey);

    setContainerOrder(newOrder);
    localStorage.setItem('docker-container-order', JSON.stringify(newOrder));
    setDragKey(null);
  }, [allContainers, containerOrder]);

  const handleDragEnd = useCallback(() => {
    setDragKey(null);
  }, []);

  const resetOrder = useCallback(() => {
    localStorage.removeItem('docker-container-order');
    setContainerOrder([]);
  }, []);

  const filtered = useMemo(() => sortedContainers.filter(c => {
    const q = filter.toLowerCase();
    return (
      (!q || c.names.some(n => n.toLowerCase().includes(q)) || c.image.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)) &&
      (levelFilter === 'all' || c.state.toLowerCase() === levelFilter.toLowerCase())
    );
  }), [sortedContainers, filter, levelFilter]);

  const toggleSelect = useCallback((sourceId: string, container: ContainerRowItem) => {
    setSelected(prev => {
      const key = `${sourceId}:${container.id}`;
      if (prev.some(s => `${s.sourceId}:${s.container.id}` === key)) {
        return prev.filter(s => `${s.sourceId}:${s.container.id}` !== key);
      }
      return [...prev, { sourceId, container }];
    });
  }, []);

  const loadTrace = useCallback(async (sourceId: string, container: ContainerRowItem) => {
    const key = `${sourceId}:${container.id}`;
    // 先展开行，这样 trace 结果面板可见
    setExpanded(prev => new Set([...prev, key]));
    if (traceResults[key]) return;
    setTraceLoading(prev => new Set([...prev, key]));
    try {
      const data = await apiFetch<TraceResult>(`/api/docker/trace/${sourceId}/${container.id}`);
      setTraceResults(prev => ({ ...prev, [key]: data }));
    } catch {}
    setTraceLoading(prev => { const s = new Set(prev); s.delete(key); return s; });
  }, [traceResults]);

  const runBatchAnalysis = async () => {
    if (selected.length === 0) return;
    setBatchAnalyzing(true);
    setBatchResult(null);
    setBatchLogs([]);

    try {
      const data = await apiJson<{ logs?: any[] }>('/api/docker/analyze/batch', 'POST', {
        containers: selected.map(s => ({
          sourceId: s.sourceId,
          containerId: s.container.id,
          name: s.container.names[0] || s.container.shortId
        }))
      });
      setBatchLogs(data.logs || []);
      // 轮询分析结果（WS推送也可以）
      pollAnalysis();
    } catch (err) {}
    setBatchAnalyzing(false);
  };

  const pollAnalysis = () => {
    const ws = new WebSocket(withWsToken(`ws://${window.location.host}/ws`), wsProtocols());
    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'docker_batch_analysis') {
        setBatchResult(data);
        setBatchAnalyzing(false);
        ws.close();
      }
    };
    ws.onerror = () => { setBatchAnalyzing(false); };
    // 60s 超时
    setTimeout(() => { ws.close(); setBatchAnalyzing(false); }, 60000);
  };

  const selectedKeys = useMemo(
    () => new Set(selected.map(s => `${s.sourceId}:${s.container.id}`)),
    [selected],
  );

  return (
    <div className="space-y-4 animate-fade-in min-w-0 max-w-full overflow-x-hidden">
      <DockerHeader
        containerCount={allContainers.length}
        selectedCount={selected.length}
        loading={loading}
        batchAnalyzing={batchAnalyzing}
        onBatchAnalyze={runBatchAnalysis}
        onRefresh={fetchContainers}
      />

      <BatchAnalysis batchResult={batchResult} onClose={() => setBatchResult(null)} />

      <DockerFilters
        filter={filter}
        onFilterChange={setFilter}
        levelFilter={levelFilter}
        onLevelFilterChange={setLevelFilter}
        onResetOrder={resetOrder}
        sources={sources}
      />

      {/* Loading */}
      {loading ? (
        <div className="flex items-center justify-center py-20 text-dark-500">
          <Loader className="w-5 h-5 animate-spin mr-3" /> 加载中...
        </div>
      ) : sources.every(s => s.error) ? (
        <div className="flex flex-col items-center justify-center py-20 text-dark-500">
          <AlertCircle className="w-12 h-12 mb-4 opacity-30" />
          <p className="text-sm">所有 Docker 连接均失败</p>
          <p className="text-xs mt-1 text-dark-600">请检查设置中的 Docker 配置</p>
        </div>
      ) : (
        <div className="space-y-2 min-w-0 max-w-full">
          {filtered.map(c => {
            const key = `${c._sourceId}:${c.id}`;
            const isTerminalOpen = terminalOpen.has(key);
            const isDiagnoseActive = diagnoseKey === key;
            const isLiveLogActive = liveLogKey === key;
            return (
              <DockerRow
                key={key}
                rowKey={key}
                container={c}
                isExpanded={expanded.has(key)}
                isSelected={selectedKeys.has(key)}
                isDragSource={dragKey === key}
                logs={containerLogs[key] || EMPTY_LOGS}
                trace={traceResults[key]}
                logsLoading={loadingLogs.has(key)}
                traceLoading={traceLoading.has(key)}
                terminalOpen={isTerminalOpen}
                terminalCmds={terminalCmds[key] || EMPTY_CMDS}
                cmdInput={isTerminalOpen ? cmdInput : ''}
                execLoading={execLoading.has(key)}
                liveLogActive={isLiveLogActive}
                liveLogLines={isLiveLogActive ? (liveLogLines[key] || EMPTY_LIVE_LINES) : EMPTY_LIVE_LINES}
                liveLogPaused={liveLogPaused[key] || false}
                liveLogConnecting={liveLogConnecting.has(key)}
                diagnoseActive={isDiagnoseActive}
                diagnoseLoading={isDiagnoseActive ? diagnoseLoading : false}
                diagnoseText={isDiagnoseActive ? diagnoseText : ''}
                diagnoseCopied={isDiagnoseActive ? diagnoseCopied : false}
                diagnoseName={isDiagnoseActive ? diagnoseContainerName : ''}
                opStop={opLoading.has(`${key}:stop`)}
                opStart={opLoading.has(`${key}:start`)}
                opRestart={opLoading.has(`${key}:restart`)}
                opRemove={opLoading.has(`${key}:remove`)}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragEnter={handleDragEnter}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onDragEnd={handleDragEnd}
                onToggleSelect={toggleSelect}
                onToggleExpand={toggleExpand}
                onToggleTerminal={toggleTerminal}
                onRunCmd={runCmd}
                onSetCmdInput={setCmdInput}
                onClearTerminal={clearTerminal}
                onDoOp={doOp}
                onLoadTrace={loadTrace}
                onDiagnose={diagnoseContainer}
                onDiagnoseCopy={copyDiagnose}
                onDiagnoseClose={closeDiagnose}
                onToggleLiveLog={toggleLiveLog}
                onPauseLiveLog={pauseLiveLog}
                onResumeLiveLog={resumeLiveLog}
                onClearLiveLog={clearLiveLog}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
