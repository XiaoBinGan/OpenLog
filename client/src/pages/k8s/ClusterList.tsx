/**
 * 左侧集群列表。
 *
 * 交互：点条目切换右侧概览；每行右侧有「测试连接」（POST .../test）与「删除」（DELETE）。
 * 行本身不是 <button>（里面还有按钮，嵌套 button 不合法），用 div + tabIndex 承担可点区域，
 * 内部按钮一律 stopPropagation，避免点删除时顺带切换选中集群。
 */

import {
  Boxes,
  CircleAlert,
  CircleCheck,
  Loader,
  Plug,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import type { K8sClusterView, K8sTestState } from './types';

interface ClusterListProps {
  clusters: K8sClusterView[];
  selectedId: string | null;
  loading: boolean;
  /** 正在执行测试/删除的集群 id（按钮转圈、禁止重复点）。 */
  busyId: string | null;
  testResults: Record<string, K8sTestState>;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onDelete: (cluster: K8sClusterView) => void;
  onTest: (cluster: K8sClusterView) => void;
  onRefresh: () => void;
}

function ClusterList({
  clusters,
  selectedId,
  loading,
  busyId,
  testResults,
  onSelect,
  onAdd,
  onDelete,
  onTest,
  onRefresh,
}: ClusterListProps) {
  return (
    <aside className="glass rounded-xl overflow-hidden w-full lg:w-72 lg:flex-shrink-0">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-dark-800/60">
        <div className="flex items-center gap-2">
          <Boxes className="w-4 h-4 text-accent-400" />
          <span className="text-sm font-semibold text-dark-100">集群</span>
          <span className="text-xs text-dark-500">{clusters.length}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onRefresh}
            title="刷新集群列表"
            className="p-1.5 rounded-lg text-dark-400 hover:text-dark-100 hover:bg-dark-800 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={onAdd}
            title="添加集群"
            className="p-1.5 rounded-lg text-dark-400 hover:text-dark-100 hover:bg-dark-800 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {clusters.length === 0 ? (
        <div className="px-3 py-6 text-center text-xs text-dark-500">
          {loading ? '正在加载集群…' : '还没有集群'}
        </div>
      ) : (
        <ul className="p-1.5 space-y-1 max-h-[calc(100vh-16rem)] overflow-y-auto">
          {clusters.map((cluster) => {
            const active = cluster.id === selectedId;
            const busy = busyId === cluster.id;
            const test = testResults[cluster.id];
            return (
              <li key={cluster.id}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(cluster.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelect(cluster.id);
                    }
                  }}
                  className={`group rounded-lg px-2.5 py-2 cursor-pointer transition-colors border ${
                    active
                      ? 'bg-accent-500/15 border-accent-500/40'
                      : 'border-transparent hover:bg-dark-800/60'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                            cluster.enabled ? 'bg-emerald-400' : 'bg-dark-600'
                          }`}
                        />
                        <span className="text-sm text-dark-100 truncate">{cluster.name}</span>
                      </div>
                      <div className="text-[11px] text-dark-500 truncate mt-0.5" title={cluster.server}>
                        {cluster.server || '未解析出 server'}
                      </div>
                      <div className="flex items-center gap-1.5 mt-1">
                        <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-dark-800 text-dark-400">
                          <ShieldCheck className="w-2.5 h-2.5" />
                          {cluster.authType === 'cert' ? 'mTLS' : 'token'}
                        </span>
                        <span className="text-[10px] text-dark-600 truncate" title={cluster.context}>
                          {cluster.context || 'current-context'}
                        </span>
                      </div>
                    </div>
                    <div className="flex flex-col items-center gap-1 flex-shrink-0">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onTest(cluster);
                        }}
                        disabled={busy}
                        title="测试连接"
                        className="p-1 rounded text-dark-500 hover:text-accent-300 hover:bg-dark-700/60 transition-colors disabled:opacity-50"
                      >
                        {busy ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Plug className="w-3.5 h-3.5" />}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(cluster);
                        }}
                        disabled={busy}
                        title="删除集群"
                        className="p-1 rounded text-dark-500 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {test && (
                    <div
                      className={`flex items-start gap-1 mt-1.5 text-[11px] ${
                        test.ok ? 'text-emerald-400' : 'text-red-400'
                      }`}
                      title={test.text}
                    >
                      {test.ok ? (
                        <CircleCheck className="w-3 h-3 mt-px flex-shrink-0" />
                      ) : (
                        <CircleAlert className="w-3 h-3 mt-px flex-shrink-0" />
                      )}
                      <span className="truncate">{test.text}</span>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

export default ClusterList;