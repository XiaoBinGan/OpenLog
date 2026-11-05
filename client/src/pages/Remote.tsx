/**
 * Remote.tsx — 远程服务器管理（修复版）
 * 修复：编辑按钮不显示、文件列表点击触发上传、状态切换竞态
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  filterServers, windowServers, countLabel,
  DEFAULT_VISIBLE_COUNT, LOAD_MORE_STEP, type ServerStatusFilter,
} from '../utils/serverList';
import { useToast } from '../contexts/ToastContext';
import {
  Server, Plus, Trash2, RefreshCw, Folder, FileText, ChevronRight,
  ChevronLeft, Search, Terminal, Check, X, AlertCircle, Loader,
  Cpu, MemoryStick, HardDrive, Clock, Home, Eye, EyeOff, Upload,
  Code2, Save, Pencil, Wifi, WifiOff, PanelLeftClose,
  PanelLeftOpen, ArrowUp, FileCode, FolderOpen, FileJson, Sparkles, Download, PowerOff,
  FolderPlus, MoreHorizontal,
} from 'lucide-react';
import { useRemote } from '../contexts/RemoteContext';
import { apiFetch, apiJson } from '../api/client';
import ShellTerminal from '../components/ShellTerminal';
import AIShellTerminal from '../components/AIShellTerminal';
import FileContextMenu, { type FileMenuTarget, type FileOpKind } from '../components/FileContextMenu';
import {
  validateFileName, validateRemotePathInput, validateMode,
  joinPath, baseName, parentDir, deleteConfirmText,
} from '../utils/fileOpPrompt';
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

// Toast 组件
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

// 表单输入统一样式（弹窗里的输入框全部复用，避免每个框一套颜色/焦点环）
const INPUT_CLASS = 'w-full px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm text-dark-200 placeholder-dark-600 transition-colors focus:border-accent-500/60 focus:ring-2 focus:ring-accent-500/15 focus:outline-none';
const LABEL_CLASS = 'block text-xs text-dark-400 mb-1';

// 添加/编辑服务器弹窗
function ServerModal({
  editingServer, onSave, onTest, onClose, formData, setFormData, testResult, testing, pwKey,
}: {
  editingServer: RemoteServer | null;
  onSave: () => void; onTest: () => void; onClose: () => void;
  formData: RemoteServerConfig;
  setFormData: (d: RemoteServerConfig) => void;
  testResult: { success: boolean; info?: any; error?: string } | null;
  testing: boolean;
  pwKey: string;
}) {
  const [showPw, setShowPw] = useState(false);
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="glass animate-scale-in rounded-2xl p-6 w-full max-w-md max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="mb-5 flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-500/15">
            <Server className="h-4 w-4 text-accent-400" />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-dark-100">{editingServer ? '编辑服务器' : '添加服务器'}</h2>
            <p className="text-[11px] text-dark-500">SSH 连接信息，保存后可在左侧列表一键连接</p>
          </div>
          <button onClick={onClose} className="ml-auto rounded-lg p-1.5 text-dark-500 transition-colors hover:bg-dark-800 hover:text-dark-200" title="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3">
          <div>
            <label className={LABEL_CLASS}>名称</label>
            <input type="text" value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })}
              placeholder="我的服务器" className={INPUT_CLASS} />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2">
              <label className={LABEL_CLASS}>主机地址</label>
              <input type="text" value={formData.host} onChange={e => setFormData({ ...formData, host: e.target.value })}
                placeholder="192.168.1.100" className={INPUT_CLASS} />
            </div>
            <div>
              <label className={LABEL_CLASS}>端口</label>
              <input type="number" value={formData.port} onChange={e => setFormData({ ...formData, port: Number(e.target.value) })}
                className={INPUT_CLASS} />
            </div>
          </div>
          <div>
            <label className={LABEL_CLASS}>用户名</label>
            <input type="text" value={formData.username} onChange={e => setFormData({ ...formData, username: e.target.value })}
              placeholder="root" className={INPUT_CLASS} />
          </div>
          <div>
            <label className={LABEL_CLASS}>密码</label>
            <div className="relative">
              <input type={showPw ? 'text' : 'password'} value={formData.password} onChange={e => setFormData({ ...formData, password: e.target.value })}
                placeholder={editingServer ? '留空则不修改密码' : 'SSH 密码'} autoComplete="new-password" name={pwKey} className={`${INPUT_CLASS} pr-10`} />
              <button type="button" onClick={() => setShowPw(v => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-dark-500 hover:text-dark-300">
                {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={LABEL_CLASS}>日志目录</label>
              <input type="text" value={formData.logPath} onChange={e => setFormData({ ...formData, logPath: e.target.value })}
                placeholder="/var/log" className={INPUT_CLASS} />
            </div>
            <div>
              <label className={LABEL_CLASS}>文件匹配</label>
              <input type="text" value={formData.watchFiles} onChange={e => setFormData({ ...formData, watchFiles: e.target.value })}
                placeholder="*.log" className={INPUT_CLASS} />
            </div>
          </div>
          <button onClick={onTest} disabled={testing || !formData.host}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-dark-700 bg-dark-800/60 px-3 py-2 text-sm text-dark-200 transition-colors hover:border-accent-500/30 hover:bg-dark-800 disabled:cursor-not-allowed disabled:opacity-40">
            {testing ? <><Loader className="w-4 h-4 animate-spin" /> 测试中...</> : <><Terminal className="w-4 h-4" /> 测试连接</>}
          </button>
          {testResult?.success && (
            <div className="flex items-start gap-1.5 rounded-lg border border-green-500/20 bg-green-500/10 px-2 py-1.5 text-xs text-green-300">
              <Check className="mt-0.5 w-3 h-3 flex-shrink-0" />
              <span className="line-clamp-2 break-all">{testResult.info?.system}</span>
            </div>
          )}
          {testResult?.error && (
            <div className="flex items-start gap-1.5 rounded-lg border border-red-500/20 bg-red-500/10 px-2 py-1.5 text-xs text-red-300">
              <AlertCircle className="mt-0.5 w-3 h-3 flex-shrink-0" />
              <span className="line-clamp-2 break-all">{testResult.error}</span>
            </div>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2 border-t border-dark-800 pt-4">
          <button onClick={onClose} className="rounded-lg border border-dark-700 px-4 py-2 text-sm text-dark-300 transition-colors hover:bg-dark-800 hover:text-dark-100">取消</button>
          <button onClick={onSave} disabled={!formData.host} className="rounded-lg bg-accent-500 px-4 py-2 text-sm font-medium text-dark-950 transition-colors hover:bg-accent-400 disabled:cursor-not-allowed disabled:opacity-40">
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
      <textarea
        value={content}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); if (!saving && modified) handleSave(); }
          if (e.key === 'Tab') { e.preventDefault(); const el = e.currentTarget; const s = el.selectionStart; const end = el.selectionEnd; onChange(content.slice(0, s) + '  ' + content.slice(end)); setTimeout(() => { el.selectionStart = el.selectionEnd = s + 2; }, 0); }
        }}
        spellCheck={false}
        className="flex-1 w-full px-6 py-4 bg-dark-950 text-sm text-dark-200 font-mono leading-relaxed resize-none focus:outline-none min-h-0"
        style={{ tabSize: 2 }}
      />
      <div className="flex items-center gap-4 px-4 py-1.5 bg-dark-900 border-t border-dark-700 text-xs text-dark-600">
        <span>UTF-8</span><span>LF</span><span>{filePath}</span><span className="ml-auto">Ctrl+S 保存</span>
      </div>
    </div>
  );
}

// 单个服务器卡片组件
const ServerCard = ({ server, isActive, selected, onToggleSelect, onConnect, onDisconnect, onEdit, onDelete, onShell, onAIShell, onSelect, aiShellOpening, connecting }: {
  server: RemoteServer;
  isActive: boolean;
  selected: boolean;
  onToggleSelect: (e: React.MouseEvent) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onShell: () => void;
  onAIShell: () => void;
  onSelect: () => void;
  onOpenEditor?: () => void;
  aiShellOpening?: boolean;
  connecting: boolean;
}) => (
  <div
    className={`group cursor-pointer rounded-xl border p-2.5 transition-all ${
      selected ? 'border-blue-400/40 bg-blue-500/10'
        : isActive ? 'border-accent-500/50 bg-accent-500/10'
        : 'border-dark-800/80 bg-dark-900/50 hover:border-dark-700 hover:bg-dark-800/50'
    }`}
    onClick={onSelect}
  >
    {/* 名称行：勾选框 + 状态点 + 名称 + hover 才出现的编辑/删除 */}
    <div className="flex items-center gap-2">
      {/* 多选：批量重连/断开用；选中态常显，未选中也保留淡显，避免用户不知道能选 */}
      <input
        type="checkbox"
        checked={selected}
        onClick={onToggleSelect}
        onChange={() => {}}
        title="选中以批量操作"
        className={`h-3 w-3 flex-shrink-0 cursor-pointer accent-accent-500 transition-opacity ${selected ? 'opacity-100' : 'opacity-40 group-hover:opacity-100'}`}
      />
      <span className={`h-2 w-2 flex-shrink-0 rounded-full ${
        server.status === 'connected'
          ? 'bg-green-500 shadow-[0_0_0_3px_rgba(34,197,94,0.15)]'
          : server.status === 'error'
            ? 'bg-red-500 shadow-[0_0_0_3px_rgba(239,68,68,0.15)]'
            : 'bg-dark-600'
      }`} />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-dark-200">{server.name}</span>
      {/* 编辑/删除按钮：阻止冒泡，避免触发 onSelect */}
      <div className="flex flex-shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <button onClick={e => { e.stopPropagation(); onEdit(); }} className="rounded p-1 text-dark-500 transition-colors hover:bg-dark-700 hover:text-dark-200" title="编辑">
          <Pencil className="w-3.5 h-3.5" />
        </button>
        <button onClick={e => { e.stopPropagation(); onDelete(); }} className="rounded p-1 text-dark-500 transition-colors hover:bg-red-500/20 hover:text-red-400" title="删除">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>

    {/* 地址与日志目录合并成一行，省掉两行留白 */}
    <div className="mt-1 flex items-center gap-1.5 pl-[18px] text-[11px] text-dark-500">
      <span className="truncate font-mono">{server.host}:{server.port}</span>
      <span className="text-dark-700">·</span>
      <span className="truncate font-mono text-dark-600">{server.logPath}</span>
    </div>

    {/* 失败原因 + 自动重连倒计时：让「红灯」变得可诊断 */}
    {server.status === 'error' && (
      <div className="mt-2 rounded-md border border-red-500/20 bg-red-500/10 px-2 py-1.5">
        <p className="text-[11px] leading-snug text-red-300 break-all line-clamp-2" title={server.lastError || ''}>
          {server.lastError || '连接失败'}
        </p>
        <p className="mt-0.5 text-[10px] text-dark-500">
          {server.lastErrorAt ? `${new Date(server.lastErrorAt).toLocaleTimeString()} 失败` : ''}
          {server.retryCount ? ` · 已重试 ${server.retryCount} 次，自动重连中` : ' · 自动重连中'}
        </p>
      </div>
    )}
    {server.status === 'disconnected' && server.lastConnected && (
      <p className="mt-1 pl-[18px] text-[10px] text-dark-600">
        上次在线：{new Date(server.lastConnected).toLocaleString()}
      </p>
    )}

    {/* 操作按钮：统一 h-7 / text-[11px]，三种状态都用同一套尺寸 */}
    {server.status === 'connected' ? (
      <div className="mt-2 flex gap-1" onClick={e => e.stopPropagation()}>
        <button onClick={onDisconnect} className="flex h-7 flex-1 items-center justify-center gap-1 rounded-md border border-dark-800 bg-dark-800/50 text-[11px] text-dark-300 transition-colors hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-400">
          <WifiOff className="w-3 h-3" /> 断开
        </button>
        <button onClick={onShell} className="flex h-7 flex-1 items-center justify-center gap-1 rounded-md border border-dark-800 bg-dark-800/50 text-[11px] text-dark-300 transition-colors hover:border-accent-500/30 hover:bg-accent-500/10 hover:text-accent-300">
          <Terminal className="w-3 h-3" /> Shell
        </button>
        <button onClick={onAIShell} disabled={aiShellOpening} className="flex h-7 flex-1 items-center justify-center gap-1 rounded-md border border-purple-500/25 bg-purple-500/10 text-[11px] text-purple-300 transition-colors hover:bg-purple-500/20 disabled:cursor-wait disabled:opacity-50">
          {aiShellOpening ? <Loader className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
          {aiShellOpening ? '启动中' : 'AI Shell'}
        </button>
      </div>
    ) : (
      <button onClick={onConnect} disabled={connecting} className="mt-2 flex h-7 w-full items-center justify-center gap-1 rounded-md border border-green-500/25 bg-green-500/10 text-[11px] text-green-400 transition-colors hover:bg-green-500/20 disabled:cursor-wait disabled:opacity-50">
        {connecting ? <Loader className="w-3 h-3 animate-spin" /> : <Wifi className="w-3 h-3" />}
        {connecting ? '连接中...' : '连接'}
      </button>
    )}
  </div>
);

