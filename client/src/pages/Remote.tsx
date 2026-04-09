/**
 * Remote.tsx — 远程服务器管理（优化版）
 * - RemoteContext 全局状态，切换页面不丢失连接
 * - 文件编辑器（点击远程文件 → 页面内编辑 → Ctrl+S 保存）
 * - 拖拽上传文件到远程服务器
 * - Shell 终端优化（快捷键提示 + 拖拽上传区）
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Server, Plus, Trash2, RefreshCw, Folder, FileText, ChevronRight,
  ChevronLeft, Search, Terminal, Check, X, AlertCircle, Loader,
  Cpu, MemoryStick, HardDrive, Clock, Home, Eye, EyeOff, Upload,
  Code2, Save, Pencil, Wifi, WifiOff, Layers, PanelLeftClose,
  PanelLeftOpen, ArrowUp, FileCode, Download, Info,
} from 'lucide-react';
import { useRemote } from '../contexts/RemoteContext';
import ShellTerminal from '../components/ShellTerminal';
import type { RemoteServer, RemoteServerConfig, RemoteServerState, RemoteFile, RemoteDir } from '../types';

const levelColors: Record<string, string> = {
  ERROR: 'text-red-400 bg-red-500/10 border border-red-500/20',
  FATAL: 'text-red-500 bg-red-600/10 border border-red-500/20',
  WARN: 'text-yellow-400 bg-yellow-500/10 border border-yellow-500/20',
  WARNING: 'text-yellow-400 bg-yellow-500/10 border border-yellow-500/20',
  INFO: 'text-blue-400 bg-blue-500/10 border border-blue-500/20',
  DEBUG: 'text-purple-400 bg-purple-500/10 border border-purple-500/20',
  TRACE: 'text-gray-400 bg-gray-500/10 border border-gray-500/20',
};

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// Toast 通知组件
function Toast({ toast, onClose }: { toast: NonNullable<ReturnType<typeof useRemote>['toast']>; onClose: () => void }) {
  const colors = {
    success: 'border-green-500/40 bg-green-500/10',
    error: 'border-red-500/40 bg-red-500/10',
    info: 'border-accent-500/40 bg-accent-500/10',
  };
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  return (
    <div className={`fixed top-4 right-4 z-50 glass rounded-xl border ${colors[toast.type]} px-4 py-3 animate-scale-in flex items-center gap-3 max-w-sm`}>
      <span>{icons[toast.type]}</span>
      <span className="text-sm text-dark-200 flex-1">{toast.message}</span>
      <button onClick={onClose} className="p-1 hover:bg-dark-700 rounded text-dark-400"><X className="w-4 h-4" /></button>
    </div>
  );
}

// 添加/编辑服务器弹窗
function ServerModal({
  editingServer, onSave, onTest, onClose, formData, setFormData, testResult, testing,
}: {
  editingServer: RemoteServer | null;
  onSave: () => void; onTest: () => void; onClose: () => void;
  formData: RemoteServerConfig;
  setFormData: (d: RemoteServerConfig) => void;
  testResult: { success: boolean; info?: any; error?: string } | null;
  testing: boolean;
}) {
  const [showPw, setShowPw] = useState(false);
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="glass rounded-2xl p-6 w-full max-w-md animate-scale-in" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-5 flex items-center gap-2">
          <Server className="w-5 h-5 text-accent-500" />
          {editingServer ? '编辑服务器' : '添加服务器'}
        </h2>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-dark-400 mb-1">名称</label>
            <input type="text" value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })}
              placeholder="我的服务器" className="w-full px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm focus:border-accent-500 focus:outline-none" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2">
              <label className="block text-xs text-dark-400 mb-1">主机地址</label>
              <input type="text" value={formData.host} onChange={e => setFormData({ ...formData, host: e.target.value })}
                placeholder="192.168.1.100" className="w-full px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm focus:border-accent-500 focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs text-dark-400 mb-1">端口</label>
              <input type="number" value={formData.port} onChange={e => setFormData({ ...formData, port: Number(e.target.value) })}
                className="w-full px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm focus:border-accent-500 focus:outline-none" />
            </div>
          </div>
          <div>
            <label className="block text-xs text-dark-400 mb-1">用户名</label>
            <input type="text" value={formData.username} onChange={e => setFormData({ ...formData, username: e.target.value })}
              placeholder="root" className="w-full px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm focus:border-accent-500 focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs text-dark-400 mb-1">密码</label>
            <div className="relative">
              <input type={showPw ? 'text' : 'password'} value={formData.password} onChange={e => setFormData({ ...formData, password: e.target.value })}
                placeholder="SSH 密码" className="w-full px-3 py-2 pr-10 bg-dark-900 border border-dark-700 rounded-lg text-sm focus:border-accent-500 focus:outline-none" />
              <button type="button" onClick={() => setShowPw(v => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-dark-500 hover:text-dark-300">
                {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-dark-400 mb-1">日志目录</label>
              <input type="text" value={formData.logPath} onChange={e => setFormData({ ...formData, logPath: e.target.value })}
                placeholder="/var/log" className="w-full px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm focus:border-accent-500 focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs text-dark-400 mb-1">文件匹配</label>
              <input type="text" value={formData.watchFiles} onChange={e => setFormData({ ...formData, watchFiles: e.target.value })}
                placeholder="*.log" className="w-full px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm focus:border-accent-500 focus:outline-none" />
            </div>
          </div>
          {/* 测试连接 */}
          <button onClick={onTest} disabled={testing || !formData.host}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-dark-700 hover:bg-dark-600 text-sm disabled:opacity-50 transition-colors">
            {testing ? <><Loader className="w-4 h-4 animate-spin" /> 测试中...</> : <><Terminal className="w-4 h-4" /> 测试连接</>}
          </button>
          {testResult?.success && <div className="text-xs text-green-400 bg-green-500/10 rounded p-2 truncate">{testResult.info?.system}</div>}
          {testResult?.error && <div className="text-xs text-red-400 bg-red-500/10 rounded p-2">{testResult.error}</div>}
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-dark-700 hover:bg-dark-600 text-sm transition-colors">取消</button>
          <button onClick={onSave} disabled={!formData.host} className="px-4 py-2 rounded-lg bg-gradient-to-r from-accent-600 to-accent-500 hover:from-accent-500 hover:to-accent-400 text-sm disabled:opacity-50 transition-all">
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

