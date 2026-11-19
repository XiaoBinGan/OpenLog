/**
 * 顶部四张统计卡：节点 Ready / Pod 总数与异常 / 工作负载 / Warning 事件。
 *
 * 数值与副标题全部来自 utils.buildStatCards（纯函数，可单测），
 * 这里只负责把 tone 映射成颜色，避免出现「卡片和表格口径不一致」。
 */

import { Layers, Server, Boxes, TriangleAlert } from 'lucide-react';
import type { K8sSummary } from './types';
import { buildStatCards, type StatCard } from './utils';

const toneClass: Record<StatCard['tone'], string> = {
  ok: 'text-emerald-400',
  warn: 'text-amber-400',
  error: 'text-red-400',
  neutral: 'text-dark-300',
};

const iconMap = {
  nodes: Server,
  pods: Boxes,
  workloads: Layers,
  events: TriangleAlert,
} as const;

function StatCards({ summary }: { summary: K8sSummary }) {
  const cards = buildStatCards(summary);
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map((card) => {
        const Icon = iconMap[card.key as keyof typeof iconMap] ?? Server;
        return (
          <div key={card.key} className="glass rounded-xl p-4">
            <div className="flex items-center gap-1.5 text-xs text-dark-400 mb-1">
              <Icon className="w-3.5 h-3.5" />
              {card.label}
            </div>
            <div className={`text-2xl font-bold ${toneClass[card.tone]}`}>{card.value}</div>
            <div className="text-[11px] text-dark-500 mt-0.5 truncate" title={card.hint}>
              {card.hint}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default StatCards;