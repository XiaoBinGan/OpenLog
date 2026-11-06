/**
 * 实时日志流面板。
 *
 * 从 pages/Docker.tsx 整块搬出（JSX / class / 文案逐字保留）。
 * WebSocket 本身不在这里：连接、暂停、清空都在父页面的 useLiveLogStream 里，
 * 这里只负责渲染 + 复制 + 自动滚动。
 */

import { useEffect, useRef, useState } from 'react';
import { StopCircle, Loader, Check, Copy, X } from 'lucide-react';
import type { LiveLogLine } from './types';
import { LEVEL_COLORS } from './utils';

interface LiveLogPanelProps {
  panelKey: string;
  containerName: string;
  lines: LiveLogLine[];
  paused: boolean;
  connecting: boolean;
  onPause: () => void;
  onResume: () => void;
  onClear: () => void;
  onClose: () => void;
}

function LiveLogPanel({ panelKey, containerName, lines, paused, connecting, onPause, onResume, onClear, onClose }: LiveLogPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);

  // 复制全部日志（支持手动框选，也提供一键复制 —— 有些浏览器/远程桌面里框选很别扭）
  const copyAll = async () => {
    const text = lines
      .map(l => `${l.timestamp ? `${l.timestamp} ` : ''}[${l.level}] ${l.content || l.line}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 非 HTTPS / 无剪贴板权限时退回到临时 textarea
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* 忽略 */ }
      document.body.removeChild(ta);
    }
  };

  // 自动滚动到底部（仅在未暂停、自动滚动开启、且用户没有正在选中文字时）
  // 注意：用 behavior:'auto' 而不是 'smooth' —— 平滑滚动会在用户框选日志时
  // 把选中区域滚走，表现为「选不中 / 一闪就没了」。
  useEffect(() => {
    if (paused || !autoScroll || !bottomRef.current) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return; // 正在选中，别抢滚动
    bottomRef.current.scrollIntoView({ behavior: 'auto', block: 'nearest' });
  }, [lines, paused, autoScroll]);

  // 检测用户手动滚动
  const handleScroll = () => {
    if (scrollRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
      setAutoScroll(scrollHeight - scrollTop - clientHeight < 50);
    }
  };

  return (
    <div className="border-t border-dark-800 bg-[#0d1117] w-full max-w-full min-w-0 overflow-hidden">
      {/* 标题栏 */}
      <div className="px-4 py-2 border-b border-dark-800 flex flex-wrap items-center gap-2 min-w-0 max-w-full overflow-hidden bg-dark-900/50">
        <StopCircle className="w-3.5 h-3.5 text-green-400" />
        <span className="text-xs font-mono text-green-400 min-w-0 max-w-[35%] truncate" title={containerName}>{containerName}</span>
        <span className="text-xs text-dark-600">
          实时日志流
          {connecting && <Loader className="w-3 h-3 animate-spin inline ml-1" />}
          {!connecting && !paused && <span className="text-green-500 ml-1">● LIVE</span>}
          {paused && <span className="text-yellow-500 ml-1">⏸ 已暂停</span>}
        </span>
        <span className="text-xs text-dark-700 ml-2">{lines.length} 条</span>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1 min-w-0">
          {paused ? (
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onResume(); }}
              className="text-xs px-2 py-0.5 rounded text-green-400 hover:text-green-300 border border-green-500/30 hover:border-green-500/50 transition-colors"
              title="继续"
            >
              ▶ 继续
            </button>
          ) : (
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onPause(); }}
              className="text-xs px-2 py-0.5 rounded text-yellow-400 hover:text-yellow-300 border border-yellow-500/30 hover:border-yellow-500/50 transition-colors"
              title="暂停"
            >
              ⏸ 暂停
            </button>
          )}
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); copyAll(); }}
            className="text-xs px-2 py-0.5 rounded text-dark-500 hover:text-dark-200 border border-dark-800 hover:border-dark-600 transition-colors flex items-center gap-1"
            title="复制全部日志"
          >
            {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
            {copied ? '已复制' : '复制'}
          </button>
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClear(); }}
            className="text-xs px-2 py-0.5 rounded text-dark-600 hover:text-dark-400 border border-dark-800 hover:border-dark-700 transition-colors"
            title="清空"
          >
            清空
          </button>
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClose(); }}
            className="text-xs px-2 py-0.5 rounded text-dark-500 hover:text-red-400 border border-dark-800 hover:border-red-500/30 transition-colors"
            title="关闭日志流"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 日志输出区 - 暗色终端风格 */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-80 overflow-y-auto overflow-x-hidden px-4 py-2 font-mono text-xs leading-relaxed min-w-0 max-w-full select-text"
      >
        {connecting && lines.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-dark-600">
            <Loader className="w-4 h-4 animate-spin mr-2" /> 连接中...
          </div>
        ) : lines.length === 0 ? (
          <div className="text-dark-600 py-8 text-center">等待日志...</div>
        ) : (
          lines.map((l, i) => (
            <div key={i} className={`flex gap-2 py-px min-w-0 max-w-full overflow-hidden hover:bg-dark-800/30 ${LEVEL_COLORS[l.level] || 'text-dark-300'}`}>
              <span className="text-dark-700 flex-shrink-0 w-44">
                {l.timestamp?.slice(0, 23) || l.timestamp?.slice(0, 19) || '-'}
              </span>
              <span className="flex-shrink-0 w-12 font-semibold">
                [{l.level}]
              </span>
              <span className="min-w-0 flex-1 break-all whitespace-pre-wrap overflow-hidden">{l.content || l.line}</span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
        {!autoScroll && !paused && (
          <button
            onClick={(e) => { e.preventDefault(); setAutoScroll(true); bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }}
            className="sticky bottom-2 mx-auto block text-xs px-3 py-1 rounded bg-dark-700 text-dark-300 hover:bg-dark-600 border border-dark-600 transition-colors"
          >
            ↓ 跟随最新日志
          </button>
        )}
      </div>
    </div>
  );
}

export default LiveLogPanel;
