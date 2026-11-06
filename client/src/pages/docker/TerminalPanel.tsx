/**
 * 容器内命令执行面板。
 *
 * 从 pages/Docker.tsx 整块搬出（JSX / class / 文案逐字保留）。
 * 输入框的值与执行记录仍由父页面持有（多行共享同一份 cmdInput，
 * 这是现有行为，不在这里改动），本组件只负责渲染与本地复制状态。
 */

import { useEffect, useRef, useState } from 'react';
import { Terminal, Check, Copy, Loader } from 'lucide-react';
import type { TermLine } from './types';

interface TermPanelProps {
  panelKey: string;
  containerName: string;
  cmds: TermLine[];
  cmdInput: string;
  setCmdInput: (v: string) => void;
  onRun: (cmd: string) => void;
  onClear: () => void;
  execLoading: boolean;
}

function TerminalPanel({ panelKey, containerName, cmds, cmdInput, setCmdInput, onRun, onClear, execLoading }: TermPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'nearest' }); }, [cmds]);

  const copyAll = async () => {
    const text = cmds.map(l => `$ ${l.cmd}\n${l.output || '(无输出)'}`).join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* 无剪贴板权限就算了，手动框选仍然可用 */ }
  };

  return (
    <div className="border-t border-dark-800 bg-[#0d1117] w-full max-w-full min-w-0 overflow-hidden">
      {/* 标题栏 */}
      <div className="px-4 py-2 border-b border-dark-800 flex items-center gap-2 bg-dark-900/50">
        <Terminal className="w-3.5 h-3.5 text-accent-400" />
        <span className="text-xs font-mono text-accent-400">{containerName}</span>
        <span className="text-xs text-dark-600">容器内执行命令</span>
        <span className="text-[10px] text-dark-700 border border-dark-800 rounded px-1">只读</span>
        <div className="ml-auto flex gap-1">
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); copyAll(); }}
            className="text-xs px-2 py-0.5 rounded text-dark-500 hover:text-dark-200 border border-dark-800 hover:border-dark-600 transition-colors flex items-center gap-1"
            title="复制全部输出"
          >
            {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
            {copied ? '已复制' : '复制'}
          </button>
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClear(); }}
            className="text-xs px-2 py-0.5 rounded text-dark-600 hover:text-dark-400 border border-dark-800 hover:border-dark-700 transition-colors"
          >清空</button>
        </div>
      </div>

      {/* 输出区 */}
      <div className="h-52 overflow-y-auto px-4 py-2 font-mono text-xs">
        {cmds.length === 0 ? (
          <div className="text-dark-600 py-4 text-center">
            输入命令按回车执行（仅只读命令，禁止 <span className="text-accent-400">; | && $( )</span> 等 shell 组成），例如 <span className="text-accent-400">ps aux</span>、<span className="text-accent-400">ls /</span>、<span className="text-accent-400">cat /etc/hosts</span>
          </div>
        ) : cmds.map((l, i) => (
          <div key={i} className="mb-3">
            <div className="flex items-center gap-1 text-accent-400">
              <span className="opacity-60">$</span>
              <span>{l.cmd}</span>
            </div>
            <pre className="text-dark-300 whitespace-pre-wrap break-all mt-0.5 leading-relaxed">{l.output || '(无输出)'}</pre>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* 输入框 */}
      <div className="border-t border-dark-800 px-4 py-2 flex items-center gap-2">
        <span className="text-accent-400 font-mono text-sm">$</span>
        <input
          type="text"
          value={cmdInput}
          onChange={e => setCmdInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !execLoading) onRun(cmdInput);
          }}
          placeholder="输入命令，按回车执行..."
          className="flex-1 bg-transparent text-dark-200 text-sm font-mono placeholder-dark-700 focus:outline-none"
        />
        {execLoading && <Loader className="w-3.5 h-3.5 animate-spin text-dark-500" />}
      </div>
    </div>
  );
}

export default TerminalPanel;
