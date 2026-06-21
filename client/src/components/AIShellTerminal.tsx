/**
 * AIShellTerminal — AI 驱动的自然语言 Shell 终端
 * 
 * 用法：
 *   用户输入自然语言 → AI 生成 shell 命令 → 用户确认 → 远程执行 → 返回结果
 * 
 * 参考：AiTerminalFoundation/ai-terminal (BetterBash3 思路)
 * 但不依赖专门的模型，使用项目已有的 OpenAI 配置生成命令
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  X, Maximize2, Minimize2, Terminal, AlertCircle, Loader,
  Sparkles, Send, Play, Check, RotateCcw, Command,
  ArrowRight, Clipboard, ClipboardCheck, ChevronRight,
} from 'lucide-react';
import type { RemoteServer } from '../types';

interface AIShellTerminalProps {
  server: RemoteServer;
  onClose: () => void;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  command?: string;
  output?: string;
  status?: 'generating' | 'confirming' | 'executing' | 'done' | 'error';
}

// ANSI 颜色渲染
function ansiToHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\x1b\[90m/g, '<span class="text-gray-500">')
    .replace(/\x1b\[32m/g, '<span class="text-green-400">')
    .replace(/\x1b\[31m/g, '<span class="text-red-400">')
    .replace(/\x1b\[33m/g, '<span class="text-yellow-400">')
    .replace(/\x1b\[34m/g, '<span class="text-blue-400">')
    .replace(/\x1b\[36m/g, '<span class="text-cyan-400">')
    .replace(/\x1b\[35m/g, '<span class="text-purple-400">')
    .replace(/\x1b\[1;32m/g, '<span class="text-green-300 font-bold">')
    .replace(/\x1b\[1;31m/g, '<span class="text-red-300 font-bold">')
    .replace(/\x1b\[1m/g, '<span class="font-bold">')
    .replace(/\x1b\[0m/g, '</span>')
    .replace(/\x1b\[[0-9;]*m/g, '');
}

// 系统提示词，指导 AI 如何生成命令
const SYSTEM_PROMPT = `You are an expert shell command generator running on a remote server. 

Given a natural language request, generate a SINGLE safe shell command that accomplishes the task.

Rules:
1. Output ONLY the command — no explanation, no markdown, no code blocks
2. Use POSIX-compatible syntax (sh, not bash-specific unless necessary)
3. Never generate destructive commands (rm -rf, dd, mkfs, etc.) unless explicitly requested
4. If the request is ambiguous, output the safest reasonable interpretation
5. For monitoring/read-only queries, prefer concise output (use head/tail/grep)
6. Multi-step operations should be joined with && or ;
7. Assume common tools are available: grep, awk, sed, find, curl, netstat, ps, top, df, free, systemctl, journalctl, docker, kubectl, python3
8. Output "NO_COMMAND" if the request cannot be reasonably converted to a shell command`;

export default function AIShellTerminal({ server, onClose }: AIShellTerminalProps) {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [mode, setMode] = useState<'ai' | 'cmd'>('ai');
  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [cmdHistoryIdx, setCmdHistoryIdx] = useState(-1);

  const wsRef = useRef<WebSocket | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingIdRef = useRef<string | null>(null);

  // 连接 WebSocket
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/aishell/${server.id}`;
    setConnecting(true);
    setError(null);

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      // Connection opened, wait for ready signal
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'aishell_ready') {
          setConnecting(false);
          setConnected(true);
          setError(null);
          inputRef.current?.focus();
        } else if (data.type === 'command_generated') {
          // AI 生成了命令
          setMessages(prev => prev.map(msg =>
            msg.id === data.id
              ? { ...msg, command: data.command, content: `已生成命令:`, status: 'confirming' }
              : msg
          ));
        } else if (data.type === 'command_output') {
          // 命令执行输出
          setMessages(prev => prev.map(msg =>
            msg.id === data.id
              ? { ...msg, output: (msg.output || '') + data.data, status: 'executing' }
              : msg
          ));
        } else if (data.type === 'command_done') {
          // 命令执行完成
          setMessages(prev => prev.map(msg =>
            msg.id === data.id
              ? { ...msg, status: 'done', output: msg.output + (data.exitCode === 0 ? '\n\x1b[1;32m✓ 完成 (exit: 0)\x1b[0m' : `\n\x1b[1;31m✗ 退出码: ${data.exitCode}\x1b[0m`) }
              : msg
          ));
        } else if (data.type === 'command_error') {
          setMessages(prev => prev.map(msg =>
            msg.id === data.id
              ? { ...msg, status: 'error', output: `\x1b[31m错误: ${data.error}\x1b[0m` }
              : msg
          ));
        } else if (data.type === 'error') {
          setError(data.error);
          setMessages(prev => prev.map(msg =>
            msg.id === pendingIdRef.current
              ? { ...msg, status: 'error', content: `\x1b[31m错误: ${data.error}\x1b[0m` }
              : msg
          ));
        }
      } catch {
        // Could not parse, ignore
      }
    };

    ws.onerror = () => {
      setError('WebSocket 连接失败');
      setConnecting(false);
    };

    ws.onclose = () => {
      setConnected(false);
      setConnecting(false);
    };

    return () => { ws.close(); };
  }, [server.id]);

  // 自动滚动
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [messages]);

  // 发送自然语言请求
  const sendMessage = useCallback(() => {
    const text = input.trim();
    if (!text || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    const msgId = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const userMsg: ChatMessage = {
      id: msgId,
      role: 'user',
      content: text,
      status: 'generating',
    };

    setMessages(prev => [...prev, userMsg]);
    setInput('');
    pendingIdRef.current = msgId;

    wsRef.current.send(JSON.stringify({ type: 'natural_language', id: msgId, text }));
  }, [input]);

  // 确认执行命令
  const executeCommand = useCallback((msgId: string, command: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    setMessages(prev => prev.map(msg =>
      msg.id === msgId
        ? { ...msg, status: 'executing' as const, output: '' }
        : msg
    ));

    wsRef.current.send(JSON.stringify({ type: 'execute', id: msgId, command }));
  }, []);

  // 重新生成命令
  const regenerate = useCallback((msgId: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    setMessages(prev => prev.map(msg =>
      msg.id === msgId
        ? { ...msg, command: undefined, content: '重新生成中...', status: 'generating' as const }
        : msg
    ));

    const msg = messages.find(m => m.id === msgId);
    if (msg) {
      wsRef.current.send(JSON.stringify({ type: 'regenerate', id: msgId, text: msg.content }));
    }
  }, [messages]);

  // 直接在 AI Shell 中执行命令（跳过 AI）
  const executeDirect = useCallback((command: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    const msgId = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const userMsg: ChatMessage = {
      id: msgId,
      role: 'user',
      content: `$ ${command}`,
      command,
      status: 'executing' as const,
      output: '',
    };

    setMessages(prev => [...prev, userMsg]);
    pendingIdRef.current = msgId;
    setCmdHistory(prev => [...prev, command]);
    setCmdHistoryIdx(-1);

    wsRef.current.send(JSON.stringify({ type: 'execute', id: msgId, command }));
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = input.trim();
      if (!text) return;
      
      if (mode === 'cmd') {
        // 命令模式：直接执行
        executeDirect(text);
        setInput('');
      } else {
        // AI 模式：以 $ 开头直接执行，否则走 AI
        if (text.startsWith('$')) {
          executeDirect(text.slice(1).trim());
          setInput('');
        } else {
          sendMessage();
        }
      }
    } else if (mode === 'cmd' && e.key === 'ArrowUp') {
      e.preventDefault();
      if (cmdHistory.length === 0) return;
      const newIdx = cmdHistoryIdx < cmdHistory.length - 1 ? cmdHistoryIdx + 1 : cmdHistoryIdx;
      setCmdHistoryIdx(newIdx);
      setInput(cmdHistory[cmdHistory.length - 1 - newIdx] || '');
    } else if (mode === 'cmd' && e.key === 'ArrowDown') {
      e.preventDefault();
      if (cmdHistoryIdx > 0) {
        const newIdx = cmdHistoryIdx - 1;
        setCmdHistoryIdx(newIdx);
        setInput(cmdHistory[cmdHistory.length - 1 - newIdx] || '');
      } else {
        setCmdHistoryIdx(-1);
        setInput('');
      }
    } else if (mode === 'cmd' && e.ctrlKey && e.key === 'l') {
      e.preventDefault();
      setMessages([]);
    }
  };

  const copyCommand = (cmd: string, msgId: string) => {
    navigator.clipboard.writeText(cmd);
    setCopiedId(msgId);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const containerCls = isFullscreen
    ? 'fixed inset-4 z-50'
    : 'relative w-full h-full';

  return (
    <div className={`${containerCls} bg-dark-950 border border-dark-700 rounded-xl overflow-hidden flex flex-col shadow-2xl`}>
      {/* 顶部栏 */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-dark-900 border-b border-dark-700">
        <div className="flex items-center gap-3">
          {/* 状态指示 */}
          {connecting ? (
            <span className="flex items-center gap-1.5 text-xs text-yellow-400">
              <Loader className="w-3.5 h-3.5 animate-spin" /> 连接中...
            </span>
          ) : connected ? (
            <span className="flex items-center gap-1.5 text-xs text-purple-400">
              <Sparkles className="w-3.5 h-3.5" /> AI Shell
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
          {/* 提示 */}
          <span className="text-xs text-dark-600 mr-2 hidden sm:block">
            用自然语言描述，AI 生成命令并执行
          </span>

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

      {/* 消息列表 / 终端输出 */}
      <div
        ref={outputRef}
        className="flex-1 overflow-y-auto p-4 min-h-0 bg-dark-950 space-y-4"
        onClick={() => inputRef.current?.focus()}
      >
        {messages.length === 0 && !connecting && !error && (
          <div className="flex flex-col items-center justify-center h-full text-dark-600 gap-3">
            <Sparkles className="w-12 h-12 opacity-20" />
            <p className="text-lg font-medium">AI Shell</p>
            <p className="text-sm text-dark-600 max-w-md text-center">
              用自然语言描述你想做什么，AI 会生成对应的 Shell 命令并在远程服务器上执行
            </p>
            <div className="flex flex-wrap justify-center gap-2 mt-4">
              {[
                '查看内存使用情况',
                '找出占用 CPU 最高的进程',
                '查看最近 50 条系统日志',
                '检查磁盘空间',
                '查看 Docker 运行的容器',
                '列出 /var/log 下最大的日志文件',
              ].map(suggestion => (
                <button
                  key={suggestion}
                  onClick={() => { setInput(suggestion); inputRef.current?.focus(); }}
                  className="px-3 py-1.5 rounded-lg bg-dark-800/60 hover:bg-dark-700 text-xs text-dark-400 transition-colors border border-dark-700"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {connecting && (
          <div className="flex items-center justify-center py-8">
            <Loader className="w-6 h-6 animate-spin text-purple-400" />
            <span className="ml-2 text-yellow-400 text-sm">正在建立 AI Shell 会话...</span>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400">
            <AlertCircle className="w-5 h-5" />
            <span className="text-sm">{error}</span>
          </div>
        )}

        {messages.map(msg => (
          <div key={msg.id} className="space-y-2">
            {/* 用户消息 */}
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 mt-1 w-8 h-8 rounded-lg bg-dark-800 flex items-center justify-center">
                <span className="text-xs text-dark-400">👤</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-dark-200">{msg.content}</p>
              </div>
              {/* Loading spinner during generation */}
              {msg.status === 'generating' && (
                <Loader className="w-4 h-4 animate-spin text-purple-400 flex-shrink-0 mt-1" />
              )}
            </div>

            {/* AI 生成的命令卡片 */}
            {msg.command && (
              <div className="flex items-start gap-3 pl-11">
                <div className="flex-shrink-0 mt-1 w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center">
                  <Sparkles className="w-4 h-4 text-purple-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-purple-400 font-medium">生成命令</span>
                    </div>
                    <div className="flex items-center gap-1">
                      {/* 复制命令 */}
                      <button
                        onClick={() => copyCommand(msg.command!, msg.id)}
                        className="p-1.5 rounded-lg hover:bg-dark-800 text-dark-500 hover:text-dark-300 transition-colors"
                        title="复制命令"
                      >
                        {copiedId === msg.id ? <ClipboardCheck className="w-3.5 h-3.5 text-green-400" /> : <Clipboard className="w-3.5 h-3.5" />}
                      </button>

                      {msg.status === 'confirming' && (
                        <>
                          <button
                            onClick={() => executeCommand(msg.id, msg.command!)}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-500/20 text-green-400 text-xs hover:bg-green-500/30 transition-colors"
                          >
                            <Play className="w-3.5 h-3.5" /> 执行
                          </button>
                          <button
                            onClick={() => regenerate(msg.id)}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-dark-700 text-dark-400 text-xs hover:bg-dark-600 transition-colors"
                          >
                            <RotateCcw className="w-3.5 h-3.5" /> 重新生成
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  <div className={`mt-2 px-3 py-2 rounded-lg font-mono text-sm bg-dark-800/80 border ${msg.status === 'executing' || msg.status === 'done' ? 'border-dark-700' : 'border-purple-500/30'}`}>
                    <code className="text-green-400 text-xs break-all">{msg.command}</code>
                  </div>
                </div>
              </div>
            )}

            {/* 命令输出 */}
            {msg.output && (
              <div className="pl-11">
                {msg.status === 'executing' && (
                  <div className="flex items-center gap-2 text-xs text-yellow-400 mb-2">
                    <Loader className="w-3 h-3 animate-spin" />
                    执行中...
                  </div>
                )}
                <div className="rounded-lg bg-dark-900/80 border border-dark-700 overflow-hidden">
                  <div className="px-3 py-1.5 border-b border-dark-800 bg-dark-800/60 flex items-center justify-between">
                    <span className="text-xs text-dark-500 font-mono flex items-center gap-1.5">
                      <Terminal className="w-3 h-3" /> 输出
                    </span>
                    {msg.status === 'done' && (
                      <span className="flex items-center gap-1 text-xs text-green-400">
                        <Check className="w-3 h-3" /> 完成
                      </span>
                    )}
                    {msg.status === 'error' && (
                      <span className="text-xs text-red-400">失败</span>
                    )}
                  </div>
                  <pre className="p-3 font-mono text-xs text-dark-300 leading-relaxed whitespace-pre-wrap break-all max-h-96 overflow-y-auto">
                    <span dangerouslySetInnerHTML={{ __html: ansiToHtml(msg.output) || '&nbsp;' }} />
                  </pre>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 输入框 */}
      <div className="border-t border-dark-700 bg-dark-900">
        {/* 快捷命令 + 模式切换 */}
        <div className="flex items-center gap-1.5 px-4 py-2 border-b border-dark-800 bg-dark-900/80 overflow-x-auto">
          {/* 模式切换 */}
          <div className="flex items-center rounded-lg bg-dark-800 p-0.5 mr-2 flex-shrink-0">
            <button
              onClick={() => setMode('ai')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs transition-colors ${
                mode === 'ai' ? 'bg-purple-500/20 text-purple-400' : 'text-dark-500 hover:text-dark-300'
              }`}
            >
              <Sparkles className="w-3 h-3" /> AI
            </button>
            <button
              onClick={() => { setMode('cmd'); inputRef.current?.focus(); }}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs transition-colors ${
                mode === 'cmd' ? 'bg-green-500/20 text-green-400' : 'text-dark-500 hover:text-dark-300'
              }`}
            >
              <Terminal className="w-3 h-3" /> 命令
            </button>
          </div>

          {mode === 'cmd' ? (
            <>
              <span className="text-xs text-dark-600 mr-1 flex-shrink-0">快速:</span>
              {[
                { label: '内存', cmd: 'free -h' },
                { label: 'CPU', cmd: 'top -bn1 | head -10' },
                { label: '磁盘', cmd: 'df -h' },
                { label: '进程', cmd: 'ps aux --sort=-%cpu | head -10' },
                { label: '网络', cmd: 'ss -tlnp' },
                { label: 'Docker', cmd: 'docker ps -a' },
                { label: 'GPU', cmd: 'nvidia-smi' },
                { label: 'uptime', cmd: 'uptime' },
                { label: '日志', cmd: 'journalctl -n 30 --no-pager' },
              ].map(q => (
                <button
                  key={q.cmd}
                  onClick={() => { setInput(q.cmd); inputRef.current?.focus(); }}
                  disabled={!connected}
                  className="flex-shrink-0 px-2 py-1 rounded bg-dark-800 hover:bg-dark-700 text-xs text-dark-400 font-mono disabled:opacity-40 transition-colors"
                >
                  {q.label}
                </button>
              ))}
            </>
          ) : (
            <>
              <span className="text-xs text-dark-600 mr-1 flex-shrink-0">快速:</span>
              {[
                { label: '内存', cmd: 'free -h' },
                { label: 'CPU', cmd: 'top -bn1 | head -10' },
                { label: '磁盘', cmd: 'df -h' },
                { label: '进程', cmd: 'ps aux --sort=-%cpu | head -10' },
                { label: '网络', cmd: 'ss -tlnp' },
                { label: 'Docker', cmd: 'docker ps -a' },
                { label: 'GPU', cmd: 'nvidia-smi' },
                { label: 'uptime', cmd: 'uptime' },
              ].map(q => (
                <button
                  key={q.cmd}
                  onClick={() => executeDirect(q.cmd)}
                  disabled={!connected}
                  className="flex-shrink-0 px-2 py-1 rounded bg-dark-800 hover:bg-dark-700 text-xs text-dark-400 font-mono disabled:opacity-40 transition-colors"
                >
                  {q.label}
                </button>
              ))}
            </>
          )}
        </div>

        {/* 输入区域 */}
        {mode === 'cmd' ? (
          <div className="flex items-center gap-2 px-4 py-3">
            <span className="text-green-400 font-mono text-sm flex-shrink-0">$</span>
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={!connected}
              placeholder={connected ? '输入命令，回车执行...' : '等待连接...'}
              className="flex-1 bg-transparent outline-none font-mono text-sm text-dark-200 placeholder-dark-600 disabled:opacity-50"
              autoFocus
            />
            <button
              onClick={() => { if (input.trim()) { executeDirect(input.trim()); setInput(''); } }}
              disabled={!connected || !input.trim()}
              className="flex-shrink-0 p-1.5 rounded-lg bg-green-500/20 text-green-400 hover:bg-green-500/30 disabled:opacity-30 transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-3 px-4 py-3">
            <Sparkles className="w-5 h-5 text-purple-400 flex-shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={!connected}
              placeholder={connected ? '描述你想做什么，回车发送...' : '等待连接...'}
              className="flex-1 bg-transparent outline-none text-sm text-dark-200 placeholder-dark-600 disabled:opacity-50"
              autoFocus
            />
            <button
              onClick={sendMessage}
              disabled={!connected || !input.trim()}
              className="flex-shrink-0 p-2 rounded-lg bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 disabled:opacity-30 transition-colors"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
