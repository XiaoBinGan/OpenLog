/**
 * RemoteContext — 全局远程服务器状态管理
 * 解决切换页面后连接状态丢失的问题
 */
import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import type { RemoteServer, RemoteFileList, RemoteFile, Log } from '../types';

interface RemoteServerState extends RemoteServer {
  // 连接后的实时数据
  systemStats: Record<string, string> | null;
  files: RemoteFileList;
  selectedFile: string | null;
  fileContent: string;        // 编辑器内容
  fileModified: boolean;       // 是否已修改
  logs: Log[];
  logsLoading: boolean;
  filesLoading: boolean;
  editingFilePath: string | null;  // 当前在编辑器中打开的文件路径
}

interface RemoteContextValue {
  // 服务器列表（全局）
  servers: RemoteServer[];
  // 当前连接的服务器（全局唯一）
  activeServer: RemoteServerState | null;
  setActiveServer: React.Dispatch<React.SetStateAction<RemoteServerState | null>>;
  connect: (server: RemoteServer) => Promise<void>;
  disconnect: () => Promise<void>;
  refreshServers: () => Promise<void>;
  // 文件操作
  loadFiles: (path?: string) => Promise<void>;
  navigateDir: (name: string) => Promise<void>;
  goUp: () => Promise<void>;
  // 日志
  loadLogs: (filePath: string, lines?: number, search?: string) => Promise<void>;
  // 文件编辑器
  openInEditor: (filePath: string) => Promise<void>;
  updateFileContent: (content: string) => void;
  saveFile: () => Promise<{ success: boolean; error?: string }>;
  closeEditor: () => void;
  // 上传
  uploadFile: (localFile: File, remoteDir: string) => Promise<{ success: boolean; error?: string }>;
  // Toast
  toast: ToastMsg | null;
  clearToast: () => void;
}

interface ToastMsg {
  id: string;
  type: 'success' | 'error' | 'info';
  message: string;
}

const RemoteContext = createContext<RemoteContextValue | null>(null);

