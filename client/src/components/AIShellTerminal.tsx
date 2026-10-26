/**
 * AIShellTerminal — AI 驱动的自然语言 Shell 终端（多步 agent 版）。
 *
 * 与旧版的区别：
 *  - 一条任务可以连续跑多步（AI 看输出再决定下一步），每步单独展示；
 *  - 命令输出**流式**渲染，可随时停止；
 *  - 会话开始自动注入服务器环境（系统/GPU/容器/端口/已装工具）；
 *  - 命令风险分级：只读自动跑，写操作/危险操作默认需要确认；
 *  - 模型思考过程实时预览。
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  X, Maximize2, Minimize2, Terminal, AlertCircle, Loader,
  Sparkles, Send, Check, Save, RotateCcw, Command,
  ArrowRight, Clipboard, ClipboardCheck, ChevronDown,
  BookOpen, Square, ShieldAlert, Cpu,
} from 'lucide-react';
import type { RemoteServer } from '../types';
import { withWsToken } from '../api/auth';
import { apiFetch } from '../api/client';
import { sanitizeHtml } from '../utils/sanitize';

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

type Risk = 'read' | 'write' | 'danger';

interface Step {
  step: number;
  thought?: string;
  command?: string;
  risk?: Risk;
  riskReason?: string;
  output: string;
  status: 'thinking' | 'waiting_confirm' | 'running' | 'done' | 'rejected' | 'error';
  exitCode?: number;
  modelPreview?: string;
}

interface Turn {
  id: string;
  text: string;
  steps: Step[];
  final?: string;
  status: 'running' | 'done' | 'cancelled' | 'error';
  error?: string;
}

const RISK_META: Record<Risk, { label: string; cls: string }> = {
  read: { label: '只读', cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
  write: { label: '写操作', cls: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20' },
  danger: { label: '危险', cls: 'text-red-400 bg-red-500/10 border-red-500/20' },
};

function ansiToHtml(text: string): string {
  return sanitizeHtml(text
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
    .replace(/\x1b\[[0-9;]*m/g, ''));
}

const OUTPUT_LIMIT = 200_000;
const QUICK_COMMANDS = [
  { label: '内存', cmd: 'free -h' },
  { label: 'CPU', cmd: 'top -bn1 | head -10' },
  { label: '磁盘', cmd: 'df -h' },
  { label: '进程', cmd: 'ps aux --sort=-%cpu | head -10' },
  { label: '网络', cmd: 'ss -tlnp' },
  { label: 'Docker', cmd: 'docker ps -a' },
  { label: 'GPU', cmd: 'nvidia-smi' },
  { label: '负载', cmd: 'uptime' },
];

const AI_SUGGESTIONS = [
  '看看这台机器现在的资源占用，有没有异常进程',
  'GPU 上跑着什么？各个模型的显存占用正常吗',
  '磁盘快满了吗？帮我找出最大的 5 个目录',
  '最近有没有报错日志？帮我定位原因',
  '检查一下 Docker 容器有没有异常退出',
  '这个服务为什么连不上？帮我排查端口和防火墙',
];

export default function AIShellTerminal({ server, onClose, onReady }: AIShellTerminalProps) {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [mode, setMode] = useState<'ai' | 'cmd'>('ai');
  const [autoRun, setAutoRun] = useState(() => localStorage.getItem('aishell.autoRun') !== '0');
  const [running, setRunning] = useState(false);
  const [contextSummary, setContextSummary] = useState('');
  const [cmdHistory, setCmdHistory] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('aishell.cmdHistory') || '[]'); } catch { return []; }
  });
  const [cmdHistoryIdx, setCmdHistoryIdx] = useState(-1);

  // 技能多选
  const [skillsList, setSkillsList] = useState<SkillBrief[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<SkillBrief[]>([]);
  const [skillsOpen, setSkillsOpen] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeTurnRef = useRef<string | null>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => { localStorage.setItem('aishell.autoRun', autoRun ? '1' : '0'); }, [autoRun]);
  useEffect(() => { localStorage.setItem('aishell.cmdHistory', JSON.stringify(cmdHistory.slice(-50))); }, [cmdHistory]);

  // 加载技能列表
  useEffect(() => {
    apiFetch<{ skills?: SkillBrief[] }>('/api/skills')
      .then(data => setSkillsList(data.skills || []))
      .catch(() => {});
  }, []);

  // ─── 更新某个 turn 的某个 step ─────────────────────────────────────────
  const patchStep = useCallback((turnId: string, stepNo: number, patch: Partial<Step>) => {
    setTurns(prev => prev.map(t => t.id !== turnId ? t : {
      ...t,
      steps: t.steps.map(s => s.step !== stepNo ? s : { ...s, ...patch }),
    }));
  }, []);

  const patchTurn = useCallback((turnId: string, patch: Partial<Turn>) => {
    setTurns(prev => prev.map(t => t.id === turnId ? { ...t, ...patch } : t));
  }, []);

  const ensureStep = useCallback((turnId: string, stepNo: number, patch: Partial<Step>) => {
    setTurns(prev => prev.map(t => {
      if (t.id !== turnId) return t;
      const exists = t.steps.some(s => s.step === stepNo);
      return {
        ...t,
        steps: exists
          ? t.steps.map(s => s.step === stepNo ? { ...s, ...patch } : s)
          : [...t.steps, { step: stepNo, output: '', status: 'thinking', ...patch }],
      };
    }));
  }, []);

  // ─── WebSocket ─────────────────────────────────────────────────────────
  const BACKEND_PORT = 3011;
  useEffect(() => {
    const isDev = import.meta.env?.DEV || false;
    const hostname = window.location.hostname;
    const wsHost = (isDev && hostname === 'localhost') ? `localhost:${BACKEND_PORT}` : window.location.host;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${wsHost}/ws/aishell/${server.id}`;
    setConnecting(true);
    setError(null);

    const ws = new WebSocket(withWsToken(wsUrl));
    wsRef.current = ws;
    let ready = false;

    ws.onmessage = (event) => {
      let data: any;
      try { data = JSON.parse(event.data); } catch { return; }
      const turnId = activeTurnRef.current;
      if (!turnId && data.type !== 'aishell_ready') return;

      switch (data.type) {
        case 'aishell_ready':
          ready = true;
          setConnecting(false);
          setConnected(true);
          onReady?.();
          inputRef.current?.focus();
          break;
        case 'context_ready':
          setContextSummary(data.context?.summary || '');
          break;
        case 'step_start':
          setRunning(true);
          ensureStep(turnId!, data.step, { status: 'thinking', output: '' });
          break;
        case 'model_delta':
          setTurns(prev => prev.map(t => t.id !== turnId ? t : {
            ...t,
            steps: t.steps.map(s => s.step === (data.step ?? t.steps[t.steps.length - 1]?.step)
              ? { ...s, modelPreview: (s.modelPreview || '') + data.data }
              : s),
          }));
          break;
        case 'thought':
          patchStep(turnId!, data.step, { thought: data.content });
          break;
        case 'command_ready':
          patchStep(turnId!, data.step, {
            command: data.command,
            risk: data.risk,
            riskReason: data.reason || undefined,
            status: data.risk === 'read' || autoRun ? 'thinking' : 'waiting_confirm',
          });
          break;
        case 'confirm_required':
          patchStep(turnId!, data.step, { status: 'waiting_confirm', command: data.command, risk: data.risk });
          break;
        case 'command_start':
          patchStep(turnId!, data.step, { status: 'running', output: '' });
          break;
        case 'command_output':
          setTurns(prev => prev.map(t => t.id !== turnId ? t : {
            ...t,
            steps: t.steps.map(s => {
              if (s.step !== data.step) return s;
              const next = s.output + (data.data || '');
              return { ...s, output: next.length > OUTPUT_LIMIT ? next.slice(-OUTPUT_LIMIT) : next };
            }),
          }));
          break;
        case 'command_done':
          patchStep(turnId!, data.step, { status: 'done', exitCode: data.exitCode });
          break;
        case 'command_error':
          patchStep(turnId!, data.step, { status: 'error', output: `${''}${data.error || ''}` });
          break;
        case 'command_rejected':
          patchStep(turnId!, data.step, { status: 'rejected' });
          break;
        case 'final':
          patchTurn(turnId!, { final: data.content, status: 'done' });
          setRunning(false);
          break;
        case 'agent_done':
          setTurns(prev => prev.map(t => t.id === turnId ? {
            ...t,
            status: t.status === 'running' ? (data.status === 'cancelled' ? 'cancelled' : 'done') : t.status,
          } : t));
          setRunning(false);
          activeTurnRef.current = null;
          break;
        case 'cancelled':
          patchTurn(turnId!, { status: 'cancelled' });
          setRunning(false);
          activeTurnRef.current = null;
          break;
        case 'error':
          setError(data.error);
          patchTurn(turnId!, { status: 'error', error: data.error });
          setRunning(false);
          break;
        default:
          break;
      }
    };

    ws.onclose = () => {
      setConnected(false);
      setConnecting(false);
      setRunning(false);
      if (!ready) onReady?.();
    };

    return () => { ws.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);

  // 自动滚动（用户上翻时不打扰）
  useEffect(() => {
    const el = outputRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const onScroll = () => {
    const el = outputRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  // ─── 发送任务 ──────────────────────────────────────────────────────────
  const sendTask = useCallback((text: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
    activeTurnRef.current = id;

    // 历史：最近 5 轮（只带最终结论，避免上下文爆炸）
    const history = turns.slice(-5).flatMap(t => ([
      { role: 'user', content: t.text },
      ...(t.final ? [{ role: 'assistant', content: t.final }] : []),
    ]));

    setTurns(prev => [...prev, { id, text: trimmed, steps: [], status: 'running' }]);
    setInput('');
    setError(null);
    setRunning(true);
    stickToBottomRef.current = true;

    const combinedContent = selectedSkills.map(s => s.content).filter(Boolean).join('\n\n---\n\n');
    ws.send(JSON.stringify({
      type: 'agent_task',
      id,
      text: trimmed,
      autoRun,
      history,
      skillContent: combinedContent,
      skillName: selectedSkills.map(s => s.name).join(' + '),
    }));
  }, [autoRun, selectedSkills, turns]);

  // ─── 命令模式：直接执行 ────────────────────────────────────────────────
  const executeDirect = useCallback((command: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const cmd = command.trim();
    if (!cmd) return;
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
    activeTurnRef.current = id;
    setTurns(prev => [...prev, {
      id, text: cmd, status: 'running',
      steps: [{ step: 1, command: cmd, output: '', status: 'running' }],
    }]);
    setCmdHistory(prev => [...prev, cmd]);
    setCmdHistoryIdx(-1);
    setInput('');
    setError(null);
    ws.send(JSON.stringify({ type: 'execute', id, command: cmd }));
  }, []);

  const confirmStep = useCallback((turn: Turn, step: Step, allow: boolean) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    activeTurnRef.current = turn.id;
    patchStep(turn.id, step.step, { status: allow ? 'running' : 'rejected' });
    if (allow) setRunning(true);
    ws.send(JSON.stringify({ type: 'confirm', id: turn.id, allow }));
  }, [patchStep]);

  const stop = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'cancel', id: activeTurnRef.current || '' }));
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = input.trim();
      if (!text) return;
      if (mode === 'cmd') executeDirect(text);
      else if (text.startsWith('$')) executeDirect(text.slice(1).trim());
      else sendTask(text);
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
      setTurns([]);
    } else if (e.key === 'Escape' && running) {
      stop();
    }
  };

  const copyText = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const containerCls = isFullscreen ? 'fixed inset-4 z-50' : 'relative w-full h-full';

  return (
    <div className={`${containerCls} bg-dark-950 border border-dark-700 rounded-xl overflow-hidden flex flex-col shadow-2xl`}>
      {/* 顶部栏 */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-dark-900 border-b border-dark-700">
        <div className="flex items-center gap-3 min-w-0">
          {connecting ? (
            <span className="flex items-center gap-1.5 text-xs text-yellow-400 shrink-0">
              <Loader className="w-3.5 h-3.5 animate-spin" /> 连接中...
            </span>
          ) : connected ? (
            <span className="flex items-center gap-1.5 text-xs text-purple-400 shrink-0">
              <Sparkles className="w-3.5 h-3.5" /> AI Shell
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-xs text-red-400 shrink-0">
              <span className="w-2 h-2 rounded-full bg-red-400" /> 已断开
            </span>
          )}

          <div className="h-4 w-px bg-dark-700 shrink-0" />

          <span className="font-mono text-sm text-dark-300 truncate">
            <span className="text-accent-400">{server.username}</span>
            <span className="text-dark-500">@</span>
            <span className="text-dark-200">{server.host}</span>
          </span>

          {contextSummary && (
            <span
              className="hidden lg:flex items-center gap-1 px-2 py-0.5 rounded bg-dark-800 border border-dark-700 text-[10px] text-dark-400 max-w-[280px] truncate"
              title={contextSummary}
            >
              <Cpu className="w-3 h-3 shrink-0 text-emerald-400" />
              <span className="truncate">{contextSummary.split('\n')[0]}</span>
            </span>
          )}

          {/* 自动执行开关 */}
          <label className="flex items-center gap-1.5 text-[11px] text-dark-400 shrink-0 cursor-pointer select-none"
            title={autoRun
              ? '只读命令自动执行；写操作/危险命令仍会先询问'
              : '每条命令都会等你点「执行」'}>
            <span className={`px-1.5 py-0.5 rounded border ${autoRun ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' : 'border-dark-700'}`}>
              {autoRun ? '自动' : '逐步'}
            </span>
            <input type="checkbox" checked={autoRun} onChange={e => setAutoRun(e.target.checked)} className="sr-only" />
          </label>

          {/* 技能选择器 */}
          {connected && skillsList.length > 0 && (
            <div className="relative shrink-0">
              <button
                onClick={() => setSkillsOpen(v => !v)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs transition-colors ${
                  selectedSkills.length > 0
                    ? 'bg-accent-500/15 text-accent-400 border border-accent-500/20'
                    : 'bg-dark-800 text-dark-400 hover:text-dark-300 border border-dark-700'
                }`}
              >
                <BookOpen className="w-3.5 h-3.5" />
                {selectedSkills.length > 0
                  ? <span className="max-w-[80px] truncate">{selectedSkills.length} 个技能</span>
                  : <span className="hidden sm:inline">技能</span>}
                <ChevronDown className="w-3 h-3" />
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

        <div className="flex items-center gap-1 shrink-0">
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
          {selectedSkills.map(s => (
            <span key={s.id} className="px-1.5 py-0.5 bg-accent-500/10 border border-accent-500/20 rounded text-[10px] text-accent-400 whitespace-nowrap flex-shrink-0">
              {s.name}
            </span>
          ))}
        </div>
      )}

      {/* 会话区 */}
      <div ref={outputRef} onScroll={onScroll} className="flex-1 overflow-y-auto p-4 min-h-0 bg-dark-950 space-y-5">
        {turns.length === 0 && !connecting && (
          <div className="flex flex-col items-center justify-center h-full text-dark-600 gap-3">
            <Sparkles className="w-12 h-12 opacity-20" />
            <p className="text-lg font-medium">AI Shell</p>
            <p className="text-sm text-dark-600 max-w-lg text-center">
              描述目标即可：AI 会先了解这台机器的环境，然后连续执行多步命令、根据输出调整，最后给你结论。
            </p>
            <div className="flex flex-wrap justify-center gap-2 mt-3 max-w-2xl">
              {AI_SUGGESTIONS.map(suggestion => (
                <button key={suggestion} onClick={() => { setInput(suggestion); inputRef.current?.focus(); }}
                  className="px-3 py-1.5 rounded-lg bg-dark-800/60 hover:bg-dark-700 text-xs text-dark-400 transition-colors border border-dark-700">
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {connecting && (
          <div className="flex flex-col items-center justify-center h-full gap-5">
            <div className="w-14 h-14 rounded-full bg-purple-500/10 border border-purple-500/20 flex items-center justify-center">
              <Sparkles className="w-7 h-7 text-purple-400 animate-pulse" />
            </div>
            <p className="text-sm text-purple-300">正在建立 AI Shell 会话，采集服务器环境...</p>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400">
            <AlertCircle className="w-4 h-4 shrink-0" /><span className="text-sm">{error}</span>
          </div>
        )}

        {turns.map(turn => (
          <div key={turn.id} className="space-y-2.5">
            {/* 用户请求 */}
            <div className="flex items-start gap-2.5">
              <div className="flex-shrink-0 mt-0.5 w-6 h-6 rounded-md bg-dark-800 flex items-center justify-center text-[11px]">👤</div>
              <p className="text-sm text-dark-200 flex-1 min-w-0 break-words">{turn.text}</p>
              <button onClick={() => copyText(turn.text, `u-${turn.id}`)} className="p-1 rounded hover:bg-dark-800 text-dark-600 hover:text-dark-400">
                {copiedId === `u-${turn.id}` ? <ClipboardCheck className="w-3 h-3 text-green-400" /> : <Clipboard className="w-3 h-3" />}
              </button>
            </div>

            {/* 步骤时间线 */}
            {turn.steps.length > 0 && (
              <div className="pl-8 space-y-2 border-l border-dark-800 ml-3">
                {turn.steps.map(step => (
                  <div key={step.step} className="relative pl-3">
                    <span className="absolute -left-[13px] top-1.5 w-2 h-2 rounded-full bg-dark-600 border border-dark-950" />
                    {/* 思考 */}
                    {(step.thought || (step.status === 'thinking' && step.modelPreview)) && (
                      <p className="text-xs text-dark-500 mb-1">
                        {step.thought || <span className="font-mono whitespace-pre-wrap">{step.modelPreview?.slice(-300)}</span>}
                      </p>
                    )}
                    {/* 命令 */}
                    {step.command && (
                      <div className="flex items-start gap-2">
                        <div className="flex-1 min-w-0 rounded-lg bg-dark-900/80 border border-dark-700 px-3 py-1.5 font-mono text-xs text-green-400 break-all">
                          {turn.steps.length > 1 && <span className="text-dark-600 mr-1.5">#{step.step}</span>}
                          {step.command}
                        </div>
                        {step.risk && (
                          <span className={`shrink-0 px-1.5 py-0.5 rounded border text-[10px] ${RISK_META[step.risk].cls}`} title={step.riskReason || undefined}>
                            {RISK_META[step.risk].label}
                          </span>
                        )}
                      </div>
                    )}
                    {/* 确认按钮 */}
                    {step.status === 'waiting_confirm' && (
                      <div className="mt-1.5 flex items-center gap-2">
                        <ShieldAlert className="w-3.5 h-3.5 text-yellow-400" />
                        <span className="text-xs text-yellow-400/90">这条命令会修改服务器状态，确认执行？</span>
                        <button onClick={() => confirmStep(turn, step, true)}
                          className="px-2.5 py-1 rounded bg-green-500/20 text-green-400 text-xs hover:bg-green-500/30">执行</button>
                        <button onClick={() => confirmStep(turn, step, false)}
                          className="px-2.5 py-1 rounded bg-dark-700 text-dark-400 text-xs hover:bg-dark-600">跳过</button>
                      </div>
                    )}
                    {step.status === 'rejected' && (
                      <p className="mt-1 text-xs text-dark-500">已跳过这条命令</p>
                    )}
                    {/* 输出 */}
                    {step.output && (
                      <div className="mt-1.5 rounded-lg bg-dark-900/60 border border-dark-800 overflow-hidden">
                        <div className="px-2.5 py-1 border-b border-dark-800 flex items-center justify-between">
                          <span className="text-[10px] text-dark-500 font-mono flex items-center gap-1">
                            <Terminal className="w-3 h-3" /> 输出
                          </span>
                          <span className="text-[10px] flex items-center gap-1">
                            {step.status === 'running' && <><Loader className="w-3 h-3 animate-spin text-yellow-400" /><span className="text-yellow-400">执行中</span></>}
                            {step.status === 'done' && step.exitCode === 0 && <><Check className="w-3 h-3 text-green-400" /><span className="text-green-400">exit 0</span></>}
                            {step.status === 'done' && step.exitCode !== 0 && <span className="text-red-400">exit {step.exitCode}</span>}
                            {step.status === 'error' && <span className="text-red-400">失败</span>}
                          </span>
                        </div>
                        <pre className="p-2.5 font-mono text-[11px] text-dark-300 leading-relaxed whitespace-pre-wrap break-all max-h-72 overflow-y-auto">
                          <span dangerouslySetInnerHTML={{ __html: ansiToHtml(step.output) }} />
                        </pre>
                      </div>
                    )}
                    {step.status === 'running' && !step.output && (
                      <p className="mt-1 text-xs text-yellow-400 flex items-center gap-1.5">
                        <Loader className="w-3 h-3 animate-spin" />执行中...
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* 最终结论 */}
            {turn.final && (
              <div className="pl-8">
                <div className="flex items-start gap-2.5">
                  <div className="flex-shrink-0 mt-0.5 w-6 h-6 rounded-md bg-purple-500/10 flex items-center justify-center">
                    <Sparkles className="w-3.5 h-3.5 text-purple-400" />
                  </div>
                  <div className="flex-1 min-w-0 text-sm text-dark-200 whitespace-pre-wrap break-words">{turn.final}</div>
                  <button onClick={() => copyText(turn.final!, `f-${turn.id}`)} className="p-1 rounded hover:bg-dark-800 text-dark-600 hover:text-dark-400">
                    {copiedId === `f-${turn.id}` ? <ClipboardCheck className="w-3 h-3 text-green-400" /> : <Clipboard className="w-3 h-3" />}
                  </button>
                </div>
                {turn.status === 'running' && <p className="text-[11px] text-dark-600 mt-1 pl-8">继续处理中…</p>}
              </div>
            )}

            {turn.status === 'cancelled' && (
              <p className="pl-8 text-xs text-dark-500 flex items-center gap-1.5"><Square className="w-3 h-3" />已停止</p>
            )}
            {turn.status === 'error' && turn.error && (
              <p className="pl-8 text-xs text-red-400 flex items-center gap-1.5"><AlertCircle className="w-3 h-3" />{turn.error}</p>
            )}
            {turn.status === 'done' && !turn.final && (
              <p className="pl-8 text-xs text-dark-600">任务结束</p>
            )}
          </div>
        ))}

        {running && (
          <div className="flex items-center gap-2 text-xs text-purple-400 pl-2">
            <Loader className="w-3.5 h-3.5 animate-spin" />
            AI 正在处理…
          </div>
        )}
      </div>

      {/* 输入区 */}
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

          <span className="text-xs text-dark-600 mr-1 flex-shrink-0">快速:</span>
          {QUICK_COMMANDS.map(q => (
            <button
              key={q.cmd}
              onClick={() => { if (mode === 'cmd') setInput(q.cmd); else executeDirect(q.cmd); inputRef.current?.focus(); }}
              disabled={!connected}
              className="flex-shrink-0 px-2 py-1 rounded bg-dark-800 hover:bg-dark-700 text-xs text-dark-400 font-mono disabled:opacity-40 transition-colors"
            >{q.label}</button>
          ))}
          {running && (
            <button onClick={stop} className="ml-auto flex-shrink-0 px-2.5 py-1 rounded bg-red-500/20 text-red-400 text-xs hover:bg-red-500/30 flex items-center gap-1">
              <Square className="w-3 h-3" /> 停止
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 px-4 py-3">
          {mode === 'cmd' ? (
            <span className="text-green-400 font-mono text-sm flex-shrink-0">$</span>
          ) : (
            <Sparkles className="w-4 h-4 text-purple-400 flex-shrink-0" />
          )}
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!connected}
            placeholder={!connected
              ? '等待连接...'
              : mode === 'cmd'
                ? '输入命令，回车执行（↑↓ 历史，Ctrl+L 清屏）'
                : '描述你想做的事，回车让 AI 处理（Shift 不换行）'}
            className={`flex-1 bg-transparent outline-none text-sm text-dark-200 placeholder-dark-600 disabled:opacity-50 ${mode === 'cmd' ? 'font-mono' : ''}`}
            autoFocus
          />
          {running ? (
            <button onClick={stop} title="停止当前任务"
              className="flex-shrink-0 p-2 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors">
              <Square className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={() => { if (!input.trim()) return; if (mode === 'cmd') executeDirect(input); else sendTask(input); }}
              disabled={!connected || !input.trim()}
              className={`flex-shrink-0 p-2 rounded-lg disabled:opacity-30 transition-colors ${mode === 'cmd' ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30' : 'bg-purple-500/20 text-purple-400 hover:bg-purple-500/30'}`}
            >
              {mode === 'cmd' ? <ChevronRightIcon /> : <Send className="w-4 h-4" />}
            </button>
          )}
        </div>
        {mode === 'ai' && (
          <div className="px-4 pb-2 -mt-1 text-[10px] text-dark-600 flex items-center gap-3">
            <span>{autoRun ? '自动模式：只读命令直接执行，写操作会询问' : '逐步模式：每条命令都要确认'}</span>
            <span>· Esc 停止</span>
          </div>
        )}
      </div>
    </div>
  );
}

function ChevronRightIcon() {
  return <ArrowRight className="w-4 h-4" />;
}

/** exitCode → step 状态 */
function DataViewDone(exitCode: number): Step['status'] {
  return exitCode === 0 || exitCode == null ? 'done' : 'done';
}
