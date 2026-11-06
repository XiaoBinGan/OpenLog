/**
 * client/src/components/monitor/ApiSection.tsx —— Monitor 页「接口指标」区块（#15 ui-api）
 *
 * 自包含：数据自己拉（`GET /api/monitor/api?window=5m`），不接 props 也能渲染，
 * Lead 直接 `<ApiSection />` 挂上去即可。轮询 15s 而非主机面板的 5s ——
 * 接口指标是分钟桶的 SQL 聚合，跟着 5s 抖只压数据库，数字一分钟才变一次。
 * 不引图表库（契约禁止新增依赖），趋势条用 div 高度画。
 */
import { useCallback, useMemo, useState } from 'react';
import { Activity, AlertCircle, RefreshCw, Timer } from 'lucide-react';
import { apiFetch } from '../../api/client';
import { usePolling } from '../../utils/usePolling';
import {
  normalizeSnapshot, topSlow, topErrors, formatMs, formatQps, formatBytes,
  errorRateLevel, buildQpsSeries, type ApiRouteStat, type ApiSnapshot,
} from '../../utils/apiMetrics';

export interface ApiSectionProps {
  /** 聚合窗口，默认 5m（契约支持 1m / 5m / 1h） */
  windowRange?: string;
  /** 轮询间隔，默认 15000ms */
  intervalMs?: number;
}

/** 当前分钟的「本轮估算 calls」，用于拼最小的 QPS 趋势条 */
interface MinuteSample {
  bucketMs: number;
  calls: number;
}

const MINUTE_MS = 60_000;

const TONE_CLASS: Record<'ok' | 'warn' | 'bad', string> = {
  ok: 'text-accent-400',
  warn: 'text-yellow-400',
  bad: 'text-red-400',
};

/** 方法徽章：颜色只做读写区分，不承载告警语义 */
function MethodBadge({ method }: { method: string }) {
  const colors: Record<string, string> = {
    GET: 'bg-accent-500/15 text-accent-300 border-accent-500/30',
    POST: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    PUT: 'bg-yellow-500/15 text-yellow-300 border-yellow-500/30',
    PATCH: 'bg-purple-500/15 text-purple-300 border-purple-500/30',
    DELETE: 'bg-red-500/15 text-red-300 border-red-500/30',
  };
  const cls = colors[method] || 'bg-dark-900 text-dark-400 border-dark-700';
  return <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-mono font-semibold shrink-0 ${cls}`}>{method}</span>;
}

/** 顶部数字卡：小字 label + 大字数值，颜色由调用方按档位决定 */
function StatCard({ label, value, tone = 'text-dark-100', hint }: {
  label: string; value: string; tone?: string; hint?: string;
}) {
  return (
    <div className="bg-dark-900 border border-dark-700 rounded-xl p-3" title={hint}>
      <div className="text-xs text-dark-400 mb-1">{label}</div>
      <div className={`text-2xl font-bold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}

