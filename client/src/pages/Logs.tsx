import { useState, useEffect, useRef } from 'react';
import { 
  FileText, 
  Filter, 
  Search, 
  RefreshCw, 
  Trash2,
  AlertTriangle,
  Info,
  AlertCircle,
  Bug,
  Zap,
  ChevronRight,
  Server,
  Monitor,
  FolderOpen,
  File
} from 'lucide-react';
import { useDevice } from '../contexts/DeviceContext';
import { useRemote } from '../contexts/RemoteContext';
import type { Log } from '../types';

const LEVELS = ['INFO', 'WARN', 'WARNING', 'ERROR', 'DEBUG', 'TRACE', 'FATAL'];
const LEVEL_COLORS = {
  ERROR: 'text-red-500 bg-red-500/10 border-red-500/30',
  FATAL: 'text-red-600 bg-red-600/10 border-red-600/30',
  WARN: 'text-yellow-500 bg-yellow-500/10 border-yellow-500/30',
  WARNING: 'text-yellow-500 bg-yellow-500/10 border-yellow-500/30',
  INFO: 'text-blue-400 bg-blue-400/10 border-blue-400/30',
  DEBUG: 'text-purple-500 bg-purple-500/10 border-purple-500/30',
  TRACE: 'text-gray-500 bg-gray-500/10 border-gray-500/30',
};

