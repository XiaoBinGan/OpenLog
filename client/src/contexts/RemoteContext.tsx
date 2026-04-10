/**
 * RemoteContext — 全局远程服务器状态管理（重构版）
 * 修复：闭包陈旧、状态竞态、内存泄漏
 */
import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import type { RemoteServer, RemoteServerState, RemoteFileList, Log } from '../types';

interface RemoteContextValue {
  servers: RemoteServer[];
  activeServer: RemoteServerState | null;
  setActiveServer: React.Dispatch<React.SetStateAction<RemoteServerState | null>>;
  connect: (server: RemoteServer) => Promise<void>;
  disconnect: () => Promise<void>;
  refreshServers: () => Promise<void>;
  loadFiles: (path?: string) => Promise<void>;
  navigateDir: (name: string) => Promise<void>;
  goUp: () => Promise<void>;
  loadLogs: (filePath: string, lines?: number, search?: string) => Promise<void>;
  openInEditor: (filePath: string) => Promise<void>;
  updateFileContent: (content: string) => void;
  saveFile: () => Promise<{ success: boolean; error?: string }>;
  closeEditor: () => void;
  uploadFile: (localFile: File, remoteDir: string) => Promise<{ success: boolean; error?: string }>;
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

  // 用 ref 追踪最新 activeServer，避免闭包陈旧
  const activeServerRef = useRef(activeServer);
  useEffect(() => { activeServerRef.current = activeServer; }, [activeServer]);

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

  useEffect(() => {
    refreshServers();
  }, [refreshServers]);

  // 心跳：仅刷新服务器列表，不 touch activeServer
  useEffect(() => {
    const interval = setInterval(refreshServers, 30000);
    return () => clearInterval(interval);
  }, [refreshServers]);

