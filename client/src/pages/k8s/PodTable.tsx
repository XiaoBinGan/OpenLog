/**
 * Pod 表：状态 / 就绪 / 重启数 / 节点 / vGPU / OOM / CrashLoop 标记，可按命名空间 + 关键字过滤。
 *
 * 行点击 = 打开该 Pod 的最近日志抽屉（父页面负责请求 logs?tail=200）。
 * 行本身用 tr + tabIndex 承担可点区域（回车/空格等效于点击），
 * 因此键盘用户也能打开日志。
 *
 * vGPU 列只在集群里有 HAMi 时出现（父页面按 overview.gpu.hasHami 传 showVgpu）——
 * 没有 HAMi 的集群表头与改动前一模一样，不会多出一列全是「—」的噪音。
 *
 * 操作列同理：只有父页面传了 renderRowActions 才出现（没开写操作 / 演示模式下不传）。
 * 单元格必须把 click / keydown 拦住不往 <tr> 冒泡 —— 否则点「删除」的同时
 * 会把该 Pod 的日志抽屉也打开（行级 onClick 就是干这个的）。
 */

import { useMemo, useState, type ReactNode } from 'react';
import { Boxes, ScrollText } from 'lucide-react';
import type { K8sPod } from './types';
import {
  ALL_NAMESPACES,
  filterPods,
  formatAge,
  isPodReady,
  podKey,
  podMarkers,
  podSeverity,
  sortPods,
  vgpuLabel,
} from './utils';

interface PodTableProps {
  pods: K8sPod[];
  namespaces: string[];
  namespace: string;
  onNamespaceChange: (namespace: string) => void;
  /** 当前打开日志的 Pod（podKey 形式），用于高亮。 */
  selectedKey?: string | null;
  onSelect: (pod: K8sPod) => void;
  /** 是否展示 vGPU 列（集群有 HAMi 时才为 true；默认 false = 与改动前完全一致） */
  showVgpu?: boolean;
  /**
   * 每行的操作区（例如 PodOpsBar）。不传 = 没有操作列，表格与改动前一致。
   *
   * 单元格内部的事件一律 stopPropagation：行本身点一下就开日志抽屉，
   * 不拦的话「点删除」会顺带把日志抽屉拉起来。
   */
  renderRowActions?: (pod: K8sPod) => ReactNode;
}

const severityDot: Record<ReturnType<typeof podSeverity>, string> = {
  error: 'bg-red-400',
  warn: 'bg-amber-400',
  ok: 'bg-emerald-400',
};

const severityText: Record<ReturnType<typeof podSeverity>, string> = {
  error: 'text-red-400',
  warn: 'text-amber-400',
  ok: 'text-emerald-400',
};

function markerClass(marker: string): string {
  if (marker === 'OOMKilled') return 'bg-red-500/15 text-red-300 border-red-500/30';
  if (marker === 'CrashLoopBackOff') return 'bg-orange-500/15 text-orange-300 border-orange-500/30';
  if (marker.startsWith('重启')) return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
  return 'bg-dark-800 text-dark-400 border-dark-700';
}

