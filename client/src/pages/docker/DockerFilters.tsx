/**
 * Docker 页过滤器：搜索框 + 状态过滤 + 重置排序 + 数据源状态。
 *
 * 从 pages/Docker.tsx 原样搬出（class / 文案逐字保留）。
 */

import { Search, GripVertical } from 'lucide-react';
import type { ContainerSource } from './types';

interface DockerFiltersProps {
  filter: string;
  onFilterChange: (v: string) => void;
  levelFilter: string;
  onLevelFilterChange: (v: string) => void;
  onResetOrder: () => void;
  sources: ContainerSource[];
}

function DockerFilters({
  filter,
  onFilterChange,
  levelFilter,
  onLevelFilterChange,
  onResetOrder,
  sources,
}: DockerFiltersProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative flex-1 min-w-[200px] max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-dark-500" />
        <input
          type="text"
          value={filter}
          onChange={e => onFilterChange(e.target.value)}
          placeholder="搜索容器名称、镜像、ID..."
          className="w-full pl-9 pr-3 py-2 bg-dark-900 border border-dark-800 rounded-lg text-sm text-dark-200 placeholder-dark-600 focus:outline-none focus:border-accent-500/50"
        />
      </div>
      {['all', 'running', 'exited', 'paused'].map(s => (
        <button
          key={s}
          onClick={() => onLevelFilterChange(s)}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            levelFilter === s
              ? 'bg-dark-700 text-dark-100 border border-dark-600'
              : 'bg-dark-900 text-dark-500 border border-dark-800 hover:border-dark-700'
          }`}
        >
          {s === 'all' ? '全部' : s}
        </button>
      ))}
      <button
        onClick={onResetOrder}
        className="px-3 py-1.5 rounded-lg text-xs font-medium bg-dark-900 text-dark-500 border border-dark-800 hover:border-dark-600 hover:text-dark-300 transition-colors"
        title="重置为默认排序"
      >
        <GripVertical className="w-3 h-3 inline mr-1" />
        重置排序
      </button>
      <div className="ml-auto text-xs text-dark-600">
        {sources.length > 0 && sources.map(s => (
          s.error
            ? <span key={s.sourceId} className="text-red-400 mr-2">⚠️ {s.sourceName}</span>
            : <span key={s.sourceId} className="text-dark-500 mr-2">{s.sourceName}</span>
        ))}
      </div>
    </div>
  );
}

export default DockerFilters;