  // 连接服务器
  const connect = useCallback(async (server: RemoteServer) => {
    try {
      const res = await fetch(`/api/remote/servers/${server.id}/connect`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error || '连接失败');

      // 拉取 stats
      let systemStats: Record<string, string> | null = null;
      try {
        const statsRes = await fetch(`/api/remote/servers/${server.id}/stats`);
        if (statsRes.ok) systemStats = await statsRes.json();
      } catch {}

      const connectedServer: RemoteServerState = {
        ...server,
        status: 'connected',
        systemStats,
        files: { files: [], dirs: [], currentPath: server.logPath?.replace(/\/$/, '') || '/var/log' },
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

  // 断开连接：用 ref 获取最新状态
  const disconnect = useCallback(async () => {
    const server = activeServerRef.current;
    if (!server) return;
    const { id, name } = server;
    try {
      await fetch(`/api/remote/servers/${id}/disconnect`, { method: 'POST' });
      showToast('info', `已断开 ${name}`);
      setActiveServer(null);
      refreshServers();
    } catch (err: any) {
      showToast('error', `断开失败: ${err.message}`);
    }
  }, [refreshServers, showToast]);

  // 加载文件列表：用 ref 获取最新 ID
  const loadFiles = useCallback(async (filePath?: string) => {
    const server = activeServerRef.current;
    if (!server) return;
    const serverId = server.id;
    const path = filePath || server.files.currentPath;
    setActiveServer(prev => prev ? { ...prev, filesLoading: true } : prev);
    try {
      const res = await fetch(`/api/remote/servers/${serverId}/files?path=${encodeURIComponent(path)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: RemoteFileList = await res.json();
      setActiveServer(prev => {
        if (!prev || prev.id !== serverId) return prev; // 确保不覆盖其他服务器
        return { ...prev, files: data, filesLoading: false };
      });
    } catch (err: any) {
      setActiveServer(prev => prev ? { ...prev, files: { files: [], dirs: [], currentPath: path, error: err.message }, filesLoading: false } : prev);
    }
  }, []);

  // 进入目录
  const navigateDir = useCallback(async (name: string) => {
    const server = activeServerRef.current;
    if (!server) return;
    const base = server.files.currentPath;
    const newPath = base === '/' ? `/${name}` : `${base}/${name}`;
    await loadFiles(newPath);
  }, [loadFiles]);

  // 返回上级
  const goUp = useCallback(async () => {
    const server = activeServerRef.current;
    if (!server) return;
    const parts = server.files.currentPath.split('/').filter(Boolean);
    if (parts.length <= 1) { await loadFiles('/'); return; }
    parts.pop();
    await loadFiles('/' + parts.join('/'));
  }, [loadFiles]);

  // 加载日志
  const loadLogs = useCallback(async (filePath: string, lines = 200, search = '') => {
    const server = activeServerRef.current;
    if (!server) return;
    const serverId = server.id;
    setActiveServer(prev => prev ? { ...prev, selectedFile: filePath, logsLoading: true } : prev);
    try {
      const params = new URLSearchParams({ file: filePath, lines: String(lines) });
      if (search) params.append('search', search);
      const res = await fetch(`/api/remote/servers/${serverId}/logs?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setActiveServer(prev => {
        if (!prev || prev.id !== serverId) return prev;
        return { ...prev, logs: data.logs || [], logsLoading: false };
      });
    } catch {
      setActiveServer(prev => prev ? { ...prev, logs: [], logsLoading: false } : prev);
    }
  }, []);

  // 编辑器打开
  const openInEditor = useCallback(async (filePath: string) => {
    const server = activeServerRef.current;
    if (!server) return;
    const serverId = server.id;
    try {
      const res = await fetch(`/api/remote/servers/${serverId}/file/read?path=${encodeURIComponent(filePath)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setActiveServer(prev => {
        if (!prev || prev.id !== serverId) return prev;
        return {
          ...prev,
          fileContent: data.content || '',
          fileModified: false,
          editingFilePath: filePath,
          selectedFile: filePath,
        };
      });
      showToast('info', `已打开: ${filePath.split('/').pop()}`);
    } catch (err: any) {
      showToast('error', `打开文件失败: ${err.message}`);
    }
  }, [showToast]);

  const updateFileContent = useCallback((content: string) => {
    setActiveServer(prev => prev ? { ...prev, fileContent: content, fileModified: true } : prev);
  }, []);

  // 保存文件
  const saveFile = useCallback(async () => {
    const server = activeServerRef.current;
    if (!server || !server.editingFilePath) return { success: false, error: '没有打开的文件' };
    const { id, editingFilePath, fileContent } = server;
    try {
      const res = await fetch(`/api/remote/servers/${id}/file/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: editingFilePath, content: fileContent }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setActiveServer(prev => prev ? { ...prev, fileModified: false } : prev);
      showToast('success', `✅ 保存成功: ${editingFilePath.split('/').pop()}`);
      return { success: true };
    } catch (err: any) {
      showToast('error', `❌ 保存失败: ${err.message}`);
      return { success: false, error: err.message };
    }
  }, [showToast]);

  const closeEditor = useCallback(() => {
    setActiveServer(prev => prev ? { ...prev, editingFilePath: null, fileContent: '', fileModified: false } : prev);
  }, []);

  // 上传文件
  const uploadFile = useCallback(async (localFile: File, remoteDir: string) => {
    const server = activeServerRef.current;
    if (!server) return { success: false, error: '未连接服务器' };
    const serverId = server.id;
    try {
      const buffer = await localFile.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
      const remotePath = remoteDir === '/' ? `/${localFile.name}` : `${remoteDir}/${localFile.name}`;
      const res = await fetch(`/api/remote/servers/${serverId}/file/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: remotePath, content: base64, name: localFile.name }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast('success', `✅ 上传成功: ${localFile.name}`);
      await loadFiles(remoteDir);
      return { success: true };
    } catch (err: any) {
      showToast('error', `❌ 上传失败: ${err.message}`);
      return { success: false, error: err.message };
    }
  }, [loadFiles, showToast]);

  // Stats 轮询：用 ref 确保不陈旧
  useEffect(() => {
    if (!activeServer || activeServer.status !== 'connected') return;
    
    const fetchStats = async () => {
      const server = activeServerRef.current;
      if (!server || server.status !== 'connected') return;
      
      try {
        const res = await fetch(`/api/remote/servers/${server.id}/stats`);
        if (res.ok) {
          const stats: Record<string, string> = await res.json();
          setActiveServer(prev => {
            if (!prev || prev.id !== server.id) return prev;
            return { ...prev, systemStats: stats };
          });
        }
      } catch {}
    };

    fetchStats();
    const interval = setInterval(fetchStats, 10000);
    return () => clearInterval(interval);
  }, [activeServer?.id, activeServer?.status]);

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