function PodTable({
  pods,
  namespaces,
  namespace,
  onNamespaceChange,
  selectedKey = null,
  onSelect,
  showVgpu = false,
  renderRowActions,
}: PodTableProps) {
  const [keyword, setKeyword] = useState('');
  const rows = useMemo(() => sortPods(filterPods(pods, namespace, keyword)), [pods, namespace, keyword]);

  return (
    <div className="glass rounded-xl overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-dark-800/60">
        <div className="flex items-center gap-2">
          <Boxes className="w-4 h-4 text-accent-400" />
          <h2 className="text-sm font-semibold text-dark-100">Pod</h2>
          <span className="text-xs text-dark-500">
            {rows.length} / {pods.length}
          </span>
          <span className="hidden sm:inline-flex items-center gap-1 text-[11px] text-dark-600">
            <ScrollText className="w-3 h-3" />
            点击行查看最近日志
          </span>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索 Pod / 节点"
            className="w-36 bg-dark-900 border border-dark-800 rounded-lg px-2 py-1 text-xs text-dark-200 placeholder:text-dark-600 focus:outline-none focus:border-accent-500/60"
          />
          <label className="flex items-center gap-1.5 text-xs text-dark-400">
            <span>命名空间</span>
            <select
              value={namespace}
              onChange={(e) => onNamespaceChange(e.target.value)}
              className="bg-dark-900 border border-dark-800 rounded-lg px-2 py-1 text-xs text-dark-200 focus:outline-none focus:border-accent-500/60"
            >
              <option value={ALL_NAMESPACES}>全部</option>
              {namespaces.map((ns) => (
                <option key={ns} value={ns}>
                  {ns}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-dark-500">
          {pods.length === 0 ? '这个集群没有读到 Pod' : '当前过滤条件下没有 Pod'}
        </div>
      ) : (
        <div className="overflow-x-auto -mx-1 px-1">
          <table className="w-full text-sm min-w-[52rem] table-fixed">
            <thead>
              <tr className="text-xs text-dark-500 border-b border-dark-800/60">
                <th className="text-left font-medium px-2 py-2 w-16">状态</th>
                <th className="text-left font-medium px-2 py-2">命名空间</th>
                <th className="text-left font-medium px-2 py-2">名称</th>
                <th className="text-left font-medium px-2 py-2 w-14">Ready</th>
                <th className="text-left font-medium px-2 py-2 w-12">重启</th>
                <th className="text-left font-medium px-2 py-2">节点</th>
                {showVgpu && <th className="text-left font-medium px-3 py-2">vGPU</th>}
                <th className="text-left font-medium px-2 py-2 w-24">IP</th>
                <th className="text-left font-medium px-2 py-2 w-16">年龄</th>
                <th className="text-left font-medium px-2 py-2">标记</th>
                {renderRowActions && <th className="text-left font-medium px-3 py-2">操作</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((pod) => {
                const key = podKey(pod);
                const severity = podSeverity(pod);
                const markers = podMarkers(pod);
                const open = selectedKey === key;
                return (
                  <tr
                    key={key}
                    tabIndex={0}
                    onClick={() => onSelect(pod)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelect(pod);
                      }
                    }}
                    className={`cursor-pointer border-b border-dark-800/40 transition-colors ${
                      open ? 'bg-accent-500/10' : 'hover:bg-dark-800/30'
                    }`}
                  >
                    <td className="px-4 py-2 whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5">
                        <span className={`w-1.5 h-1.5 rounded-full ${severityDot[severity]}`} />
                        <span className={severityText[severity]}>{pod.phase || 'Unknown'}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2 text-dark-400 whitespace-nowrap">{pod.namespace || '—'}</td>
                    <td className="px-2 py-2 text-dark-200 max-w-[16rem] truncate" title={pod.name}>
                      {pod.name}
                    </td>
                    <td
                      className={`px-3 py-2 font-mono text-xs whitespace-nowrap ${
                        isPodReady(pod) ? 'text-dark-300' : 'text-amber-400'
                      }`}
                    >
                      {pod.ready || '—'}
                    </td>
                    <td
                      className={`px-3 py-2 font-mono text-xs whitespace-nowrap ${
                        pod.restarts > 0 ? 'text-amber-400' : 'text-dark-500'
                      }`}
                    >
                      {pod.restarts}
                    </td>
                    <td className="px-3 py-2 text-dark-400 text-xs whitespace-nowrap" title={pod.node}>
                      {pod.node || '—'}
                    </td>
                    {showVgpu && (
                      <td
                        className={`px-3 py-2 font-mono text-xs whitespace-nowrap ${
                          pod.vgpu?.hasVgpu ? 'text-accent-300' : 'text-dark-600'
                        }`}
                        title={
                          pod.vgpu?.devices?.length
                            ? pod.vgpu.devices.map((device) => device.id).join('\n')
                            : '没有 vGPU 分配'
                        }
                      >
                        {vgpuLabel(pod.vgpu)}
                      </td>
                    )}
                    <td className="px-3 py-2 text-dark-400 font-mono text-xs whitespace-nowrap">
                      {pod.ip || '—'}
                    </td>
                    <td className="px-3 py-2 text-dark-500 text-xs whitespace-nowrap" title={pod.created}>
                      {formatAge(pod.created)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {markers.length === 0 ? (
                        <span className="text-dark-600 text-xs">—</span>
                      ) : (
                        <span className="inline-flex flex-wrap items-center gap-1">
                          {markers.map((marker) => (
                            <span
                              key={marker}
                              className={`text-[10px] px-1.5 py-0.5 rounded border ${markerClass(marker)}`}
                            >
                              {marker}
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                    {renderRowActions && (
                      <td
                        className="px-3 py-2 whitespace-nowrap"
                        // 拦住 click / keydown：行级 handler 会打开日志抽屉
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        {renderRowActions(pod)}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default PodTable;