/**
 * 联合会诊（批量分析）结果面板。
 *
 * 从 pages/Docker.tsx 原样搬出（文案 / class 逐字保留）。
 * 数据仍由父页面的 runBatchAnalysis + pollAnalysis 提供，这里只负责展示。
 */

import { CheckCircle, AlertCircle, X } from 'lucide-react';
import { renderMarkdown } from './utils';

interface BatchAnalysisProps {
  batchResult: any;
  onClose: () => void;
}

function BatchAnalysis({ batchResult, onClose }: BatchAnalysisProps) {
  if (!batchResult) return null;

  return (
    <div className="glass rounded-xl border border-accent-500/30 overflow-hidden">
      <div className="px-4 py-3 bg-accent-500/10 border-b border-accent-500/20 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {batchResult.status === 'done'
            ? <CheckCircle className="w-4 h-4 text-green-400" />
            : <AlertCircle className="w-4 h-4 text-red-400" />
          }
          <span className="text-sm font-medium text-dark-100">
            {batchResult.status === 'done' ? '✅ 联合会诊分析完成' : '❌ 分析失败'}
          </span>
        </div>
        <button onClick={onClose} className="text-dark-500 hover:text-dark-200">
          <X className="w-4 h-4" />
        </button>
      </div>
      {batchResult.status === 'done' && batchResult.analysis && (
        <div className="p-4">
          <div
            className="text-sm text-dark-200 leading-relaxed prose-invert max-h-96 overflow-y-auto
              [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-xs [&_h1_h2_h3]:font-bold [&_h1_h2_h3]:mt-3 [&_h1_h2_h3]:mb-1
              [&_code]:bg-dark-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs
              [&_li]:text-xs [&_li]:ml-3"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(batchResult.analysis) }}
          />
        </div>
      )}
      {batchResult.status === 'error' && (
        <div className="p-4 text-sm text-red-400">{batchResult.message}</div>
      )}
    </div>
  );
}

export default BatchAnalysis;
