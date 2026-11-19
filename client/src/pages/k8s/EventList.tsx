/**
 * Warning 事件列表。
 *
 * 用列表而不是表格：message 经常是一整句（"Readiness probe failed: ..."），
 * 表格列宽会把它切成三行并横向溢出。这里按「reason + 对象 + 次数 + 时间」一行，
 * message 放下一行自动换行，长文本只影响这一行的高度。
 */

import { TriangleAlert } from 'lucide-react';
import type { K8sEvent } from './types';
import { formatAge, warningEvents } from './utils';

function EventList({ events }: { events: K8sEvent[] }) {
  const warnings = warningEvents(events);
  return (
    <div className="glass rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-dark-800/60">
        <TriangleAlert className="w-4 h-4 text-amber-400" />
        <h2 className="text-sm font-semibold text-dark-100">Warning 事件</h2>
        <span className="text-xs text-dark-500">{warnings.length}</span>
      </div>

      {warnings.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-dark-500">最近没有 Warning 事件</div>
      ) : (
        <ul className="divide-y divide-dark-800/40 max-h-96 overflow-y-auto">
          {warnings.map((event, index) => (
            <li key={`${event.namespace}/${event.object}/${event.reason}/${event.lastSeen}/${index}`} className="px-4 py-2.5">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
                  {event.reason || 'Warning'}
                </span>
                <span className="text-dark-300 font-mono">{event.object || '—'}</span>
                {event.namespace && <span className="text-dark-500">{event.namespace}</span>}
                <span className="text-dark-500">×{event.count}</span>
                <span className="text-dark-600 ml-auto" title={event.lastSeen}>
                  {formatAge(event.lastSeen)}
                </span>
              </div>
              <div className="mt-1 text-xs text-dark-400 break-words" title={event.message}>
                {event.message || '—'}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default EventList;