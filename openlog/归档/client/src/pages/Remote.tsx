import { useState, useEffect } from 'react';
import { 
  Server, 
  Plus, 
  Trash2, 
  RefreshCw, 
  Folder, 
  FileText, 
  ChevronRight, 
  ChevronLeft,
  Search,
  Terminal,
  Check,
  X,
  AlertCircle,
  Loader,
  HardDrive,
  Cpu,
  MemoryStick,
  Clock,
  Home,
  Eye,
  EyeOff,
  Key
} from 'lucide-react';
import { format } from 'date-fns';
import { useDevice } from '../contexts/DeviceContext';
import ShellTerminal from '../components/ShellTerminal';
import type { RemoteServer, RemoteServerConfig, RemoteFileList, RemoteLogResult, Log } from '../types';

const levelColors: Record<string, string> = {
  ERROR: 'text-red-500 bg-red-500/10',
  FATAL: 'text-red-600 bg-red-600/10',
  WARN: 'text-yellow-500 bg-yellow-500/10',
  WARNING: 'text-yellow-500 bg-yellow-500/10',
  INFO: 'text-blue-400 bg-blue-400/10',
  DEBUG: 'text-purple-400 bg-purple-400/10',
  TRACE: 'text-gray-400 bg-gray-400/10',
};

