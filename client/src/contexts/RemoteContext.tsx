/**
 * RemoteContext — 全局远程服务器状态管理（重构版）
 * 修复：闭包陈旧、状态竞态、内存泄漏
 */
import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import type { RemoteServer, RemoteServerState, RemoteFileList, Log } from '../types';
import { useDevice } from './DeviceContext';

interface RemoteContextValue {
  servers: RemoteServer[];
  activeServer: RemoteServerState | null;
  setActiveServer: React.Dispatch<React.SetStateAction<RemoteServerState | null>>;
  selectServer: (server: RemoteServer) => void;
  connect: (server: RemoteServer) => Promise<void>;
  disconnect: (serverId?: string) => Promise<void>;
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
  uploadProgress: { current: number; total: number; fileName: string } | null;
  cancelUpload: () => void;
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
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number; fileName: string } | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const loadingRef = useRef(false); // 防并发导航锁

  // 用 ref 追踪最新 activeServer，避免闭包陈旧
  const activeServerRef = useRef(activeServer);
  useEffect(() => { activeServerRef.current = activeServer; }, [activeServer]);

  // 同步 DeviceContext，断开时切回本地
  const { resetToLocal, setSelectedDevice, refreshDevices } = useDevice();

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

  // 选中服务器（纯前端状态切换，不发起连接）
  const selectServer = useCallback((server: RemoteServer) => {
    if (server.status !== 'connected') {
      setActiveServer(null);
    } else {
      const latest = servers.find(s => s.id === server.id) ?? server;
      setActiveServer(prev => {
        if (prev?.id === latest.id) return prev;
        return {
          ...latest,
          status: 'connected',
          systemStats: prev?.systemStats ?? null,
          files: prev?.files ?? { files: [], dirs: [], currentPath: latest.logPath?.replace(/\/$/, '') || '/var/log' },
          selectedFile: null,
          fileContent: '',
          fileModified: false,
          logs: [],
          totalLines: 0,
          logsLoading: false,
          filesLoading: false,
          editingFilePath: null,
        };
      });
    }
  }, [servers]);

  // 连接服务器
  const connect = useCallback(async (server: RemoteServer) => {
    try {
      const res = await fetch(`/api/remote/servers/${server.id}/connect`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (!data.success) throw new Error(data.error || '连接失败');

      // 拉取 stats
      let systemStats: Record<string, string> | null = null;
      try {
        const statsRes = await fetch(`/api/remote/servers/${server.id}/stats`);
        if (statsRes.ok) systemStats = await statsRes.json();
      } catch {}

      const initPath = server.logPath?.replace(/\/$/, '') || '/var/log';
      const connectedServer: RemoteServerState = {
        ...server,
        status: 'connected',
        systemStats,
        files: { files: [], dirs: [], currentPath: initPath },
        selectedFile: null,
        fileContent: '',
        fileModified: false,
        logs: [],
        totalLines: 0,
        logsLoading: false,
        filesLoading: true,
        editingFilePath: null,
      };
      setActiveServer(connectedServer);
      setSelectedDevice(server);

      // 立即加载初始目录文件（不靠 useEffect，避免时序问题）
      try {
        const filesRes = await fetch(`/api/remote/servers/${server.id}/files?path=${encodeURIComponent(initPath)}`);
        if (filesRes.ok) {
          const fileData = await filesRes.json();
          setActiveServer(prev => {
            if (!prev || prev.id !== server.id) return prev;
            return { ...prev, files: fileData, filesLoading: false };
          });
        } else {
          setActiveServer(prev => prev && prev.id === server.id ? { ...prev, filesLoading: false } : prev);
        }
      } catch {
        setActiveServer(prev => prev && prev.id === server.id ? { ...prev, filesLoading: false } : prev);
      }

      showToast('success', `已连接到 ${server.name}`);
      refreshServers();
      refreshDevices(); // 立即更新右上角设备列表
    } catch (err: any) {
      showToast('error', `连接失败: ${err.message}`);
      throw err;
    }
  }, [refreshServers, showToast]);

  // 断开连接：支持传入指定 serverId，否则断开当前活跃服务器
  const disconnect = useCallback(async (serverId?: string) => {
    // 优先用传入的 id，找到对应服务器信息
    const targetId = serverId || activeServerRef.current?.id;
    if (!targetId) return;

    // 从 servers 列表或 activeServer 里找名字
    const name = activeServerRef.current?.id === targetId
      ? activeServerRef.current.name
      : (servers.find(s => s.id === targetId)?.name ?? targetId);

    try {
      await fetch(`/api/remote/servers/${targetId}/disconnect`, { method: 'POST' });
      showToast('info', `已断开 ${name}`);
      // 只有断开的是当前活跃服务器时才清空 activeServer
      if (activeServerRef.current?.id === targetId) {
        setActiveServer(null);
        resetToLocal(); // 同步 DeviceContext 切回本地
      }
      refreshServers();
      refreshDevices(); // 立即更新右上角设备列表
    } catch (err: any) {
      showToast('error', `断开失败: ${err.message}`);
    }
  }, [servers, refreshServers, refreshDevices, showToast, resetToLocal]);

  // 加载文件列表：用 ref 获取最新 ID
  // 路径规范化：消除多余的 /
  const normPath = (p: string) => '/' + p.split('/').filter(Boolean).join('/');

  const loadFiles = useCallback(async (filePath?: string) => {
    const server = activeServerRef.current;
    if (!server || loadingRef.current) return;
    loadingRef.current = true;
    const serverId = server.id;
    const path = normPath(filePath || server.files.currentPath);
    setActiveServer(prev => prev ? { ...prev, filesLoading: true } : prev);
    try {
      const res = await fetch(`/api/remote/servers/${serverId}/files?path=${encodeURIComponent(path)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: RemoteFileList = await res.json();
      setActiveServer(prev => {
        if (!prev || prev.id !== serverId) return prev;
        return { ...prev, files: data, filesLoading: false };
      });
    } catch (err: any) {
      setActiveServer(prev => prev ? { ...prev, files: { files: [], dirs: [], currentPath: path, error: err.message }, filesLoading: false } : prev);
    } finally {
      loadingRef.current = false;
    }
  }, []);

  // 进入目录
  const navigateDir = useCallback(async (name: string) => {
    const server = activeServerRef.current;
    if (!server) return;
    const base = normPath(server.files.currentPath);
    const newPath = base === '/' ? `/${name}` : `${base}/${name}`;
    await loadFiles(normPath(newPath));
  }, [loadFiles]);

  // 返回上级
  const goUp = useCallback(async () => {
    const server = activeServerRef.current;
    if (!server) return;
    const parts = normPath(server.files.currentPath).split('/').filter(Boolean);
    if (parts.length === 0) { await loadFiles('/'); return; }
    parts.pop();
    await loadFiles(parts.length === 0 ? '/' : '/' + parts.join('/'));
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
        return { ...prev, logs: data.logs || [], totalLines: data.totalLines ?? 0, logsLoading: false };
      });
    } catch {
      setActiveServer(prev => prev ? { ...prev, logs: [], totalLines: 0, logsLoading: false } : prev);
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

  // 上传文件（分片上传）
  const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB

  const cancelUpload = useCallback(() => {
    uploadAbortRef.current?.abort();
    setUploadProgress(null);
  }, []);

  const uploadFile = useCallback(async (localFile: File, remoteDir: string) => {
    const server = activeServerRef.current;
    if (!server) return { success: false, error: '未连接服务器' };
    const serverId = server.id;

    const abort = new AbortController();
    uploadAbortRef.current = abort;

    const remotePath = remoteDir === '/' ? `/${localFile.name}` : `${remoteDir}/${localFile.name}`;
    const totalChunks = Math.ceil(localFile.size / CHUNK_SIZE);
    setUploadProgress({ current: 0, total: totalChunks, fileName: localFile.name });

    const MAX_RETRIES = 3;

    try {
      // 1. 初始化
      const initRes = await fetch(`/api/remote/servers/${serverId}/file/upload/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: remotePath, fileSize: localFile.size }),
        signal: abort.signal,
      });
      const initData = await initRes.json();
      if (initData.error) throw new Error(initData.error);
      const { uploadId } = initData;

      // 2. 逐片上传
      for (let i = 0; i < totalChunks; i++) {
        if (abort.signal.aborted) throw new DOMException('Aborted', 'AbortError');

        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, localFile.size);
        const blob = localFile.slice(start, end);
        const arrayBuf = await blob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuf);
        // 手动 base64 编码（大文件避免 btoa 栈溢出）
        let base64 = '';
        for (let j = 0; j < bytes.length; j += 4096) {
          const slice = bytes.subarray(j, j + 4096);
          base64 += String.fromCharCode(...slice);
        }
        base64 = btoa(base64);

        // 带重试
        let lastErr = '';
        for (let retry = 0; retry < MAX_RETRIES; retry++) {
          try {
            const chunkRes = await fetch(`/api/remote/servers/${serverId}/file/upload/chunk`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ uploadId, chunkIndex: i, data: base64 }),
              signal: abort.signal,
            });
            const chunkData = await chunkRes.json();
            if (chunkData.error) throw new Error(chunkData.error);
            setUploadProgress({ current: i + 1, total: totalChunks, fileName: localFile.name });
            break;
          } catch (err: any) {
            if (err.name === 'AbortError') throw err;
            lastErr = err.message;
            if (retry < MAX_RETRIES - 1) await new Promise(r => setTimeout(r, 1000 * (retry + 1)));
          }
        }
        if (lastErr && !abort.signal.aborted) throw new Error(`分片 ${i + 1}/${totalChunks} 上传失败: ${lastErr}`);
      }

      // 3. 完成合并
      const completeRes = await fetch(`/api/remote/servers/${serverId}/file/upload/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId, totalChunks }),
        signal: abort.signal,
      });
      const completeData = await completeRes.json();
      if (completeData.error) throw new Error(completeData.error);

      setUploadProgress(null);
      showToast('success', `✅ 上传成功: ${localFile.name}${completeData.warning ? ' ⚠️ ' + completeData.warning : ''}`);
      await loadFiles(remoteDir);
      return { success: true };
    } catch (err: any) {
      setUploadProgress(null);
      if (err.name === 'AbortError') {
        // 清理远程会话
        try { await fetch(`/api/remote/servers/${serverId}/file/upload/cancel`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uploadId: '' }),
        }); } catch (_) {}
        showToast('info', '上传已取消');
        return { success: false, error: '已取消' };
      }
      showToast('error', `❌ 上传失败: ${err.message}`);
      return { success: false, error: err.message };
    } finally {
      uploadAbortRef.current = null;
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
          const stats: Record<string, any> = await res.json();
          setActiveServer(prev => {
            if (!prev || prev.id !== server.id) return prev;
            return { ...prev, systemStats: stats };
          });
        } else {
          // stats API 失败（如 SSH 已断开），清理连接状态
          setActiveServer(null);
          resetToLocal();
          refreshServers();
        }
      } catch {
        // 网络错误，同样清理状态
        setActiveServer(null);
        resetToLocal();
        refreshServers();
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 10000);
    return () => clearInterval(interval);
  }, [activeServer?.id, activeServer?.status, refreshServers]);

  return (
    <RemoteContext.Provider value={{
      servers,
      activeServer,
      setActiveServer,
      selectServer,
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
      uploadProgress,
      cancelUpload,
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