export default function Logs() {
  const { selectedDevice, isRemote } = useDevice();
  const { activeServer, loadFiles, navigateDir, goUp, loadLogs } = useRemote();

  // ── 本地设备状态 ──
  const [localLogs, setLocalLogs] = useState<Log[]>([]);
  const [localTotal, setLocalTotal] = useState(0);
  const [localLoading, setLocalLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [levelFilter, setLevelFilter] = useState<string>('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);
  
  // ── 远程设备：文件浏览器展开/折叠 ──
  const [showFileBrowser, setShowFileBrowser] = useState(false);

  // ── 远端日志派生（从 RemoteContext）──
  const remoteLogs: Log[] = activeServer?.logs ?? [];
  const remoteTotal: number = activeServer?.totalLines ?? 0;
  const remoteLoading: boolean = activeServer?.logsLoading ?? false;
  const remoteFiles = activeServer?.files;
  const remoteSelectedFile = activeServer?.selectedFile ?? null;

  // 本地 WebSocket
  useEffect(() => {
    if (!isRemote && autoRefresh) {
      connectWebSocket();
    }
    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, [isRemote, autoRefresh]);

  // 本地日志拉取
  useEffect(() => {
    if (!isRemote && !autoRefresh) {
      fetchLocalLogs();
    }
  }, [levelFilter, selectedDevice.id, isRemote]);

  // 远程：首次进入时自动加载文件列表
  useEffect(() => {
    if (isRemote && activeServer && activeServer.status === 'connected') {
      loadFiles();
    }
  }, [isRemote, activeServer?.id, activeServer?.status]);

  // search / levelFilter 已在组件顶部声明

  const connectWebSocket = () => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'log') {
        setLocalLogs(prev => [data.data, ...prev].slice(0, 1000));
        setLocalTotal(prev => prev + 1);
      }
    };
    wsRef.current = ws;
  };

  const fetchLocalLogs = async () => {
    setLocalLoading(true);
    try {
      const params = new URLSearchParams();
      if (levelFilter) params.append('level', levelFilter);
      if (search) params.append('search', search);
      params.append('limit', '200');
      const res = await fetch(`/api/logs?${params}`);
      const data = await res.json();
      setLocalLogs(data.logs || []);
      setLocalTotal(data.total || 0);
    } catch (err) {
      console.error('Failed to fetch local logs:', err);
    }
    setLocalLoading(false);
  };

  const clearLocalLogs = async () => {
    if (confirm('确定要清空所有日志吗？')) {
      await fetch('/api/logs', { method: 'DELETE' });
      setLocalLogs([]);
      setLocalTotal(0);
    }
  };

  // 触发日志刷新
  const handleRefresh = () => {
    if (isRemote && remoteSelectedFile) {
      loadLogs(remoteSelectedFile, 200, search);
    } else if (!isRemote) {
      fetchLocalLogs();
    }
  };

  // 键盘搜索
  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleRefresh();
  };

  const getLevelIcon = (level: string) => {
    switch (level) {
      case 'ERROR': case 'FATAL': return <AlertCircle className="w-4 h-4" />;
      case 'WARN': case 'WARNING': return <AlertTriangle className="w-4 h-4" />;
      case 'DEBUG': case 'TRACE': return <Bug className="w-4 h-4" />;
      default: return <Info className="w-4 h-4" />;
    }
  };

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  };

  // ── 当前显示的数据源 ──
  const logs: Log[] = isRemote ? remoteLogs : localLogs;
  const total: number = isRemote ? remoteTotal : localTotal;
  const loading: boolean = isRemote ? remoteLoading : localLoading;

  // ── 远程文件浏览器 ──
  const renderFileBrowser = () => {
    if (!remoteFiles) return null;
    const { files, dirs, currentPath } = remoteFiles;
    return (
      <div className="glass rounded-xl p-4 mb-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold flex items-center gap-2">
            <FolderOpen className="w-5 h-5 text-accent-500" />
            日志文件
          </h3>
          <button onClick={() => loadFiles()} className="p-2 hover:bg-dark-800 rounded-lg transition-colors">
            <RefreshCw className="w-4 h-4 text-dark-400" />
          </button>
        </div>
        <div className="mb-2 text-sm text-dark-400 font-mono">{currentPath}</div>
        <div className="border border-dark-700 rounded-lg overflow-hidden max-h-64 overflow-y-auto">
          {/* 上级目录 */}
          {currentPath !== '/' && (
            <button onClick={goUp}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-dark-800 transition-colors border-b border-dark-800">
              <ChevronRight className="w-4 h-4 text-dark-500" />
              <span className="text-dark-400">..</span>
            </button>
          )}
          {/* 子目录 */}
          {dirs.map(dir => (
            <button key={dir.path} onClick={() => navigateDir(dir.name)}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-dark-800 transition-colors border-b border-dark-800">
              <FolderOpen className="w-4 h-4 text-blue-400" />
              <span className="text-dark-300">{dir.name}</span>
              <ChevronRight className="w-4 h-4 text-dark-500 ml-auto" />
            </button>
          ))}
          {/* 文件 */}
          {files.map(file => (
            <button key={file.path} onClick={() => { loadLogs(file.path, 200, search); setShowFileBrowser(false); }}
              className={`w-full flex items-center gap-2 px-3 py-2 hover:bg-dark-800 transition-colors border-b border-dark-800 ${
                remoteSelectedFile === file.path ? 'bg-accent-500/10' : ''
              }`}>
              <File className={`w-4 h-4 ${file.isLog ? 'text-green-400' : 'text-dark-500'}`} />
              <span className="text-dark-300 flex-1 text-left truncate">{file.name}</span>
              <span className="text-xs text-dark-500">{(file.size / 1024).toFixed(1)} KB</span>
            </button>
          ))}
          {files.length === 0 && dirs.length === 0 && (
            <div className="px-3 py-8 text-center text-dark-500">目录为空</div>
          )}
        </div>
        {remoteSelectedFile && (
          <div className="mt-2 text-sm text-accent-400 flex items-center gap-2">
            <File className="w-4 h-4" />
            <span className="truncate">{remoteSelectedFile}</span>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-3">
            <FileText className="w-7 h-7 text-accent-500" />
            日志流
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
            <span className="text-xs ml-2">共 {total} 条日志</span>
          </p>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap gap-3">
        {/* Remote file browser toggle */}
        {isRemote && (
          <button
            onClick={() => {
              setShowFileBrowser(!showFileBrowser);
              if (!showFileBrowser) loadFiles();
            }}
            className="px-4 py-2 rounded-lg bg-dark-800 text-dark-300 hover:bg-dark-700 transition-colors flex items-center gap-2"
          >
            <FolderOpen className="w-4 h-4" />
            选择文件
            {remoteSelectedFile && <span className="text-accent-400">✓</span>}
          </button>
        )}
        
        {/* Search */}
        <div className="flex-1 min-w-[200px] max-w-md">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-dark-500" />
            <input
              type="text" value={search} onChange={e => setSearch(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="搜索日志..."
              className="w-full pl-10 pr-4 py-2 bg-dark-900 border border-dark-800 rounded-lg text-dark-200 placeholder-dark-500 focus:outline-none focus:border-accent-500"
            />
          </div>
        </div>

        {/* Level Filter */}
        <div className="relative">
          <select value={levelFilter} onChange={e => setLevelFilter(e.target.value)}
            className="appearance-none px-4 py-2 pr-10 bg-dark-900 border border-dark-800 rounded-lg text-dark-200 focus:outline-none focus:border-accent-500">
            <option value="">所有级别</option>
            {LEVELS.map(level => <option key={level} value={level}>{level}</option>)}
          </select>
          <Filter className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-dark-500 pointer-events-none" />
        </div>

        {/* Refresh */}
        <button onClick={handleRefresh} disabled={loading}
          className="px-4 py-2 rounded-lg bg-dark-800 text-dark-300 hover:bg-dark-700 transition-colors flex items-center gap-2 disabled:opacity-50">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </button>

        {/* Auto Refresh - local only */}
        {!isRemote && (
          <button onClick={() => setAutoRefresh(!autoRefresh)}
            className={`px-4 py-2 rounded-lg transition-colors flex items-center gap-2 ${
              autoRefresh ? 'bg-green-500/20 text-green-400' : 'bg-dark-800 text-dark-300 hover:bg-dark-700'
            }`}>
            <Zap className="w-4 h-4" /> 实时
          </button>
        )}

        {/* Clear - local only */}
        {!isRemote && (
          <button onClick={clearLocalLogs}
            className="px-4 py-2 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors flex items-center gap-2">
            <Trash2 className="w-4 h-4" /> 清空
          </button>
        )}
      </div>

      {/* Remote File Browser */}
      {isRemote && showFileBrowser && renderFileBrowser()}

      {/* Remote hint */}
      {isRemote && !remoteSelectedFile && (
        <div className="glass rounded-xl p-4 bg-blue-500/10 border border-blue-500/20">
          <p className="text-blue-400 text-sm">
            在 Remote 页面或点击"选择文件"按钮，选择要查看的远程日志文件
          </p>
        </div>
      )}

      {/* Log List */}
      <div className="glass rounded-xl overflow-hidden">
        <div className="max-h-[calc(100vh-300px)] overflow-y-auto">
          {loading && logs.length === 0 ? (
            <div className="flex items-center justify-center py-12">
              <RefreshCw className="w-8 h-8 text-accent-500 animate-spin" />
            </div>
          ) : logs.length === 0 ? (
            <div className="text-center py-12 text-dark-500">
              {isRemote && !remoteSelectedFile ? '请选择日志文件' : '暂无日志数据'}
            </div>
          ) : (
            <table className="w-full">
              <tbody className="divide-y divide-dark-800">
                {logs.map((log) => (
                  <tr key={log.id} className="hover:bg-dark-900/50 transition-colors">
                    <td className="px-4 py-2">
                      <div className="flex items-start gap-3">
                        <span className="text-xs text-dark-500 whitespace-nowrap font-mono">
                          {formatTimestamp(log.timestamp)}
                        </span>
                        <span className={`px-2 py-0.5 rounded text-xs font-semibold border flex items-center gap-1 whitespace-nowrap ${
                          LEVEL_COLORS[log.level] || LEVEL_COLORS.INFO
                        }`}>
                          {getLevelIcon(log.level)}
                          {log.level}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-dark-300 font-mono text-sm break-all">{log.message}</p>
                          {log.source && <p className="text-xs text-dark-500 mt-1">{log.source}</p>}
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Load More - for remote */}
      {isRemote && logs.length > 0 && logs.length < total && (
        <div className="text-center">
          <button onClick={handleRefresh} disabled={loading}
            className="px-6 py-2 rounded-lg bg-dark-800 text-dark-300 hover:bg-dark-700 transition-colors">
            加载更多
          </button>
        </div>
      )}
    </div>
  );
}