export default function Remote() {
  const { refreshDevices } = useDevice();
  const [servers, setServers] = useState<RemoteServer[]>([]);
  const [selectedServer, setSelectedServer] = useState<RemoteServer | null>(null);
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  
  // Add/Edit server modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingServer, setEditingServer] = useState<RemoteServer | null>(null);
  const [formData, setFormData] = useState<RemoteServerConfig>({
    name: '',
    host: '',
    port: 22,
    username: 'root',
    password: '',
    logPath: '/var/log',
    watchFiles: '*.log',
  });
  const [showPassword, setShowPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; info?: any; error?: string } | null>(null);
  
  // File browser
  const [fileList, setFileList] = useState<RemoteFileList>({ files: [], dirs: [], currentPath: '' });
  const [currentPath, setCurrentPath] = useState('');
  const [loadingFiles, setLoadingFiles] = useState(false);
  
  // Log viewer
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [logs, setLogs] = useState<Log[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [logSearch, setLogSearch] = useState('');
  const [logLines, setLogLines] = useState(200);
  
  // System stats
  const [systemStats, setSystemStats] = useState<any>(null);
  
  // Shell terminal
  const [showShell, setShowShell] = useState(false);

  // Load servers
  useEffect(() => {
    loadServers();
  }, []);

  const loadServers = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/remote/servers');
      if (!res.ok) {
        console.error('Failed to load servers:', res.status);
        setServers([]);
        return;
      }
      const data = await res.json();
      setServers(data.servers || []);
    } catch (err) {
      console.error('Failed to load servers:', err);
      setServers([]);
    }
    setLoading(false);
  };

  const connectToServer = async (server: RemoteServer) => {
    setConnecting(true);
    try {
      const res = await fetch(`/api/remote/servers/${server.id}/connect`, { method: 'POST' });
      if (!res.ok) {
        alert(`连接失败: HTTP ${res.status}`);
        setConnecting(false);
        return;
      }
      const data = await res.json();
      if (data.success) {
        // Update server status
        setServers(prev => prev.map(s =>
          s.id === server.id ? { ...s, status: 'connected' } : s
        ));
        setSelectedServer({ ...server, status: 'connected' });
        // Refresh device list for global selector
        refreshDevices();
        // Load files
        loadFiles(server.id, server.logPath);
        // Load stats
        loadStats(server.id);
      } else {
        alert('连接失败: ' + data.error);
      }
    } catch (err: any) {
      alert('连接失败: ' + err.message);
    }
    setConnecting(false);
  };

  const disconnectServer = async (server: RemoteServer) => {
    try {
      const res = await fetch(`/api/remote/servers/${server.id}/disconnect`, { method: 'POST' });
      if (!res.ok) {
        console.error('Disconnect failed:', res.status);
        return;
      }
      setServers(prev => prev.map(s =>
        s.id === server.id ? { ...s, status: 'disconnected' } : s
      ));
      if (selectedServer?.id === server.id) {
        setSelectedServer({ ...server, status: 'disconnected' });
        setFileList({ files: [], dirs: [], currentPath: '' });
        setSelectedFile(null);
        setLogs([]);
      }
      // Refresh device list for global selector
      refreshDevices();
    } catch (err) {
      console.error('Disconnect failed:', err);
    }
  };

  const loadFiles = async (serverId: string, path: string) => {
    setLoadingFiles(true);
    try {
      const res = await fetch(`/api/remote/servers/${serverId}/files?path=${encodeURIComponent(path)}`);
      if (!res.ok) {
        console.error('Files request failed:', res.status);
        setFileList({ files: [], dirs: [], currentPath: '', error: '加载失败' });
        return;
      }
      const data = await res.json();
      setFileList(data);
      setCurrentPath(data.currentPath);
    } catch (err) {
      console.error('Failed to load files:', err);
      setFileList({ files: [], dirs: [], currentPath: '', error: '加载失败' });
    }
    setLoadingFiles(false);
  };

  const loadLogs = async (serverId: string, filePath: string) => {
    setLoadingLogs(true);
    setSelectedFile(filePath);
    try {
      const params = new URLSearchParams({
        file: filePath,
        lines: String(logLines),
      });
      if (logSearch) {
        params.append('search', logSearch);
      }
      
      const res = await fetch(`/api/remote/servers/${serverId}/logs?${params}`);
      if (!res.ok) {
        console.error('Logs request failed:', res.status);
        setLogs([]);
        return;
      }
      const data: RemoteLogResult = await res.json();
      setLogs(data.logs || []);
    } catch (err) {
      console.error('Failed to load logs:', err);
      setLogs([]);
    }
    setLoadingLogs(false);
  };

  const loadStats = async (serverId: string) => {
    try {
      const res = await fetch(`/api/remote/servers/${serverId}/stats`);
      if (!res.ok) {
        console.error('Stats request failed:', res.status);
        setSystemStats(null);
        return;
      }
      const data = await res.json();
      setSystemStats(data);
    } catch (err) {
      console.error('Failed to load stats:', err);
      setSystemStats(null);
    }
  };

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/remote/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      if (!res.ok) {
        setTestResult({ success: false, error: `HTTP ${res.status}` });
        setTesting(false);
        return;
      }
      const data = await res.json();
      setTestResult(data);
    } catch (err: any) {
      setTestResult({ success: false, error: err.message });
    }
    setTesting(false);
  };

  const saveServer = async () => {
    try {
      const url = editingServer
        ? `/api/remote/servers/${editingServer.id}`
        : '/api/remote/servers';
      const method = editingServer ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      if (!res.ok) {
        console.error('Save failed:', res.status);
        alert(`保存失败: HTTP ${res.status}`);
        return;
      }

      const data = await res.json();

      if (data.success) {
        await loadServers();
        setShowAddModal(false);
        resetForm();
      }
    } catch (err) {
      console.error('Save failed:', err);
      alert('保存失败: ' + (err as Error).message);
    }
  };

  const deleteServer = async (server: RemoteServer) => {
    if (!confirm(`确定删除服务器 "${server.name}"?`)) return;

    try {
      const res = await fetch(`/api/remote/servers/${server.id}`, { method: 'DELETE' });
      if (!res.ok) {
        alert(`删除失败: HTTP ${res.status}`);
        return;
      }
      setServers(prev => prev.filter(s => s.id !== server.id));
      if (selectedServer?.id === server.id) {
        setSelectedServer(null);
      }
    } catch (err) {
      console.error('Delete failed:', err);
      alert('删除失败: ' + (err as Error).message);
    }
  };

  const resetForm = () => {
    setFormData({
      name: '',
      host: '',
      port: 22,
      username: 'root',
      password: '',
      logPath: '/var/log',
      watchFiles: '*.log',
    });
    setEditingServer(null);
    setTestResult(null);
    setShowPassword(false);
  };

  const openEditModal = (server: RemoteServer) => {
    setEditingServer(server);
    setFormData({
      name: server.name,
      host: server.host,
      port: server.port,
      username: server.username,
      logPath: server.logPath,
      watchFiles: server.watchFiles,
    });
    setShowAddModal(true);
  };

  const navigateDir = (dir?: string) => {
    if (!selectedServer) return;
    const newPath = dir 
      ? (currentPath === '/' ? `/${dir}` : `${currentPath}/${dir}`)
      : selectedServer.logPath;
    loadFiles(selectedServer.id, newPath);
    setSelectedFile(null);
    setLogs([]);
  };

  const goUp = () => {
    if (!selectedServer || currentPath === '/') return;
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    const newPath = '/' + parts.join('/');
    loadFiles(selectedServer.id, newPath || '/');
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  };

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-3">
            <Server className="w-7 h-7 text-accent-500" />
            远程服务器
          </h1>
          <p className="text-dark-400">管理远程服务器日志</p>
        </div>
        <button
          onClick={() => { resetForm(); setShowAddModal(true); }}
          className="px-4 py-2 rounded-lg bg-gradient-to-r from-accent-600 to-accent-500 hover:from-accent-500 hover:to-accent-400 transition-all flex items-center gap-2"
        >
          <Plus className="w-5 h-5" />
          添加服务器
        </button>
      </div>

      <div className="grid grid-cols-12 gap-4">
        {/* Server List */}
        <div className="col-span-3 space-y-2">
          <h2 className="text-sm font-medium text-dark-400 px-2">服务器列表</h2>
          
          {loading ? (
            <div className="glass rounded-xl p-4 flex items-center justify-center">
              <Loader className="w-5 h-5 animate-spin text-accent-500" />
            </div>
          ) : servers.length === 0 ? (
            <div className="glass rounded-xl p-4 text-center text-dark-500">
              <Server className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">暂无服务器</p>
              <p className="text-xs mt-1">点击右上角添加</p>
            </div>
          ) : (
            servers.map(server => (
              <div
                key={server.id}
                className={`glass rounded-xl p-3 cursor-pointer transition-all ${
                  selectedServer?.id === server.id 
                    ? 'ring-2 ring-accent-500 bg-accent-500/10' 
                    : 'hover:bg-dark-800/50'
                }`}
                onClick={() => setSelectedServer(server)}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-medium truncate">{server.name}</span>
                  <span className={`w-2 h-2 rounded-full ${
                    server.status === 'connected' ? 'bg-green-500' :
                    server.status === 'error' ? 'bg-red-500' : 'bg-dark-500'
                  }`} />
                </div>
                <div className="text-xs text-dark-400 truncate">{server.host}:{server.port}</div>
                <div className="text-xs text-dark-500 truncate mt-1">
                  {server.logPath}
                </div>
                
                {/* Actions */}
                <div className="flex items-center gap-1 mt-2">
                  {server.status === 'connected' ? (
                    <button
                      onClick={(e) => { e.stopPropagation(); disconnectServer(server); }}
                      className="flex-1 px-2 py-1 text-xs rounded bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30"
                    >
                      断开
                    </button>
                  ) : (
                    <button
                      onClick={(e) => { e.stopPropagation(); connectToServer(server); }}
                      disabled={connecting}
                      className="flex-1 px-2 py-1 text-xs rounded bg-green-500/20 text-green-400 hover:bg-green-500/30"
                    >
                      连接
                    </button>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); openEditModal(server); }}
                    className="px-2 py-1 text-xs rounded bg-dark-700 text-dark-300 hover:bg-dark-600"
                  >
                    编辑
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteServer(server); }}
                    className="px-2 py-1 text-xs rounded bg-red-500/20 text-red-400 hover:bg-red-500/30"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* File Browser & Log Viewer */}
        <div className="col-span-9 space-y-4">
          {!selectedServer ? (
            <div className="glass rounded-xl p-12 text-center text-dark-500">
              <Server className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p>选择一个服务器查看日志</p>
            </div>
          ) : selectedServer.status !== 'connected' ? (
            <div className="glass rounded-xl p-12 text-center text-dark-500">
              <AlertCircle className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p>服务器未连接</p>
              <button
                onClick={() => connectToServer(selectedServer)}
                disabled={connecting}
                className="mt-3 px-4 py-2 rounded-lg bg-green-500/20 text-green-400 hover:bg-green-500/30"
              >
                {connecting ? '连接中...' : '连接'}
              </button>
            </div>
          ) : (
            <>
              {/* System Stats */}
              {systemStats && (
                <div className="grid grid-cols-4 gap-2">
                  <div className="glass rounded-lg p-3">
                    <div className="flex items-center gap-2 text-dark-400 text-xs mb-1">
                      <Cpu className="w-3 h-3" />
                      CPU
                    </div>
                    <div className="text-sm font-medium">{systemStats.cpu || 'N/A'}</div>
                  </div>
                  <div className="glass rounded-lg p-3">
                    <div className="flex items-center gap-2 text-dark-400 text-xs mb-1">
                      <MemoryStick className="w-3 h-3" />
                      内存
                    </div>
                    <div className="text-sm font-medium">{systemStats.mem || 'N/A'}</div>
                  </div>
                  <div className="glass rounded-lg p-3">
                    <div className="flex items-center gap-2 text-dark-400 text-xs mb-1">
                      <HardDrive className="w-3 h-3" />
                      磁盘
                    </div>
                    <div className="text-sm font-medium">{systemStats.disk || 'N/A'}</div>
                  </div>
                  <div className="glass rounded-lg p-3">
                    <div className="flex items-center gap-2 text-dark-400 text-xs mb-1">
                      <Clock className="w-3 h-3" />
                      运行时间
                    </div>
                    <div className="text-sm font-medium">{systemStats.uptime || 'N/A'}</div>
                  </div>
                </div>
              )}
              
              {/* Shell Terminal Button */}
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => setShowShell(true)}
                  className="px-4 py-2 rounded-lg bg-gradient-to-r from-green-600 to-green-500 hover:from-green-500 hover:to-green-400 transition-all flex items-center gap-2 text-sm"
                >
                  <Terminal className="w-4 h-4" />
                  打开 Shell 终端
                </button>
              </div>

              {/* File Browser */}
              <div className="glass rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={goUp}
                      disabled={currentPath === '/'}
                      className="p-1.5 rounded hover:bg-dark-700 disabled:opacity-30"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => navigateDir()}
                      className="p-1.5 rounded hover:bg-dark-700"
                      title="返回根目录"
                    >
                      <Home className="w-4 h-4" />
                    </button>
                    <span className="text-sm text-dark-400 font-mono">{currentPath}</span>
                  </div>
                  <button
                    onClick={() => loadFiles(selectedServer.id, currentPath || selectedServer.logPath)}
                    disabled={loadingFiles}
                    className="p-1.5 rounded hover:bg-dark-700"
                  >
                    <RefreshCw className={`w-4 h-4 ${loadingFiles ? 'animate-spin' : ''}`} />
                  </button>
                </div>

                {fileList.error ? (
                  <div className="text-red-400 text-sm p-4">{fileList.error}</div>
                ) : (
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 max-h-48 overflow-y-auto">
                    {/* Directories */}
                    {fileList.dirs.map(dir => (
                      <button
                        key={dir.path}
                        onClick={() => navigateDir(dir.name)}
                        className="p-2 rounded-lg bg-dark-800 hover:bg-dark-700 text-left flex items-center gap-2"
                      >
                        <Folder className="w-4 h-4 text-yellow-400 flex-shrink-0" />
                        <span className="text-sm truncate">{dir.name}</span>
                        <ChevronRight className="w-3 h-3 text-dark-500 ml-auto flex-shrink-0" />
                      </button>
                    ))}
                    
                    {/* Files */}
                    {fileList.files.map(file => (
                      <button
                        key={file.path}
                        onClick={() => loadLogs(selectedServer.id, file.path)}
                        className={`p-2 rounded-lg text-left flex items-center gap-2 ${
                          selectedFile === file.path
                            ? 'bg-accent-500/20 ring-1 ring-accent-500/50'
                            : 'bg-dark-800 hover:bg-dark-700'
                        }`}
                      >
                        <FileText className={`w-4 h-4 flex-shrink-0 ${file.isLog ? 'text-green-400' : 'text-dark-400'}`} />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm truncate">{file.name}</div>
                          <div className="text-xs text-dark-500">{formatSize(file.size)}</div>
                        </div>
                      </button>
                    ))}
                    
                    {fileList.files.length === 0 && fileList.dirs.length === 0 && (
                      <div className="col-span-full text-center text-dark-500 py-4">
                        目录为空
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Log Viewer */}
              {selectedFile && (
                <div className="glass rounded-xl overflow-hidden">
                  {/* Log Header */}
                  <div className="p-3 border-b border-dark-800 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <FileText className="w-4 h-4 text-green-400" />
                      <span className="text-sm font-mono">{selectedFile.split('/').pop()}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <select
                        value={logLines}
                        onChange={(e) => setLogLines(Number(e.target.value))}
                        className="px-2 py-1 rounded bg-dark-800 text-sm border border-dark-700"
                      >
                        <option value={100}>100 行</option>
                        <option value={200}>200 行</option>
                        <option value={500}>500 行</option>
                        <option value={1000}>1000 行</option>
                      </select>
                      <div className="relative">
                        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-dark-500" />
                        <input
                          type="text"
                          placeholder="搜索..."
                          value={logSearch}
                          onChange={(e) => setLogSearch(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && loadLogs(selectedServer.id, selectedFile)}
                          className="pl-7 pr-2 py-1 rounded bg-dark-800 text-sm border border-dark-700 w-40"
                        />
                      </div>
                      <button
                        onClick={() => loadLogs(selectedServer.id, selectedFile)}
                        disabled={loadingLogs}
                        className="px-2 py-1 rounded bg-dark-700 hover:bg-dark-600 text-sm"
                      >
                        {loadingLogs ? <Loader className="w-4 h-4 animate-spin" /> : '刷新'}
                      </button>
                    </div>
                  </div>

                  {/* Log Content */}
                  <div className="max-h-[400px] overflow-y-auto">
                    {loadingLogs ? (
                      <div className="flex items-center justify-center py-12">
                        <Loader className="w-6 h-6 animate-spin text-accent-500" />
                      </div>
                    ) : logs.length === 0 ? (
                      <div className="text-center text-dark-500 py-12">
                        无日志数据
                      </div>
                    ) : (
                      <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-dark-900/95">
                          <tr className="text-left text-xs text-dark-400">
                            <th className="px-3 py-2 font-medium w-32">时间</th>
                            <th className="px-3 py-2 font-medium w-20">级别</th>
                            <th className="px-3 py-2 font-medium">消息</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-dark-800/50">
                          {logs.map((log) => (
                            <tr key={log.id} className="hover:bg-dark-800/30 font-mono">
                              <td className="px-3 py-1.5 text-dark-500 whitespace-nowrap text-xs">
                                {log.timestamp.substring(11, 23)}
                              </td>
                              <td className="px-3 py-1.5">
                                <span className={`px-1.5 py-0.5 rounded text-xs ${
                                  levelColors[log.level] || 'bg-dark-700 text-dark-300'
                                }`}>
                                  {log.level}
                                </span>
                              </td>
                              <td className="px-3 py-1.5 text-dark-300 break-all">
                                {log.message}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Add/Edit Server Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="glass rounded-2xl p-6 w-full max-w-md animate-scale-in">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Server className="w-5 h-5 text-accent-500" />
              {editingServer ? '编辑服务器' : '添加服务器'}
            </h2>

            <div className="space-y-3">
              <div>
                <label className="block text-sm text-dark-400 mb-1">名称</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="我的服务器"
                  className="w-full px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm focus:border-accent-500 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <label className="block text-sm text-dark-400 mb-1">主机地址</label>
                  <input
                    type="text"
                    value={formData.host}
                    onChange={(e) => setFormData({ ...formData, host: e.target.value })}
                    placeholder="192.168.1.100"
                    className="w-full px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm focus:border-accent-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm text-dark-400 mb-1">端口</label>
                  <input
                    type="number"
                    value={formData.port}
                    onChange={(e) => setFormData({ ...formData, port: Number(e.target.value) })}
                    className="w-full px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm focus:border-accent-500 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm text-dark-400 mb-1">用户名</label>
                <input
                  type="text"
                  value={formData.username}
                  onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                  placeholder="root"
                  className="w-full px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm focus:border-accent-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-sm text-dark-400 mb-1">密码</label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={formData.password}
                    onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                    placeholder="SSH 密码"
                    className="w-full px-3 py-2 pr-10 bg-dark-900 border border-dark-700 rounded-lg text-sm focus:border-accent-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-dark-500 hover:text-dark-300"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-sm text-dark-400 mb-1">日志目录</label>
                  <input
                    type="text"
                    value={formData.logPath}
                    onChange={(e) => setFormData({ ...formData, logPath: e.target.value })}
                    placeholder="/var/log"
                    className="w-full px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm focus:border-accent-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm text-dark-400 mb-1">文件匹配</label>
                  <input
                    type="text"
                    value={formData.watchFiles}
                    onChange={(e) => setFormData({ ...formData, watchFiles: e.target.value })}
                    placeholder="*.log"
                    className="w-full px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm focus:border-accent-500 focus:outline-none"
                  />
                </div>
              </div>

              {/* Test Connection */}
              <div className="flex items-center gap-2">
                <button
                  onClick={testConnection}
                  disabled={testing || !formData.host}
                  className="flex-1 px-3 py-2 rounded-lg bg-dark-700 hover:bg-dark-600 text-sm flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {testing ? (
                    <><Loader className="w-4 h-4 animate-spin" /> 测试中...</>
                  ) : (
                    <><Terminal className="w-4 h-4" /> 测试连接</>
                  )}
                </button>
                
                {testResult && (
                  <span className={`text-sm ${testResult.success ? 'text-green-400' : 'text-red-400'}`}>
                    {testResult.success ? <Check className="w-4 h-4" /> : <X className="w-4 h-4" />}
                  </span>
                )}
              </div>

              {testResult?.success && testResult.info && (
                <div className="text-xs text-dark-400 bg-dark-800 rounded p-2">
                  <div className="truncate">{testResult.info.system}</div>
                </div>
              )}

              {testResult?.error && (
                <div className="text-xs text-red-400 bg-red-500/10 rounded p-2">
                  {testResult.error}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => { setShowAddModal(false); resetForm(); }}
                className="px-4 py-2 rounded-lg bg-dark-700 hover:bg-dark-600 text-sm"
              >
                取消
              </button>
              <button
                onClick={saveServer}
                disabled={!formData.host}
                className="px-4 py-2 rounded-lg bg-gradient-to-r from-accent-600 to-accent-500 hover:from-accent-500 hover:to-accent-400 text-sm disabled:opacity-50"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* Shell Terminal Modal */}
      {showShell && selectedServer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-5xl h-[600px] mx-4">
            <ShellTerminal 
              server={selectedServer}
              onClose={() => setShowShell(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
