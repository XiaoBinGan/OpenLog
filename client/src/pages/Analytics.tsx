import { useState, useEffect } from 'react';
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
  Monitor
} from 'lucide-react';
import { useDevice } from '../contexts/DeviceContext';
import type { Log, RemoteServer } from '../types';

export default function Analytics() {
  const { selectedDevice, isRemote } = useDevice();
  const [logs, setLogs] = useState<Log[]>([]);
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [errorLogsOnly, setErrorLogsOnly] = useState(true);
  const [customPrompt, setCustomPrompt] = useState('');
  const [copied, setCopied] = useState(false);
  
  // Fix code flow
  const [selectedLog, setSelectedLog] = useState<Log | null>(null);
  const [fixResult, setFixResult] = useState<string | null>(null);
  const [fixing, setFixing] = useState(false);
  const [confirmStep, setConfirmStep] = useState(0);
  const [codeContext, setCodeContext] = useState('');
  const [showCodeInput, setShowCodeInput] = useState(false);

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
          onClick={() => setErrorLogsOnly(!errorLogsOnly)}
          className={`px-4 py-2 rounded-lg transition-colors flex items-center gap-2 ${
            errorLogsOnly 
              ? 'bg-red-500/20 text-red-400' 
              : 'bg-dark-800 text-dark-300 hover:bg-dark-700'
          }`}
        >
          <AlertTriangle className="w-4 h-4" />
          {errorLogsOnly ? '仅错误日志' : '全部日志'}
        </button>
      </div>

      {/* Main Content */}
      <div className="grid md:grid-cols-2 gap-6">
        {/* Log Selection */}
        <div className="glass rounded-xl p-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <FileText className="w-5 h-5 text-blue-400" />
              待分析日志
              <span className="text-sm font-normal text-dark-400">({logs.length} 条)</span>
            </h2>
          </div>

          {/* Log List */}
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

          {/* Analyze Button */}
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
    </div>
  );
}
