/**
 * 集群手风琴：每个集群一行表头，点开后在下方内联展开该集群的全部信息。
 *
 * 为什么不用左右分栏：左侧列表固定宽度 + 右侧详情，在笔记本屏幕上两侧都很挤，
 * 节点表/Pod 表被压成横向滚动；而且"选中"与"展开"是两套心智。
 * 手风琴把两者合成一个动作：展开 = 选中，收起 = 不看。
 *
 * 表头右侧的操作按钮一律 stopPropagation —— 否则点"删除"会同时触发展开/收起。
 */
import type { ReactNode } from 'react';
import { ChevronRight, Loader, Pencil, Plug, Trash2 } from 'lucide-react';

export interface AccordionCluster {
  id: string;
  name: string;
  server: string;
  context?: string;
  enabled?: boolean;
}

interface ClusterAccordionProps {
  clusters: AccordionCluster[];
  expandedId: string | null;
  busyId: string | null;
  testResults: Record<string, { ok: boolean; text: string }>;
  onToggle: (id: string) => void;
  onTest: (cluster: AccordionCluster) => void;
  onEdit: (cluster: AccordionCluster) => void;
  onDelete: (cluster: AccordionCluster) => void;
  renderDetail: (cluster: AccordionCluster) => ReactNode;
  /** 演示模式：禁止增删改（按钮置灰 + title 说明） */
  disabledReason?: string | null;
}

export default function ClusterAccordion({
  clusters,
  expandedId,
  busyId,
  testResults,
  onToggle,
  onTest,
  onEdit,
  onDelete,
  renderDetail,
  disabledReason = null,
}: ClusterAccordionProps) {
  return (
    <div className="space-y-3">
      {clusters.map((cluster) => {
        const expanded = cluster.id === expandedId;
        const busy = cluster.id === busyId;
        const test = testResults[cluster.id];
        return (
          <section key={cluster.id} className="glass rounded-xl overflow-hidden" data-cluster={cluster.id}>
            <div
              role="button"
              tabIndex={0}
              aria-expanded={expanded}
              onClick={() => onToggle(cluster.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(cluster.id); }
              }}
              className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none hover:bg-dark-800/40 transition-colors"
            >
              <ChevronRight className={`w-4 h-4 shrink-0 text-dark-500 transition-transform ${expanded ? 'rotate-90' : ''}`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-medium text-dark-100 truncate">{cluster.name}</span>
                  {cluster.enabled === false && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-dark-700 text-dark-400 shrink-0">已停用</span>
                  )}
                  {test && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${test.ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'}`}>
                      {test.ok ? '连接正常' : '连接失败'}
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-dark-500 font-mono truncate" title={cluster.server}>
                  {cluster.server}{cluster.context ? ` · ${cluster.context}` : ''}
                </div>
              </div>

              <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  onClick={() => onTest(cluster)}
                  disabled={busy || Boolean(disabledReason)}
                  title={disabledReason ?? '测试连接'}
                  className="p-1.5 rounded hover:bg-dark-700 text-dark-400 hover:text-accent-400 transition-colors disabled:opacity-40"
                >
                  {busy ? <Loader className="w-4 h-4 animate-spin" /> : <Plug className="w-4 h-4" />}
                </button>
                <button
                  type="button"
                  onClick={() => onEdit(cluster)}
                  disabled={Boolean(disabledReason)}
                  title={disabledReason ?? '编辑集群（改名 / 换 kubeconfig / 启停）'}
                  className="p-1.5 rounded hover:bg-dark-700 text-dark-400 hover:text-accent-400 transition-colors disabled:opacity-40"
                >
                  <Pencil className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(cluster)}
                  disabled={busy || Boolean(disabledReason)}
                  title={disabledReason ?? '删除集群'}
                  className="p-1.5 rounded hover:bg-dark-700 text-dark-400 hover:text-red-400 transition-colors disabled:opacity-40"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>

            {expanded && (
              <div className="border-t border-dark-800 px-4 py-4 space-y-4">{renderDetail(cluster)}</div>
            )}
          </section>
        );
      })}
    </div>
  );
}
