/**
 * Pod 表：状态 / 就绪 / 重启数 / OOM / CrashLoop 标记，可按命名空间 + 关键字过滤。
 *
 * 行点击 = 打开该 Pod 的最近日志抽屉（父页面负责请求 logs?tail=200）。
 * 行本身用 tr + tabIndex 承担可点区域（回车/空格等效于点击），
 * 因此键盘用户也能打开日志。
 */

import { useMemo, useState } from 'react';
import { Boxes, ScrollText } from 'lucide-react';
import type { K8sPod } from './types';
import { ALL_NAMESPACES, filterPods, formatAge, isPodReady, podKey, podMarkers, podSeverity, sortPods } from './utils';

interface PodTableProps {
  pods: K8sPod[];
  namespaces: string[];
  namespace: string;
  onNamespaceChange: (namespace: string) => void;
  /** 当前打开日志的 Pod（podKey 形式），用于高亮。 */
  selectedKey?: string | null;
  onSelect: (pod: K8sPod) => void;
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
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-dark-500 border-b border-dark-800/60">
                <th className="text-left font-medium px-4 py-2">状态</th>
                <th className="text-left font-medium px-3 py-2">命名空间</th>
                <th className="text-left font-medium px-3 py-2">名称</th>
                <th className="text-left font-medium px-3 py-2">Ready</th>
                <th className="text-left font-medium px-3 py-2">重启</th>
                <th className="text-left font-medium px-3 py-2">节点</th>
                <th className="text-left font-medium px-3 py-2">IP</th>
                <th className="text-left font-medium px-3 py-2">年龄</th>
                <th className="text-left font-medium px-3 py-2">标记</th>
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
                    <td className="px-3 py-2 text-dark-200 whitespace-nowrap" title={pod.name}>
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