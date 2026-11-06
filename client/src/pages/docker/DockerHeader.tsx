/**
 * Docker 页标题栏：图标 + 标题 + 已选计数 + 设备选择 + 联合会诊 + 刷新。
 *
 * 从 pages/Docker.tsx 原样搬出（class / 文案逐字保留）。
 */

import { Container, RefreshCw, Zap, Loader } from 'lucide-react';
import DeviceSelector from '../../components/DeviceSelector';

interface DockerHeaderProps {
  containerCount: number;
  selectedCount: number;
  loading: boolean;
  batchAnalyzing: boolean;
  onBatchAnalyze: () => void;
  onRefresh: () => void;
}

function DockerHeader({
  containerCount,
  selectedCount,
  loading,
  batchAnalyzing,
  onBatchAnalyze,
  onRefresh,
}: DockerHeaderProps) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-blue-500/20">
          <Container className="w-6 h-6 text-blue-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-dark-100">Docker 容器管理</h1>
          <p className="text-xs text-dark-500">
            {containerCount} 个容器 · 已选 {selectedCount} 个
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <DeviceSelector />
        {selectedCount > 0 && (
          <button
            onClick={onBatchAnalyze}
            disabled={batchAnalyzing}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-accent-500 text-white text-sm font-medium hover:bg-accent-600 transition-colors disabled:opacity-50"
          >
            {batchAnalyzing ? <Loader className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            联合会诊 ({selectedCount})
          </button>
        )}
        <button
          onClick={() => onRefresh()}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-dark-800 text-dark-300 hover:bg-dark-700 transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </button>
      </div>
    </div>
  );
}

export default DockerHeader;
