/**
 * Docker 页面的纯函数 / 常量。
 *
 * 全部从 pages/Docker.tsx 原样搬出：判定文案、颜色、Markdown 渲染。
 * 不含任何 state，所以可以放心被父页面和行组件共用。
 */

import { marked } from 'marked';
import { sanitizeHtml } from '../../utils/sanitize';

export function renderMarkdown(md: string): string {
  // DOMPurify runs at the source so every dangerouslySetInnerHTML in this page
  // (batch analysis + fix suggestions) is already sanitized.
  return sanitizeHtml(marked.parse(md, { breaks: true }) as string);
}

export const getStateColor = (state: string, exitType?: string | null) => {
  if (state === 'running') return 'text-green-400';
  if (state === 'exited') {
    if (exitType === 'oom') return 'text-red-400';
    if (exitType === 'error' || exitType === 'segfault') return 'text-orange-400';
    if (exitType === 'terminated') return 'text-yellow-400';
    return 'text-dark-400';
  }
  if (state === 'paused') return 'text-yellow-400';
  return 'text-red-400';
};

export const getStateDot = (state: string, exitType?: string | null) => {
  if (state === 'running') return 'bg-green-400';
  if (state === 'exited') {
    if (exitType === 'oom') return 'bg-red-500 animate-pulse';
    if (exitType === 'error' || exitType === 'segfault') return 'bg-orange-400';
    if (exitType === 'terminated') return 'bg-yellow-400';
    return 'bg-dark-500';
  }
  if (state === 'paused') return 'bg-yellow-400';
  return 'bg-red-400';
};

export const getExitLabel = (exitType?: string | null, exitCode?: number | null) => {
  if (exitType === 'oom') return '💀 OOM 内存溢出';
  if (exitType === 'error') return `❌ 异常退出(${exitCode})`;
  if (exitType === 'segfault') return '💥 段错误';
  if (exitType === 'terminated') return '🛑 被终止';
  if (exitType === 'normal') return '✅ 正常退出';
  return null;
};

export const logLevelColor = (level: string) => {
  if (level === 'ERROR') return 'text-red-400';
  if (level === 'WARN') return 'text-yellow-400';
  if (level === 'DEBUG') return 'text-dark-500';
  return 'text-dark-300';
};

export const LEVEL_COLORS: Record<string, string> = {
  'FATAL': 'text-red-300',
  'ERROR': 'text-red-400',
  'WARN': 'text-yellow-400',
  'WARNING': 'text-yellow-400',
  'INFO': 'text-dark-200',
  'DEBUG': 'text-dark-500',
  'TRACE': 'text-dark-600',
};

/**
 * 稳定的空值常量。
 *
 * 行组件是 React.memo 的：父页面若写 `containerLogs[key] || []`，每次渲染都会
 * 产生一个新数组，memo 就永远失效（整张列表跟着日志逐行重渲染）。用同一个
 * 冻结常量做兜底，值语义不变，引用稳定。
 */
export const EMPTY_LOGS: any[] = [];
export const EMPTY_LIVE_LINES: { timestamp: string; line: string; level: string; content: string }[] = [];
export const EMPTY_CMDS: { cmd: string; output: string; time: number }[] = [];