// 主组件
export default function Remote() {
  const _toastCtx = useToast();
  const showToast = (msg: string, type: string) => _toastCtx.toast(type as any, msg);
  const {
    servers, activeServer, setActiveServer, selectServer, connect, disconnect, refreshServers,
    loadFiles, navigateDir, goUp,
    loadLogs, openInEditor, updateFileContent, saveFile, closeEditor,
    uploadFile, uploadProgress, cancelUpload, toast, clearToast,
  } = useRemote();

  // 本地 UI 状态
  const [showAddModal, setShowAddModal] = useState(false);
  const [pwKey, setPwKey] = useState(() => Math.random().toString(36).slice(2));
  const [editingServer, setEditingServer] = useState<RemoteServer | null>(null);
  const [formData, setFormData] = useState<RemoteServerConfig>({
    name: '', host: '', port: 22, username: 'root', password: '',
    logPath: '/var/log', watchFiles: '*.log',
  });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; info?: any; error?: string } | null>(null);
  const [showShell, setShowShell] = useState(false);
  const [showAIShell, setShowAIShell] = useState(false);
  const [aiShellOpening, setAiShellOpening] = useState(false);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  // 多选 + 批量操作（一键重连 / 一键断开 / 全选）
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState<'connect' | 'disconnect' | null>(null);
  const [logLines, setLogLines] = useState(200);
  const [logSearch, setLogSearch] = useState('');
  const [showServerList, setShowServerList] = useState(true);
  // 1000 台规模：一次性渲染全部卡片会卡死浏览器，先按关键字/状态过滤，再做窗口化
  const [serverSearch, setServerSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'connected' | 'error' | 'disconnected'>('all');
  const [visibleCount, setVisibleCount] = useState(DEFAULT_VISIBLE_COUNT);
  const [dragOver, setDragOver] = useState(false);

  // ─── 文件右键菜单 + 操作对话框（重命名 / 删除 / 新建文件夹 / 复制移动 / 权限）──
  // 用户反馈：「文件支持修改但无法右键修改文件名等操作」—— 这里补上。
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; target: FileMenuTarget | null } | null>(null);
  const [opDialog, setOpDialog] = useState<{
    op: FileOpKind;
    target: FileMenuTarget | null;
    title: string;
    label: string;
    placeholder: string;
    initial: string;
  } | null>(null);
  const [opInput, setOpInput] = useState('');
  const [opError, setOpError] = useState('');
  const [opBusy, setOpBusy] = useState(false);

  const currentDir = activeServer?.files.currentPath || '/';

  /** 打开右键菜单（target 为空 = 右键空白处） */
  const openFileMenu = (e: React.MouseEvent, target: FileMenuTarget | null) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, target });
  };

  /** 调用后端文件操作接口，成功后刷新当前目录 */
  const callFileOp = async (op: string, path: string, extra: Record<string, unknown> = {}) => {
    if (!activeServer) return false;
    try {
      await apiJson(`/api/remote/servers/${activeServer.id}/file/op`, 'POST', { op, path, ...extra });
      loadFiles(currentDir);
      // 删掉/改名了正在看/正在编辑的文件 → 顺手清掉对应面板，避免点开报错
      if (op === 'delete' || op === 'rename' || op === 'move') {
        if (activeServer.selectedFile === path) {
          setActiveServer(s => (s ? { ...s, selectedFile: null, logs: [] } : s));
        }
        if (activeServer.editingFilePath === path) closeEditor();
      }
      return true;
    } catch (err: any) {
      showToast(err?.message || '操作失败', 'error');
      return false;
    }
  };

  /** 菜单里的动作分发 */
  const handleFileOp = (op: FileOpKind) => {
    const target = ctxMenu?.target || null;
    setOpError('');
    if (op === 'refresh') { loadFiles(currentDir); return; }
    if (op === 'delete') {
      if (!target) return;
      if (!window.confirm(deleteConfirmText(target.kind, target.name, target.path))) return;
      callFileOp('delete', target.path).then(ok => { if (ok) showToast(`已删除 ${target.name}`, 'success'); });
      return;
    }
    if (op === 'rename') {
      if (!target) return;
      setOpInput(target.name);
      setOpDialog({ op, target, title: `重命名${target.kind === 'dir' ? '目录' : '文件'}`, label: '新名称', placeholder: '新名称', initial: target.name });
      return;
    }
    if (op === 'mkdir') {
      setOpInput('');
      setOpDialog({ op, target: null, title: '新建文件夹', label: '文件夹名称', placeholder: '例如 logs-backup', initial: '' });
      return;
    }
    if (op === 'copy' || op === 'move') {
      if (!target) return;
      const initial = joinPath(currentDir, target.name);
      setOpInput(initial);
      setOpDialog({
        op, target,
        title: op === 'copy' ? `复制「${target.name}」到` : `移动「${target.name}」到`,
        label: '目标路径（含文件名）', placeholder: '/var/log/xxx', initial,
      });
      return;
    }
    if (op === 'chmod') {
      if (!target) return;
      setOpInput('755');
      setOpDialog({ op, target, title: `修改「${target.name}」权限`, label: '权限（八进制）', placeholder: '755', initial: '755' });
    }
  };

  /** 对话框提交 */
  const submitOpDialog = async () => {
    if (!opDialog) return;
    const { op, target } = opDialog;
    setOpError('');
    let path = '';
    let extra: Record<string, unknown> = {};
    let successMsg = '';

    if (op === 'mkdir') {
      const v = validateFileName(opInput);
      if (!v.ok) { setOpError(v.error!); return; }
      path = joinPath(currentDir, v.value!);
      successMsg = `已创建 ${v.value}`;
    } else if (op === 'rename') {
      const v = validateFileName(opInput);
      if (!v.ok) { setOpError(v.error!); return; }
      if (!target) return;
      path = target.path;
      extra = { newPath: joinPath(parentDir(target.path), v.value!) };
      successMsg = `已重命名为 ${v.value}`;
    } else if (op === 'copy' || op === 'move') {
      const v = validateRemotePathInput(opInput);
      if (!v.ok) { setOpError(v.error!); return; }
      if (!target) return;
      path = target.path;
      extra = { newPath: v.value! };
      successMsg = op === 'copy' ? `已复制到 ${v.value}` : `已移动到 ${v.value}`;
    } else if (op === 'chmod') {
      const v = validateMode(opInput);
      if (!v.ok) { setOpError(v.error!); return; }
      if (!target) return;
      path = target.path;
      extra = { mode: v.value! };
      successMsg = `权限已改为 ${v.value}`;
    } else {
      return;
    }

    if (!path) return;
    setOpBusy(true);
    const ok = await callFileOp(op, path, extra);
    setOpBusy(false);
    if (ok) { showToast(successMsg, 'success'); setOpDialog(null); }
  };

  // 首次连接后加载文件
  const loadedRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeServer && activeServer.status === 'connected' && activeServer.files.currentPath && loadedRef.current !== activeServer.id) {
      loadedRef.current = activeServer.id;
      loadFiles(activeServer.logPath || '/var/log');
    }
  }, [activeServer?.id, activeServer?.status, activeServer?.logPath, loadFiles]);

  // 测试连接
  const testConn = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const body: any = { ...formData };
      // 编辑模式：密码为空时传 serverId，让后端用已存密码测试
      if (editingServer && !formData.password && !formData.privateKey) {
        body.serverId = editingServer.id;
      }
      setTestResult(await apiJson<{ success: boolean; info?: any; error?: string }>('/api/remote/test', 'POST', body));
    } catch (e: any) { setTestResult({ success: false, error: e.message }); }
    setTesting(false);
  };

  // 保存服务器
  const saveServer = async () => {
    try {
      const url = editingServer ? `/api/remote/servers/${editingServer.id}` : '/api/remote/servers';
      const method = editingServer ? 'PUT' : 'POST';
      const data = await apiJson<{ success?: boolean; error?: string }>(url, method, formData);
      if (data.success) {
        await refreshServers();
        setShowAddModal(false);
        resetForm();
      } else {
        alert(data.error || '保存失败');
      }
    } catch (e: any) { alert('保存失败: ' + e.message); }
  };

  // 删除服务器
  const deleteServer = async (server: RemoteServer) => {
    if (!confirm(`确定删除 "${server.name}"？`)) return;
    try {
      await apiFetch(`/api/remote/servers/${server.id}`, { method: 'DELETE' });
      await refreshServers();
      if (activeServer?.id === server.id) disconnect();
    } catch (e: any) {
      showToast('删除失败: ' + e.message, 'error');
    }
  };

  // 导入 FinalShell JSON 文件
  const importFinalShell = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    
    const configs: any[] = [];
    for (const file of Array.from(files)) {
      try {
        const text = await file.text();
        const json = JSON.parse(text);
        // 支持 OpenLog 格式（数组）和 FinalShell 格式（单个对象）
        if (Array.isArray(json)) {
          json.forEach(item => { if (item.host) configs.push(item); });
        } else if (json.host) {
          configs.push(json);
        }
      } catch (e) {
        console.error('解析文件失败:', file.name, e);
      }
    }
    
    if (configs.length === 0) {
      showToast('未找到有效的服务器配置', 'error');
      return;
    }
    
    try {
      const data = await apiJson<{ success?: boolean; imported?: number; skipped?: number; error?: string }>('/api/remote/import', 'POST', { configs });
      if (data.success) {
        showToast(`导入成功: ${data.imported} 个, 跳过: ${data.skipped} 个`, 'success');
        await refreshServers();
      } else {
        showToast('导入失败: ' + data.error, 'error');
      }
    } catch (e: any) {
      showToast('导入失败: ' + e.message, 'error');
    }
  };

  // 打开编辑弹窗
  const openEdit = async (server: RemoteServer) => {
    setEditingServer(server);
    setPwKey(Math.random().toString(36).slice(2));
    setShowAddModal(true);
    
    // 安全：不再从服务端回读明文密码。留空即表示不修改（后端 updateServer 会保留原密码）
    setFormData({ name: server.name, host: server.host, port: server.port, username: server.username, password: '', logPath: server.logPath, watchFiles: server.watchFiles });
  };

  const resetForm = () => {
    setFormData({ name: '', host: '', port: 22, username: 'root', password: '', logPath: '/var/log', watchFiles: '*.log' });
    setEditingServer(null);
    setTestResult(null);
    setPwKey(Math.random().toString(36).slice(2));
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

  // 连接：直接调用 context 的 connect
  const handleConnect = async (server: RemoteServer) => {
    if (connectingId) return; // 已有连接进行中
    setConnectingId(server.id);
    try {
      await connect(server);
      loadedRef.current = null;
    } catch {
      // connect 内部已处理 toast
    }
    setConnectingId(null);
  };

  // 过滤 + 窗口化（纯函数，见 client/src/utils/serverList.ts，有单测）
  // 注意：必须放在 runBatch/toggleSelectAll 之前 —— 它们引用了 filteredServers，
  // 而 const 有暂时性死区（TDZ），放后面会编译报 "used before its declaration"。
  const filteredServers = filterServers(servers, { search: serverSearch, status: statusFilter });
  const { visible: renderedServers, remaining: remainingServers } = windowServers(filteredServers, visibleCount);

  // ─── 多选 + 批量重连/断开 ────────────────────────────────────
  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** 批量操作：只对当前筛选结果里选中的机器动手，避免"全选"误伤被搜索过滤掉的 */
  const runBatch = async (action: 'connect' | 'disconnect', explicitIds?: string[]) => {
    const ids = explicitIds ?? [...selectedIds].filter(id => filteredServers.some(s => s.id === id));
    if (ids.length === 0) {
      showToast('先勾选服务器（可点「全选」）', 'info');
      return;
    }
    if (batchBusy) return;
    setBatchBusy(action);
    try {
      const data = await apiJson<{ ok: number; failed: number; total: number; results: Array<{ id: string; ok: boolean; error?: string }> }>(
        `/api/remote/servers/batch/${action}`, 'POST', { ids },
      );
      const failedList = (data.results || []).filter(r => !r.ok);
      if (data.failed === 0) {
        showToast(`${action === 'connect' ? '重连' : '断开'}成功：${data.ok} 台`, 'success');
      } else {
        const firstErr = failedList[0]?.error || '';
        showToast(`${action === 'connect' ? '重连' : '断开'}：${data.ok} 成功 / ${data.failed} 失败${firstErr ? ` · ${firstErr.slice(0, 60)}` : ''}`, 'error');
      }
      await refreshServers();
      loadedRef.current = null;
      if (action === 'disconnect' && activeServer && ids.includes(activeServer.id)) {
        setActiveServer(null);
      }
    } catch (e: any) {
      showToast(`批量操作失败: ${e.message}`, 'error');
    } finally {
      setBatchBusy(null);
    }
  };

  /** 「全部重连」：所有未连接的（不受搜索筛选影响，用户意图是"把断的都连上"） */
  const runBatchConnectAll = () => {
    const ids = servers.filter(s => s.status !== 'connected').map(s => s.id);
    if (ids.length === 0) {
      showToast('所有服务器都是连接状态', 'info');
      return;
    }
    void runBatch('connect', ids);
  };

  const disconnectedCount = servers.filter(s => s.status !== 'connected').length;
  const connectedCount = servers.filter(s => s.status === 'connected').length;

  // 全选/取消全选：只作用于当前筛选结果
  const allVisibleSelected = filteredServers.length > 0 && filteredServers.every(s => selectedIds.has(s.id));
  const toggleSelectAll = () => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const s of filteredServers) next.delete(s.id);
      } else {
        for (const s of filteredServers) next.add(s.id);
      }
      return next;
    });
  };

  return (
    <div className="flex h-[calc(100vh-8rem)] animate-fade-in gap-4">
      {/* Toast */}
      {toast && <Toast toast={toast} onClose={clearToast} />}

      {/* 左侧：服务器列表 */}
      {showServerList && (
        <div className="w-80 flex-shrink-0 flex flex-col gap-3">
          <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between px-1">
            <h2 className="flex items-baseline gap-1.5 text-sm font-semibold text-dark-300">
              服务器
              <span className="text-xs font-normal text-dark-600">{countLabel(servers.length, filteredServers.length)}</span>
              {connectedCount > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-1.5 py-0.5 text-[10px] font-normal text-green-400">
                  <span className="h-1 w-1 rounded-full bg-green-500" />
                  {connectedCount} 在线
                </span>
              )}
            </h2>
            <button
              onClick={() => refreshServers()}
              className="rounded-lg p-1.5 text-dark-500 transition-colors hover:bg-dark-800 hover:text-dark-200"
              title="刷新列表"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* 批量操作条：状态一行 + 三个等宽按钮一行，窄面板里也不会换行 */}
          <div className="rounded-lg border border-dark-800 bg-dark-900/40 p-1.5">
            <div className="flex items-center justify-between px-0.5">
              <label className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-dark-300">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={toggleSelectAll}
                  className="h-3 w-3 cursor-pointer accent-accent-500"
                />
                全选
              </label>
              <div className="flex items-center gap-2">
                <span className={`text-[11px] tabular-nums ${selectedIds.size > 0 ? 'text-accent-400' : 'text-dark-600'}`}>
                  {selectedIds.size > 0 ? `已选 ${selectedIds.size} 台` : '未选'}
                </span>
                {selectedIds.size > 0 && (
                  <button
                    onClick={() => setSelectedIds(new Set())}
                    className="text-[11px] text-dark-500 transition-colors hover:text-dark-200"
                    title="清除选择"
                  >
                    清空
                  </button>
                )}
              </div>
            </div>
            <div className="mt-1.5 grid grid-cols-3 gap-1">
              <button
                onClick={() => runBatch('connect')}
                disabled={batchBusy !== null || selectedIds.size === 0}
                title="重连选中服务器"
                className="flex h-7 items-center justify-center gap-1 rounded-md border border-green-500/25 bg-green-500/10 text-[11px] text-green-400 transition-colors hover:bg-green-500/20 disabled:cursor-not-allowed disabled:border-dark-800 disabled:bg-dark-800/30 disabled:text-dark-600"
              >
                {batchBusy === 'connect' ? <Loader className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                重连
              </button>
              <button
                onClick={() => runBatch('disconnect')}
                disabled={batchBusy !== null || selectedIds.size === 0}
                title="断开选中服务器"
                className="flex h-7 items-center justify-center gap-1 rounded-md border border-dark-800 bg-dark-800/50 text-[11px] text-dark-300 transition-colors hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-400 disabled:cursor-not-allowed disabled:border-dark-800 disabled:bg-dark-800/30 disabled:text-dark-600"
              >
                {batchBusy === 'disconnect' ? <Loader className="w-3 h-3 animate-spin" /> : <PowerOff className="w-3 h-3" />}
                断开
              </button>
              <button
                onClick={runBatchConnectAll}
                disabled={batchBusy !== null || disconnectedCount === 0}
                title="连接所有当前未连接的服务器"
                className="flex h-7 items-center justify-center gap-1 rounded-md border border-accent-500/30 bg-accent-500/15 text-[11px] text-accent-300 transition-colors hover:bg-accent-500/25 disabled:cursor-not-allowed disabled:border-dark-800 disabled:bg-dark-800/30 disabled:text-dark-600"
              >
                {batchBusy === 'connect' ? <Loader className="w-3 h-3 animate-spin" /> : <Wifi className="w-3 h-3" />}
                全部重连{disconnectedCount > 0 ? `(${disconnectedCount})` : ''}
              </button>
            </div>
          </div>

          {/* 1000 台规模：搜索 + 状态筛选（放在导入/导出按钮上方，先说清"为什么列表不全"） */}
          <div className="flex flex-col gap-1.5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-dark-600" />
              <input
                type="search"
                value={serverSearch}
                onChange={e => { setServerSearch(e.target.value); setVisibleCount(DEFAULT_VISIBLE_COUNT); }}
                placeholder="搜索名称 / IP / 用户"
                className="w-full rounded-lg border border-dark-800 bg-dark-900 py-1.5 pl-8 pr-2.5 text-xs text-dark-200 placeholder-dark-600 focus:border-accent-500/50 focus:outline-none"
              />
            </div>
            <div className="grid grid-cols-4 gap-0.5 rounded-lg border border-dark-800 bg-dark-900/50 p-0.5">
              {([
                ['all', '全部'],
                ['connected', '已连接'],
                ['error', '异常'],
                ['disconnected', '未连接'],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => { setStatusFilter(value); setVisibleCount(DEFAULT_VISIBLE_COUNT); }}
                  className={`rounded-md py-1 text-[11px] transition-colors ${
                    statusFilter === value
                      ? 'bg-accent-500/20 font-medium text-accent-300'
                      : 'text-dark-500 hover:bg-dark-800/60 hover:text-dark-300'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-1">
            <input
              type="file"
              id="import-finalshell"
              className="hidden"
              accept=".json"
              multiple
              onChange={e => importFinalShell(e.target.files)}
            />
            <label htmlFor="import-finalshell" className="flex h-7 cursor-pointer items-center justify-center gap-1 rounded-md border border-dark-800 bg-dark-800/40 text-[11px] text-dark-300 transition-colors hover:bg-dark-800 hover:text-dark-100">
              <FileJson className="w-3.5 h-3.5" /> 导入
            </label>
            <button onClick={async () => {
                            try {
                              const data = await apiFetch<{ servers?: unknown[] }>('/api/remote/export');
                              const servers = data.servers ?? [];
                              const blob = new Blob([JSON.stringify(servers, null, 2)], { type: 'application/json' });
                              const url = URL.createObjectURL(blob);
                              const a = document.createElement('a');
                              a.href = url; a.download = `openlog-servers-${new Date().toISOString().slice(0,10)}.json`;
                              a.click(); URL.revokeObjectURL(url);
                              showToast(`${servers.length} 台服务器配置已导出`, 'success');
                            } catch (e: any) {
                              showToast('导出失败: ' + e.message, 'error');
                            }
                          }} className="flex h-7 items-center justify-center gap-1 rounded-md border border-dark-800 bg-dark-800/40 text-[11px] text-dark-300 transition-colors hover:bg-dark-800 hover:text-dark-100">
              <Download className="w-3.5 h-3.5" /> 导出
            </button>
            <button onClick={() => { resetForm(); setShowAddModal(true); }} className="flex h-7 items-center justify-center gap-1 rounded-md border border-accent-500/30 bg-accent-500/15 text-[11px] text-accent-300 transition-colors hover:bg-accent-500/25">
              <Plus className="w-3.5 h-3.5" /> 添加
            </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto flex flex-col gap-2">
            {servers.length === 0 ? (
              <div className="glass rounded-xl p-6 text-center text-dark-500 flex-1 flex flex-col items-center justify-center">
                <Server className="w-10 h-10 opacity-30 mb-3" />
                <p className="text-sm">暂无服务器</p>
                <p className="text-xs mt-1 text-dark-600">点上方「添加」新建</p>
              </div>
            ) : filteredServers.length === 0 ? (
              <div className="glass rounded-xl p-6 text-center text-dark-500">
                <p className="text-sm">没有匹配的服务器</p>
                <button
                  onClick={() => { setServerSearch(''); setStatusFilter('all'); setVisibleCount(DEFAULT_VISIBLE_COUNT); }}
                  className="text-xs mt-2 text-accent-400 hover:text-accent-300"
                >
                  清除筛选
                </button>
              </div>
            ) : renderedServers.map(server => (
              <ServerCard
                key={server.id}
                server={server}
                isActive={activeServer?.id === server.id}
                selected={selectedIds.has(server.id)}
                onToggleSelect={(e) => { e.preventDefault(); e.stopPropagation(); toggleSelect(server.id); }}
                onConnect={() => handleConnect(server)}
                onDisconnect={() => disconnect(server.id)}
                onEdit={() => openEdit(server)}
                onDelete={() => deleteServer(server)}
                onShell={() => { selectServer(server); setShowShell(true); }}
                onAIShell={() => { selectServer(server); setAiShellOpening(true); setShowAIShell(true); }}
                connecting={connectingId === server.id}
                aiShellOpening={aiShellOpening}
                onSelect={() => {
                  if (server.status !== 'connected') {
                    setActiveServer(null); // 未连接 → 显示默认空白状态
                  } else if (activeServer?.id !== server.id) {
                    selectServer(server); // 已连接但非当前 → 切换
                  }
                }}
              />
            ))}
            {remainingServers > 0 && (
              <button
                onClick={() => setVisibleCount(c => c + LOAD_MORE_STEP)}
                className="glass rounded-xl p-2.5 text-xs text-dark-400 hover:text-dark-200 hover:bg-dark-800/40 transition-colors"
              >
                还有 {remainingServers} 台，点击加载更多
              </button>
            )}
          </div>
        </div>
      )}

      {/* 折叠按钮 */}
      <button onClick={() => setShowServerList(v => !v)}
        className="self-start p-1.5 rounded-lg hover:bg-dark-800 text-dark-500 hover:text-dark-300 transition-colors flex-shrink-0 mt-6"
        title={showServerList ? '隐藏服务器列表' : '显示服务器列表'}>
        {showServerList ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
      </button>

      {/* 主区：文件浏览器 / 编辑器 */}
      <div className="flex flex-col flex-1 min-w-0 gap-3">
        {!activeServer ? (
          <div className="flex-1 glass rounded-xl flex flex-col items-center justify-center text-dark-500">
            <Server className="w-16 h-16 opacity-20 mb-4" />
            <p className="text-lg font-medium mb-1 text-dark-300">未连接任何服务器</p>
            <p className="mb-4 text-sm text-dark-600">
              {servers.length === 0
                ? '先在左侧点「添加」新建一台服务器'
                : showServerList
                  ? '在左侧服务器列表点「连接」，或勾选多台后点「全部重连」'
                  : '先从左侧打开服务器列表'}
            </p>
            {servers.length === 0 ? (
              <button onClick={() => { resetForm(); setShowAddModal(true); }} className="flex items-center gap-2 rounded-lg border border-accent-500/30 bg-accent-500/15 px-4 py-2 text-sm text-accent-300 transition-colors hover:bg-accent-500/25">
                <Plus className="w-4 h-4" /> 添加服务器
              </button>
            ) : !showServerList && (
              <button onClick={() => setShowServerList(true)} className="flex items-center gap-2 rounded-lg border border-accent-500/30 bg-accent-500/15 px-4 py-2 text-sm text-accent-300 transition-colors hover:bg-accent-500/25">
                <PanelLeftOpen className="w-4 h-4" /> 显示服务器列表
              </button>
            )}
          </div>
        ) : (
          <>
            {/* 系统状态栏 */}
            <div className="grid grid-cols-4 gap-2">
              {[
                { 
                  icon: <Cpu className="w-4 h-4" />, 
                  label: 'CPU', 
                  value: (() => {
                    const cpu = activeServer.systemStats?.cpu as any;
                    if (!cpu) return '–';
                    if (typeof cpu === 'object' && 'load' in cpu) return `${(cpu as {load: number}).load?.toFixed(1) || 0}%`;
                    return String(cpu);
                  })()
                },
                { 
                  icon: <MemoryStick className="w-4 h-4" />, 
                  label: '内存', 
                  value: (() => {
                    const mem = activeServer.systemStats?.memory as any;
                    if (!mem) return '–';
                    if (typeof mem === 'object' && 'used' in mem && 'total' in mem) {
                      const usedGB = (mem.used / 1e9).toFixed(1);
                      const totalGB = (mem.total / 1e9).toFixed(1);
                      const percent = ((mem.used / mem.total) * 100).toFixed(1);
                      return `${usedGB}/${totalGB} GB (${percent}%)`;
                    }
                    return String(mem);
                  })()
                },
                { 
                  icon: <HardDrive className="w-4 h-4" />, 
                  label: '磁盘', 
                  value: (() => {
                    const disk = activeServer.systemStats?.disk as any;
                    if (!disk) return '–';
                    if (Array.isArray(disk) && disk.length > 0 && 'usePercent' in disk[0]) {
                      return `${disk[0].usePercent || 0}%`;
                    }
                    return String(disk);
                  })()
                },
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

            {/* 编辑器 或 文件浏览器 */}
            {activeServer.editingFilePath ? (
              <FileEditor
                content={activeServer.fileContent}
                onChange={updateFileContent}
                onSave={saveFile}
                onClose={closeEditor}
                filePath={activeServer.editingFilePath}
                modified={activeServer.fileModified}
              />
            ) : (
              <>
                {/* 路径导航 */}
                <div className="flex items-center gap-2">
                  <div className="flex h-8 flex-1 min-w-0 items-center gap-0.5 rounded-lg border border-dark-800 bg-dark-900/70 px-1.5">
                    <button onClick={goUp} disabled={activeServer.files.currentPath === '/'} title="上一级"
                      className="flex-shrink-0 rounded p-1 text-dark-400 transition-colors hover:bg-dark-800 hover:text-dark-100 disabled:cursor-not-allowed disabled:opacity-30">
                      <ChevronLeft className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => loadFiles('/')} title="根目录"
                      className="flex-shrink-0 rounded p-1 text-dark-400 transition-colors hover:bg-dark-800 hover:text-dark-100">
                      <Home className="w-3.5 h-3.5" />
                    </button>
                    <span className="ml-1 min-w-0 flex-1 truncate font-mono text-[11px] text-dark-400">{activeServer.files.currentPath}</span>
                    <button onClick={() => loadFiles(activeServer.files.currentPath)} title="刷新目录"
                      className="flex-shrink-0 rounded p-1 text-dark-400 transition-colors hover:bg-dark-800 hover:text-dark-100">
                      <RefreshCw className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <label className="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-accent-500/30 bg-accent-500/15 px-3 text-xs text-accent-300 transition-colors hover:bg-accent-500/25">
                    <Upload className="w-3.5 h-3.5" /> 上传
                    <input type="file" multiple className="hidden" onChange={e => handleFiles(e.target.files)} />
                  </label>
                  <button
                    onClick={() => handleFileOp('mkdir')}
                    title="在当前目录新建文件夹"
                    className="flex h-8 flex-shrink-0 items-center gap-1.5 rounded-lg border border-dark-700 bg-dark-800 px-2.5 text-xs text-dark-300 transition-colors hover:bg-dark-700 hover:text-dark-100"
                  >
                    <FolderPlus className="w-3.5 h-3.5" /> 新建文件夹
                  </button>
                </div>

                {/* 上传进度条 */}
                {uploadProgress && (
                  <div className="px-4 py-2 bg-dark-800/80 border border-dark-700 rounded-lg">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm text-dark-300 truncate flex-1">
                        📤 上传中: {uploadProgress.fileName}
                      </span>
                      <span className="text-xs text-dark-500 ml-2">
                        {uploadProgress.current}/{uploadProgress.total}
                      </span>
                      <button onClick={cancelUpload} className="ml-2 text-dark-500 hover:text-red-400">
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="w-full h-2 bg-dark-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-accent-500 to-accent-400 rounded-full transition-all duration-300"
                        style={{ width: `${Math.round((uploadProgress.current / uploadProgress.total) * 100)}%` }}
                      />
                    </div>
                    <p className="text-xs text-dark-500 mt-1">{Math.round((uploadProgress.current / uploadProgress.total) * 100)}%</p>
                  </div>
                )}

                {/* 文件列表 */}
                <div
                  className={`flex-1 glass rounded-xl overflow-hidden transition-colors ${dragOver ? 'border-accent-500 bg-accent-500/5' : ''}`}
                  onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleDrop}
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
                    <div
                      className="p-4 h-full overflow-y-auto"
                      onContextMenu={e => {
                        // 右键空白处 = 新建文件夹 / 刷新
                        if ((e.target as HTMLElement).closest('[data-file-item]')) return;
                        openFileMenu(e, null);
                      }}
                    >
                      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                        {/* 目录 */}
                        {activeServer.files.dirs.map((dir: RemoteDir) => (
                          <button key={dir.path}
                            data-file-item
                            onClick={() => navigateDir(dir.name)}
                            onContextMenu={e => openFileMenu(e, { kind: 'dir', path: dir.path, name: dir.name })}
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
                          <div key={file.path}
                            data-file-item
                            onContextMenu={e => openFileMenu(e, { kind: 'file', path: file.path, name: file.name })}
                            className="flex items-center gap-2 p-3 rounded-lg bg-dark-800/60 hover:bg-dark-800 transition-colors group">
                            <FileText className={`w-5 h-5 flex-shrink-0 ${file.isLog ? 'text-green-400' : 'text-dark-400'}`} />
                            {/* 文件名区域：点击加载日志，阻止冒泡 */}
                            <div className="min-w-0 flex-1 cursor-pointer" onClick={e => { e.stopPropagation(); loadLogs(file.path, logLines, logSearch); }}>
                              <div className="text-sm truncate">{file.name}</div>
                              <div className="text-xs text-dark-600">{formatSize(file.size)}</div>
                            </div>
                            {/* 编辑按钮：阻止冒泡 */}
                            <button onClick={e => { e.stopPropagation(); openInEditor(file.path); }}
                              className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-accent-500/20 text-dark-500 hover:text-accent-400 transition-all flex-shrink-0"
                              title="编辑文件">
                              <Code2 className="w-3.5 h-3.5" />
                            </button>
                            {/* 更多操作（≡）：和右键同一套菜单，不方便右键时用 */}
                            <button
                              onClick={e => {
                                e.stopPropagation();
                                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                setCtxMenu({ x: rect.left, y: rect.bottom + 4, target: { kind: 'file', path: file.path, name: file.name } });
                              }}
                              className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-dark-500 hover:bg-dark-700 hover:text-dark-200 transition-all flex-shrink-0"
                              title="更多操作（重命名 / 删除 / 复制路径…）"
                            >
                              <MoreHorizontal className="w-3.5 h-3.5" />
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
                        <button onClick={() => setActiveServer(s => s ? { ...s, selectedFile: null, logs: [] } : s)}
                          className="p-1 rounded hover:bg-dark-700 text-dark-500">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <div className="flex items-center gap-2">
                        <select value={logLines} onChange={e => { setLogLines(Number(e.target.value)); loadLogs(activeServer.selectedFile!, Number(e.target.value), logSearch); }}
                          className="h-6 rounded-md border border-dark-700 bg-dark-800 px-1.5 text-[11px] text-dark-300 focus:border-accent-500/50 focus:outline-none">
                          <option value={100}>100 行</option>
                          <option value={200}>200 行</option>
                          <option value={500}>500 行</option>
                          <option value={1000}>1000 行</option>
                        </select>
                        <div className="relative">
                          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-dark-500" />
                          <input type="text" placeholder="搜索..." value={logSearch} onChange={e => setLogSearch(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && loadLogs(activeServer.selectedFile!, logLines, logSearch)}
                            className="h-6 w-36 rounded-md border border-dark-700 bg-dark-800 pl-7 pr-2 text-[11px] text-dark-200 placeholder-dark-600 focus:border-accent-500/50 focus:outline-none" />
                        </div>
                        <button onClick={() => loadLogs(activeServer.selectedFile!, logLines, logSearch)}
                          className="flex h-6 items-center gap-1 rounded-md border border-dark-700 bg-dark-800 px-2 text-[11px] text-dark-300 transition-colors hover:bg-dark-700 hover:text-dark-100">
                          <RefreshCw className="w-3 h-3" /> 刷新
                        </button>
                        <button onClick={() => openInEditor(activeServer.selectedFile!)}
                          className="flex h-6 items-center gap-1 rounded-md border border-accent-500/30 bg-accent-500/15 px-2 text-[11px] text-accent-300 transition-colors hover:bg-accent-500/25">
                          <Code2 className="w-3 h-3" /> 编辑
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
          pwKey={pwKey}
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

      {/* AI Shell 终端弹窗 */}
      {showAIShell && activeServer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-6xl mx-4 h-[82vh]">
            <AIShellTerminal
              server={{ ...activeServer, name: activeServer.name, host: activeServer.host, port: activeServer.port, username: activeServer.username }}
              onClose={() => { setShowAIShell(false); setAiShellOpening(false); }}
              onReady={() => setAiShellOpening(false)}
            />
          </div>
        </div>
      )}

      {/* 文件右键菜单：重命名 / 删除 / 新建文件夹 / 复制移动 / 权限 */}
      {ctxMenu && (
        <FileContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          target={ctxMenu.target}
          canEdit={ctxMenu.target?.kind === 'file'}
          onEdit={ctxMenu.target ? () => openInEditor(ctxMenu.target!.path) : undefined}
          onOpen={ctxMenu.target ? () => navigateDir(ctxMenu.target!.name) : undefined}
          onOp={handleFileOp}
          onCopyPath={(p) => {
            navigator.clipboard?.writeText(p).then(
              () => showToast('路径已复制', 'success'),
              () => showToast(p, 'info'),
            );
          }}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {/* 文件操作输入框（重命名 / 新建文件夹 / 复制移动目标 / 权限） */}
      {opDialog && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
          onMouseDown={e => { if (e.target === e.currentTarget) { setOpDialog(null); setOpError(''); } }}>
          <div className="w-full max-w-md rounded-xl border border-dark-700 bg-dark-900 shadow-2xl">
            <div className="flex items-center justify-between border-b border-dark-800 px-5 py-3">
              <h3 className="text-sm font-semibold text-dark-100">{opDialog.title}</h3>
              <button onClick={() => { setOpDialog(null); setOpError(''); }}
                className="rounded p-1 text-dark-500 hover:bg-dark-800 hover:text-dark-200">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-5 py-4 space-y-2">
              {opDialog.target && (
                <p className="font-mono text-[11px] text-dark-500 break-all">{opDialog.target.path}</p>
              )}
              <label className="block text-xs text-dark-400">{opDialog.label}</label>
              <input
                autoFocus
                value={opInput}
                onChange={e => { setOpInput(e.target.value); setOpError(''); }}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !opBusy) submitOpDialog();
                  if (e.key === 'Escape') { setOpDialog(null); setOpError(''); }
                }}
                placeholder={opDialog.placeholder}
                className="w-full rounded-lg border border-dark-700 bg-dark-800 px-3 py-2 font-mono text-sm text-dark-200 placeholder-dark-600 focus:border-accent-500/50 focus:outline-none"
              />
              {opError && <p className="text-xs text-red-400">{opError}</p>}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-dark-800 px-5 py-3">
              <button onClick={() => { setOpDialog(null); setOpError(''); }}
                className="rounded-lg border border-dark-700 px-3 py-1.5 text-xs text-dark-300 hover:bg-dark-800">
                取消
              </button>
              <button onClick={submitOpDialog} disabled={opBusy}
                className="flex items-center gap-1.5 rounded-lg bg-accent-500/20 px-3 py-1.5 text-xs font-medium text-accent-300 hover:bg-accent-500/30 disabled:opacity-50">
                {opBusy ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                {opBusy ? '处理中…' : '确定'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
