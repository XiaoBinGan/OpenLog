/**
 * 「GPU 分配（HAMi）」卡片。
 *
 * 解决的问题：HAMi 把一张物理卡切成多份 vGPU 给多个 Pod 共享，
 * 节点表只能看到「4 张卡」，看不到「这张卡被谁占了多少显存 / 算力」，
 * 于是「Pod 为什么 Pending」这类问题只能靠猜。
 *
 * 数据来自 `overview.gpu`（服务端 summarizeVgpu 的结果），结构：
 *   节点行   卡量 / 显存总量·已分配（进度条）/ 算力总量·已分配（进度条）/ 占卡 Pod 数
 *   物理卡行  型号 · 显存 · 槽位 · 已分配（%），下面紧跟占这张卡的 Pod
 *   Pod 行   命名空间 / Pod / 显存 / 算力（按节点分组）
 *
 * 真机（243）与旧服务端的差别 —— 全部「字段存在才渲染」：
 *   · 真机节点带 `devices`（物理卡明细：型号/容量/槽位来自 `hami.io/node-nvidia-register`），
 *     所以能显示「RTX 4090 · 49140 MiB · 10 槽位」；没有 `devices` 就退回按节点聚合；
 *   · `totals.physicalCount / slots` 同理：有就显示「2 张物理卡 · 20 个 vGPU 槽位」，
 *     没有就退回「N 张卡」。
 *
 * 两个硬约定：
 *   · 没有 HAMi（hasHami:false）时**整张卡片不渲染** —— 老集群页面看不出任何差别；
 *   · 缺字段一律显示「—」，绝不出现 NaN / undefined（换算只在 utils 里做一次）。
 */

import { Cpu, Layers } from 'lucide-react';
import type { K8sGpuNodeDevice, K8sGpuOverview, K8sGpuPod } from './types';
import {
  MISSING,
  deviceLabel,
  formatAllocCores,
  formatAllocMib,
  formatCount,
  formatMib,
  formatMibRaw,
  gpuCardsLabel,
  gpuDeviceGroups,
  gpuPodsByNode,
  hasHamiData,
  nodeCardsLabel,
  shortGpuId,
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

/** 一张卡/节点上的一段分配（Pod 视角，可能是整 Pod 也可能是整 Pod 里的一段）。 */
type AllocationRow = { pod: K8sGpuPod; memMiB: number; cores: number };

/** 占卡 Pod 表（节点级与物理卡级共用；物理卡级更紧凑）。 */
function PodRows({ rows, dense = false }: { rows: AllocationRow[]; dense?: boolean }) {
  return (
    <table className="w-full text-xs mt-1">
      <thead>
        <tr className="text-[11px] text-dark-600">
          <th className="text-left font-medium px-2 py-1">命名空间</th>
          <th className="text-left font-medium px-2 py-1">Pod</th>
          <th className="text-right font-medium px-2 py-1">显存</th>
          <th className="text-right font-medium px-2 py-1">算力</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ pod, memMiB, cores }) => (
          <tr
            key={`${pod.namespace}/${pod.name}`}
            className={`border-t border-dark-800/30 hover:bg-dark-800/20 ${dense ? 'text-[11px]' : ''}`}
          >
            <td className="px-2 py-1 text-dark-400 whitespace-nowrap">{pod.namespace || MISSING}</td>
            <td
              className="px-2 py-1 text-dark-200 whitespace-nowrap"
              title={`${pod.namespace}/${pod.name}`}
            >
              {pod.name || MISSING}
            </td>
            <td className="px-2 py-1 text-right font-mono text-dark-300 whitespace-nowrap">
              {formatAllocMib(memMiB)}
            </td>
            <td className="px-2 py-1 text-right font-mono text-dark-300 whitespace-nowrap">
              {formatAllocCores(cores)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * 一张**物理卡**的一行：`RTX 4090 · 49140 MiB · 10 槽位 · 已分配 23552 MiB（48%）`，
 * 下面紧跟占这张卡的 Pod。
 *
 * 「有没有型号」是字段存在才渲染的典型：真机 register 里有 `type`，旧数据没有 ——
 * 这时不能写「未知型号」，改用短 id（`GPU-86d1…`）当标识，指标行也照样成立。
 */
function DeviceCard({ device, rows }: { device: K8sGpuNodeDevice; rows: AllocationRow[] }) {
  const percent = usagePercent(device.allocatedMemMiB, device.memMiB);
  return (
    <div className="mt-1.5 rounded-lg border border-dark-800/50 bg-dark-900/30 px-2.5 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex items-baseline gap-1.5 min-w-0" title={device.id || MISSING}>
          <Layers className="w-3 h-3 shrink-0 text-dark-600" />
          <span className="text-[11px] text-dark-300 truncate">{deviceLabel(device)}</span>
        </div>
        <span className="text-[11px] text-dark-600 font-mono shrink-0">
          {shortGpuId(device.id)}
        </span>
      </div>
      {device.memMiB > 0 && (
        <div className="mt-1">
          <UsageBar
            label="卡显存"
            percent={percent}
            hint={`已分配 ${formatMibRaw(device.allocatedMemMiB)} / ${formatMibRaw(device.memMiB)}`}
          />
        </div>
      )}
      {device.health === false && (
        <div className="mt-1 text-[11px] text-amber-300/90">该卡 register 上报 health:false</div>
      )}
      {rows.length === 0 ? (
        <div className="mt-1 text-[11px] text-dark-600">该卡没有 vGPU 分配</div>
      ) : (
        <PodRows rows={rows} dense />
      )}
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
            {gpuCardsLabel(gpu.totals)} · {formatCount(gpu.totals.podCount)} 个 Pod 占用
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
            // 物理卡视图：只有服务端给了 devices 才有内容（旧服务端 → 空 → 走下面的平铺表）
            const { groups: deviceGroups, unassigned } = gpuDeviceGroups(node, group.pods);
            const hasDevices = deviceGroups.length > 0;

            return (
              <div key={group.node} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm text-dark-200 truncate" title={group.node}>
                      {group.node}
                    </span>
                    <span className="text-[11px] text-dark-500">
                      {nodeCardsLabel(node)} · {formatCount(podCount)} 个 Pod 占用
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

                {hasDevices ? (
                  // ── 真机形态：按物理卡分行，Pod 挂在它实际占的那张卡下面 ──
                  <div className="mt-2">
                    {deviceGroups.map(({ device, allocations }) => (
                      <DeviceCard
                        key={device.id || `${group.node}-${device.type ?? ''}-${device.memMiB}`}
                        device={device}
                        rows={allocations}
                      />
                    ))}
                    {unassigned.length > 0 && (
                      <div className="mt-1.5 rounded-lg border border-dark-800/50 bg-dark-900/20 px-2.5 py-2">
                        <div className="text-[11px] text-dark-500" title="注解里的设备 UUID 与节点 register 对不上">
                          未匹配到物理卡（{unassigned.length} 个 Pod）
                        </div>
                        <PodRows rows={unassigned} dense />
                      </div>
                    )}
                  </div>
                ) : podCount === 0 ? (
                  <div className="mt-2 text-[11px] text-dark-600">该节点没有 vGPU 分配</div>
                ) : (
                  // ── 旧服务端：没有物理卡明细，保持原来的节点级平铺表 ──
                  <PodRows
                    rows={group.pods.map((pod) => ({
                      pod,
                      memMiB: pod.totalMemMiB,
                      cores: pod.totalCores,
                    }))}
                  />
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
