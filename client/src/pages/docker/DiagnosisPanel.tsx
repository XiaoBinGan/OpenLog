/**
 * AI 智能诊断面板。
 *
 * 从 pages/Docker.tsx 整块搬出（JSX / class / 文案逐字保留）。
 * 请求与 SSE 解析不在这个文件里 —— 在这里放置会把流式细节和渲染缠在一起，
 * 它留在父页面的 useDiagnosis（`headers: {'Content-Type': 'application/json'}`
 * + `body: JSON.stringify({})` + `j.status` 进度事件，一行都没动）。
 */

import { useEffect, useRef } from 'react';
import { Stethoscope, Loader, CheckCircle, Copy, Check, X } from 'lucide-react';
import { renderMarkdown } from './utils';

interface DiagnosisPanelProps {
  panelKey: string;
  containerName: string;
  loading: boolean;
  text: string;
  copied: boolean;
  onCopy: () => void;
  onClose: () => void;
}

function DiagnosisPanel({ panelKey, containerName, loading, text, copied, onCopy, onClose }: DiagnosisPanelProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  // Auto-scroll 内容区底部（流式输出时）。
  // 用户正在框选诊断内容时不要抢滚动，否则选中区域会被滚走。
  useEffect(() => {
    const el = contentRef.current;
    if (!el || !text) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim() && el.contains(sel.anchorNode)) return;
    el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <div className="border-t border-accent-500/30 bg-[#0d1117]">
      {/* 标题栏 */}
      <div className="px-4 py-2 border-b border-accent-500/20 flex items-center gap-2 bg-accent-500/5">
        <Stethoscope className="w-3.5 h-3.5 text-accent-400" />
        <span className="text-xs font-mono text-accent-400">{containerName}</span>
        <span className="text-xs text-accent-500/70">
          AI 诊断
          {loading && <Loader className="w-3 h-3 animate-spin inline ml-1 text-accent-400" />}
          {!loading && text && <CheckCircle className="w-3 h-3 inline ml-1 text-green-400" />}
        </span>
        <div className="ml-auto flex gap-1">
          {text && !loading && (
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onCopy(); }}
              className="text-xs px-2 py-0.5 rounded text-dark-400 hover:text-dark-200 border border-dark-700 hover:border-dark-500 transition-colors flex items-center gap-1"
              title="复制诊断结果"
            >
              {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
              {copied ? '已复制' : '复制'}
            </button>
          )}
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClose(); }}
            className="text-xs px-2 py-0.5 rounded text-dark-500 hover:text-red-400 border border-dark-800 hover:border-red-500/30 transition-colors"
            title="关闭诊断面板"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 诊断内容区 */}
      <div className="h-80 overflow-y-auto px-4 py-3" ref={contentRef}>
        {loading && !text ? (
          <div className="flex flex-col items-center justify-center py-16 text-dark-500">
            <Stethoscope className="w-10 h-10 mb-3 animate-pulse text-accent-500/50" />
            <p className="text-sm">正在拉取容器日志并进行分析...</p>
            <p className="text-xs mt-1 text-dark-600">AI 正在诊断 {containerName}</p>
          </div>
        ) : !text ? (
          <div className="text-dark-600 py-8 text-center text-sm">
            诊断未开始
          </div>
        ) : (
          <div
            className="text-sm text-dark-200 leading-relaxed prose-invert
              [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-xs [&_h1_h2_h3]:font-bold [&_h1_h2_h3]:mt-3 [&_h1_h2_h3]:mb-1
              [&_code]:bg-dark-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs
              [&_ul]:list-disc [&_ul]:ml-4 [&_ol]:list-decimal [&_ol]:ml-4
              [&_li]:text-xs [&_li]:my-0.5
              [&_pre]:bg-dark-900 [&_pre]:p-2 [&_pre]:rounded [&_pre]:text-xs [&_pre]:overflow-x-auto
              [&_strong]:text-dark-100
              [&_blockquote]:border-l-2 [&_blockquote]:border-accent-500/30 [&_blockquote]:pl-3 [&_blockquote]:text-dark-400"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
          />
        )}
      </div>
    </div>
  );
}

export default DiagnosisPanel;
