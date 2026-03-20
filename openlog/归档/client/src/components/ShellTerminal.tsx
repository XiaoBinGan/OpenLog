import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Maximize2, Minimize2, Terminal, AlertCircle, Loader } from 'lucide-react';
import type { RemoteServer } from '../types';

interface ShellTerminalProps {
  server: RemoteServer;
  onClose: () => void;
}

export default function ShellTerminal({ server, onClose }: ShellTerminalProps) {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  
  const wsRef = useRef<WebSocket | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  
  // 连接 WebSocket Shell
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/shell/${server.id}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    
    ws.onopen = () => {
      setOutput(prev => [...prev, '\x1b[90m正在连接到远程服务器...\x1b[0m']);
    };
    
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        if (data.type === 'shell_ready') {
          setConnected(true);
          setError(null);
          setOutput(prev => [...prev, '\x1b[32m✓ Shell 会话已建立\x1b[0m']);
          setOutput(prev => [...prev, '\x1b[90m输入命令后按回车执行...\x1b[0m']);
          setOutput(prev => [...prev, '']);
        } else if (data.type === 'shell_output') {
          // 处理终端输出（包含 ANSI 转义码）
          setOutput(prev => [...prev, data.data]);
        } else if (data.type === 'shell_error') {
          setError(data.error);
          setOutput(prev => [...prev, `\x1b[31m错误: ${data.error}\x1b[0m`]);
        } else if (data.type === 'shell_closed') {
          setConnected(false);
          setOutput(prev => [...prev, '\x1b[33mShell 会话已关闭\x1b[0m']);
        }
      } catch (err) {
        console.error('Failed to parse shell message:', err);
      }
    };
    
    ws.onerror = () => {
      setError('WebSocket 连接失败');
      setOutput(prev => [...prev, '\x1b[31m✗ WebSocket 连接失败\x1b[0m']);
    };
    
    ws.onclose = () => {
      setConnected(false);
    };
    
    return () => {
      ws.close();
    };
  }, [server.id]);
  
  // 自动滚动到底部
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);
  
  // 发送命令
  const sendCommand = useCallback((cmd: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'input', data: cmd + '\n' }));
      
      // 添加到历史
      if (cmd.trim()) {
        setHistory(prev => [...prev, cmd]);
        setHistoryIndex(-1);
      }
    }
  }, []);
  
  // 处理输入
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      sendCommand(input);
      setInput('');
    } else if (e.key === 'ArrowUp') {
      // 上一条历史命令
      e.preventDefault();
      if (history.length > 0) {
        const newIndex = historyIndex < history.length - 1 ? historyIndex + 1 : historyIndex;
        setHistoryIndex(newIndex);
        setInput(history[history.length - 1 - newIndex] || '');
      }
    } else if (e.key === 'ArrowDown') {
      // 下一条历史命令
      e.preventDefault();
      if (historyIndex > 0) {
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        setInput(history[history.length - 1 - newIndex] || '');
      } else {
        setHistoryIndex(-1);
        setInput('');
      }
    } else if (e.key === 'Tab') {
      // Tab 补全（简单实现）
      e.preventDefault();
    } else if (e.ctrlKey && e.key === 'c') {
      // Ctrl+C 中断
      sendCommand('\x03');
      setInput('');
    } else if (e.ctrlKey && e.key === 'd') {
      // Ctrl+D 退出
      sendCommand('\x04');
    }
  };
  
  // 解析 ANSI 转义码并渲染
  const renderOutput = (text: string) => {
    // 简单的 ANSI 颜色转换
    return text
      .replace(/\x1b\[90m/g, '<span class="text-gray-500">')
      .replace(/\x1b\[32m/g, '<span class="text-green-500">')
      .replace(/\x1b\[31m/g, '<span class="text-red-500">')
      .replace(/\x1b\[33m/g, '<span class="text-yellow-500">')
      .replace(/\x1b\[34m/g, '<span class="text-blue-400">')
      .replace(/\x1b\[36m/g, '<span class="text-cyan-400">')
      .replace(/\x1b\[1m/g, '<span class="font-bold">')
      .replace(/\x1b\[0m/g, '</span>')
      .replace(/\x1b\[[0-9;]*m/g, ''); // 移除其他 ANSI 转义码
  };
  
  return (
    <div 
      className={`${
        isFullscreen 
          ? 'fixed inset-4 z-50' 
          : 'relative'
      } bg-dark-950 border border-dark-700 rounded-xl overflow-hidden flex flex-col`}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-dark-900 border-b border-dark-700">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-accent-500" />
          <span className="font-mono text-sm">{server.name}</span>
          <span className="text-xs text-dark-400">@ {server.host}</span>
        </div>
        
        <div className="flex items-center gap-2">
          {/* 状态指示 */}
          {connected ? (
            <span className="flex items-center gap-1 text-xs text-green-400">
              <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
              已连接
            </span>
          ) : error ? (
            <span className="flex items-center gap-1 text-xs text-red-400">
              <AlertCircle className="w-3 h-3" />
              {error}
            </span>
          ) : (
            <span className="flex items-center gap-1 text-xs text-yellow-400">
              <Loader className="w-3 h-3 animate-spin" />
              连接中
            </span>
          )}
          
          {/* 全屏按钮 */}
          <button
            onClick={() => setIsFullscreen(!isFullscreen)}
            className="p-1 hover:bg-dark-800 rounded"
          >
            {isFullscreen ? (
              <Minimize2 className="w-4 h-4 text-dark-400" />
            ) : (
              <Maximize2 className="w-4 h-4 text-dark-400" />
            )}
          </button>
          
          {/* 关闭按钮 */}
          <button
            onClick={onClose}
            className="p-1 hover:bg-dark-800 rounded"
          >
            <X className="w-4 h-4 text-dark-400" />
          </button>
        </div>
      </div>
      
      {/* Terminal Output */}
      <div 
        ref={outputRef}
        className="flex-1 overflow-y-auto p-4 font-mono text-sm leading-relaxed bg-dark-950"
        onClick={() => inputRef.current?.focus()}
      >
        {output.map((line, i) => (
          <div 
            key={i}
            className="whitespace-pre-wrap break-all"
            dangerouslySetInnerHTML={{ __html: renderOutput(line) }}
          />
        ))}
        
        {output.length === 0 && !error && (
          <div className="text-dark-500">正在连接...</div>
        )}
      </div>
      
      {/* Input */}
      <div className="flex items-center gap-2 px-4 py-3 bg-dark-900 border-t border-dark-700">
        <span className="text-green-400 font-mono">$</span>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!connected}
          placeholder={connected ? "输入命令..." : "等待连接..."}
          className="flex-1 bg-transparent outline-none font-mono text-sm disabled:opacity-50"
          autoFocus
        />
      </div>
      
      {/* 快捷命令 */}
      <div className="flex items-center gap-2 px-4 py-2 bg-dark-900 border-t border-dark-700">
        <span className="text-xs text-dark-500">快捷:</span>
        <button
          onClick={() => sendCommand('ls -lah')}
          disabled={!connected}
          className="px-2 py-1 text-xs bg-dark-800 hover:bg-dark-700 rounded disabled:opacity-50"
        >
          ls -lah
        </button>
        <button
          onClick={() => sendCommand('df -h')}
          disabled={!connected}
          className="px-2 py-1 text-xs bg-dark-800 hover:bg-dark-700 rounded disabled:opacity-50"
        >
          df -h
        </button>
        <button
          onClick={() => sendCommand('free -h')}
          disabled={!connected}
          className="px-2 py-1 text-xs bg-dark-800 hover:bg-dark-700 rounded disabled:opacity-50"
        >
          free -h
        </button>
        <button
          onClick={() => sendCommand('top -n 1 | head -20')}
          disabled={!connected}
          className="px-2 py-1 text-xs bg-dark-800 hover:bg-dark-700 rounded disabled:opacity-50"
        >
          top
        </button>
        <button
          onClick={() => sendCommand('tail -n 50 /var/log/syslog')}
          disabled={!connected}
          className="px-2 py-1 text-xs bg-dark-800 hover:bg-dark-700 rounded disabled:opacity-50"
        >
          syslog
        </button>
      </div>
    </div>
  );
}
