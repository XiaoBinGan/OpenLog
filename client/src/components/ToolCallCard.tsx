/**
 * ToolCallCard — 运维助手里的「工具步骤卡」。
 *
 * 为什么需要：之前工具调用只渲染成一个小 chip + tooltip，用户看不到
 * 「执行了什么命令、输出了什么、跑了多久」，体验远不如 AI Shell 的步骤列表。
 * 这张卡把一步工具调用画成：
 *   状态图标 + 中文工具名 + 摘要（命令/路径） + 退出码 + 耗时 + 展开输出
 * 运行中显示流式输出（后端 tool_progress 推来的片段），完成后显示结果。
 */
import { useState } from 'react';
import {
  ChevronDown, ChevronRight, Loader, CheckCircle2, XCircle, Ban, Terminal, Copy, Check,
} from 'lucide-react';
import {
  toolLabel, toolCallStatus, toolCallSummary, toolCallOutput,
  toolCallExitCode, durationLabel, hasDetails, type ToolCallLike,
} from '../utils/toolCallView';

interface Props {
  tc: ToolCallLike;
  /** 默认展开（例如失败、或用户点过「全部展开」） */
  defaultOpen?: boolean;
}

const STATUS_STYLE: Record<string, { row: string; icon: string }> = {
  running: { row: 'border-yellow-500/25 bg-yellow-500/5', icon: 'text-yellow-400' },
  ok: { row: 'border-dark-800 bg-dark-900/60', icon: 'text-green-400' },
  failed: { row: 'border-red-500/30 bg-red-500/5', icon: 'text-red-400' },
  aborted: { row: 'border-dark-800 bg-dark-900/40', icon: 'text-dark-500' },
};

export default function ToolCallCard({ tc, defaultOpen = false }: Props) {
  const status = toolCallStatus(tc);
  const detail = hasDetails(tc);
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);
  const style = STATUS_STYLE[status] || STATUS_STYLE.ok;
  const summary = toolCallSummary(tc);
  const exitCode = toolCallExitCode(tc);
  const dur = durationLabel(tc.durationMs);
  const output = open ? toolCallOutput(tc) : { text: '', truncated: false, kind: 'none' as const };
  const preview = tc.result?.preview ? String(tc.result.preview) : '';

  /** 复制这次工具的输出（排查时最常干的事） */
  const copyOutput = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const text = toolCallOutput(tc).text || preview;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* 剪贴板不可用时静默 */ }
  };

  const StatusIcon = status === 'running' ? Loader
    : status === 'failed' ? XCircle
    : status === 'aborted' ? Ban
    : CheckCircle2;

  return (
    <div className={`rounded-lg border text-xs overflow-hidden ${style.row}`}>
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => detail && setOpen(v => !v)}
          className={`flex-1 min-w-0 flex items-center gap-2 px-2.5 py-1.5 text-left ${detail ? 'cursor-pointer hover:bg-white/5' : 'cursor-default'}`}
        >
          <StatusIcon className={`w-3.5 h-3.5 flex-shrink-0 ${style.icon} ${status === 'running' ? 'animate-spin' : ''}`} />
          <span className="font-medium text-dark-200 flex-shrink-0">{toolLabel(tc.tool)}</span>
          {summary && (
            <span className="font-mono text-[11px] text-dark-400 truncate min-w-0 flex-1" title={summary}>
              <Terminal className="w-3 h-3 inline mr-1 opacity-60" />{summary}
            </span>
          )}
          {!summary && <span className="flex-1" />}
          {status === 'aborted' && <span className="text-[10px] text-dark-500 flex-shrink-0">已中断</span>}
          {exitCode != null && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${
              exitCode === 0 ? 'bg-dark-800 text-dark-400' : 'bg-red-500/15 text-red-400'
            }`}>exit {exitCode}</span>
          )}
          {dur && <span className="text-[10px] text-dark-500 flex-shrink-0">{dur}</span>}
          {detail && (
            <span className="text-dark-500 flex-shrink-0">
              {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            </span>
          )}
        </button>
        {/* 复制这次工具的输出（排查时最常干的事） */}
        {detail && (
          <button
            type="button"
            onClick={copyOutput}
            title="复制输出"
            className="mr-1.5 p-1 rounded text-dark-500 hover:text-accent-400 hover:bg-white/5 transition-colors flex-shrink-0"
          >
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>

      {/* 失败原因不用展开也看得到 */}
      {!open && tc.result?.error && (
        <div className="px-2.5 pb-1.5 text-[11px] text-red-300/80 font-mono break-all">
          {String(tc.result.error).slice(0, 300)}
        </div>
      )}

      {open && (
        <div className="border-t border-dark-800/60">
          {output.text && (
            <div className="relative">
              <pre className="px-2.5 py-2 text-[11px] font-mono text-dark-300 whitespace-pre-wrap break-all max-h-64 overflow-y-auto bg-dark-950/50">
                {output.text}
              </pre>
              {output.truncated && (
                <div className="px-2.5 py-1 text-[10px] text-yellow-500/80 border-t border-dark-800/60">
                  输出过长，仅显示前 {output.text.length} 字符
                </div>
              )}
            </div>
          )}
          {preview && (
            <pre className="px-2.5 py-2 text-[11px] font-mono bg-dark-950/50 max-h-64 overflow-y-auto">
              {preview.split('\n').map((line, i) => (
                <div key={i} className={line.startsWith('+') ? 'text-green-400' : line.startsWith('-') ? 'text-red-400' : 'text-dark-400'}>
                  {line}
                </div>
              ))}
            </pre>
          )}
          {!output.text && !preview && (
            <div className="px-2.5 py-2 text-[11px] text-dark-500">（无输出）</div>
          )}
        </div>
      )}
    </div>
  );
}