// 文件编辑器组件
function FileEditor({
  content, onChange, onSave, onClose, filePath, modified,
}: {
  content: string; onChange: (s: string) => void;
  onSave: () => Promise<{ success: boolean; error?: string }>; onClose: () => void;
  filePath: string | null; modified: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const [lineCount, setLineCount] = useState(1);

  useEffect(() => { setLineCount((content.match(/\n/g) || []).length + 1); }, [content]);

  const handleSave = async () => {
    setSaving(true);
    await onSave();
    setSaving(false);
  };

  return (
    <div className="flex flex-col h-full border border-dark-700 rounded-xl overflow-hidden bg-dark-950">
      {/* 编辑器顶栏 */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-dark-900 border-b border-dark-700">
        <div className="flex items-center gap-3">
          <FileCode className="w-4 h-4 text-accent-400" />
          <span className="text-sm font-mono text-dark-300">{filePath?.split('/').pop()}</span>
          {modified && <span className="text-xs text-yellow-400 bg-yellow-500/10 px-1.5 py-0.5 rounded">已修改</span>}
          <span className="text-xs text-dark-600">{lineCount} 行</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleSave} disabled={saving || !modified}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent-500/20 text-accent-400 text-xs hover:bg-accent-500/30 disabled:opacity-40 transition-colors">
            {saving ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            保存 {modified && '•'}
          </button>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-dark-700 text-dark-500 hover:text-dark-300 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
      {/* 编辑器主体 */}
      <textarea
        value={content}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); if (!saving && modified) handleSave(); }
          // Tab 插入空格
          if (e.key === 'Tab') { e.preventDefault(); const el = e.currentTarget; const s = el.selectionStart; const end = el.selectionEnd; onChange(content.slice(0, s) + '  ' + content.slice(end)); setTimeout(() => { el.selectionStart = el.selectionEnd = s + 2; }, 0); }
        }}
        spellCheck={false}
        className="flex-1 w-full px-6 py-4 bg-dark-950 text-sm text-dark-200 font-mono leading-relaxed resize-none focus:outline-none min-h-0"
        style={{ tabSize: 2 }}
      />
      {/* 底部状态栏 */}
      <div className="flex items-center gap-4 px-4 py-1.5 bg-dark-900 border-t border-dark-700 text-xs text-dark-600">
        <span>UTF-8</span>
        <span>LF</span>
        <span>{filePath}</span>
        <span className="ml-auto">Ctrl+S 保存</span>
      </div>
    </div>
  );
}

