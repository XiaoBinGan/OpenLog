import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Container, Boxes, Activity, Search, Filter, RefreshCw,
  ChevronDown, ChevronRight, Terminal, AlertCircle, CheckCircle,
  Clock, Server, X, Loader, ArrowRightLeft, Zap, Trash2,
  Play, Pause, RotateCcw
} from 'lucide-react';

interface ContainerInfo {
  id: string;
  shortId: string;
  names: string[];
  image: string;
  command: string;
  created: string;
  state: string;
  status: string;
  ports: any[];
  labels: any;
}

interface ContainerSource {
  sourceId: string;
  sourceName: string;
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

  // 终端执行
  const [terminalOpen, setTerminalOpen] = useState<Set<string>>(new Set());
  const [terminalCmds, setTerminalCmds] = useState<Record<string, { cmd: string; output: string; time: number }[]>>({});
  const [cmdInput, setCmdInput] = useState('');
  const [execLoading, setExecLoading] = useState<Set<string>>(new Set());

  // 操作中状态
  const [opLoading, setOpLoading] = useState<Set<string>>(new Set());

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
      setSources(data.sources || []);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchContainers(); }, [fetchContainers]);

  const allContainers = sources.flatMap(s => s.containers.map(c => ({ ...c, _sourceId: s.sourceId, _sourceName: s.sourceName })));

  const filtered = allContainers.filter(c => {
    const q = filter.toLowerCase();
    return (
      (!q || c.names.some(n => n.toLowerCase().includes(q)) || c.image.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)) &&
      (levelFilter === 'all' || c.state.toLowerCase() === levelFilter.toLowerCase())
    );
  });

  const getStateColor = (state: string) => {
    if (state === 'running') return 'text-green-400';
    if (state === 'exited') return 'text-dark-500';
    if (state === 'paused') return 'text-yellow-400';
    return 'text-red-400';
  };

  const getStateDot = (state: string) => {
    if (state === 'running') return 'bg-green-400';
    if (state === 'exited') return 'bg-dark-600';
    if (state === 'paused') return 'bg-yellow-400';
    return 'bg-red-400';
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
    if (traceResults[key]) return;
    setTraceLoading(prev => new Set([...prev, key]));
    try {
      const res = await fetch(`/api/docker/trace/${sourceId}/${container.id}`);
      const data = await res.json();
      setTraceResults(prev => ({ ...prev, [key]: data }));
    } catch {}
    setTraceLoading(prev => { const s = new Set(prev); s.delete(key); return s; });
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

            return (
              <div key={key} className={`glass rounded-xl border transition-all overflow-hidden ${
                isSelected ? 'border-accent-500/50 bg-accent-500/5' : 'border-dark-800 hover:border-dark-700'
              }`}>
                {/* Container row */}
                <div className="flex items-center gap-3 px-4 py-3">
                  {/* Select */}
                  <button
                    onClick={() => toggleSelect(c._sourceId, c)}
                    className={`w-5 h-5 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
                      isSelected
                        ? 'bg-accent-500 border-accent-500 text-white'
                        : 'border-dark-700 hover:border-dark-600'
                    }`}
                  >
                    {isSelected && <CheckCircle className="w-3.5 h-3.5" />}
                  </button>

                  {/* State dot */}
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${getStateDot(c.state)}`} />

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-dark-100 truncate">
                        {c.names[0] || c.shortId}
                      </span>
                      <span className={`text-xs ${getStateColor(c.state)}`}>{c.state}</span>
                      {errorLogs.length > 0 && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/20">
                          {errorLogs.length} 错误
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
                      onClick={() => toggleTerminal(`${c._sourceId}:${c.id}`)}
                      className={`p-1.5 rounded-lg transition-colors ${terminalOpen.has(`${c._sourceId}:${c.id}`) ? 'bg-accent-500/15 text-accent-400' : 'hover:bg-dark-700 text-dark-500 hover:text-accent-400'}`}
                      title="进入容器"
                    >
                      <Terminal className="w-4 h-4" />
                    </button>

                    {/* 启停 */}
                    {c.state === 'running' ? (
                      <button
                        onClick={() => doOp(c._sourceId, c.id, 'stop', `${c._sourceId}:${c.id}:stop`)}
                        disabled={opLoading.has(`${c._sourceId}:${c.id}:stop`)}
                        className="p-1.5 rounded-lg hover:bg-dark-700 text-dark-500 hover:text-yellow-400 transition-colors"
                        title="停止"
                      >
                        {opLoading.has(`${c._sourceId}:${c.id}:stop`) ? <Loader className="w-4 h-4 animate-spin" /> : <Pause className="w-4 h-4" />}
                      </button>
                    ) : (
                      <button
                        onClick={() => doOp(c._sourceId, c.id, 'start', `${c._sourceId}:${c.id}:start`)}
                        disabled={opLoading.has(`${c._sourceId}:${c.id}:start`)}
                        className="p-1.5 rounded-lg hover:bg-dark-700 text-dark-500 hover:text-green-400 transition-colors"
                        title="启动"
                      >
                        {opLoading.has(`${c._sourceId}:${c.id}:start`) ? <Loader className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                      </button>
                    )}

                    {/* 重启 */}
                    <button
                      onClick={() => doOp(c._sourceId, c.id, 'restart', `${c._sourceId}:${c.id}:restart`)}
                      disabled={opLoading.has(`${c._sourceId}:${c.id}:restart`)}
                      className="p-1.5 rounded-lg hover:bg-dark-700 text-dark-500 hover:text-blue-400 transition-colors"
                      title="重启"
                    >
                      {opLoading.has(`${c._sourceId}:${c.id}:restart`) ? <Loader className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                    </button>

                    {/* 链路追踪 */}
                    <button
                      onClick={() => loadTrace(c._sourceId, c)}
                      disabled={traceLoading_}
                      className="p-1.5 rounded-lg hover:bg-dark-700 text-dark-500 hover:text-purple-400 transition-colors"
                      title="上下游链路追踪"
                    >
                      {traceLoading_ ? <Loader className="w-4 h-4 animate-spin" /> : <ArrowRightLeft className="w-4 h-4" />}
                    </button>

                    {/* 展开日志 */}
                    <button
                      onClick={() => toggleExpand(c._sourceId, c)}
                      className="p-1.5 rounded-lg hover:bg-dark-700 text-dark-500 hover:text-dark-200 transition-colors"
                    >
                      {isExpanded ? <ChevronDown className="w-4 h-4" /> : <Activity className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

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
                                  {u.name}
                                </span>
                              ))}
                            </div>
                          )}
                          {(trace.downstream || []).length > 0 && (
                            <div className="flex items-center gap-1">
                              <span className="text-xs text-dark-600">下游:</span>
                              {(trace.downstream || []).map(u => (
                                <span key={u.id} className="text-xs px-2 py-0.5 rounded bg-purple-500/15 text-purple-400 border border-purple-500/20">
                                  {u.name}
                                </span>
                              ))}
                            </div>
                          )}
                          {(trace.networkPeers || []).length > 0 && (
                            <div className="flex items-center gap-1">
                              <span className="text-xs text-dark-600">同网:</span>
                              {(trace.networkPeers || []).slice(0, 5).map(u => (
                                <span key={u.id} className="text-xs px-2 py-0.5 rounded bg-dark-800 text-dark-400">
                                  {u.name}
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
  let html = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  html = html.replace(/```[\w]*\n?([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');
  html = html.replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`);
  html = html.replace(/\n\n/g, '</p><p>');
  html = html.replace(/\n/g, '<br/>');
  return `<p>${html}</p>`;
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
  useEffect(() => { bottomRef.current?.scrollIntoView(); }, [cmds]);

  return (
    <div className="border-t border-dark-800 bg-[#0d1117]">
      {/* 标题栏 */}
      <div className="px-4 py-2 border-b border-dark-800 flex items-center gap-2 bg-dark-900/50">
        <Terminal className="w-3.5 h-3.5 text-accent-400" />
        <span className="text-xs font-mono text-accent-400">{containerName}</span>
        <span className="text-xs text-dark-600">容器内执行命令</span>
        <div className="ml-auto flex gap-1">
          <button
            onClick={onClear}
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
