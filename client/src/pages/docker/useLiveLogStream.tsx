/**
 * 容器实时日志流（WebSocket）。
 *
 * 从 pages/Docker.tsx 原样搬出，**逐字保留**：
 *   new WebSocket(withWsToken(wsUrl), wsProtocols())
 * 第二个参数是 WS 鉴权改造（token 走 Sec-WebSocket-Protocol 子协议，
 * 不再放 URL）。少一个参数服务端直接 401，不要删。
 *
 * 同一时刻只跟一个容器（liveLogKey 单值），所以 state 仍归父页面，
 * 这里用 hook 收拢连接 / 暂停 / 清空的处理逻辑。
 */

import { useCallback, useRef, useState } from 'react';
import { withWsToken, wsProtocols } from '../../api/auth';
import type { LiveLogLine } from './types';

export interface LiveLogStream {
  liveLogKey: string | null;
  liveLogLines: Record<string, LiveLogLine[]>;
  liveLogPaused: Record<string, boolean>;
  liveLogConnecting: Set<string>;
  toggleLiveLog: (sourceId: string, containerId: string) => void;
  pauseLiveLog: (key: string) => void;
  resumeLiveLog: (key: string) => void;
  clearLiveLog: (key: string) => void;
}

export function useLiveLogStream(): LiveLogStream {
  // 实时日志流
  const [liveLogKey, setLiveLogKey] = useState<string | null>(null);
  const [liveLogLines, setLiveLogLines] = useState<Record<string, LiveLogLine[]>>({});
  const [liveLogPaused, setLiveLogPaused] = useState<Record<string, boolean>>({});
  const [liveLogConnecting, setLiveLogConnecting] = useState<Set<string>>(new Set());
  const liveLogWsRef = useRef<Record<string, WebSocket>>({});

  const toggleLiveLog = useCallback((sourceId: string, containerId: string) => {
    const key = `${sourceId}:${containerId}`;
    if (liveLogKey === key) {
      // 关闭实时日志
      const ws = liveLogWsRef.current[key];
      if (ws) { ws.close(); delete liveLogWsRef.current[key]; }
      setLiveLogKey(null);
      setLiveLogPaused(prev => { const s = { ...prev }; delete s[key]; return s; });
      return;
    }

    // 如果之前有其他的 ws，先关闭
    if (liveLogKey) {
      const oldWs = liveLogWsRef.current[liveLogKey];
      if (oldWs) { oldWs.close(); delete liveLogWsRef.current[liveLogKey]; }
    }

    setLiveLogKey(key);
    setLiveLogLines(prev => ({ ...prev, [key]: [] }));
    setLiveLogConnecting(prev => new Set([...prev, key]));

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsHost = window.location.host;
    const wsUrl = `${protocol}//${wsHost}/ws/docker/logs/${sourceId}/${containerId}`;
    const ws = new WebSocket(withWsToken(wsUrl), wsProtocols());
    liveLogWsRef.current[key] = ws;

    ws.onopen = () => {
      setLiveLogConnecting(prev => { const s = new Set(prev); s.delete(key); return s; });
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'log') {
          setLiveLogLines(prev => {
            const lines = [...(prev[key] || []), data];
            // 限制最多保留 5000 条
            return { ...prev, [key]: lines.length > 5000 ? lines.slice(-5000) : lines };
          });
        } else if (data.type === 'paused') {
          setLiveLogPaused(prev => ({ ...prev, [key]: true }));
        } else if (data.type === 'resumed') {
          setLiveLogPaused(prev => ({ ...prev, [key]: false }));
        } else if (data.type === 'stream_error') {
          setLiveLogLines(prev => ({
            ...prev, [key]: [...(prev[key] || []), { timestamp: new Date().toISOString(), line: `⚠️ 错误: ${data.error}`, level: 'ERROR', content: `错误: ${data.error}` }]
          }));
        } else if (data.type === 'stream_end') {
          setLiveLogLines(prev => ({
            ...prev, [key]: [...(prev[key] || []), { timestamp: new Date().toISOString(), line: '── 日志流结束 ──', level: 'INFO', content: '日志流结束' }]
          }));
        }
      } catch {}
    };

    ws.onerror = () => {
      setLiveLogConnecting(prev => { const s = new Set(prev); s.delete(key); return s; });
      setLiveLogLines(prev => ({
        ...prev, [key]: [...(prev[key] || []), { timestamp: new Date().toISOString(), line: '⚠️ WebSocket 连接失败', level: 'ERROR', content: 'WebSocket 连接失败' }]
      }));
    };

    ws.onclose = () => {
      setLiveLogConnecting(prev => { const s = new Set(prev); s.delete(key); return s; });
      delete liveLogWsRef.current[key];
    };
  }, [liveLogKey]);

  const pauseLiveLog = useCallback((key: string) => {
    const ws = liveLogWsRef.current[key];
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'pause' }));
    }
    setLiveLogPaused(prev => ({ ...prev, [key]: true }));
  }, []);

  const resumeLiveLog = useCallback((key: string) => {
    const ws = liveLogWsRef.current[key];
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resume' }));
    }
    setLiveLogPaused(prev => ({ ...prev, [key]: false }));
  }, []);

  const clearLiveLog = useCallback((key: string) => {
    setLiveLogLines(prev => ({ ...prev, [key]: [] }));
  }, []);

  return {
    liveLogKey,
    liveLogLines,
    liveLogPaused,
    liveLogConnecting,
    toggleLiveLog,
    pauseLiveLog,
    resumeLiveLog,
    clearLiveLog,
  };
}