export function RemoteProvider({ children }: { children: React.ReactNode }) {
  const [servers, setServers] = useState<RemoteServer[]>([]);
  const [activeServer, setActiveServer] = useState<RemoteServerState | null>(null);
  const [toast, setToast] = useState<ToastMsg | null>(null);

  const showToast = useCallback((type: ToastMsg['type'], message: string) => {
    const id = `${Date.now()}`;
    setToast({ id, type, message });
    setTimeout(() => setToast(prev => prev?.id === id ? null : prev), 4000);
  }, []);

  const clearToast = useCallback(() => setToast(null), []);

  // 加载服务器列表
  const refreshServers = useCallback(async () => {
    try {
      const res = await fetch('/api/remote/servers');
      if (res.ok) {
        const data = await res.json();
        setServers(data.servers || []);
      }
    } catch {}
  }, []);

  useEffect(() => { refreshServers(); }, [refreshServers]);

  // 自动重连：切换页面回来时恢复连接
  useEffect(() => {
    if (!activeServer || activeServer.status !== 'connected') return;
    // 每 30s 刷新服务器状态（保持心跳）
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/remote/servers');
        if (res.ok) {
          const data = await res.json();
          setServers(data.servers || []);
          const updated = data.servers?.find((s: RemoteServer) => s.id === activeServer.id);
          if (updated && updated.status === 'connected') {
            setActiveServer(prev => prev ? { ...prev, ...updated } : prev);
          } else if (updated && updated.status !== 'connected') {
            // 连接被服务端断开，重置状态
            setActiveServer(null);
          }
        }
      } catch {}
    }, 30000);
    return () => clearInterval(interval);
  }, [activeServer?.id, activeServer?.status]);

  // 连接服务器
  const connect = useCallback(async (server: RemoteServer) => {
    try {
      const res = await fetch(`/api/remote/servers/${server.id}/connect`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error || '连接失败');

      const connectedServer: RemoteServerState = {
        ...server,
        status: 'connected',
        systemStats: null,
        files: { files: [], dirs: [], currentPath: server.logPath },
        selectedFile: null,
        fileContent: '',
        fileModified: false,
        logs: [],
        logsLoading: false,
        filesLoading: false,
        editingFilePath: null,
      };
      setActiveServer(connectedServer);
      showToast('success', `已连接到 ${server.name}`);
      refreshServers();
    } catch (err: any) {
      showToast('error', `连接失败: ${err.message}`);
      throw err;
    }
  }, [refreshServers, showToast]);

  // 断开连接
  const disconnect = useCallback(async () => {
    if (!activeServer) return;
    try {
      await fetch(`/api/remote/servers/${activeServer.id}/disconnect`, { method: 'POST' });
      showToast('info', `已断开 ${activeServer.name}`);
      setActiveServer(null);
      refreshServers();
    } catch (err: any) {
      showToast('error', `断开失败: ${err.message}`);
    }
  }, [activeServer, refreshServers, showToast]);

  // 加载文件列表
  const loadFiles = useCallback(async (filePath?: string) => {
    if (!activeServer) return;
    const path = filePath || activeServer.files.currentPath;
    setActiveServer(prev => prev ? { ...prev, filesLoading: true } : prev);
    try {
      const res = await fetch(`/api/remote/servers/${activeServer.id}/files?path=${encodeURIComponent(path)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: RemoteFileList = await res.json();
      setActiveServer(prev => prev ? { ...prev, files: data, filesLoading: false } : prev);
    } catch (err: any) {
      setActiveServer(prev => prev ? { ...prev, files: { files: [], dirs: [], currentPath: path, error: err.message }, filesLoading: false } : prev);
    }
  }, [activeServer?.id]);

  // 进入目录
  const navigateDir = useCallback(async (name: string) => {
    if (!activeServer) return;
    const base = activeServer.files.currentPath;
    const newPath = base === '/' ? `/${name}` : `${base}/${name}`;
    await loadFiles(newPath);
  }, [activeServer, loadFiles]);

  // 返回上级目录
  const goUp = useCallback(async () => {
    if (!activeServer) return;
    const parts = activeServer.files.currentPath.split('/').filter(Boolean);
    if (parts.length <= 1) { await loadFiles('/'); return; }
    parts.pop();
    await loadFiles('/' + parts.join('/'));
  }, [activeServer, loadFiles]);

  // 加载日志
  const loadLogs = useCallback(async (filePath: string, lines = 200, search = '') => {
    if (!activeServer) return;
    setActiveServer(prev => prev ? { ...prev, selectedFile: filePath, logsLoading: true } : prev);
    try {
      const params = new URLSearchParams({ file: filePath, lines: String(lines) });
      if (search) params.append('search', search);
      const res = await fetch(`/api/remote/servers/${activeServer.id}/logs?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setActiveServer(prev => prev ? { ...prev, logs: data.logs || [], logsLoading: false } : prev);
    } catch (err: any) {
      setActiveServer(prev => prev ? { ...prev, logs: [], logsLoading: false } : prev);
    }
  }, [activeServer?.id]);

  // 在编辑器中打开文件
  const openInEditor = useCallback(async (filePath: string) => {
    if (!activeServer) return;
    try {
      const res = await fetch(`/api/remote/servers/${activeServer.id}/file/read?path=${encodeURIComponent(filePath)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setActiveServer(prev => prev ? {
        ...prev,
        fileContent: data.content || '',
        fileModified: false,
        editingFilePath: filePath,
        selectedFile: filePath,
      } : prev);
      showToast('info', `已打开: ${filePath.split('/').pop()}`);
    } catch (err: any) {
      showToast('error', `打开文件失败: ${err.message}`);
    }
  }, [activeServer?.id, showToast]);

  const updateFileContent = useCallback((content: string) => {
    setActiveServer(prev => prev ? { ...prev, fileContent: content, fileModified: true } : prev);
  }, []);

  // 保存文件
  const saveFile = useCallback(async () => {
    if (!activeServer || !activeServer.editingFilePath) {
      return { success: false, error: '没有打开的文件' };
    }
    try {
      const res = await fetch(`/api/remote/servers/${activeServer.id}/file/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: activeServer.editingFilePath, content: activeServer.fileContent }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setActiveServer(prev => prev ? { ...prev, fileModified: false } : prev);
      showToast('success', `✅ 保存成功: ${activeServer.editingFilePath.split('/').pop()}`);
      return { success: true };
    } catch (err: any) {
      showToast('error', `❌ 保存失败: ${err.message}`);
      return { success: false, error: err.message };
    }
  }, [activeServer?.id, activeServer?.editingFilePath, activeServer?.fileContent, showToast]);

  const closeEditor = useCallback(() => {
    setActiveServer(prev => prev ? { ...prev, editingFilePath: null, fileContent: '', fileModified: false } : prev);
  }, []);

  // 上传文件
  const uploadFile = useCallback(async (localFile: File, remoteDir: string) => {
    if (!activeServer) return { success: false, error: '未连接服务器' };
    try {
      const buffer = await localFile.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
      const remotePath = remoteDir === '/' ? `/${localFile.name}` : `${remoteDir}/${localFile.name}`;
      const res = await fetch(`/api/remote/servers/${activeServer.id}/file/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: remotePath, content: base64, name: localFile.name }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast('success', `✅ 上传成功: ${localFile.name} → ${remotePath}`);
      await loadFiles(remoteDir);
      return { success: true };
    } catch (err: any) {
      showToast('error', `❌ 上传失败: ${err.message}`);
      return { success: false, error: err.message };
    }
  }, [activeServer?.id, loadFiles, showToast]);

  return (
    <RemoteContext.Provider value={{
      servers,
      activeServer,
      setActiveServer,
      connect,
      disconnect,
      refreshServers,
      loadFiles,
      navigateDir,
      goUp,
      loadLogs,
      openInEditor,
      updateFileContent,
      saveFile,
      closeEditor,
      uploadFile,
      toast,
      clearToast,
    }}>
      {children}
    </RemoteContext.Provider>
  );
}

export function useRemote() {
  const ctx = useContext(RemoteContext);
  if (!ctx) throw new Error('useRemote must be used inside RemoteProvider');
  return ctx;
}
