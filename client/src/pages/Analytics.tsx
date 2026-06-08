import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useToast } from '../contexts/ToastContext';
import { 
  Brain, 
  Sparkles, 
  Loader2, 
  AlertTriangle, 
  Lightbulb,
  FileText,
  RefreshCw,
  Copy,
  Check,
  Wrench,
  AlertOctagon,
  Eye,
  EyeOff,
  Server,
  Monitor,
  Stethoscope,
  Boxes,
  Container,
  X,
  Clock,
  Search
} from 'lucide-react';
import { useDevice } from '../contexts/DeviceContext';
import { useWsMessage } from '../contexts/WebSocketContext';
import type { Log, RemoteServer } from '../types';

export default function Analytics() {
  const { selectedDevice, isRemote } = useDevice();
  const [searchParams, setSearchParams] = useSearchParams();
  const [logs, setLogs] = useState<Log[]>([]);
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [errorLogsOnly, setErrorLogsOnly] = useState(true);
  const [healthMode, setHealthMode] = useState<'logs' | 'containers'>('logs');
  const [healthReport, setHealthReport] = useState<any>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [customPrompt, setCustomPrompt] = useState('');
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  
  // Fix code flow
  const [selectedLog, setSelectedLog] = useState<Log | null>(null);
  const [fixResult, setFixResult] = useState<string | null>(null);
  const [fixing, setFixing] = useState(false);
  const [confirmStep, setConfirmStep] = useState(0);
  const [codeContext, setCodeContext] = useState('');
  const [showCodeInput, setShowCodeInput] = useState(false);

  // 容器异常退出通知
  const [exitAlerts, setExitAlerts] = useState<any[]>([]);
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set());

  // 容器日志巡检
  const [patrolResults, setPatrolResults] = useState<any[]>([]);
  const [patrolTimestamp, setPatrolTimestamp] = useState('');
  const [patrolAnalyzing, setPatrolAnalyzing] = useState(false);
  const [patrolAnalysis, setPatrolAnalysis] = useState<string | null>(null);

  // WebSocket 事件监听
  useWsMessage('container_exited', (data) => {
    const key = `${data.containerId}-${data.timestamp}`;
    setExitAlerts(prev => [{ ...data, _key: key }, ...prev].slice(0, 20));
  });

  useWsMessage('container_patrol', (data) => {
    if (data.data?.results) {
      setPatrolResults(data.data.results);
      setPatrolTimestamp(data.data.timestamp);
    }
  });

  // 从 toast 点击跳转过来的，自动触发 AI 分析
  useEffect(() => {
    const auto = searchParams.get('autoPatrol');
    if (auto === '1') {
      setSearchParams({}, { replace: true });

      (async () => {
        // Step 1: 触发巡检
        try {
          const patrolRes = await fetch('/api/docker/patrol/now', { method: 'POST' });
          const patrolData = await patrolRes.json();
          if (patrolData.results?.length > 0) {
            setPatrolResults(patrolData.results);
            setPatrolTimestamp(new Date().toISOString());
          } else {
            // 巡检无新增，尝试从缓存拿
            try {
              const last = await fetch('/api/docker/patrol/last').then(r => r.json());
              if (last.results?.length > 0) {
                setPatrolResults(last.results);
                setPatrolTimestamp(last.timestamp);
              }
            } catch {}
          }
        } catch {}

        // Step 2: AI 分析
        setPatrolAnalyzing(true);
        setPatrolAnalysis('');
        try {
          const res = await fetch('/api/docker/patrol/analyze', { method: 'POST' });
          if (!res.ok) {
            setPatrolAnalysis('🕐 暂无新异常日志，尝试分析历史数据...');
            // 从 patrol/last 拉已有数据展示
            const last = await fetch('/api/docker/patrol/last').then(r => r.json());
            if (last.results?.length > 0) {
              setPatrolResults(last.results);
              setPatrolTimestamp(last.timestamp);
              setPatrolAnalysis('✅ 上次巡检无新增异常。以下为已记录的异常：');
            } else {
              setPatrolAnalysis('✨ 所有容器运行正常，未发现任何异常日志。');
            }
            setPatrolAnalyzing(false);
            return;
          }
          const reader = res.body?.getReader();
          const decoder = new TextDecoder();
          if (!reader) return;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            const lines = text.split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const payload = line.slice(6);
                if (payload === '[DONE]') continue;
                try {
                  const j = JSON.parse(payload);
                  if (j.content) setPatrolAnalysis(prev => (prev || '') + j.content);
                  if (j.error) setPatrolAnalysis(prev => (prev || '') + `\n❌ ${j.error}`);
                } catch {}
              }
            }
          }
        } catch {}
        setPatrolAnalyzing(false);
      })();
    }
  }, [searchParams]);

  // 从容器退出 toast 跳转过来的，触发单容器诊断
  useEffect(() => {
    if (searchParams.get('autoExit') === '1') {
      const sourceId = searchParams.get('sourceId') || '';
      const containerId = searchParams.get('containerId') || '';
      const containerName = searchParams.get('containerName') || '';
      setSearchParams({}, { replace: true });
      setHealthMode('containers');

      if (!sourceId || !containerId) return;

      // 单容器诊断
      setTimeout(async () => {
        setHealthLoading(true);
        setAnalysis('');
        try {
          const res = await fetch(`/api/docker/container/${encodeURIComponent(sourceId)}/${encodeURIComponent(containerId)}/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              exitCode: parseInt(searchParams.get('exitCode') || '0'),
              exitType: searchParams.get('exitType') || '',
              exitLabel: searchParams.get('exitLabel') || '',
              image: searchParams.get('image') || '',
            }),
          });
          const reader = res.body?.getReader();
          if (reader) {
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
                  const d = line.slice(6);
                  if (d === '[DONE]') continue;
                  try {
                    const j = JSON.parse(d);
                    if (j.content) setAnalysis(p => (p || '') + j.content);
                  } catch {}
                }
              }
            }
          }
          // 拉退出容器清单展示在健康报告里
          setHealthReport({
            target: containerName,
            problems: [{ name: containerName, image: searchParams.get('image') || '?', exitCode: searchParams.get('exitCode'), exitType: searchParams.get('exitType'), sourceName: searchParams.get('sourceId'), errors: [] }],
            summary: { total: 1, running: 0, oomKilled: 0, errorExited: 1, normalExited: 0 }
          });
        } catch {}
        setHealthLoading(false);
      }, 300);
    }
  }, [searchParams]);

  useEffect(() => {
    fetchLogs();
  }, [errorLogsOnly, selectedDevice.id, isRemote]);

  const fetchLogs = async () => {
    setLoading(true);
    
    try {
      if (isRemote) {
        // 远程服务器日志
        const remoteServer = selectedDevice as RemoteServer;
        const filesRes = await fetch(`/api/remote/servers/${selectedDevice.id}/files?path=${encodeURIComponent(remoteServer.logPath || '/var/log')}`);
        const filesData = await filesRes.json();
        
        if (filesData.files && filesData.files.length > 0) {
          // 找第一个日志文件
          const logFile = filesData.files.find((f: any) => f.isLog) || filesData.files[0];
          
          const logsRes = await fetch(`/api/remote/servers/${selectedDevice.id}/logs?file=${encodeURIComponent(logFile.path)}&lines=100${errorLogsOnly ? '&level=ERROR' : ''}`);
          const logsData = await logsRes.json();
          setLogs(logsData.logs || []);
        } else {
          setLogs([]);
        }
      } else {
        // 本地日志
        const endpoint = errorLogsOnly 
          ? '/api/logs?level=ERROR&limit=100' 
          : '/api/logs?limit=100';
        
        const res = await fetch(endpoint);
        const data = await res.json();
        setLogs(data.logs || []);
      }
    } catch (err) {
      console.error('Failed to fetch logs:', err);
      setLogs([]);
    }
    
    setLoading(false);
  };

  const runHealthCheck = async () => {
    setHealthLoading(true);
    setAnalysis(null);
    setHealthReport(null);
    try {
      // Step 1: Get health report
      const reportRes = await fetch('/api/docker/health-check');
      const report = await reportRes.json();
      setHealthReport(report);
      
      if (report.problems && report.problems.length > 0) {
        toast.warning(`健康检查: ${report.problems.length} 个问题`);
        // Step 2: AI diagnosis (SSE)
        const analyzeRes = await fetch('/api/docker/health-check/analyze', { method: 'POST' });
        const reader = analyzeRes.body?.getReader();
        if (!reader) throw new Error('No response body');
        
        const decoder = new TextDecoder();
        let buffer = '';
        setAnalysis('');
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') continue;
              try {
                const parsed = JSON.parse(data);
                if (parsed.content) setAnalysis(prev => (prev || '') + parsed.content);
                if (parsed.error) setAnalysis(prev => (prev || '') + '\n❌ ' + parsed.error);
              } catch {}
            }
          }
        }
      } else {
        setAnalysis(report.analysis || '🎉 所有容器运行正常');
        toast.success('健康检查通过 · 所有容器正常');
      }
    } catch (err: any) {
      setAnalysis('❌ 诊断失败: ' + (err.message || err));
    }
    setHealthLoading(false);
  };

  const analyzeLogs = async () => {
    if (logs.length === 0) return;
    
    setAnalyzing(true);
    setAnalysis(null);
    
    try {
      const res = await fetch('/api/logs/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          logs: logs,
          prompt: customPrompt || undefined,
          deviceId: isRemote ? selectedDevice.id : 'local',
          deviceName: selectedDevice.name
        })
      });
      
      const data = await res.json();
      
      if (data.error) {
        setAnalysis(`❌ 错误: ${data.error}\n\n请检查设置中的 API Key 配置。`);
      } else {
        setAnalysis(data.analysis);
      }
    } catch (err) {
      setAnalysis(`❌ 分析失败: ${err}`);
    }
    
    setAnalyzing(false);
  };

  const copyAnalysis = () => {
    if (analysis) {
      navigator.clipboard.writeText(analysis);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // AI 修复代码 - 三次确认流程
  const requestFix = (log: Log) => {
    setSelectedLog(log);
    setConfirmStep(1);
  };

  const confirmAnalysis = async () => {
    if (!selectedLog) return;
    setConfirmStep(2);
    
    setFixing(true);
    try {
      const res = await fetch('/api/logs/fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          errorLog: `[${selectedLog.timestamp}] [${selectedLog.level}] ${selectedLog.message}`,
          codeContext: codeContext || undefined,
          filePath: undefined,
          deviceId: isRemote ? selectedDevice.id : 'local'
        })
      });
      const data = await res.json();
      if (data.fix) {
        setFixResult(data.fix);
      } else {
        setFixResult(`❌ 错误: ${data.error}`);
      }
    } catch (err) {
      setFixResult(`❌ 请求失败: ${err}`);
    }
    setFixing(false);
  };

  const confirmFix = () => {
    setConfirmStep(3);
  };

  const cancelFix = () => {
    setConfirmStep(0);
    setSelectedLog(null);
    setFixResult(null);
    setCodeContext('');
  };

  const renderMarkdown = (text: string) => {
    return text.split('\n').map((line, idx) => {
      if (line.startsWith('## ')) {
        return <h3 key={idx} className="text-lg font-bold mt-4 mb-2 text-accent-400">{line.slice(3)}</h3>;
      }
      if (line.startsWith('### ')) {
        return <h4 key={idx} className="text-md font-semibold mt-3 mb-1 text-dark-200">{line.slice(4)}</h4>;
      }
      if (line.match(/^[-*]\s/)) {
        return <li key={idx} className="ml-4 text-dark-300">{line.slice(2)}</li>;
      }
      if (line.match(/^\d+\.\s/)) {
        return <li key={idx} className="ml-4 text-dark-300">{line.replace(/^\d+\.\s/, '')}</li>;
      }
      if (line.startsWith('```')) {
        return null;
      }
      if (line.includes('**')) {
        const parts = line.split(/(\*\*[^*]+\*\*)/g);
        return (
          <p key={idx} className="text-dark-300 my-1">
            {parts.map((part, i) => 
              part.startsWith('**') && part.endsWith('**') 
                ? <strong key={i} className="text-dark-100">{part.slice(2, -2)}</strong>
                : part
            )}
          </p>
        );
      }
      if (!line.trim()) {
        return <br key={idx} />;
      }
      return <p key={idx} className="text-dark-300 my-1">{line}</p>;
    });
  };

  const renderHealthPanel = () => (
    <>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Container className="w-5 h-5 text-green-400" />
          容器健康报告
          {healthReport && (
            <span className="text-sm font-normal text-dark-400">
              ({healthReport.summary?.total || 0} 个容器)
            </span>
          )}
        </h2>
      </div>
      {healthLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 text-accent-500 animate-spin" />
        </div>
      ) : healthReport ? (
        <>
          <div className="p-3 bg-dark-900 rounded-lg border border-dark-800 mb-3">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div><div className="text-green-400 font-bold text-lg">{healthReport.summary?.running || 0}</div><div className="text-xs text-dark-500">运行中</div></div>
              <div><div className="text-red-400 font-bold text-lg">{healthReport.summary?.unhealthy || 0}</div><div className="text-xs text-dark-500">异常</div></div>
              <div><div className="text-dark-400 font-bold text-lg">{healthReport.summary?.normalExited || 0}</div><div className="text-xs text-dark-500">正常退出</div></div>
            </div>
          </div>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {healthReport.problems?.map((p: any) => (
              <div key={p.name} className={`p-3 bg-dark-900 rounded-lg border-l-2 ${
                p.exitType === 'oom' ? 'border-red-500 bg-red-500/5' : 'border-orange-500 bg-orange-500/5'
              }`}>
                <div className="flex items-center justify-between mb-1">
                  <span className="font-medium text-sm">{p.name}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded ${
                    p.exitType === 'oom' ? 'bg-red-500/20 text-red-400' : 'bg-orange-500/20 text-orange-400'
                  }`}>
                    {p.exitType === 'oom' ? 'OOM' : `退出码 ${p.exitCode}`}
                  </span>
                </div>
                <p className="text-xs text-dark-500">{p.image} · {p.sourceName}</p>
                {p.errors?.length > 0 && (
                  <div className="mt-2 text-xs font-mono text-dark-400 bg-dark-950 rounded p-2 max-h-20 overflow-y-auto">
                    {p.errors.slice(0, 3).map((e: string, i: number) => (
                      <div key={i} className="truncate text-red-300/70">{e}</div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {healthReport.problems?.length === 0 && (
              <div className="text-center py-4 text-green-400">✅ 无问题容器</div>
            )}
          </div>
        </>
      ) : (
        <div className="flex flex-col items-center justify-center py-12 text-dark-500">
          <Stethoscope className="w-10 h-10 mb-3 opacity-50" />
          <p>点击下方按钮开始诊断</p>
        </div>
      )}
      <button
        onClick={runHealthCheck}
        disabled={healthLoading}
        className="w-full mt-4 px-4 py-3 rounded-lg bg-gradient-to-r from-green-600 to-green-500 hover:from-green-500 hover:to-green-400 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 font-semibold"
      >
        {healthLoading ? (
          <>
            <Loader2 className="w-5 h-5 animate-spin" />
            诊断中...
          </>
        ) : (
          <>
            <Stethoscope className="w-5 h-5" />
            开始容器健康诊断
          </>
        )}
      </button>
    </>
  );

  const renderLogPanel = () => (
    <>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <FileText className="w-5 h-5 text-blue-400" />
          待分析日志
          <span className="text-sm font-normal text-dark-400">({logs.length} 条)</span>
        </h2>
      </div>

      <div className="space-y-2 max-h-96 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 text-accent-500 animate-spin" />
          </div>
        ) : logs.length === 0 ? (
          <div className="text-center py-8 text-dark-500">
            暂无日志数据
          </div>
        ) : (
          logs.map(log => (
            <div 
              key={log.id}
              className="p-3 bg-dark-900 rounded-lg border border-dark-800 hover:border-dark-700 transition-colors"
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-dark-500">
                    {new Date(log.timestamp).toLocaleString()}
                  </span>
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                    log.level === 'ERROR' 
                      ? 'bg-red-500/20 text-red-400' 
                      : 'bg-yellow-500/20 text-yellow-400'
                  }`}>
                    {log.level}
                  </span>
                </div>
                <button
                  onClick={() => requestFix(log)}
                  className="px-2 py-1 rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 text-xs flex items-center gap-1 transition-colors"
                >
                  <Wrench className="w-3 h-3" />
                  AI 修复
                </button>
              </div>
              <p className="text-sm text-dark-300 font-mono line-clamp-2">
                {log.message}
              </p>
            </div>
          ))
        )}
      </div>

      <button
        onClick={analyzeLogs}
        disabled={analyzing || logs.length === 0}
        className="w-full mt-4 px-4 py-3 rounded-lg bg-gradient-to-r from-accent-600 to-accent-500 hover:from-accent-500 hover:to-accent-400 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 font-semibold"
      >
        {analyzing ? (
          <>
            <Loader2 className="w-5 h-5 animate-spin" />
            AI 正在分析中...
          </>
        ) : (
          <>
            <Sparkles className="w-5 h-5" />
            开始 AI 分析
          </>
        )}
      </button>
    </>
  );

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-3">
            <Brain className="w-7 h-7 text-accent-500" />
            AI 日志分析
          </h1>
          <p className="text-dark-400 flex items-center gap-2">
            {isRemote ? (
              <>
                <Server className="w-4 h-4 text-green-500" />
                远程服务器: {selectedDevice.name}
              </>
            ) : (
              <>
                <Monitor className="w-4 h-4 text-accent-500" />
                本地设备
              </>
            )}
          </p>
        </div>
      </div>

      {/* 容器异常退出通知 */}
      {exitAlerts.filter(a => !dismissedAlerts.has(a._key)).slice(0, 3).map((alert, i) => (
        <div key={alert._key} className={`rounded-xl p-4 flex items-start gap-3 animate-fade-in ${
          alert.exitType === 'oom' ? 'bg-red-500/15 border border-red-500/30'
          : alert.exitType === 'segfault' ? 'bg-orange-500/15 border border-orange-500/30'
          : 'bg-red-500/10 border border-red-500/20'
        }`}>
          <AlertOctagon className={`w-5 h-5 mt-0.5 flex-shrink-0 ${
            alert.exitType === 'oom' ? 'text-red-400' : 'text-orange-400'
          }`} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">
              {alert.label} — <span className="font-mono text-dark-300">{alert.containerName}</span>
            </p>
            <p className="text-xs text-dark-400 mt-1">
              {alert.sourceName} · 镜像: {alert.image} · 退出码: {alert.exitCode} · {new Date(alert.timestamp).toLocaleTimeString()}
            </p>
            {alert.recentErrors && alert.recentErrors.length > 0 && (
              <details className="mt-2">
                <summary className="text-xs text-dark-400 cursor-pointer hover:text-dark-300">
                  最近错误日志 ({alert.recentErrors.length} 条) ▸
                </summary>
                <pre className="mt-1 text-xs text-dark-500 font-mono bg-dark-900/50 rounded p-2 overflow-x-auto max-h-32">
                  {alert.recentErrors.join('\n')}
                </pre>
              </details>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={async () => {
                setAnalysis('');
                setHealthMode('containers');
                setHealthLoading(true);
                try {
                  const res = await fetch(`/api/docker/container/${encodeURIComponent(alert.sourceId)}/${encodeURIComponent(alert.containerId)}/analyze`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      exitCode: alert.exitCode,
                      exitType: alert.exitType,
                      exitLabel: alert.label,
                      image: alert.image,
                    }),
                  });
                  const reader = res.body?.getReader();
                  if (reader) {
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
                          const d = line.slice(6);
                          if (d === '[DONE]') continue;
                          try { const j = JSON.parse(d); if (j.content) setAnalysis(p => (p || '') + j.content); } catch {}
                        }
                      }
                    }
                  }
                } catch {}
                setHealthLoading(false);
              }}
              className="px-2.5 py-1 text-xs rounded-lg bg-dark-800 text-accent-400 hover:bg-dark-700 border border-dark-700 hover:border-accent-500/30 transition-colors"
            >
              诊断
            </button>
            <button
              onClick={() => setDismissedAlerts(prev => new Set([...prev, alert._key]))}
              className="p-1 text-dark-500 hover:text-dark-300"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      ))}

      {/* Quick Actions */}
      <div className="flex flex-wrap gap-3">
        <button
          onClick={fetchLogs}
          disabled={loading}
          className="px-4 py-2 rounded-lg bg-dark-800 text-dark-300 hover:bg-dark-700 transition-colors flex items-center gap-2 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          刷新日志
        </button>
        
        <button
          onClick={() => { setErrorLogsOnly(!errorLogsOnly); setHealthMode('logs'); }}
          className={`px-4 py-2 rounded-lg transition-colors flex items-center gap-2 ${
            errorLogsOnly && healthMode === 'logs'
              ? 'bg-red-500/20 text-red-400' 
              : healthMode === 'logs'
              ? 'bg-dark-800 text-dark-300 hover:bg-dark-700'
              : 'bg-dark-800/50 text-dark-500 hover:bg-dark-700'
          }`}
        >
          <AlertTriangle className="w-4 h-4" />
          {errorLogsOnly ? '仅错误日志' : '全部日志'}
        </button>

        <button
          onClick={() => { setHealthMode('containers'); }}
          className={`px-4 py-2 rounded-lg transition-colors flex items-center gap-2 ${
            healthMode === 'containers'
              ? 'bg-green-500/20 text-green-400 border border-green-500/30'
              : 'bg-dark-800 text-dark-300 hover:bg-dark-700'
          }`}
        >
          <Stethoscope className="w-4 h-4" />
          容器健康诊断
        </button>
      </div>

      {/* Main Content */}
      <div className="grid md:grid-cols-2 gap-6">
        {/* Left Panel */}
        <div className="glass rounded-xl p-4">
          {healthMode === 'containers' ? renderHealthPanel() : renderLogPanel()}
        </div>

        {/* Analysis Result */}
        <div className="glass rounded-xl p-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Lightbulb className="w-5 h-5 text-yellow-400" />
              分析结果
            </h2>
            {analysis && (
              <button
                onClick={copyAnalysis}
                className="px-3 py-1.5 rounded-lg bg-dark-800 text-dark-400 hover:text-dark-200 transition-colors flex items-center gap-1 text-sm"
              >
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copied ? '已复制' : '复制'}
              </button>
            )}
          </div>

          {/* Custom Prompt */}
          <div className="mb-4">
            <label className="block text-sm text-dark-400 mb-2">
              自定义分析提示词（可选）
            </label>
            <textarea
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              placeholder="例如：重点关注数据库连接问题..."
              className="w-full px-3 py-2 bg-dark-900 border border-dark-800 rounded-lg text-dark-200 placeholder-dark-500 focus:outline-none focus:border-accent-500 text-sm resize-none h-20"
            />
          </div>

          {/* Result */}
          <div className="bg-dark-900 rounded-lg p-4 min-h-[300px] max-h-[500px] overflow-y-auto">
            {!analysis && !analyzing && (
              <div className="flex flex-col items-center justify-center h-64 text-dark-500">
                <Brain className="w-12 h-12 mb-4 opacity-50" />
                <p>点击"开始 AI 分析"按钮</p>
                <p className="text-sm">分析当前选中的日志</p>
              </div>
            )}
            
            {analyzing && (
              <div className="flex flex-col items-center justify-center h-64">
                <Loader2 className="w-12 h-12 text-accent-500 animate-spin mb-4" />
                <p className="text-dark-300">AI 正在分析日志...</p>
                <p className="text-sm text-dark-500 mt-2">这可能需要几秒钟</p>
              </div>
            )}
            
            {analysis && (
              <div className="prose prose-invert max-w-none">
                {renderMarkdown(analysis)}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Tips */}
      <div className="glass rounded-xl p-4 bg-gradient-to-r from-accent-500/10 to-purple-500/10">
        <h3 className="font-semibold mb-2 flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-accent-400" />
          使用提示
        </h3>
        <ul className="text-sm text-dark-400 space-y-1 ml-6 list-disc">
          <li>确保在设置页面正确配置了 AI 模型（支持 OpenAI、Ollama 等）</li>
          <li>建议先筛选错误日志进行分析，可获得更精准的结果</li>
          <li>可使用自定义提示词指定分析重点</li>
          <li>分析结果仅供参考，实际问题需要人工确认</li>
          <li>当前分析{isRemote ? '远程服务器' : '本地设备'}的日志</li>
        </ul>
      </div>

      {/* AI Fix Confirmation Modal */}
      {confirmStep > 0 && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="glass rounded-xl p-6 max-w-2xl w-full max-h-[80vh] overflow-y-auto">
            {/* Step 1: Confirm to analyze */}
            {confirmStep === 1 && (
              <>
                <h2 className="text-xl font-bold flex items-center gap-2 mb-4">
                  <AlertOctagon className="w-6 h-6 text-yellow-500" />
                  确认分析此错误
                </h2>
                <div className="bg-dark-900 rounded-lg p-4 mb-4">
                  <p className="text-red-400 font-medium mb-2">错误日志：</p>
                  <p className="text-dark-300 font-mono text-sm">{selectedLog?.message}</p>
                  {isRemote && (
                    <p className="text-xs text-blue-400 mt-2">
                      来源: {selectedDevice.name} ({selectedDevice.host})
                    </p>
                  )}
                </div>
                
                {/* Optional code context input */}
                <div className="mb-4">
                  <button
                    onClick={() => setShowCodeInput(!showCodeInput)}
                    className="text-sm text-blue-400 hover:text-blue-300 flex items-center gap-1 mb-2"
                  >
                    {showCodeInput ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    {showCodeInput ? '隐藏' : '添加'}相关代码上下文（可选）
                  </button>
                  {showCodeInput && (
                    <textarea
                      value={codeContext}
                      onChange={(e) => setCodeContext(e.target.value)}
                      placeholder="粘贴相关代码片段，帮助 AI 更准确定位问题..."
                      className="w-full px-3 py-2 bg-dark-900 border border-dark-800 rounded-lg text-dark-200 placeholder-dark-500 focus:outline-none focus:border-accent-500 text-sm font-mono h-32 resize-none"
                    />
                  )}
                </div>
                
                <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-4 mb-4">
                  <p className="text-yellow-400 text-sm">
                    ⚠️ AI 将分析此错误并尝试生成修复代码。在应用任何修复前，请务必：
                  </p>
                  <ul className="text-yellow-300/80 text-sm mt-2 ml-4 list-disc">
                    <li>备份原文件</li>
                    <li>在测试环境验证</li>
                    <li>仔细审查 AI 生成的代码</li>
                  </ul>
                </div>
                
                <div className="flex gap-3 justify-end">
                  <button
                    onClick={cancelFix}
                    className="px-4 py-2 rounded-lg bg-dark-800 text-dark-300 hover:bg-dark-700"
                  >
                    取消
                  </button>
                  <button
                    onClick={confirmAnalysis}
                    disabled={fixing}
                    className="px-4 py-2 rounded-lg bg-blue-500 text-white hover:bg-blue-600 flex items-center gap-2"
                  >
                    {fixing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Brain className="w-4 h-4" />}
                    确认分析
                  </button>
                </div>
              </>
            )}

            {/* Step 2: Review fix proposal */}
            {confirmStep === 2 && (
              <>
                <h2 className="text-xl font-bold flex items-center gap-2 mb-4">
                  <Wrench className="w-6 h-6 text-blue-500" />
                  AI 修复方案
                </h2>
                
                <div className="bg-dark-900 rounded-lg p-4 mb-4 max-h-64 overflow-y-auto">
                  {fixing ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="w-8 h-8 text-accent-500 animate-spin" />
                      <span className="ml-3 text-dark-400">AI 正在分析并生成修复方案...</span>
                    </div>
                  ) : fixResult ? (
                    <div className="prose prose-invert max-w-none">
                      {renderMarkdown(fixResult)}
                    </div>
                  ) : (
                    <p className="text-red-400">无法生成修复方案</p>
                  )}
                </div>
                
                {!fixing && fixResult && (
                  <>
                    <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 mb-4">
                      <p className="text-red-400 font-medium mb-2">⚠️ 重要警告</p>
                      <ul className="text-red-300/80 text-sm space-y-1">
                        <li>• 此修复方案由 AI 生成，可能不完整或不准确</li>
                        <li>• 在生产环境应用前，必须在测试环境验证</li>
                        <li>• 建议手动审查并理解每一行修改</li>
                      </ul>
                    </div>
                    
                    <div className="flex gap-3 justify-end">
                      <button
                        onClick={cancelFix}
                        className="px-4 py-2 rounded-lg bg-dark-800 text-dark-300 hover:bg-dark-700"
                      >
                        取消
                      </button>
                      <button
                        onClick={confirmFix}
                        className="px-4 py-2 rounded-lg bg-yellow-500 text-black font-medium hover:bg-yellow-400 flex items-center gap-2"
                      >
                        <AlertTriangle className="w-4 h-4" />
                        已了解风险，继续
                      </button>
                    </div>
                  </>
                )}
              </>
            )}

            {/* Step 3: Final warning */}
            {confirmStep === 3 && (
              <>
                <h2 className="text-xl font-bold flex items-center gap-2 mb-4 text-red-500">
                  <AlertOctagon className="w-6 h-6" />
                  最终确认
                </h2>
                
                <div className="bg-red-500/20 border-2 border-red-500/50 rounded-lg p-6 mb-4">
                  <p className="text-red-400 text-lg font-bold text-center mb-4">
                    🚨 危险操作警告 🚨
                  </p>
                  <p className="text-dark-300 text-center mb-4">
                    你即将对生产服务进行代码修改。此操作<span className="text-red-400 font-bold">不可逆</span>，
                    可能导致服务中断或数据丢失。
                  </p>
                  <div className="bg-dark-900 rounded-lg p-4 mb-4">
                    <p className="text-sm text-dark-400">建议的操作：</p>
                    <ol className="text-dark-300 text-sm mt-2 ml-4 list-decimal space-y-1">
                      <li>复制修复代码到剪贴板</li>
                      <li>手动备份相关文件</li>
                      <li>在本地测试环境验证</li>
                      <li>在低峰期部署到生产环境</li>
                    </ol>
                  </div>
                </div>
                
                <div className="flex gap-3 justify-end">
                  <button
                    onClick={cancelFix}
                    className="px-4 py-2 rounded-lg bg-dark-800 text-dark-300 hover:bg-dark-700"
                  >
                    取消
                  </button>
                  <button
                    onClick={() => {
                      if (fixResult) {
                        navigator.clipboard.writeText(fixResult);
                      }
                      cancelFix();
                    }}
                    className="px-4 py-2 rounded-lg bg-green-500 text-white hover:bg-green-600 flex items-center gap-2"
                  >
                    <Copy className="w-4 h-4" />
                    复制代码（不自动修改）
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* 容器日志巡检结果 */}
      {patrolResults.length > 0 && (
        <div className="glass rounded-xl p-4 border border-yellow-500/20">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Search className="w-5 h-5 text-yellow-400" />
              容器日志巡检
              <span className="text-sm font-normal text-dark-400">
                ({patrolResults.length} 个容器 · {patrolTimestamp ? new Date(patrolTimestamp).toLocaleTimeString() : ''})
              </span>
            </h2>
            <div className="flex gap-2">
              <button
                onClick={async () => {
                  try {
                    const res = await fetch('/api/docker/patrol/now', { method: 'POST' });
                    const data = await res.json();
                    if (data.results) {
                      setPatrolResults(data.results);
                      setPatrolTimestamp(new Date().toISOString());
                      if (data.results.length > 0) {
                        const total = data.results.reduce((s: number, r: any) => s + (r.uniqueCount || r.matchCount || 0), 0);
                        toast.info(`巡检完成 · ${data.results.length} 个容器 · ${total} 种异常`);
                      } else {
                        toast.success('巡检完成 · 无异常');
                      }
                    }
                  } catch (_) { toast.error('巡检请求失败'); }
                }}
                className="px-3 py-1.5 rounded-lg bg-dark-800 text-dark-400 hover:text-dark-200 transition-colors flex items-center gap-1 text-sm"
              >
                <RefreshCw className="w-4 h-4" />
                立即巡检
              </button>
              <button
                onClick={async () => {
                  setPatrolAnalyzing(true);
                  setPatrolAnalysis('');
                  try {
                    const res = await fetch('/api/docker/patrol/analyze', { method: 'POST' });
                    const reader = res.body?.getReader();
                    const decoder = new TextDecoder();
                    if (!reader) return;
                    while (true) {
                      const { done, value } = await reader.read();
                      if (done) break;
                      const text = decoder.decode(value, { stream: true });
                      const lines = text.split('\n');
                      for (const line of lines) {
                        if (line.startsWith('data: ')) {
                          const payload = line.slice(6);
                          if (payload === '[DONE]') continue;
                          try {
                            const j = JSON.parse(payload);
                            if (j.content) setPatrolAnalysis(prev => (prev || '') + j.content);
                            if (j.error) setPatrolAnalysis(prev => (prev || '') + `\n❌ ${j.error}`);
                          } catch (_) {}
                        }
                      }
                    }
                  } catch (_) {}
                  setPatrolAnalyzing(false);
                }}
                disabled={patrolAnalyzing}
                className="px-3 py-1.5 rounded-lg bg-accent-600 text-white hover:bg-accent-500 transition-colors flex items-center gap-1 text-sm disabled:opacity-50"
              >
                <Sparkles className="w-4 h-4" />
                {patrolAnalyzing ? '分析中...' : 'AI 分析'}
              </button>
            </div>
          </div>

          {/* 容器列表 */}
          <div className="space-y-2 mb-4">
            {patrolResults.map((r, i) => (
              <details key={i} className="bg-dark-900/50 rounded-lg border border-dark-800">
                <summary className="px-4 py-2.5 cursor-pointer flex items-center justify-between hover:bg-dark-800/50 rounded-lg">
                  <div className="flex items-center gap-3">
                    <Container className="w-4 h-4 text-dark-400" />
                    <span className="font-mono text-sm">{r.containerName}</span>
                    <span className="text-xs text-dark-500">{r.sourceName}</span>
                    <span className="text-xs text-dark-600">{r.image}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-dark-500">{r.totalNewLines} 行新日志 · {r.uniqueCount} 种错误</span>
                    <span className="px-2 py-0.5 rounded text-xs font-medium bg-red-500/20 text-red-400">
                      {r.matchCount} 条匹配
                    </span>
                  </div>
                </summary>
                <div className="px-4 pb-3">
                  <pre className="text-xs font-mono bg-dark-950 rounded p-2 overflow-x-auto max-h-48">
                    {r.lines.map((l: any, j: number) => {
                      const lvl = l.level || 'INFO';
                      const lvlColor = lvl === 'ERROR' || lvl === 'FATAL' ? 'text-red-400' : lvl === 'WARN' ? 'text-yellow-400' : 'text-blue-400';
                      return (
                        <div key={j} className="flex gap-2 py-0.5">
                          <span className="text-dark-600 flex-shrink-0 w-20">{l.timestamp ? new Date(l.timestamp).toLocaleTimeString() : ''}</span>
                          <span className={`flex-shrink-0 w-14 font-semibold ${lvlColor}`}>[{lvl}]</span>
                          <span className="text-dark-300">{l.content || l.line}</span>
                        </div>
                      );
                    })}
                  </pre>
                </div>
              </details>
            ))}
          </div>

          {/* AI 分析结果 */}
          {patrolAnalysis && (
            <div className="bg-dark-900/50 rounded-lg p-4 border border-accent-500/20">
              <div className="flex items-center gap-2 mb-2">
                <Brain className="w-4 h-4 text-accent-400" />
                <h3 className="text-sm font-semibold text-accent-400">AI 巡检分析</h3>
              </div>
              <div className="prose prose-invert prose-sm max-w-none text-dark-300 whitespace-pre-wrap">
                {patrolAnalysis}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