// 主组件
export default function Remote() {
  const {
    servers, activeServer, setActiveServer, connect, disconnect, refreshServers,
    loadFiles, navigateDir, goUp,
    loadLogs, openInEditor, updateFileContent, saveFile, closeEditor,
    uploadFile, toast, clearToast,
  } = useRemote();


  // 本地 UI 状态
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingServer, setEditingServer] = useState<RemoteServer | null>(null);
  const [formData, setFormData] = useState<RemoteServerConfig>({
    name: '', host: '', port: 22, username: 'root', password: '',
    logPath: '/var/log', watchFiles: '*.log',
  });
  const [showPw, setShowPw] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; info?: any; error?: string } | null>(null);
  const [showShell, setShowShell] = useState(false);
  const [logLines, setLogLines] = useState(200);
  const [logSearch, setLogSearch] = useState('');
  const [showServerList, setShowServerList] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<'files' | 'editor'>('files');

  // 加载文件（首次连接时）
  useEffect(() => {
    if (activeServer && activeServer.status === 'connected' && activeServer.files.currentPath) {
      loadFiles(activeServer.logPath || '/var/log');
      // 同时获取系统状态
      fetchStats();
    }
  }, [activeServer?.id]);

  // 获取系统状态
  const fetchStats = async () => {
    if (!activeServer) return;
    try {
      const res = await fetch(`/api/remote/servers/${activeServer.id}/stats`);
      if (res.ok) {
        const data = await res.json();
        // 更新到全局状态（暂时用日志刷新触发）
      }
    } catch {}
  };

  // 测试连接
  const testConn = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/remote/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      setTestResult(await res.json());
    } catch (e: any) { setTestResult({ success: false, error: e.message }); }
    setTesting(false);
  };

  // 保存服务器
  const saveServer = async () => {
    try {
      const url = editingServer ? `/api/remote/servers/${editingServer.id}` : '/api/remote/servers';
      const method = editingServer ? 'PUT' : 'POST';
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(formData) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.success) {
        await refreshServers();
        setShowAddModal(false);
        resetForm();
      }
    } catch (e: any) { alert('保存失败: ' + e.message); }
  };

  // 删除服务器
  const deleteServer = async (server: RemoteServer) => {
    if (!confirm(`确定删除 "${server.name}"？`)) return;
    await fetch(`/api/remote/servers/${server.id}`, { method: 'DELETE' });
    await refreshServers();
    if (activeServer?.id === server.id) disconnect();
  };

  // 打开编辑弹窗
  const openEdit = (server: RemoteServer) => {
    setEditingServer(server);
    setFormData({ name: server.name, host: server.host, port: server.port, username: server.username, password: '', logPath: server.logPath, watchFiles: server.watchFiles });
    setShowAddModal(true);
  };

  const resetForm = () => {
    setFormData({ name: '', host: '', port: 22, username: 'root', password: '', logPath: '/var/log', watchFiles: '*.log' });
    setEditingServer(null);
    setTestResult(null);
    setShowPw(false);
  };

  // 处理文件上传
  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0 || !activeServer) return;
    for (const file of Array.from(files)) {
      await uploadFile(file, activeServer.files.currentPath || '/tmp');
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer.files);
  };

  // 连接：先设置 activeServer，再加载文件
  const handleConnect = async (server: RemoteServer) => {
    const newServer: RemoteServerState = {
      ...server,
      status: 'connected' as const,
      systemStats: null,
      files: { files: [], dirs: [], currentPath: server.logPath || '/var/log' },
      selectedFile: null,
      fileContent: '',
      fileModified: false,
      logs: [],
      logsLoading: false,
      filesLoading: true,
      editingFilePath: null,
    };
    setActiveServer(newServer);
    try {
      await connect(server);
      await loadFiles(server.logPath || '/var/log');
    } catch {
      // connect 内部已经处理了 toast
    }
  };

  const stats = activeServer?.systemStats;

  return (
    <div className="flex h-[calc(100vh-8rem)] animate-fade-in gap-4">

      {/* Toast 通知 */}
      {toast && <Toast toast={toast} onClose={clearToast} />}

      {/* ===== 左侧：服务器列表 ===== */}
      {showServerList && (
        <div className="w-72 flex-shrink-0 flex flex-col gap-3">
          {/* Header */}
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-dark-400 px-1">服务器</h2>
            <div className="flex items-center gap-1">
              <button onClick={() => refreshServers()} className="p-1.5 rounded-lg hover:bg-dark-800 text-dark-500 hover:text-dark-300 transition-colors" title="刷新">
                <RefreshCw className="w-4 h-4" />
              </button>
              <button onClick={() => { resetForm(); setShowAddModal(true); }} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent-500/20 text-accent-400 text-xs hover:bg-accent-500/30 transition-colors">
                <Plus className="w-3.5 h-3.5" /> 添加
              </button>
            </div>
          </div>

          {/* 服务器列表 */}
          <div className="flex-1 overflow-y-auto flex flex-col gap-2">
            {servers.length === 0 ? (
              <div className="glass rounded-xl p-6 text-center text-dark-500 flex-1 flex flex-col items-center justify-center">
                <Server className="w-10 h-10 opacity-30 mb-3" />
                <p className="text-sm">暂无服务器</p>
                <p className="text-xs mt-1 text-dark-600">点击右上角添加</p>
              </div>
            ) : servers.map(server => (
              <div key={server.id} className={`glass rounded-xl p-3 transition-all ${activeServer?.id === server.id ? 'ring-2 ring-accent-500/60 bg-accent-500/5' : ''}`}>
                {/* 服务器基本信息 */}
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${server.status === 'connected' ? 'bg-green-500' : server.status === 'error' ? 'bg-red-500' : 'bg-dark-600'}`} />
                    <span className="text-sm font-medium truncate">{server.name}</span>
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => openEdit(server)} className="p-1 rounded hover:bg-dark-700 text-dark-500 hover:text-dark-300">
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => deleteServer(server)} className="p-1 rounded hover:bg-red-500/20 text-dark-500 hover:text-red-400">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <div className="text-xs text-dark-500 font-mono mb-2 truncate">{server.host}:{server.port}</div>
                <div className="text-xs text-dark-600 truncate mb-3">{server.logPath}</div>

                {/* 操作按钮 */}
                {server.status === 'connected' ? (
                  <div className="flex gap-1">
                    <button onClick={() => disconnect()} className="flex-1 px-2 py-1.5 text-xs rounded bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 transition-colors flex items-center justify-center gap-1">
                      <WifiOff className="w-3 h-3" /> 断开
                    </button>
                    <button onClick={() => setShowShell(true)} className="flex-1 px-2 py-1.5 text-xs rounded bg-green-500/20 text-green-400 hover:bg-green-500/30 transition-colors flex items-center justify-center gap-1">
                      <Terminal className="w-3 h-3" /> Shell
                    </button>
                  </div>
                ) : (
                  <button onClick={() => handleConnect(server)} className="w-full px-2 py-1.5 text-xs rounded bg-green-500/20 text-green-400 hover:bg-green-500/30 transition-colors flex items-center justify-center gap-1">
                    <Wifi className="w-3 h-3" /> 连接
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 折叠按钮 */}
      <button onClick={() => setShowServerList(v => !v)}
        className="self-start p-1.5 rounded-lg hover:bg-dark-800 text-dark-500 hover:text-dark-300 transition-colors flex-shrink-0 mt-6"
        title={showServerList ? '隐藏服务器列表' : '显示服务器列表'}>
        {showServerList ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
      </button>

      {/* ===== 主区：文件浏览器 / 编辑器 ===== */}
      <div className="flex flex-col flex-1 min-w-0 gap-3">

        {/* 未连接提示 */}
        {!activeServer ? (
          <div className="flex-1 glass rounded-xl flex flex-col items-center justify-center text-dark-500">
            <Server className="w-16 h-16 opacity-20 mb-4" />
            <p className="text-lg font-medium mb-1">未连接任何服务器</p>
            <p className="text-sm text-dark-600 mb-4">从左侧选择一个服务器并连接</p>
            <button onClick={() => setShowServerList(true)} className="px-4 py-2 rounded-lg bg-accent-500/20 text-accent-400 text-sm hover:bg-accent-500/30 transition-colors flex items-center gap-2">
              <PanelLeftOpen className="w-4 h-4" /> 显示服务器列表
            </button>
          </div>
        ) : (
          <>
            {/* 系统状态栏 */}
            <div className="grid grid-cols-4 gap-2">
              {[
                { icon: <Cpu className="w-4 h-4" />, label: 'CPU', value: activeServer.systemStats?.cpu || '–' },
                { icon: <MemoryStick className="w-4 h-4" />, label: '内存', value: activeServer.systemStats?.mem || '–' },
                { icon: <HardDrive className="w-4 h-4" />, label: '磁盘', value: activeServer.systemStats?.disk || '–' },
                { icon: <Clock className="w-4 h-4" />, label: '运行时间', value: activeServer.systemStats?.uptime || '–' },
              ].map((stat, i) => (
                <div key={i} className="glass rounded-lg p-3 flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-accent-500/10 text-accent-400">{stat.icon}</div>
                  <div>
                    <div className="text-xs text-dark-500">{stat.label}</div>
                    <div className="text-sm font-medium text-dark-200 truncate">{stat.value}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Tab 切换：文件 / 编辑器 */}
            {activeServer.editingFilePath ? (
              /* 文件编辑器模式 */
              <FileEditor
                content={activeServer.fileContent}
                onChange={updateFileContent}
                onSave={saveFile}
                onClose={closeEditor}
                filePath={activeServer.editingFilePath}
                modified={activeServer.fileModified}
              />
            ) : (
              /* 文件浏览器模式 */
              <>
                {/* 顶部工具栏 */}
                <div className="flex items-center gap-3">
                  {/* 路径导航 */}
                  <div className="flex items-center gap-1 flex-1 min-w-0 bg-dark-900 border border-dark-800 rounded-lg px-3 py-2">
                    <button onClick={goUp} disabled={activeServer.files.currentPath === '/'} className="p-1 rounded hover:bg-dark-700 disabled:opacity-30 transition-colors flex-shrink-0">
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <button onClick={() => loadFiles('/')} className="p-1 rounded hover:bg-dark-700 transition-colors flex-shrink-0" title="根目录">
                      <Home className="w-4 h-4" />
                    </button>
                    <span className="text-xs text-dark-500 font-mono truncate ml-2">{activeServer.files.currentPath}</span>
                    <button onClick={() => loadFiles(activeServer.files.currentPath)} className="p-1 rounded hover:bg-dark-700 transition-colors flex-shrink-0 ml-auto">
                      <RefreshCw className="w-4 h-4" />
                    </button>
                  </div>

                  {/* 上传按钮 */}
                  <button
                    onClick={() => document.getElementById('remote-upload-input')?.click()}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-accent-500/20 text-accent-400 text-xs hover:bg-accent-500/30 transition-colors"
                  >
                    <Upload className="w-3.5 h-3.5" /> 上传文件
                  </button>
                  <input id="remote-upload-input" type="file" multiple className="hidden"
                    onChange={e => handleFiles(e.target.files)} />
                </div>

                {/* 文件列表（支持拖拽上传） */}
                <div
                  className={`flex-1 glass rounded-xl overflow-hidden transition-colors ${
                    dragOver ? 'border-accent-500 bg-accent-500/5' : ''
                  }`}
                  onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleDrop}
                  onClick={() => document.getElementById('remote-upload-input')?.click()}
                >
                  {dragOver ? (
                    <div className="flex flex-col items-center justify-center h-full text-accent-400">
                      <ArrowUp className="w-10 h-10 mb-3 animate-bounce" />
                      <p className="text-sm font-medium">松开以上传到 {activeServer.files.currentPath}</p>
                    </div>
                  ) : activeServer.filesLoading ? (
                    <div className="flex items-center justify-center h-full">
                      <Loader className="w-8 h-8 animate-spin text-accent-500" />
                    </div>
                  ) : activeServer.files.error ? (
                    <div className="flex items-center justify-center h-full text-red-400">
                      <AlertCircle className="w-5 h-5 mr-2" /> {activeServer.files.error}
                    </div>
                  ) : (
                    <div className="p-4 h-full overflow-y-auto">
                      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                        {/* 目录 */}
                        {activeServer.files.dirs.map((dir: RemoteDir) => (
                          <button key={dir.path} onClick={e => { e.stopPropagation(); navigateDir(dir.name); }}
                            className="flex items-center gap-2 p-3 rounded-lg bg-dark-800/60 hover:bg-dark-800 text-left transition-colors">
                            <Folder className="w-5 h-5 text-yellow-400 flex-shrink-0" />
                            <div className="min-w-0 flex-1">
                              <div className="text-sm truncate">{dir.name}</div>
                              <div className="text-xs text-dark-600">目录</div>
                            </div>
                            <ChevronRight className="w-3.5 h-3.5 text-dark-600 flex-shrink-0" />
                          </button>
                        ))}
                        {/* 文件 */}
                        {activeServer.files.files.map((file: RemoteFile) => (
                          <div key={file.path} className="flex items-center gap-2 p-3 rounded-lg bg-dark-800/60 hover:bg-dark-800 transition-colors group">
                            <FileText className={`w-5 h-5 flex-shrink-0 ${file.isLog ? 'text-green-400' : 'text-dark-400'}`} />
                            <div className="min-w-0 flex-1" onClick={() => loadLogs(file.path, logLines, logSearch)}>
                              <div className="text-sm truncate">{file.name}</div>
                              <div className="text-xs text-dark-600">{formatSize(file.size)}</div>
                            </div>
                            <button onClick={e => { e.stopPropagation(); openInEditor(file.path); }}
                              className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-accent-500/20 text-dark-500 hover:text-accent-400 transition-all flex-shrink-0"
                              title="编辑文件">
                              <Code2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                        {activeServer.files.files.length === 0 && activeServer.files.dirs.length === 0 && (
                          <div className="col-span-full text-center text-dark-500 py-10">
                            目录为空，拖拽文件到此处上传
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* 日志查看器 */}
                {activeServer.selectedFile && (
                  <div className="glass rounded-xl overflow-hidden">
                    <div className="flex items-center justify-between px-4 py-2.5 border-b border-dark-800 bg-dark-900/50">
                      <div className="flex items-center gap-2">
                        <FileText className="w-4 h-4 text-green-400" />
                        <span className="text-sm font-mono text-dark-300 truncate max-w-64">{activeServer.selectedFile.split('/').pop()}</span>
                        <button onClick={() => { setActiveServer(s => s ? { ...s, selectedFile: null, logs: [] } : s); }}
                          className="p-1 rounded hover:bg-dark-700 text-dark-500">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <div className="flex items-center gap-2">
                        <select value={logLines} onChange={e => { setLogLines(Number(e.target.value)); loadLogs(activeServer.selectedFile!, Number(e.target.value), logSearch); }}
                          className="px-2 py-1 rounded bg-dark-800 text-xs border border-dark-700">
                          <option value={100}>100 行</option>
                          <option value={200}>200 行</option>
                          <option value={500}>500 行</option>
                          <option value={1000}>1000 行</option>
                        </select>
                        <div className="relative">
                          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-dark-500" />
                          <input type="text" placeholder="搜索..." value={logSearch} onChange={e => setLogSearch(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && loadLogs(activeServer.selectedFile!, logLines, logSearch)}
                            className="pl-7 pr-2 py-1 rounded bg-dark-800 text-xs border border-dark-700 w-36 focus:outline-none focus:border-accent-500/50" />
                        </div>
                        <button onClick={() => loadLogs(activeServer.selectedFile!, logLines, logSearch)}
                          className="px-2 py-1 rounded bg-dark-700 hover:bg-dark-600 text-xs transition-colors">
                          刷新
                        </button>
                        <button onClick={() => openInEditor(activeServer.selectedFile!)}
                          className="flex items-center gap-1 px-2 py-1 rounded bg-accent-500/20 text-accent-400 text-xs hover:bg-accent-500/30 transition-colors">
                          <Code2 className="w-3.5 h-3.5" /> 编辑
                        </button>
                      </div>
                    </div>
                    <div className="max-h-72 overflow-y-auto">
                      {activeServer.logsLoading ? (
                        <div className="flex items-center justify-center py-8"><Loader className="w-6 h-6 animate-spin text-accent-500" /></div>
                      ) : activeServer.logs.length === 0 ? (
                        <div className="text-center text-dark-500 py-8 text-sm">无日志数据</div>
                      ) : (
                        <table className="w-full text-sm">
                          <tbody className="divide-y divide-dark-800/40">
                            {activeServer.logs.map(log => (
                              <tr key={log.id} className="hover:bg-dark-800/30 font-mono">
                                <td className="px-3 py-1.5 text-xs text-dark-500 whitespace-nowrap">{log.timestamp.substring(11, 23)}</td>
                                <td className="px-3 py-1.5"><span className={`px-1.5 py-0.5 rounded text-xs ${levelColors[log.level] || 'bg-dark-700 text-dark-300'}`}>{log.level}</span></td>
                                <td className="px-3 py-1.5 text-dark-300 break-all text-xs">{log.message}</td>
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
          </>
        )}
      </div>

      {/* 添加服务器弹窗 */}
      {showAddModal && (
        <ServerModal
          editingServer={editingServer}
          onSave={saveServer}
          onTest={testConn}
          onClose={() => { setShowAddModal(false); resetForm(); }}
          formData={formData}
          setFormData={setFormData}
          testResult={testResult}
          testing={testing}
        />
      )}

      {/* Shell 终端弹窗 */}
      {showShell && activeServer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-5xl mx-4 h-[640px]">
            <ShellTerminal
              server={{ ...activeServer, name: activeServer.name, host: activeServer.host, port: activeServer.port, username: activeServer.username }}
              onClose={() => setShowShell(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
