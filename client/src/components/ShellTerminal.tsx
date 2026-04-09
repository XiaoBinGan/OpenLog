import { useState, useEffect, useRef, useCallback } from 'react';
import {
  X, Maximize2, Minimize2, Terminal, AlertCircle, Loader,
  Upload, FileText, ChevronDown, ChevronUp, Wifi, WifiOff,
  Download, Info, Keyboard, Command
} from 'lucide-react';
import type { RemoteServer } from '../types';

interface ShellTerminalProps {
  server: RemoteServer;
  onClose: () => void;
}

// SSH 快捷命令
const QUICK_CMDS = [
  { label: 'ls -lah', cmd: 'ls -lah' },
  { label: 'df -h', cmd: 'df -h' },
  { label: 'free -m', cmd: 'free -m' },
  { label: 'top -n1', cmd: 'top -bn1 | head -20' },
  { label: 'ps aux', cmd: 'ps aux | head -20' },
  { label: 'netstat', cmd: 'netstat -tlnp 2>/dev/null | head -20' },
  { label: 'journalctl', cmd: 'journalctl -n 30 --no-pager' },
  { label: 'syslog', cmd: 'tail -n 50 /var/log/syslog' },
];

// 快捷键说明
const SHORTCUTS = [
  { keys: '↑ / ↓', desc: '历史命令' },
  { keys: 'Tab', desc: '自动补全' },
  { keys: 'Ctrl+C', desc: '中断当前' },
  { keys: 'Ctrl+D', desc: '退出会话' },
  { keys: 'Ctrl+L', desc: '清屏' },
];

