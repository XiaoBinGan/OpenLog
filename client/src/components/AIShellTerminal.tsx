/**
 * AIShellTerminal — AI 驱动的自然语言 Shell 终端
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  X, Maximize2, Minimize2, Terminal, AlertCircle, Loader,
  Sparkles, Send, Play, Check, RotateCcw, Command,
  ArrowRight, Clipboard, ClipboardCheck, ChevronRight,
  BookOpen, ChevronDown,
} from 'lucide-react';
import type { RemoteServer } from '../types';

interface SkillBrief {
  id: string;
  name: string;
  command: string;
  description: string;
  content: string;
  category: string;
}

interface AIShellTerminalProps {
  server: RemoteServer;
  onClose: () => void;
  onReady?: () => void;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  command?: string;
  output?: string;
  status?: 'generating' | 'confirming' | 'executing' | 'done' | 'error';
}

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

export default function AIShellTerminal({ server, onClose, onReady }: AIShellTerminalProps) {
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

  // 技能多选
  const [skillsList, setSkillsList] = useState<SkillBrief[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<SkillBrief[]>([]);
  const [skillsOpen, setSkillsOpen] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingIdRef = useRef<string | null>(null);

  // 加载技能列表
  useEffect(() => {
    fetch('/api/skills')
      .then(r => r.json())
      .then(data => setSkillsList(data.skills || []))
      .catch(() => {});
  }, []);

  // 连接 WebSocket — localhost 直连 3001，LAN 走 Vite 代理
  useEffect(() => {
    const isDev = (import.meta as any).env?.DEV;
    const hostname = window.location.hostname;
    const wsHost = (isDev && hostname === 'localhost') ? 'localhost:3001' : window.location.host;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${wsHost}/ws/aishell/${server.id}`;
    setConnecting(true);
    setError(null);

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    let ready = false;

    ws.onopen = () => {};

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'aishell_ready') {
          ready = true;
          setConnecting(false);
          setConnected(true);
          setError(null);
          onReady?.();
          inputRef.current?.focus();
        } else if (data.type === 'command_generated') {
          setMessages(prev => prev.map(msg =>
            msg.id === data.id
              ? { ...msg, command: data.command, content: '已生成命令:', status: 'confirming' }
              : msg
          ));
        } else if (data.type === 'assistant_answer') {
          setMessages(prev => prev.map(msg =>
            msg.id === data.id
              ? { ...msg, content: data.content, status: 'done' }
              : msg
          ));
        } else if (data.type === 'command_output') {
          setMessages(prev => prev.map(msg =>
            msg.id === data.id
              ? { ...msg, output: (msg.output || '') + data.data, status: 'executing' }
              : msg
          ));
        } else if (data.type === 'command_done') {
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
      } catch {}
    };

    ws.onerror = () => {
      // 不立即报错（SSH 握手可能产生瞬时错误），等 onclose 处理
    };

    ws.onclose = () => {
      setConnected(false);
      setConnecting(false);
      if (!ready) onReady?.();
    };

    return () => { ws.close(); };
  }, [server.id]);

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [messages]);

  const sendMessage = useCallback(() => {
    const text = input.trim();
    if (!text || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    const msgId = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const userMsg: ChatMessage = { id: msgId, role: 'user', content: text, status: 'generating' };

    setMessages(prev => [...prev, userMsg]);
    setInput('');
    pendingIdRef.current = msgId;

    const combinedContent = selectedSkills.map(s => s.content).filter(Boolean).join('\n\n---\n\n');
    const combinedNames = selectedSkills.map(s => s.name).join(' + ');

    // Build conversation history (last 6 messages)
    const history = messages.slice(-6).map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.command
        ? `命令: ${m.command}\n输出: ${m.output || '(无输出)'}`
        : m.content
    }));

    wsRef.current.send(JSON.stringify({
      type: 'natural_language', id: msgId, text,
      skillContent: combinedContent, skillName: combinedNames,
      history,
    }));
  }, [input, selectedSkills]);

  const executeCommand = useCallback((msgId: string, command: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    setMessages(prev => prev.map(msg =>
      msg.id === msgId ? { ...msg, status: 'executing' as const, output: '' } : msg
    ));
    wsRef.current.send(JSON.stringify({ type: 'execute', id: msgId, command }));
  }, []);

  const regenerate = useCallback((msgId: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    setMessages(prev => prev.map(msg =>
      msg.id === msgId ? { ...msg, command: undefined, content: '重新生成中...', status: 'generating' as const } : msg
    ));
    const msg = messages.find(m => m.id === msgId);
    if (msg) {
      const combinedContent = selectedSkills.map(s => s.content).filter(Boolean).join('\n\n---\n\n');
      const combinedNames = selectedSkills.map(s => s.name).join(' + ');
      const history = messages.slice(-6).map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.command
          ? `命令: ${m.command}\n输出: ${m.output || '(无输出)'}`
          : m.content
      }));
      wsRef.current.send(JSON.stringify({
        type: 'regenerate', id: msgId, text: msg.content,
        skillContent: combinedContent, skillName: combinedNames, history,
      }));
    }
  }, [messages, selectedSkills]);

  const executeDirect = useCallback((command: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const msgId = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const userMsg: ChatMessage = { id: msgId, role: 'user', content: `$ ${command}`, command, status: 'executing' as const, output: '' };
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
      if (mode === 'cmd') { executeDirect(text); setInput(''); }
      else if (text.startsWith('$')) { executeDirect(text.slice(1).trim()); setInput(''); }
      else { sendMessage(); }
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
      } else { setCmdHistoryIdx(-1); setInput(''); }
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

  const containerCls = isFullscreen ? 'fixed inset-4 z-50' : 'relative w-full h-full';

  return (
    <div className={`${containerCls} bg-dark-950 border border-dark-700 rounded-xl overflow-hidden flex flex-col shadow-2xl`}>
      {/* 顶部栏 */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-dark-900 border-b border-dark-700">
        <div className="flex items-center gap-3">
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

          {/* 技能选择器（多选） */}
          {connected && skillsList.length > 0 && (
            <div className="relative">
              <button
                onClick={() => setSkillsOpen(v => !v)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs transition-colors ${
                  selectedSkills.length > 0
                    ? 'bg-accent-500/15 text-accent-400 border border-accent-500/20'
                    : 'bg-dark-800 text-dark-400 hover:text-dark-300 border border-dark-700'
                }`}
              >
                <BookOpen className="w-3.5 h-3.5" />
                {selectedSkills.length > 0 ? (
                  <>
                    <span className="max-w-[80px] truncate">{selectedSkills.length} 个技能</span>
                    <button onClick={e => { e.stopPropagation(); setSelectedSkills([]); }} className="ml-0.5 p-0.5 rounded hover:bg-dark-700">
                      <X className="w-3 h-3" />
                    </button>
                  </>
                ) : (
                  <><span className="hidden sm:inline">技能</span><ChevronDown className="w-3 h-3" /></>
                )}
              </button>

              {skillsOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setSkillsOpen(false)} />
                  <div className="absolute top-full left-0 mt-1 w-64 bg-dark-900 border border-dark-700 rounded-lg shadow-xl z-20 max-h-80 overflow-y-auto">
                    <div className="px-3 py-2 border-b border-dark-800 flex items-center justify-between">
                      <p className="text-[10px] text-dark-500 uppercase tracking-wider">选择技能 {selectedSkills.length > 0 && `(${selectedSkills.length})`}</p>
                      {selectedSkills.length > 0 && (
                        <button onClick={() => { setSelectedSkills([]); setSkillsOpen(false); }} className="text-[10px] text-dark-400 hover:text-dark-200">清除全部</button>
                      )}
                    </div>
                    {skillsList.map(s => {
                      const isSel = selectedSkills.some(ss => ss.id === s.id);
                      return (
                        <button
                          key={s.id}
                          onClick={() => setSelectedSkills(prev => isSel ? prev.filter(ss => ss.id !== s.id) : [...prev, s])}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-left transition-colors ${isSel ? 'bg-accent-500/10 text-accent-400' : 'text-dark-300 hover:bg-dark-800'}`}
                        >
                          <span className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 text-[10px] ${isSel ? 'bg-accent-500 border-accent-500 text-white' : 'border-dark-600'}`}>
                            {isSel && <Check className="w-3 h-3" />}
                          </span>
                          <div className="min-w-0">
                            <div className="truncate font-medium">{s.name}</div>
                            <div className="text-[10px] text-dark-500 truncate">{s.description}</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1">
          <span className="text-xs text-dark-600 mr-2 hidden sm:block">用自然语言描述，AI 生成命令并执行</span>
          <button onClick={() => setIsFullscreen(v => !v)} className="p-1.5 rounded-lg hover:bg-dark-800 text-dark-500 hover:text-dark-300 transition-colors">
            {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-dark-800 text-dark-500 hover:text-dark-300 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 已选技能标签行 */}
      {selectedSkills.length > 0 && (
        <div className="flex items-center gap-1.5 px-4 py-1.5 bg-dark-900/50 border-b border-dark-800 overflow-x-auto">
          <span className="text-[10px] text-dark-500 flex-shrink-0">技能:</span>
          {selectedSkills.slice(0, 3).map(s => (
            <span key={s.id} className="px-1.5 py-0.5 bg-accent-500/10 border border-accent-500/20 rounded text-[10px] text-accent-400 whitespace-nowrap flex-shrink-0">
              {s.name}
            </span>
          ))}
          {selectedSkills.length > 3 && (
            <span className="text-[10px] text-dark-500 flex-shrink-0">+{selectedSkills.length - 3} 更多</span>
          )}
        </div>
      )}

      {/* 消息列表 */}
      <div ref={outputRef} className="flex-1 overflow-y-auto p-4 min-h-0 bg-dark-950 space-y-4" onClick={() => inputRef.current?.focus()}>
        {messages.length === 0 && !connecting && !error && (
          <div className="flex flex-col items-center justify-center h-full text-dark-600 gap-3">
            <Sparkles className="w-12 h-12 opacity-20" />
            <p className="text-lg font-medium">AI Shell</p>
            <p className="text-sm text-dark-600 max-w-md text-center">用自然语言描述你想做什么，AI 会生成对应的 Shell 命令并在远程服务器上执行</p>
            <div className="flex flex-wrap justify-center gap-2 mt-4">
              {['查看内存使用情况', '找出占用 CPU 最高的进程', '查看最近 50 条系统日志', '检查磁盘空间', '查看 Docker 运行的容器', '列出 /var/log 下最大的日志文件'].map(suggestion => (
                <button key={suggestion} onClick={() => { setInput(suggestion); inputRef.current?.focus(); }} className="px-3 py-1.5 rounded-lg bg-dark-800/60 hover:bg-dark-700 text-xs text-dark-400 transition-colors border border-dark-700">
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {connecting && (
          <div className="flex flex-col items-center justify-center h-full gap-6">
            <div className="relative">
              <div className="w-16 h-16 rounded-full bg-purple-500/10 border border-purple-500/20 flex items-center justify-center">
                <Sparkles className="w-8 h-8 text-purple-400 animate-pulse" />
              </div>
              <div className="absolute inset-0 rounded-full border-2 border-purple-500/30 animate-ping" />
            </div>
            <div className="text-center">
              <p className="text-sm text-purple-300 font-medium mb-1.5">正在建立 AI Shell 会话</p>
              <div className="flex items-center justify-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
              <p className="text-xs text-dark-500 mt-3">正在连接 {server.username}@{server.host}...</p>
            </div>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400">
            <AlertCircle className="w-5 h-5" /><span className="text-sm">{error}</span>
          </div>
        )}

        {messages.map(msg => (
          <div key={msg.id} className="space-y-2">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 mt-1 w-8 h-8 rounded-lg bg-dark-800 flex items-center justify-center">
                <span className="text-xs text-dark-400">👤</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-dark-200">{msg.content}</p>
              </div>
              {msg.status === 'generating' && <Loader className="w-4 h-4 animate-spin text-purple-400 flex-shrink-0 mt-1" />}
            </div>

            {msg.command && (
              <div className="flex items-start gap-3 pl-11">
                <div className="flex-shrink-0 mt-1 w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center">
                  <Sparkles className="w-4 h-4 text-purple-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2"><span className="text-xs text-purple-400 font-medium">生成命令</span></div>
                    <div className="flex items-center gap-1">
                      <button onClick={() => copyCommand(msg.command!, msg.id)} className="p-1.5 rounded-lg hover:bg-dark-800 text-dark-500 hover:text-dark-300 transition-colors" title="复制命令">
                        {copiedId === msg.id ? <ClipboardCheck className="w-3.5 h-3.5 text-green-400" /> : <Clipboard className="w-3.5 h-3.5" />}
                      </button>
                      {msg.status === 'confirming' && (
                        <>
                          <button onClick={() => executeCommand(msg.id, msg.command!)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-500/20 text-green-400 text-xs hover:bg-green-500/30 transition-colors">
                            <Play className="w-3.5 h-3.5" /> 执行
                          </button>
                          <button onClick={() => regenerate(msg.id)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-dark-700 text-dark-400 text-xs hover:bg-dark-600 transition-colors">
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

            {msg.output && (
              <div className="pl-11">
                {msg.status === 'executing' && (
                  <div className="flex items-center gap-2 text-xs text-yellow-400 mb-2"><Loader className="w-3 h-3 animate-spin" />执行中...</div>
                )}
                <div className="rounded-lg bg-dark-900/80 border border-dark-700 overflow-hidden">
                  <div className="px-3 py-1.5 border-b border-dark-800 bg-dark-800/60 flex items-center justify-between">
                    <span className="text-xs text-dark-500 font-mono flex items-center gap-1.5"><Terminal className="w-3 h-3" /> 输出</span>
                    {msg.status === 'done' && <span className="flex items-center gap-1 text-xs text-green-400"><Check className="w-3 h-3" /> 完成</span>}
                    {msg.status === 'error' && <span className="text-xs text-red-400">失败</span>}
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
        <div className="flex items-center gap-1.5 px-4 py-2 border-b border-dark-800 bg-dark-900/80 overflow-x-auto">
          <div className="flex items-center rounded-lg bg-dark-800 p-0.5 mr-2 flex-shrink-0">
            <button onClick={() => setMode('ai')} className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs transition-colors ${mode === 'ai' ? 'bg-purple-500/20 text-purple-400' : 'text-dark-500 hover:text-dark-300'}`}>
              <Sparkles className="w-3 h-3" /> AI
            </button>
            <button onClick={() => { setMode('cmd'); inputRef.current?.focus(); }} className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs transition-colors ${mode === 'cmd' ? 'bg-green-500/20 text-green-400' : 'text-dark-500 hover:text-dark-300'}`}>
              <Terminal className="w-3 h-3" /> 命令
            </button>
          </div>

          {mode === 'cmd' ? (
            <>
              <span className="text-xs text-dark-600 mr-1 flex-shrink-0">快速:</span>
              {[{ label: '内存', cmd: 'free -h' },{ label: 'CPU', cmd: 'top -bn1 | head -10' },{ label: '磁盘', cmd: 'df -h' },{ label: '进程', cmd: 'ps aux --sort=-%cpu | head -10' },{ label: '网络', cmd: 'ss -tlnp' },{ label: 'Docker', cmd: 'docker ps -a' },{ label: 'GPU', cmd: 'nvidia-smi' },{ label: 'uptime', cmd: 'uptime' },{ label: '日志', cmd: 'journalctl -n 30 --no-pager' }].map(q => (
                <button key={q.cmd} onClick={() => { setInput(q.cmd); inputRef.current?.focus(); }} disabled={!connected} className="flex-shrink-0 px-2 py-1 rounded bg-dark-800 hover:bg-dark-700 text-xs text-dark-400 font-mono disabled:opacity-40 transition-colors">{q.label}</button>
              ))}
            </>
          ) : (
            <>
              <span className="text-xs text-dark-600 mr-1 flex-shrink-0">快速:</span>
              {[{ label: '内存', cmd: 'free -h' },{ label: 'CPU', cmd: 'top -bn1 | head -10' },{ label: '磁盘', cmd: 'df -h' },{ label: '进程', cmd: 'ps aux --sort=-%cpu | head -10' },{ label: '网络', cmd: 'ss -tlnp' },{ label: 'Docker', cmd: 'docker ps -a' },{ label: 'GPU', cmd: 'nvidia-smi' },{ label: 'uptime', cmd: 'uptime' }].map(q => (
                <button key={q.cmd} onClick={() => executeDirect(q.cmd)} disabled={!connected} className="flex-shrink-0 px-2 py-1 rounded bg-dark-800 hover:bg-dark-700 text-xs text-dark-400 font-mono disabled:opacity-40 transition-colors">{q.label}</button>
              ))}
            </>
          )}
        </div>

        {mode === 'cmd' ? (
          <div className="flex items-center gap-2 px-4 py-3">
            <span className="text-green-400 font-mono text-sm flex-shrink-0">$</span>
            <input ref={inputRef} type="text" value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown} disabled={!connected} placeholder={connected ? '输入命令，回车执行...' : '等待连接...'} className="flex-1 bg-transparent outline-none font-mono text-sm text-dark-200 placeholder-dark-600 disabled:opacity-50" autoFocus />
            <button onClick={() => { if (input.trim()) { executeDirect(input.trim()); setInput(''); } }} disabled={!connected || !input.trim()} className="flex-shrink-0 p-1.5 rounded-lg bg-green-500/20 text-green-400 hover:bg-green-500/30 disabled:opacity-30 transition-colors">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-3 px-4 py-3">
            <Sparkles className="w-5 h-5 text-purple-400 flex-shrink-0" />
            <input ref={inputRef} type="text" value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown} disabled={!connected} placeholder={connected ? '描述你想做什么，回车发送...' : '等待连接...'} className="flex-1 bg-transparent outline-none text-sm text-dark-200 placeholder-dark-600 disabled:opacity-50" autoFocus />
            <button onClick={sendMessage} disabled={!connected || !input.trim()} className="flex-shrink-0 p-2 rounded-lg bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 disabled:opacity-30 transition-colors">
              <Send className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}