/**
 * 「GPU 分配（HAMi）」卡片。
 *
 * 解决的问题：HAMi 把一张物理卡切成多份 vGPU 给多个 Pod 共享，
 * 节点表只能看到「4 张卡」，看不到「这张卡被谁占了多少显存 / 算力」，
 * 于是「Pod 为什么 Pending」这类问题只能靠猜。
 *
 * 数据来自 `overview.gpu`（服务端 summarizeVgpu 的结果），结构：
 *   节点行  卡数 / 显存总量·已分配（进度条）/ 算力总量·已分配（进度条）/ 占卡 Pod 数
 *   Pod 行  命名空间 / Pod / 显存 / 算力（按节点分组，紧跟在该节点下面）
 *
 * 两个硬约定：
 *   · 没有 HAMi（hasHami:false）时**整张卡片不渲染** —— 老集群页面看不出任何差别；
 *   · 缺字段一律显示「—」，绝不出现 NaN / undefined（换算只在 utils 里做一次）。
 */

import { Cpu } from 'lucide-react';
import type { K8sGpuOverview } from './types';
import {
  MISSING,
  formatAllocCores,
  formatAllocMib,
  formatMib,
  gpuPodsByNode,
  hasHamiData,
  usagePercent,
} from './utils';

interface GpuAllocationProps {
  /** overview.gpu；缺席（旧版服务端）或 hasHami:false 时不渲染 */
  gpu: K8sGpuOverview | null | undefined;
}

/** 进度条颜色：越满越刺眼（≥90% 红、≥70% 黄，其余用主题色）。 */
function barClass(percent: number | null): string {
  if (percent === null) return 'bg-dark-700';
  if (percent >= 90) return 'bg-red-400';
  if (percent >= 70) return 'bg-amber-400';
  return 'bg-accent-500';
}

/** 百分比文案：「58%」或「—」。 */
function percentLabel(percent: number | null): string {
  return percent === null ? MISSING : `${percent}%`;
}

/**
 * 整数文案（卡数 / Pod 数 / 算力点）。
 * 缺字段时给「—」—— 直接把 undefined 插进 JSX 会渲染成 "undefined 张卡"。
 */
function formatCount(value: number | null | undefined): string {
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.round(n)) : MISSING;
}

/** 一行「标签 + 进度条 + 百分比」。 */
function UsageBar({ label, percent, hint }: { label: string; percent: number | null; hint: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-8 shrink-0 text-[10px] text-dark-600">{label}</span>
      <div className="flex-1 min-w-0 h-1.5 rounded-full bg-dark-800 overflow-hidden" title={hint}>
        <div
          className={`h-full rounded-full transition-all ${barClass(percent)}`}
          style={{ width: `${percent ?? 0}%` }}
        />
      </div>
      <span className="w-9 shrink-0 text-right text-[10px] font-mono text-dark-400">
        {percentLabel(percent)}
      </span>
    </div>
  );
}