// 简单的 ANSI 颜色渲染
function ansiToHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\x1b\[90m/g, '<span class="text-gray-500">')
    .replace(/\x1b\[32m/g, '<span class="text-green-400">')
    .replace(/\x1b\[31m/g, '<span class="text-red-400">')
    .replace(/\x1b\[33m/g, '<span class="text-yellow-400">')
    .replace(/\x1b\[34m/g, '<span class="text-blue-400">')
    .replace(/\x1b\[36m/g, '<span class="text-cyan-400">')
    .replace(/\x1b\[1;32m/g, '<span class="text-green-300 font-bold">')
    .replace(/\x1b\[1m/g, '<span class="font-bold">')
    .replace(/\x1b\[0m/g, '</span>')
    .replace(/\x1b\[[0-9;]*m/g, '');
}

export default function ShellTerminal({ server, onClose }: ShellTerminalProps) {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showHelp, setShowHelp] = useState(true);
  const [showQuick, setShowQuick] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 连接 WebSocket
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/shell/${server.id}`;
    setConnecting(true);
    setError(null);

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setOutput(prev => [...prev, '\x1b[90m正在连接到 ' + server.host + '...\x1b[0m']);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'shell_ready') {
          setConnecting(false);
          setConnected(true);
          setError(null);
          setOutput(prev => [
            ...prev,
            '\x1b[1;32m✓ 已连接到 ' + server.host + '\x1b[0m',
            '\x1b[90m输入命令后按回车执行，Ctrl+C 中断，Ctrl+D 退出\x1b[0m',
            '',
          ]);
          inputRef.current?.focus();
        } else if (data.type === 'shell_output') {
          setOutput(prev => [...prev, data.data]);
        } else if (data.type === 'shell_error') {
          setOutput(prev => [...prev, '\x1b[31m错误: ' + data.error + '\x1b[0m']);
        } else if (data.type === 'shell_closed') {
          setConnected(false);
          setConnecting(false);
          setOutput(prev => [...prev, '\x1b[33m连接已关闭\x1b[0m']);
        }
      } catch {
        setOutput(prev => [...prev, event.data]);
      }
    };

    ws.onerror = () => {
      setError('WebSocket 连接失败');
      setConnecting(false);
      setOutput(prev => [...prev, '\x1b[31m✗ WebSocket 连接失败\x1b[0m']);
    };

    ws.onclose = () => {
      setConnected(false);
      setConnecting(false);
    };

    return () => { ws.close(); };
  }, [server.id, server.host]);

  // 自动滚动
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  const sendCommand = useCallback((cmd: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'input', data: cmd + '\n' }));
    }
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      const cmd = input.trim();
      sendCommand(input);
      setInput('');
      if (cmd) {
        setHistory(prev => [...prev, cmd]);
        setHistoryIndex(-1);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      const newIndex = historyIndex < history.length - 1 ? historyIndex + 1 : historyIndex;
      setHistoryIndex(newIndex);
      setInput(history[history.length - 1 - newIndex] || '');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex > 0) {
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        setInput(history[history.length - 1 - newIndex] || '');
      } else {
        setHistoryIndex(-1);
        setInput('');
      }
    } else if (e.ctrlKey && e.key === 'c') {
      sendCommand('\x03');
      setInput('');
    } else if (e.ctrlKey && e.key === 'd') {
      sendCommand('\x04');
    } else if (e.ctrlKey && e.key === 'l') {
      e.preventDefault();
      setOutput([]);
    }
  };

  // 拖拽上传
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = e.dataTransfer.files;
    if (!files.length || !wsRef.current) return;
    for (const file of Array.from(files)) {
      setOutput(prev => [...prev, `\x1b[33m正在上传 ${file.name}...\x1b[0m`]);
      // 读取本地文件内容
      const text = await file.text();
      // 通过 WebSocket 发送（需要后端支持 upload 命令）
      // 先用 base64 方式通知服务端
      const b64 = btoa(unescape(encodeURIComponent(text)));
      sendCommand(`echo '${b64}' | base64 -d > /tmp/${file.name} && echo '\x1b[32m上传成功: /tmp/${file.name}\x1b[0m'`);
      setOutput(prev => [...prev, `\x1b[90m文件已发送到 /tmp/${file.name}，可用以下命令移动：\x1b[0m`]);
    }
  };

  const containerCls = isFullscreen
    ? 'fixed inset-4 z-50'
    : 'relative w-full h-full';

  return (
    <div className={`${containerCls} bg-dark-950 border border-dark-700 rounded-xl overflow-hidden flex flex-col shadow-2xl`}>

      {/* 顶部栏 */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-dark-900 border-b border-dark-700">
        <div className="flex items-center gap-3">
          {/* 状态 */}
          {connecting ? (
            <span className="flex items-center gap-1.5 text-xs text-yellow-400">
              <Loader className="w-3.5 h-3.5 animate-spin" /> 连接中...
            </span>
          ) : connected ? (
            <span className="flex items-center gap-1.5 text-xs text-green-400">
              <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" /> 已连接
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-xs text-red-400">
              <span className="w-2 h-2 rounded-full bg-red-400" /> 已断开
            </span>
          )}

          <div className="h-4 w-px bg-dark-700" />

          <span className="font-mono text-sm text-dark-300">
            <span className="text-accent-400">{server.username}</span>
            <span className="text-dark-500">@</span>
            <span className="text-dark-200">{server.host}</span>
          </span>
        </div>

        <div className="flex items-center gap-1">
          {/* 快捷键说明 */}
          <button
            onClick={() => setShowHelp(v => !v)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
              showHelp ? 'bg-accent-500/20 text-accent-400' : 'text-dark-500 hover:text-dark-300 hover:bg-dark-800'
            }`}
          >
            <Keyboard className="w-3.5 h-3.5" />
            快捷键
          </button>

          {/* 快捷命令 */}
          <button
            onClick={() => setShowQuick(v => !v)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
              showQuick ? 'bg-accent-500/20 text-accent-400' : 'text-dark-500 hover:text-dark-300 hover:bg-dark-800'
            }`}
          >
            <Command className="w-3.5 h-3.5" />
            快捷命令
          </button>

          {/* 全屏 */}
          <button onClick={() => setIsFullscreen(v => !v)} className="p-1.5 rounded-lg hover:bg-dark-800 text-dark-500 hover:text-dark-300 transition-colors">
            {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>

          {/* 关闭 */}
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-dark-800 text-dark-500 hover:text-dark-300 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 快捷键说明条 */}
      {showHelp && (
        <div className="flex items-center gap-4 px-4 py-2 bg-dark-900/80 border-b border-dark-800/60 text-xs text-dark-500">
          {SHORTCUTS.map(s => (
            <span key={s.keys} className="flex items-center gap-1.5">
              <kbd className="px-1.5 py-0.5 rounded bg-dark-800 text-dark-400 font-mono border border-dark-700">{s.keys}</kbd>
              <span>{s.desc}</span>
            </span>
          ))}
        </div>
      )}

      {/* 快捷命令条 */}
      {showQuick && (
        <div className="flex items-center gap-2 px-4 py-2 bg-dark-900/80 border-b border-dark-800/60 overflow-x-auto">
          {QUICK_CMDS.map(q => (
            <button
              key={q.cmd}
              onClick={() => { sendCommand(q.cmd); inputRef.current?.focus(); }}
              disabled={!connected}
              className="flex-shrink-0 px-2.5 py-1 rounded-lg bg-dark-800 hover:bg-dark-700 text-xs text-dark-300 font-mono disabled:opacity-40 transition-colors"
            >
              {q.label}
            </button>
          ))}
        </div>
      )}

      {/* 终端输出 */}
      <div
        ref={outputRef}
        className={`flex-1 overflow-y-auto p-4 font-mono text-sm leading-relaxed bg-dark-950 min-h-0 ${dragOver ? 'bg-accent-500/5 border-2 border-dashed border-accent-500/40' : ''}`}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.focus()}
      >
        {output.length === 0 && !connecting && !error && (
          <div className="text-dark-600">等待连接...</div>
        )}
        {output.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap break-all" dangerouslySetInnerHTML={{ __html: ansiToHtml(line) || '&nbsp;' }} />
        ))}
        {connecting && (
          <div className="text-yellow-400 animate-pulse">正在建立 SSH 会话...</div>
        )}
        {error && (
          <div className="text-red-400">{error}</div>
        )}
        {dragOver && (
          <div className="absolute inset-0 flex items-center justify-center text-accent-400 font-medium">
            <Upload className="w-8 h-8 mr-2" /> 拖放文件上传到 /tmp
          </div>
        )}
      </div>

      {/* 输入框 */}
      <div className="flex items-center gap-2 px-4 py-3 bg-dark-900 border-t border-dark-700">
        <span className="text-green-400 font-mono flex-shrink-0">$</span>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!connected}
          placeholder={connected ? '输入命令，回车执行...' : '等待连接...'}
          className="flex-1 bg-transparent outline-none font-mono text-sm text-dark-200 placeholder-dark-700 disabled:opacity-50"
          autoFocus
        />
        {connected && (
          <button onClick={() => { sendCommand(input); setInput(''); }}
            className="flex-shrink-0 p-1.5 rounded-lg bg-dark-800 hover:bg-dark-700 text-dark-400 transition-colors">
            <Terminal className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}
