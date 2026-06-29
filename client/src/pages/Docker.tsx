import { useState, useEffect, useCallback, useRef } from 'react';
import { marked } from 'marked';
import {
  Container, Boxes, Activity, Search, Filter, RefreshCw,
  ChevronDown, ChevronRight, Terminal, AlertCircle, CheckCircle,
  Clock, Server, X, Loader, ArrowRightLeft, Zap, Trash2,
  Play, Pause, RotateCcw, StopCircle, Square,
  Stethoscope, Copy, Check
} from 'lucide-react';
import { useDevice } from '../contexts/DeviceContext';
import DeviceSelector from '../components/DeviceSelector';

interface ContainerInfo {
  id: string;
  shortId: string;
  names: string[];
  image: string;
  command: string;
  created: string;
  state: string;
  status: string;
  exitCode?: number | null;
  exitType?: 'normal' | 'oom' | 'segfault' | 'terminated' | 'error' | null;
  ports: any[];
  labels: any;
}

interface ContainerSource {
  sourceId: string;
  sourceName: string;
  host?: string;
  containers: ContainerInfo[];
  error?: string;
}

interface TraceResult {
  target: any;
  upstream: any[];
  downstream: any[];
  networkPeers: any[];
  serviceName: string;
}

export default function Docker() {
  const { selectedDevice, isRemote } = useDevice();
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

  // AI 诊断（单容器）
  const [diagnoseKey, setDiagnoseKey] = useState<string | null>(null);
  const [diagnoseContainerName, setDiagnoseContainerName] = useState('');
  const [diagnoseLoading, setDiagnoseLoading] = useState(false);
  const [diagnoseText, setDiagnoseText] = useState('');
  const [diagnoseCopied, setDiagnoseCopied] = useState(false);

  // 终端执行
  const [terminalOpen, setTerminalOpen] = useState<Set<string>>(new Set());
  const [terminalCmds, setTerminalCmds] = useState<Record<string, { cmd: string; output: string; time: number }[]>>({});
  const [cmdInput, setCmdInput] = useState('');
  const [execLoading, setExecLoading] = useState<Set<string>>(new Set());

  // 操作中状态
  const [opLoading, setOpLoading] = useState<Set<string>>(new Set());

  // 实时日志流
  const [liveLogKey, setLiveLogKey] = useState<string | null>(null);
  const [liveLogLines, setLiveLogLines] = useState<Record<string, { timestamp: string; line: string; level: string; content: string }[]>>({});
  const [liveLogPaused, setLiveLogPaused] = useState<Record<string, boolean>>({});
  const [liveLogConnecting, setLiveLogConnecting] = useState<Set<string>>(new Set());
  const liveLogWsRef = useRef<Record<string, WebSocket>>({});

  const toggleTerminal = (key: string) => {
    setTerminalOpen(prev => {
      const s = new Set(prev);
      s.has(key) ? s.delete(key) : s.add(key);
      return s;
    });
  };

  const runCmd = async (sourceId: string, containerId: string, key: string, cmd: string) => {
    if (!cmd.trim()) return;
    setExecLoading(prev => new Set([...prev, key]));
    const hist = terminalCmds[key] || [];
    try {
      const res = await fetch(`/api/docker/${sourceId}/${containerId}/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd.trim() }),
      });
      const data = await res.json();
      setTerminalCmds(prev => ({ ...prev, [key]: [...(prev[key] || []), { cmd, output: data.output || data.error || '', time: Date.now() }] }));
    } catch (e: any) {
      setTerminalCmds(prev => ({ ...prev, [key]: [...(prev[key] || []), { cmd, output: 'Error: ' + e.message, time: Date.now() }] }));
    }
    setExecLoading(prev => { const s = new Set(prev); s.delete(key); return s; });
    setCmdInput('');
  };

  const doOp = async (sourceId: string, containerId: string, op: string, key: string) => {
    setOpLoading(prev => new Set([...prev, key]));
    try {
      await fetch(`/api/docker/${sourceId}/${containerId}/${op}`, { method: 'POST' });
    } catch {}
    setOpLoading(prev => { const s = new Set(prev); s.delete(key); return s; });
    fetchContainers();
  };

  const fetchContainers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/docker/containers');
      const data = await res.json();
      let sources = data.sources || [];

      // 远程设备：按 host 地址过滤 Docker 源
      if (isRemote && (selectedDevice as any).host) {
        const remoteHost = (selectedDevice as any).host;
        sources = sources.filter((s: any) => s.host === remoteHost);
      }
      setSources(sources);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }, [isRemote, selectedDevice.id]);

  useEffect(() => { fetchContainers(); }, [fetchContainers]);

  const allContainers = sources.flatMap(s => s.containers.map(c => ({ ...c, _sourceId: s.sourceId, _sourceName: s.sourceName })));

  const filtered = allContainers.filter(c => {
    const q = filter.toLowerCase();
    return (
      (!q || c.names.some(n => n.toLowerCase().includes(q)) || c.image.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)) &&
      (levelFilter === 'all' || c.state.toLowerCase() === levelFilter.toLowerCase())
    );
  });

  const getStateColor = (state: string, exitType?: string | null) => {
    if (state === 'running') return 'text-green-400';
    if (state === 'exited') {
      if (exitType === 'oom') return 'text-red-400';
      if (exitType === 'error' || exitType === 'segfault') return 'text-orange-400';
      if (exitType === 'terminated') return 'text-yellow-400';
      return 'text-dark-400';
    }
    if (state === 'paused') return 'text-yellow-400';
    return 'text-red-400';
  };

  const getStateDot = (state: string, exitType?: string | null) => {
    if (state === 'running') return 'bg-green-400';
    if (state === 'exited') {
      if (exitType === 'oom') return 'bg-red-500 animate-pulse';
      if (exitType === 'error' || exitType === 'segfault') return 'bg-orange-400';
      if (exitType === 'terminated') return 'bg-yellow-400';
      return 'bg-dark-500';
    }
    if (state === 'paused') return 'bg-yellow-400';
    return 'bg-red-400';
  };

  const getExitLabel = (exitType?: string | null, exitCode?: number | null) => {
    if (exitType === 'oom') return '💀 OOM 内存溢出';
    if (exitType === 'error') return `❌ 异常退出(${exitCode})`;
    if (exitType === 'segfault') return '💥 段错误';
    if (exitType === 'terminated') return '🛑 被终止';
    if (exitType === 'normal') return '✅ 正常退出';
    return null;
  };

  const toggleExpand = async (sourceId: string, container: ContainerInfo) => {
    const key = `${sourceId}:${container.id}`;
    if (expanded.has(key)) {
      setExpanded(prev => { const s = new Set(prev); s.delete(key); return s; });
      return;
    }
    setExpanded(prev => new Set([...prev, key]));

    if (!containerLogs[key]) {
      setLoadingLogs(prev => new Set([...prev, key]));
      try {
        const res = await fetch(`/api/docker/containers/${sourceId}/${container.id}/logs?tail=50`);
        const data = await res.json();
        setContainerLogs(prev => ({ ...prev, [key]: data.logs || [] }));
      } catch {}
      setLoadingLogs(prev => { const s = new Set(prev); s.delete(key); return s; });
    }
  };

  const toggleLiveLog = (sourceId: string, containerId: string) => {
    const key = `${sourceId}:${containerId}`;
    if (liveLogKey === key) {
      // 关闭实时日志
      const ws = liveLogWsRef.current[key];
      if (ws) { ws.close(); delete liveLogWsRef.current[key]; }
      setLiveLogKey(null);
      setLiveLogPaused(prev => { const s = { ...prev }; delete s[key]; return s; });
      return;
    }

    // 如果之前有其他的 ws，先关闭
    if (liveLogKey) {
      const oldWs = liveLogWsRef.current[liveLogKey];
      if (oldWs) { oldWs.close(); delete liveLogWsRef.current[liveLogKey]; }
    }

    setLiveLogKey(key);
    setLiveLogLines(prev => ({ ...prev, [key]: [] }));
    setLiveLogConnecting(prev => new Set([...prev, key]));

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsHost = window.location.host;
    const wsUrl = `${protocol}//${wsHost}/ws/docker/logs/${sourceId}/${containerId}`;
    const ws = new WebSocket(wsUrl);
    liveLogWsRef.current[key] = ws;

    ws.onopen = () => {
      setLiveLogConnecting(prev => { const s = new Set(prev); s.delete(key); return s; });
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'log') {
          setLiveLogLines(prev => {
            const lines = [...(prev[key] || []), data];
            // 限制最多保留 5000 条
            return { ...prev, [key]: lines.length > 5000 ? lines.slice(-5000) : lines };
          });
        } else if (data.type === 'paused') {
          setLiveLogPaused(prev => ({ ...prev, [key]: true }));
        } else if (data.type === 'resumed') {
          setLiveLogPaused(prev => ({ ...prev, [key]: false }));
        } else if (data.type === 'stream_error') {
          setLiveLogLines(prev => ({
            ...prev, [key]: [...(prev[key] || []), { timestamp: new Date().toISOString(), line: `⚠️ 错误: ${data.error}`, level: 'ERROR', content: `错误: ${data.error}` }]
          }));
        } else if (data.type === 'stream_end') {
          setLiveLogLines(prev => ({
            ...prev, [key]: [...(prev[key] || []), { timestamp: new Date().toISOString(), line: '── 日志流结束 ──', level: 'INFO', content: '日志流结束' }]
          }));
        }
      } catch {}
    };

    ws.onerror = () => {
      setLiveLogConnecting(prev => { const s = new Set(prev); s.delete(key); return s; });
      setLiveLogLines(prev => ({
        ...prev, [key]: [...(prev[key] || []), { timestamp: new Date().toISOString(), line: '⚠️ WebSocket 连接失败', level: 'ERROR', content: 'WebSocket 连接失败' }]
      }));
    };

    ws.onclose = () => {
      setLiveLogConnecting(prev => { const s = new Set(prev); s.delete(key); return s; });
      delete liveLogWsRef.current[key];
    };
  };

  const pauseLiveLog = (key: string) => {
    const ws = liveLogWsRef.current[key];
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'pause' }));
    }
    setLiveLogPaused(prev => ({ ...prev, [key]: true }));
  };

  const resumeLiveLog = (key: string) => {
    const ws = liveLogWsRef.current[key];
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resume' }));
    }
    setLiveLogPaused(prev => ({ ...prev, [key]: false }));
  };

  const clearLiveLog = (key: string) => {
    setLiveLogLines(prev => ({ ...prev, [key]: [] }));
  };

  const toggleSelect = (sourceId: string, container: ContainerInfo) => {
    setSelected(prev => {
      const key = `${sourceId}:${container.id}`;
      if (prev.some(s => `${s.sourceId}:${s.container.id}` === key)) {
        return prev.filter(s => `${s.sourceId}:${s.container.id}` !== key);
      }
      return [...prev, { sourceId, container }];
    });
  };

  const loadTrace = async (sourceId: string, container: ContainerInfo) => {
    const key = `${sourceId}:${container.id}`;
    // 先展开行，这样 trace 结果面板可见
    setExpanded(prev => new Set([...prev, key]));
    if (traceResults[key]) return;
    setTraceLoading(prev => new Set([...prev, key]));
    try {
      const res = await fetch(`/api/docker/trace/${sourceId}/${container.id}`);
      const data = await res.json();
      setTraceResults(prev => ({ ...prev, [key]: data }));
    } catch {}
    setTraceLoading(prev => { const s = new Set(prev); s.delete(key); return s; });
  };

  const diagnoseContainer = async (sourceId: string, containerId: string, containerName: string) => {
    const key = `${sourceId}:${containerId}`;
    setDiagnoseKey(key);
    setDiagnoseContainerName(containerName);
    setDiagnoseLoading(true);
    setDiagnoseText('');
    setDiagnoseCopied(false);

    try {
      const res = await fetch(`/api/docker/container/${encodeURIComponent(sourceId)}/${encodeURIComponent(containerId)}/diagnose`, {
        method: 'POST',
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        setDiagnoseText(`❌ 诊断失败: ${errData.error || res.statusText}`);
        setDiagnoseLoading(false);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        setDiagnoseText('❌ 无法读取响应流');
        setDiagnoseLoading(false);
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const payload = line.slice(6);
            if (payload === '[DONE]') continue;
            try {
              const j = JSON.parse(payload);
              if (j.content) setDiagnoseText(prev => prev + j.content);
              if (j.error) setDiagnoseText(prev => prev + `\n\n❌ ${j.error}`);
            } catch {}
          }
        }
      }
    } catch (err: any) {
      setDiagnoseText(`❌ 诊断请求失败: ${err.message}`);
    }
    setDiagnoseLoading(false);
  };

  const closeDiagnose = () => {
    setDiagnoseKey(null);
    setDiagnoseContainerName('');
    setDiagnoseText('');
    setDiagnoseCopied(false);
  };

  const runBatchAnalysis = async () => {
    if (selected.length === 0) return;
    setBatchAnalyzing(true);
    setBatchResult(null);
    setBatchLogs([]);

    try {
      const res = await fetch('/api/docker/analyze/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          containers: selected.map(s => ({
            sourceId: s.sourceId,
            containerId: s.container.id,
            name: s.container.names[0] || s.container.shortId
          }))
        })
      });
      const data = await res.json();
      setBatchLogs(data.logs || []);
      // 轮询分析结果（WS推送也可以）
      pollAnalysis();
    } catch (err) {}
    setBatchAnalyzing(false);
  };

  const pollAnalysis = () => {
    const ws = new WebSocket(`ws://${window.location.host}/ws`);
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

  const logLevelColor = (level: string) => {
    if (level === 'ERROR') return 'text-red-400';
    if (level === 'WARN') return 'text-yellow-400';
    if (level === 'DEBUG') return 'text-dark-500';
    return 'text-dark-300';
  };

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-blue-500/20">
            <Container className="w-6 h-6 text-blue-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-dark-100">Docker 容器管理</h1>
            <p className="text-xs text-dark-500">
              {allContainers.length} 个容器 · 已选 {selected.length} 个
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <DeviceSelector />
          {selected.length > 0 && (
            <button
              onClick={runBatchAnalysis}
              disabled={batchAnalyzing}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-accent-500 text-white text-sm font-medium hover:bg-accent-600 transition-colors disabled:opacity-50"
            >
              {batchAnalyzing ? <Loader className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
              联合会诊 ({selected.length})
            </button>
          )}
          <button
            onClick={fetchContainers}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-dark-800 text-dark-300 hover:bg-dark-700 transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </button>
        </div>
      </div>

      {/* Batch analysis result */}
      {batchResult && (
        <div className="glass rounded-xl border border-accent-500/30 overflow-hidden">
          <div className="px-4 py-3 bg-accent-500/10 border-b border-accent-500/20 flex items-center justify-between">
            <div className="flex items-center gap-2">
              {batchResult.status === 'done'
                ? <CheckCircle className="w-4 h-4 text-green-400" />
                : <AlertCircle className="w-4 h-4 text-red-400" />
              }
              <span className="text-sm font-medium text-dark-100">
                {batchResult.status === 'done' ? '✅ 联合会诊分析完成' : '❌ 分析失败'}
              </span>
            </div>
            <button onClick={() => setBatchResult(null)} className="text-dark-500 hover:text-dark-200">
              <X className="w-4 h-4" />
            </button>
          </div>
          {batchResult.status === 'done' && batchResult.analysis && (
            <div className="p-4">
              <div
                className="text-sm text-dark-200 leading-relaxed prose-invert max-h-96 overflow-y-auto
                  [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-xs [&_h1_h2_h3]:font-bold [&_h1_h2_h3]:mt-3 [&_h1_h2_h3]:mb-1
                  [&_code]:bg-dark-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs
                  [&_li]:text-xs [&_li]:ml-3"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(batchResult.analysis) }}
              />
            </div>
          )}
          {batchResult.status === 'error' && (
            <div className="p-4 text-sm text-red-400">{batchResult.message}</div>
          )}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-dark-500" />
          <input
            type="text"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="搜索容器名称、镜像、ID..."
            className="w-full pl-9 pr-3 py-2 bg-dark-900 border border-dark-800 rounded-lg text-sm text-dark-200 placeholder-dark-600 focus:outline-none focus:border-accent-500/50"
          />
        </div>
        {['all', 'running', 'exited', 'paused'].map(s => (
          <button
            key={s}
            onClick={() => setLevelFilter(s)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              levelFilter === s
                ? 'bg-dark-700 text-dark-100 border border-dark-600'
                : 'bg-dark-900 text-dark-500 border border-dark-800 hover:border-dark-700'
            }`}
          >
            {s === 'all' ? '全部' : s}
          </button>
        ))}
        <div className="ml-auto text-xs text-dark-600">
          {sources.length > 0 && sources.map(s => (
            s.error
              ? <span key={s.sourceId} className="text-red-400 mr-2">⚠️ {s.sourceName}</span>
              : <span key={s.sourceId} className="text-dark-500 mr-2">{s.sourceName}</span>
          ))}
        </div>
      </div>

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
        <div className="space-y-2">
          {filtered.map(c => {
            const key = `${c._sourceId}:${c.id}`;
            const isExpanded = expanded.has(key);
            const isSelected = selected.some(s => `${s.sourceId}:${s.container.id}` === key);
            const logs = containerLogs[key] || [];
            const trace = traceResults[key];
            const logsLoading = loadingLogs.has(key);
            const traceLoading_ = traceLoading.has(key);
            const errorLogs = logs.filter(l => l.level === 'ERROR' || l.level === 'WARN');
            // 去重计数：忽略时间戳，只比错误模式
            const normalize = (s: string) => (s || '').replace(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\w+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\w+\s+\d{4}\s*-\s*/i, '').replace(/req_[a-f0-9]+/gi,'req_XXX').trim();
            const uniqueErrorSet = new Set(errorLogs.map(l => normalize(l.content || l.line)));

            return (
              <div key={key} className={`glass rounded-xl border transition-all overflow-hidden ${
                isSelected ? 'border-accent-500/50 bg-accent-500/5' :
                c.exitType === 'oom' ? 'border-red-500/30 border-l-2 bg-red-500/5' :
                c.exitType === 'error' || c.exitType === 'segfault' ? 'border-orange-500/20 border-l-2 bg-orange-500/3' :
                'border-dark-800 hover:border-dark-700'
              }`}>
                {/* Container row */}
                <div className="flex items-center gap-3 px-4 py-3">
                  {/* Select */}
                  <button
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleSelect(c._sourceId, c); }}
                    className={`w-5 h-5 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
                      isSelected
                        ? 'bg-accent-500 border-accent-500 text-white'
                        : 'border-dark-700 hover:border-dark-600'
                    }`}
                  >
                    {isSelected && <CheckCircle className="w-3.5 h-3.5" />}
                  </button>

                  {/* State dot */}
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${getStateDot(c.state, c.exitType)}`} />

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-dark-100 truncate">
                        {c.names[0] || c.shortId}
                      </span>
                      <span className={`text-xs ${getStateColor(c.state, c.exitType)}`}>{c.state}</span>
                      {errorLogs.length > 0 && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/20">
                          {uniqueErrorSet.size} 种错误
                        </span>
                      )}
                      {getExitLabel(c.exitType, c.exitCode) && (
                        <span className={`text-xs px-1.5 py-0.5 rounded border ${
                          c.exitType === 'oom' ? 'bg-red-500/20 text-red-300 border-red-500/30' :
                          c.exitType === 'error' || c.exitType === 'segfault' ? 'bg-orange-500/15 text-orange-300 border-orange-500/20' :
                          c.exitType === 'terminated' ? 'bg-yellow-500/15 text-yellow-300 border-yellow-500/20' :
                          'bg-dark-600/50 text-dark-400 border-dark-600'
                        }`}>
                          {getExitLabel(c.exitType, c.exitCode)}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5">
                      <span className="text-xs text-dark-600 truncate max-w-[200px]">{c.image}</span>
                      <span className="text-xs text-dark-600">{c.status}</span>
                      <span className="text-xs text-dark-700">{c._sourceName}</span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {/* 终端 */}
                    <button
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleTerminal(`${c._sourceId}:${c.id}`); }}
                      className={`p-1.5 rounded-lg transition-colors ${terminalOpen.has(`${c._sourceId}:${c.id}`) ? 'bg-accent-500/15 text-accent-400' : 'hover:bg-dark-700 text-dark-500 hover:text-accent-400'}`}
                      title="进入容器"
                    >
                      <Terminal className="w-4 h-4" />
                    </button>

                    {/* 启停 */}
                    {c.state === 'running' ? (
                      <button
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); doOp(c._sourceId, c.id, 'stop', `${c._sourceId}:${c.id}:stop`); }}
                        disabled={opLoading.has(`${c._sourceId}:${c.id}:stop`)}
                        className="p-1.5 rounded-lg hover:bg-dark-700 text-dark-500 hover:text-yellow-400 transition-colors"
                        title="停止"
                      >
                        {opLoading.has(`${c._sourceId}:${c.id}:stop`) ? <Loader className="w-4 h-4 animate-spin" /> : <Pause className="w-4 h-4" />}
                      </button>
                    ) : (
                      <button
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); doOp(c._sourceId, c.id, 'start', `${c._sourceId}:${c.id}:start`); }}
                        disabled={opLoading.has(`${c._sourceId}:${c.id}:start`)}
                        className="p-1.5 rounded-lg hover:bg-dark-700 text-dark-500 hover:text-green-400 transition-colors"
                        title="启动"
                      >
                        {opLoading.has(`${c._sourceId}:${c.id}:start`) ? <Loader className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                      </button>
                    )}

                    {/* 重启 */}
                    <button
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); doOp(c._sourceId, c.id, 'restart', `${c._sourceId}:${c.id}:restart`); }}
                      disabled={opLoading.has(`${c._sourceId}:${c.id}:restart`)}
                      className="p-1.5 rounded-lg hover:bg-dark-700 text-dark-500 hover:text-blue-400 transition-colors"
                      title="重启"
                    >
                      {opLoading.has(`${c._sourceId}:${c.id}:restart`) ? <Loader className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                    </button>

                    {/* 链路追踪 */}
                    <button
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); loadTrace(c._sourceId, c); }}
                      disabled={traceLoading_}
                      className="p-1.5 rounded-lg hover:bg-dark-700 text-dark-500 hover:text-purple-400 transition-colors"
                      title="上下游链路追踪"
                    >
                      {traceLoading_ ? <Loader className="w-4 h-4 animate-spin" /> : <ArrowRightLeft className="w-4 h-4" />}
                    </button>

                    {/* 删除容器 */}
                    <button
                      onClick={(e) => { e.preventDefault(); e.stopPropagation();
                        if (confirm(`确定删除容器 "${c.names[0] || c.shortId}"？此操作不可撤销。`)) {
                          doOp(c._sourceId, c.id, 'remove', `${c._sourceId}:${c.id}:remove`);
                        }
                      }}
                      disabled={opLoading.has(`${c._sourceId}:${c.id}:remove`)}
                      className="p-1.5 rounded-lg hover:bg-dark-700 text-dark-500 hover:text-red-400 transition-colors"
                      title="删除容器"
                    >
                      {opLoading.has(`${c._sourceId}:${c.id}:remove`) ? <Loader className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                    </button>

                    {/* AI 诊断 */}
                    <button
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); diagnoseContainer(c._sourceId, c.id, c.names[0] || c.shortId); }}
                      className={`p-1.5 rounded-lg transition-colors ${diagnoseKey === key ? 'bg-accent-500/15 text-accent-400' : 'hover:bg-dark-700 text-dark-500 hover:text-accent-400'}`}
                      title="AI 诊断"
                    >
                      <Stethoscope className="w-4 h-4" />
                    </button>

                    {/* 实时日志 */}
                    <button
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleLiveLog(c._sourceId, c.id); }}
                      className={`p-1.5 rounded-lg transition-colors ${liveLogKey === key ? 'bg-green-500/15 text-green-400' : 'hover:bg-dark-700 text-dark-500 hover:text-green-400'}`}
                      title="实时日志流"
                    >
                      {liveLogConnecting.has(key) ? <Loader className="w-4 h-4 animate-spin" /> : <StopCircle className="w-4 h-4" />}
                    </button>

                    {/* 展开日志 */}
                    <button
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleExpand(c._sourceId, c); }}
                      className="p-1.5 rounded-lg hover:bg-dark-700 text-dark-500 hover:text-dark-200 transition-colors"
                    >
                      {isExpanded ? <ChevronDown className="w-4 h-4" /> : <Activity className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {/* 实时日志流面板 */}
                {liveLogKey === key && (
                  <LiveLogPanel
                    panelKey={key}
                    containerName={c.names[0] || c.shortId}
                    lines={liveLogLines[key] || []}
                    paused={liveLogPaused[key] || false}
                    connecting={liveLogConnecting.has(key)}
                    onPause={() => pauseLiveLog(key)}
                    onResume={() => resumeLiveLog(key)}
                    onClear={() => clearLiveLog(key)}
                    onClose={() => toggleLiveLog(c._sourceId, c.id)}
                  />
                )}

                {/* 终端面板 */}
                {terminalOpen.has(`${c._sourceId}:${c.id}`) && (() => {
                  const k = `${c._sourceId}:${c.id}`;
                  return (
                    <TerminalPanel
                      panelKey={k}
                      containerName={c.names[0] || c.shortId}
                      cmds={terminalCmds[k] || []}
                      cmdInput={cmdInput}
                      setCmdInput={setCmdInput}
                      onRun={cmd => runCmd(c._sourceId, c.id, k, cmd)}
                      onClear={() => setTerminalCmds(prev => ({ ...prev, [k]: [] }))}
                      execLoading={execLoading.has(k)}
                    />
                  );
                })()}

                {/* AI 诊断面板 */}
                {diagnoseKey === key && (
                  <DiagnosisPanel
                    panelKey={key}
                    containerName={diagnoseContainerName || c.names[0] || c.shortId}
                    loading={diagnoseLoading}
                    text={diagnoseText}
                    copied={diagnoseCopied}
                    onCopy={() => {
                      if (diagnoseText) {
                        navigator.clipboard.writeText(diagnoseText);
                        setDiagnoseCopied(true);
                        setTimeout(() => setDiagnoseCopied(false), 2000);
                      }
                    }}
                    onClose={closeDiagnose}
                  />
                )}

                {/* Expanded: logs + trace */}
                {isExpanded && (
                  <div className="border-t border-dark-800">
                    {/* Trace */}
                    {trace && (
                      <div className="px-4 py-3 bg-dark-900/50 border-b border-dark-800">
                        <p className="text-xs font-medium text-dark-400 mb-2 flex items-center gap-1">
                          <ArrowRightLeft className="w-3 h-3" /> 上下游链路 — {trace.serviceName}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {(trace.upstream || []).length > 0 && (
                            <div className="flex items-center gap-1">
                              <span className="text-xs text-dark-600">上游:</span>
                              {(trace.upstream || []).map(u => (
                                <span key={u.id} className="text-xs px-2 py-0.5 rounded bg-blue-500/15 text-blue-400 border border-blue-500/20">
                                  {u.names?.[0] || u.shortId || u.id?.slice(0, 12)}
                                </span>
                              ))}
                            </div>
                          )}
                          {(trace.downstream || []).length > 0 && (
                            <div className="flex items-center gap-1">
                              <span className="text-xs text-dark-600">下游:</span>
                              {(trace.downstream || []).map(u => (
                                <span key={u.id} className="text-xs px-2 py-0.5 rounded bg-purple-500/15 text-purple-400 border border-purple-500/20">
                                  {u.names?.[0] || u.shortId || u.id?.slice(0, 12)}
                                </span>
                              ))}
                            </div>
                          )}
                          {(trace.networkPeers || []).length > 0 && (
                            <div className="flex items-center gap-1">
                              <span className="text-xs text-dark-600">同网:</span>
                              {(trace.networkPeers || []).slice(0, 5).map(u => (
                                <span key={u.id} className="text-xs px-2 py-0.5 rounded bg-dark-800 text-dark-400">
                                  {u.names?.[0] || u.shortId || u.id?.slice(0, 12)}
                                </span>
                              ))}
                            </div>
                          )}
                          {(trace.upstream || []).length === 0 && (trace.downstream || []).length === 0 && (
                            <span className="text-xs text-dark-600">无链路信息（检查容器 label）</span>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Logs */}
                    <div className="px-4 py-2">
                      <p className="text-xs text-dark-600 mb-2 flex items-center gap-1">
                        <Terminal className="w-3 h-3" /> 最近日志
                        {logsLoading && <Loader className="w-3 h-3 animate-spin ml-1" />}
                      </p>
                      <div className="max-h-60 overflow-y-auto space-y-0.5">
                        {logsLoading ? (
                          <div className="text-xs text-dark-600 py-2">加载中...</div>
                        ) : logs.length === 0 ? (
                          <div className="text-xs text-dark-600 py-2">无日志</div>
                        ) : logs.slice(-30).map((l, i) => (
                          <div key={i} className="flex gap-2 text-xs font-mono py-0.5">
                            <span className="text-dark-700 flex-shrink-0 w-36">{l.timestamp?.slice(0, 19) || '-'}</span>
                            <span className={`flex-shrink-0 w-12 ${logLevelColor(l.level)}`}>[{l.level}]</span>
                            <span className="text-dark-300 truncate">{l.content}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function renderMarkdown(md: string): string {
  return marked.parse(md, { breaks: true }) as string;
}

// ─── 终端面板组件 ─────────────────────────────────────────────
interface TermLine { cmd: string; output: string; time: number; }

interface TermPanelProps {
  panelKey: string;
  containerName: string;
  cmds: TermLine[];
  cmdInput: string;
  setCmdInput: (v: string) => void;
  onRun: (cmd: string) => void;
  onClear: () => void;
  execLoading: boolean;
}

function TerminalPanel({ panelKey, containerName, cmds, cmdInput, setCmdInput, onRun, onClear, execLoading }: TermPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'nearest' }); }, [cmds]);

  return (
    <div className="border-t border-dark-800 bg-[#0d1117]">
      {/* 标题栏 */}
      <div className="px-4 py-2 border-b border-dark-800 flex items-center gap-2 bg-dark-900/50">
        <Terminal className="w-3.5 h-3.5 text-accent-400" />
        <span className="text-xs font-mono text-accent-400">{containerName}</span>
        <span className="text-xs text-dark-600">容器内执行命令</span>
        <div className="ml-auto flex gap-1">
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClear(); }}
            className="text-xs px-2 py-0.5 rounded text-dark-600 hover:text-dark-400 border border-dark-800 hover:border-dark-700 transition-colors"
          >清空</button>
        </div>
      </div>

      {/* 输出区 */}
      <div className="h-52 overflow-y-auto px-4 py-2 font-mono text-xs">
        {cmds.length === 0 ? (
          <div className="text-dark-600 py-4 text-center">
            输入命令按回车执行，例如 <span className="text-accent-400">ps aux</span>、<span className="text-accent-400">ls /</span>、<span className="text-accent-400">cat /etc/hosts</span>
          </div>
        ) : cmds.map((l, i) => (
          <div key={i} className="mb-3">
            <div className="flex items-center gap-1 text-accent-400">
              <span className="opacity-60">$</span>
              <span>{l.cmd}</span>
            </div>
            <pre className="text-dark-300 whitespace-pre-wrap break-all mt-0.5 leading-relaxed">{l.output || '(无输出)'}</pre>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* 输入框 */}
      <div className="border-t border-dark-800 px-4 py-2 flex items-center gap-2">
        <span className="text-accent-400 font-mono text-sm">$</span>
        <input
          type="text"
          value={cmdInput}
          onChange={e => setCmdInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !execLoading) onRun(cmdInput);
          }}
          placeholder="输入命令，按回车执行..."
          className="flex-1 bg-transparent text-dark-200 text-sm font-mono placeholder-dark-700 focus:outline-none"
        />
        {execLoading && <Loader className="w-3.5 h-3.5 animate-spin text-dark-500" />}
      </div>
    </div>
  );
}

// ─── 实时日志流面板组件 ─────────────────────────────────────────────
interface LiveLogLine {
  timestamp: string;
  line: string;
  level: string;
  content: string;
}

interface LiveLogPanelProps {
  panelKey: string;
  containerName: string;
  lines: LiveLogLine[];
  paused: boolean;
  connecting: boolean;
  onPause: () => void;
  onResume: () => void;
  onClear: () => void;
  onClose: () => void;
}

const LEVEL_COLORS: Record<string, string> = {
  'FATAL': 'text-red-300',
  'ERROR': 'text-red-400',
  'WARN': 'text-yellow-400',
  'WARNING': 'text-yellow-400',
  'INFO': 'text-dark-200',
  'DEBUG': 'text-dark-500',
  'TRACE': 'text-dark-600',
};

function LiveLogPanel({ panelKey, containerName, lines, paused, connecting, onPause, onResume, onClear, onClose }: LiveLogPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // 自动滚动到底部（仅在未暂停且自动滚动开启时）
  useEffect(() => {
    if (!paused && autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [lines, paused, autoScroll]);

  // 检测用户手动滚动
  const handleScroll = () => {
    if (scrollRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
      setAutoScroll(scrollHeight - scrollTop - clientHeight < 50);
    }
  };

  return (
    <div className="border-t border-dark-800 bg-[#0d1117]">
      {/* 标题栏 */}
      <div className="px-4 py-2 border-b border-dark-800 flex items-center gap-2 bg-dark-900/50">
        <StopCircle className="w-3.5 h-3.5 text-green-400" />
        <span className="text-xs font-mono text-green-400">{containerName}</span>
        <span className="text-xs text-dark-600">
          实时日志流
          {connecting && <Loader className="w-3 h-3 animate-spin inline ml-1" />}
          {!connecting && !paused && <span className="text-green-500 ml-1">● LIVE</span>}
          {paused && <span className="text-yellow-500 ml-1">⏸ 已暂停</span>}
        </span>
        <span className="text-xs text-dark-700 ml-2">{lines.length} 条</span>
        <div className="ml-auto flex gap-1">
          {paused ? (
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onResume(); }}
              className="text-xs px-2 py-0.5 rounded text-green-400 hover:text-green-300 border border-green-500/30 hover:border-green-500/50 transition-colors"
              title="继续"
            >
              ▶ 继续
            </button>
          ) : (
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onPause(); }}
              className="text-xs px-2 py-0.5 rounded text-yellow-400 hover:text-yellow-300 border border-yellow-500/30 hover:border-yellow-500/50 transition-colors"
              title="暂停"
            >
              ⏸ 暂停
            </button>
          )}
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClear(); }}
            className="text-xs px-2 py-0.5 rounded text-dark-600 hover:text-dark-400 border border-dark-800 hover:border-dark-700 transition-colors"
            title="清空"
          >
            清空
          </button>
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClose(); }}
            className="text-xs px-2 py-0.5 rounded text-dark-500 hover:text-red-400 border border-dark-800 hover:border-red-500/30 transition-colors"
            title="关闭日志流"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 日志输出区 - 暗色终端风格 */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-80 overflow-y-auto px-4 py-2 font-mono text-xs leading-relaxed"
      >
        {connecting && lines.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-dark-600">
            <Loader className="w-4 h-4 animate-spin mr-2" /> 连接中...
          </div>
        ) : lines.length === 0 ? (
          <div className="text-dark-600 py-8 text-center">等待日志...</div>
        ) : (
          lines.map((l, i) => (
            <div key={i} className={`flex gap-2 py-px hover:bg-dark-800/30 ${LEVEL_COLORS[l.level] || 'text-dark-300'}`}>
              <span className="text-dark-700 flex-shrink-0 w-44 select-none">
                {l.timestamp?.slice(0, 23) || l.timestamp?.slice(0, 19) || '-'}
              </span>
              <span className="flex-shrink-0 w-12 font-semibold">
                [{l.level}]
              </span>
              <span className="break-all">{l.content || l.line}</span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
        {!autoScroll && !paused && (
          <button
            onClick={(e) => { e.preventDefault(); setAutoScroll(true); bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }}
            className="sticky bottom-2 mx-auto block text-xs px-3 py-1 rounded bg-dark-700 text-dark-300 hover:bg-dark-600 border border-dark-600 transition-colors"
          >
            ↓ 跟随最新日志
          </button>
        )}
      </div>
    </div>
  );
}

// ─── AI 诊断面板组件 ─────────────────────────────────────────────
interface DiagnosisPanelProps {
  panelKey: string;
  containerName: string;
  loading: boolean;
  text: string;
  copied: boolean;
  onCopy: () => void;
  onClose: () => void;
}

function DiagnosisPanel({ panelKey, containerName, loading, text, copied, onCopy, onClose }: DiagnosisPanelProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  // Auto-scroll 内容区底部（流式输出时）
  useEffect(() => {
    if (contentRef.current && text) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [text]);

  return (
    <div className="border-t border-accent-500/30 bg-[#0d1117]">
      {/* 标题栏 */}
      <div className="px-4 py-2 border-b border-accent-500/20 flex items-center gap-2 bg-accent-500/5">
        <Stethoscope className="w-3.5 h-3.5 text-accent-400" />
        <span className="text-xs font-mono text-accent-400">{containerName}</span>
        <span className="text-xs text-accent-500/70">
          AI 诊断
          {loading && <Loader className="w-3 h-3 animate-spin inline ml-1 text-accent-400" />}
          {!loading && text && <CheckCircle className="w-3 h-3 inline ml-1 text-green-400" />}
        </span>
        <div className="ml-auto flex gap-1">
          {text && !loading && (
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onCopy(); }}
              className="text-xs px-2 py-0.5 rounded text-dark-400 hover:text-dark-200 border border-dark-700 hover:border-dark-500 transition-colors flex items-center gap-1"
              title="复制诊断结果"
            >
              {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
              {copied ? '已复制' : '复制'}
            </button>
          )}
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClose(); }}
            className="text-xs px-2 py-0.5 rounded text-dark-500 hover:text-red-400 border border-dark-800 hover:border-red-500/30 transition-colors"
            title="关闭诊断面板"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 诊断内容区 */}
      <div className="h-80 overflow-y-auto px-4 py-3" ref={contentRef}>
        {loading && !text ? (
          <div className="flex flex-col items-center justify-center py-16 text-dark-500">
            <Stethoscope className="w-10 h-10 mb-3 animate-pulse text-accent-500/50" />
            <p className="text-sm">正在拉取容器日志并进行分析...</p>
            <p className="text-xs mt-1 text-dark-600">AI 正在诊断 {containerName}</p>
          </div>
        ) : !text ? (
          <div className="text-dark-600 py-8 text-center text-sm">
            诊断未开始
          </div>
        ) : (
          <div
            className="text-sm text-dark-200 leading-relaxed prose-invert
              [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-xs [&_h1_h2_h3]:font-bold [&_h1_h2_h3]:mt-3 [&_h1_h2_h3]:mb-1
              [&_code]:bg-dark-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs
              [&_ul]:list-disc [&_ul]:ml-4 [&_ol]:list-decimal [&_ol]:ml-4
              [&_li]:text-xs [&_li]:my-0.5
              [&_pre]:bg-dark-900 [&_pre]:p-2 [&_pre]:rounded [&_pre]:text-xs [&_pre]:overflow-x-auto
              [&_strong]:text-dark-100
              [&_blockquote]:border-l-2 [&_blockquote]:border-accent-500/30 [&_blockquote]:pl-3 [&_blockquote]:text-dark-400"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
          />
        )}
      </div>
    </div>
  );
}