function GpuAllocation({ gpu }: GpuAllocationProps) {
  // 没有 HAMi 的集群：卡片不存在（页面与改动前完全一致）
  if (!hasHamiData(gpu) || !gpu) return null;

  const memPercent = usagePercent(gpu.totals.allocatedMemMiB, gpu.totals.memMiB);
  const coresPercent = usagePercent(gpu.totals.allocatedCores, gpu.totals.cores);
  const groups = gpuPodsByNode(gpu);
  const empty = groups.every((group) => group.pods.length === 0);

  return (
    <div className="glass rounded-xl overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-dark-800/60">
        <div className="flex items-center gap-2">
          <Cpu className="w-4 h-4 text-accent-400" />
          <h2 className="text-sm font-semibold text-dark-100">GPU 分配（HAMi）</h2>
          <span className="text-xs text-dark-500">
            {formatCount(gpu.totals.gpuCount)} 张卡 · {formatCount(gpu.totals.podCount)} 个 Pod 占用
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-dark-500">
          <span>
            显存{' '}
            <span className="font-mono text-dark-300">
              {formatMib(gpu.totals.allocatedMemMiB)} / {formatMib(gpu.totals.memMiB)}
            </span>{' '}
            · {percentLabel(memPercent)}
          </span>
          <span title="算力点：100 点 = 一张整卡">
            算力{' '}
            <span className="font-mono text-dark-300">
              {formatCount(gpu.totals.allocatedCores)} / {formatCount(gpu.totals.cores)} 点
            </span>{' '}
            · {percentLabel(coresPercent)}
          </span>
        </div>
      </div>

      {empty ? (
        <div className="px-4 py-6 text-center text-xs text-dark-500">
          检测到 HAMi，但还没有读到任何 vGPU 分配（Pod 未调度或节点未上报 nvidia.com/* 资源）
        </div>
      ) : (
        <div className="divide-y divide-dark-800/40">
          {groups.map((group) => {
            const node = gpu.nodes.find((item) => item.name === group.node);
            const nodeMemPercent = node
              ? usagePercent(node.allocatedMemMiB, node.memMiB)
              : null;
            const nodeCoresPercent = node ? usagePercent(node.allocatedCores, node.cores) : null;
            const podCount = group.pods.length;

            return (
              <div key={group.node} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm text-dark-200 truncate" title={group.node}>
                      {group.node}
                    </span>
                    <span className="text-[11px] text-dark-500">
                      {node ? `${formatCount(node.count)} 张卡` : '卡数未知'} · {formatCount(podCount)} 个 Pod 占用
                    </span>
                  </div>
                  {node && (
                    <span className="text-[11px] text-dark-500">
                      显存 {formatMib(node.allocatedMemMiB)} / {formatMib(node.memMiB)} · 算力{' '}
                      {formatCount(node.allocatedCores)} / {formatCount(node.cores)} 点
                    </span>
                  )}
                </div>

                {node && (
                  <div className="mt-1.5 space-y-1">
                    <UsageBar
                      label="显存"
                      percent={nodeMemPercent}
                      hint={`${formatMib(node.allocatedMemMiB)} / ${formatMib(node.memMiB)}`}
                    />
                    <UsageBar
                      label="算力"
                      percent={nodeCoresPercent}
                      hint={`${formatCount(node.allocatedCores)} / ${formatCount(node.cores)} 点（100 点 = 整卡）`}
                    />
                  </div>
                )}

                {podCount === 0 ? (
                  <div className="mt-2 text-[11px] text-dark-600">该节点没有 vGPU 分配</div>
                ) : (
                  <table className="w-full text-xs mt-2">
                    <thead>
                      <tr className="text-[11px] text-dark-600">
                        <th className="text-left font-medium px-2 py-1">命名空间</th>
                        <th className="text-left font-medium px-2 py-1">Pod</th>
                        <th className="text-right font-medium px-2 py-1">显存</th>
                        <th className="text-right font-medium px-2 py-1">算力</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.pods.map((pod) => (
                        <tr
                          key={`${pod.namespace}/${pod.name}`}
                          className="border-t border-dark-800/30 hover:bg-dark-800/20"
                        >
                          <td className="px-2 py-1 text-dark-400 whitespace-nowrap">
                            {pod.namespace || MISSING}
                          </td>
                          <td
                            className="px-2 py-1 text-dark-200 whitespace-nowrap"
                            title={`${pod.namespace}/${pod.name}`}
                          >
                            {pod.name || MISSING}
                          </td>
                          <td className="px-2 py-1 text-right font-mono text-dark-300 whitespace-nowrap">
                            {formatAllocMib(pod.totalMemMiB)}
                          </td>
                          <td className="px-2 py-1 text-right font-mono text-dark-300 whitespace-nowrap">
                            {formatAllocCores(pod.totalCores)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })}
        </div>
      )}

      {(gpu.warnings?.length ?? 0) > 0 && (
        <div className="px-4 py-2 border-t border-dark-800/60 space-y-0.5">
          {gpu.warnings?.map((warning, index) => (
            <div key={`${index}-${warning}`} className="text-[11px] leading-snug text-amber-300/90">
              · {warning}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default GpuAllocation;
