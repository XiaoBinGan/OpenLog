/**
 * Warning 事件摘要卡片。
 *
 * 数据来自 `GET /api/k8s/clusters/:id/warning-digest`（A3 实现）：按 reason 聚合、
 * 窗口过滤、并给出 ack 之后的「新增条数」。
 *
 * 为什么单独做一块：事件列表是「流水账」，运维真正要看的是「哪个 reason 在反复刷」，
 * 以及「我把它标已读之后有没有新的」。
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { apiFetch, apiJson } from '../../api/client';

interface DigestGroup {
  reason: string;
  count: number;
  lastSeen?: string | null;
  objects?: string[];
}

interface DigestResponse {
  window?: string;
  since?: string;
  total?: number;
  newEvents?: number;
  byReason?: DigestGroup[];
  demo?: boolean;
  error?: string;
}

export default function WarningDigestPanel({ clusterId }: { clusterId: string }) {
  const [data, setData] = useState<DigestResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!clusterId) return;
    setLoading(true);
    setError(null);
    try {
      const body = await apiFetch<DigestResponse>(
        `/api/k8s/clusters/${encodeURIComponent(clusterId)}/warning-digest?window=1h`,
      );
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取失败');
    } finally {
      setLoading(false);
    }
  }, [clusterId]);

  useEffect(() => { void load(); }, [load]);

  const ack = async (reason: string) => {
    try {
      await apiJson(`/api/k8s/clusters/${encodeURIComponent(clusterId)}/warning-digest/ack`, 'POST', { reason });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '标记已读失败');
    }
  };

  const groups = data?.byReason ?? [];

  return (
    <section className="glass rounded-xl p-4 space-y-3" data-testid="warning-digest">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400" />
          <h3 className="text-sm font-semibold text-dark-100">Warning 事件摘要</h3>
          {data?.demo && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">演示数据</span>}
        </div>
        <div className="flex items-center gap-3 text-xs text-dark-500">
          {Number(data?.newEvents) > 0 && (
            <span className="text-red-400">新增 {data?.newEvents} 条</span>
          )}
          <span>最近 {data?.window ?? '1h'} · 共 {data?.total ?? 0} 次</span>
          <button onClick={() => void load()} disabled={loading} className="p-1 rounded hover:bg-dark-800 disabled:opacity-50" title="刷新">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      {error && (
        <div className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
          读取失败：{error}
        </div>
      )}

      {groups.length === 0 ? (
        <p className="text-xs text-dark-500">这个时间窗内没有 Warning 事件。</p>
      ) : (
        <ul className="space-y-1.5">
          {groups.map((g) => {
            return (
              <li key={g.reason} className="flex items-center gap-2 text-xs" data-reason={g.reason}>
                <span className="font-mono text-dark-200 truncate min-w-0 flex-1" title={(g.objects ?? []).join('\n')}>
                  {g.reason}
                </span>
                <span className="text-dark-400 tabular-nums">{g.count} 次</span>
                <span className="text-dark-600 w-24 text-right tabular-nums">
                  {g.lastSeen ? String(g.lastSeen).replace('T', ' ').slice(5, 19) : '—'}
                </span>
                <button
                  onClick={() => void ack(g.reason)}
                  className="text-dark-500 hover:text-accent-400 transition-colors"
                  title="标记已读（只影响新增计数）"
                >
                  已读
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