export default function ApiSection({ windowRange = '5m', intervalMs = 15_000 }: ApiSectionProps = {}) {
  const [snapshot, setSnapshot] = useState<ApiSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [minutes, setMinutes] = useState<MinuteSample[]>([]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const raw = await apiFetch<unknown>(`/api/monitor/api?window=${encodeURIComponent(windowRange)}`);
      const next = normalizeSnapshot(raw);
      setSnapshot(next);
      setError(null);
      // 后端只给汇总值、没有时间轴；自己按分钟记一笔才看得出「哪一分钟断了」
      const bucketMs = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
      const calls = Math.round((next.qps ?? 0) * 60);
      setMinutes((prev) => [...prev.filter((p) => p.bucketMs !== bucketMs), { bucketMs, calls }]
        .sort((a, b) => a.bucketMs - b.bucketMs).slice(-10));
    } catch (err) {
      // 只降级这一块，不让整块消失：Monitor 页其它 section 还要继续用
      setError(err instanceof Error ? err.message : String(err ?? '未知错误'));
    } finally {
      setLoading(false);
    }
  }, [windowRange]);

  usePolling(fetchData, intervalMs, [fetchData]);

  const enabled = snapshot?.enabled === true;
  const totalCalls = snapshot?.totalCalls ?? 0;

  const slowRows: ApiRouteStat[] = useMemo(() => {
    if (!snapshot) return [];
    return (snapshot.slowest?.length ? snapshot.slowest : topSlow(snapshot, 10)).slice(0, 10);
  }, [snapshot]);

  const errorRows: ApiRouteStat[] = useMemo(() => {
    if (!snapshot) return [];
    return (snapshot.errorTop?.length ? snapshot.errorTop : topErrors(snapshot, 10)).slice(0, 10);
  }, [snapshot]);

  /** 全局 P95：各路由 P95 的最大值（聚合 P95 无法从分路由精确还原，取最坏值） */
  const worstP95 = useMemo(() => (snapshot?.routes ?? []).reduce((acc, r) => Math.max(acc, r.p95), 0), [snapshot]);
  const series = useMemo(() => buildQpsSeries(minutes, 5 * MINUTE_MS), [minutes]);
  const seriesMax = useMemo(() => series.reduce((acc, p) => Math.max(acc, p.v), 1), [series]);
  const level = errorRateLevel(snapshot?.errorRate ?? 0);

  return (
    <section className="bg-dark-800/60 border border-dark-700 rounded-xl p-4 md:p-5 space-y-4">
      {/* 标题行 */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <Activity className="w-5 h-5 text-accent-500 shrink-0" />
          <h3 className="text-lg font-semibold">接口指标</h3>
          <span className="px-2 py-0.5 rounded-md text-xs bg-dark-900 border border-dark-700 text-dark-400">{windowRange}</span>
          {enabled && (
            <span className="flex items-center gap-1.5 text-xs text-dark-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />采集运行中
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs text-dark-500">
          {(snapshot?.dropped ?? 0) > 0 && (
            <span className="text-yellow-400" title="超出路由基数上限被丢弃的样本">丢弃 {snapshot!.dropped} 条</span>
          )}
          {snapshot?.storage && (
            <span title="api_metrics_minute 表占用">
              存储 {snapshot.storage.rows.toLocaleString()} 行 · {formatBytes(snapshot.storage.approxBytes)}
            </span>
          )}
          <button
            type="button"
            onClick={fetchData}
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-dark-400 hover:text-dark-200 hover:bg-dark-900/60 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />刷新
          </button>
        </div>
      </div>

      {/* 失败：一行提示 + 重试；数据块保持原样（可能仍在展示上一轮的值） */}
      {error && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          <span className="flex items-center gap-2 min-w-0">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span className="truncate">接口指标不可用：{error}</span>
          </span>
          <button type="button" onClick={fetchData} className="shrink-0 px-2 py-1 rounded-md border border-red-500/40 hover:bg-red-500/20 transition-colors">重试</button>
        </div>
      )}

      {/* 空态：未启用 / 窗口内无流量 */}
      {snapshot && (!enabled || totalCalls === 0) && (
        <div className="rounded-lg border border-dark-700 bg-dark-900/60 px-4 py-6 text-center text-sm text-dark-400">
          {enabled ? '最近 5 分钟没有请求' : '接口监控未启用（OPENLOG_METRICS=off）'}
        </div>
      )}

      {/* 首屏加载中（既无快照也无报错） */}
      {!snapshot && !error && (
        <div className="flex items-center justify-center gap-2 py-6 text-sm text-dark-500">
          <RefreshCw className="w-4 h-4 animate-spin" />正在读取接口指标…
        </div>
      )}

      {snapshot && enabled && totalCalls > 0 && (
        <>
          {/* ① 四个数字卡 */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard label="QPS" value={formatQps(snapshot.qps ?? 0)} tone="text-accent-400" hint="每秒请求数（窗口内均值）" />
            <StatCard label="错误率" value={`${(snapshot.errorRate ?? 0).toFixed(2)}%`} tone={TONE_CLASS[level]} hint="4xx + 5xx 占比：<1% 正常，<5% 注意，≥5% 告警" />
            <StatCard label="P95 延迟" value={formatMs(worstP95)} hint="各路由 P95 的最大值（最坏情况）" />
            <StatCard label="总请求数" value={totalCalls.toLocaleString()} hint="窗口内累计" />
          </div>

          {/* QPS 分钟趋势：纯 CSS 条 */}
          {series.length > 1 && (
            <div className="flex items-end gap-1 h-10" title="每分钟请求数（最近 5 分钟）">
              {series.map((point) => (
                <div
                  key={point.t}
                  className="flex-1 min-w-0 bg-accent-500/60 hover:bg-accent-400 rounded-sm transition-colors"
                  style={{ height: `${Math.max(3, Math.round((point.v / seriesMax) * 100))}%` }}
                  title={`${new Date(point.t).toLocaleTimeString()} · ${point.v} 次`}
                />
              ))}
            </div>
          )}

          {/* ②③ 两张 Top 10 */}
          <div className="grid lg:grid-cols-2 gap-4">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Timer className="w-4 h-4 text-accent-500" />
                <h4 className="text-sm font-semibold text-dark-200">慢接口 Top 10</h4>
                <span className="text-xs text-dark-500">按 p95 降序</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm whitespace-nowrap">
                  <thead>
                    <tr className="text-left text-xs text-dark-400 border-b border-dark-700">
                      <th className="pb-2 font-medium">方法</th>
                      <th className="pb-2 font-medium">路由</th>
                      <th className="pb-2 font-medium text-right">calls</th>
                      <th className="pb-2 font-medium text-right">p95</th>
                      <th className="pb-2 font-medium text-right">错误</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-dark-700/60">
                    {slowRows.map((r, i) => {
                      const errors = r.err4xx + r.err5xx;
                      return (
                        <tr key={`${r.method}-${r.route}-${i}`} className="hover:bg-dark-900/60">
                          <td className="py-1.5 pr-2"><MethodBadge method={r.method} /></td>
                          <td className="py-1.5 pr-3 font-mono text-xs text-dark-300">{r.route}</td>
                          <td className="py-1.5 text-right tabular-nums text-dark-400">{r.calls}</td>
                          <td className="py-1.5 text-right tabular-nums text-accent-300">{formatMs(r.p95)}</td>
                          <td className={`py-1.5 text-right tabular-nums ${errors > 0 ? 'text-red-400' : 'text-dark-500'}`}>{errors}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {slowRows.length === 0 && <div className="py-4 text-center text-xs text-dark-500">窗口内没有慢接口记录</div>}
              </div>
            </div>

            <div>
              <div className="flex items-center gap-2 mb-2">
                <AlertCircle className="w-4 h-4 text-red-500" />
                <h4 className="text-sm font-semibold text-dark-200">错误 Top 10</h4>
                <span className="text-xs text-dark-500">按 4xx+5xx 降序</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm whitespace-nowrap">
                  <thead>
                    <tr className="text-left text-xs text-dark-400 border-b border-dark-700">
                      <th className="pb-2 font-medium">方法</th>
                      <th className="pb-2 font-medium">路由</th>
                      <th className="pb-2 font-medium text-right">4xx</th>
                      <th className="pb-2 font-medium text-right">5xx</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-dark-700/60">
                    {errorRows.map((r, i) => (
                      <tr key={`${r.method}-${r.route}-${i}`} className="hover:bg-dark-900/60">
                        <td className="py-1.5 pr-2"><MethodBadge method={r.method} /></td>
                        <td className="py-1.5 pr-3 font-mono text-xs text-dark-300">{r.route}</td>
                        <td className={`py-1.5 text-right tabular-nums ${r.err4xx > 0 ? 'text-yellow-400' : 'text-dark-500'}`}>{r.err4xx}</td>
                        <td className={`py-1.5 text-right tabular-nums ${r.err5xx > 0 ? 'text-red-400' : 'text-dark-500'}`}>{r.err5xx}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {errorRows.length === 0 && <div className="py-4 text-center text-xs text-dark-500">窗口内没有 4xx/5xx</div>}
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}