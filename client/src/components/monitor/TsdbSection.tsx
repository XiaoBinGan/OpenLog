/**
 * 时序库查询面板 —— PromQL 输入 + 结果表格/折线图。
 *
 * 为什么要有这个：TSDB 的能力（PromQL、抓取、规则告警）此前只有 API，
 * 用户想看指标曲线得自己 curl。数据在库里但没人看得见，
 * 等于把「有」变成了「实际上没有」。
 *
 * 设计上的三个取舍：
 *
 * 1) **不做成通用图表编辑器**。那是 Grafana 的活，重复做只会做得更差。
 *    这里只做「输入 PromQL → 看结果」，并给一栏常用查询让新手不用背语法。
 *
 * 2) **打错的查询要把错误原样显示出来**，包括位置。
 *    PromQL 报错信息本身很有用（"期望 ]，实际是 :1m"），
 *    包装成「查询失败」反而丢掉了最有价值的部分。
 *
 * 3) **结果同时给图和表**。图看趋势，表看具体数值 ——
 *    排查时经常需要「那个尖峰的准确值是多少」。
 */

import { useState, useCallback, useMemo } from 'react';
import {
  Search, RefreshCw, AlertCircle, ChevronRight, Table2, LineChart as LineIcon,
} from 'lucide-react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { apiFetch } from '../../api/client';

/** 常用查询：覆盖「刚接手时最想看的几件事」 */
const PRESETS = [
  { label: '内存使用率', query: 'openlog_memory_usage_percent', range: '1h' },
  { label: 'CPU 使用率', query: 'openlog_cpu_usage_percent', range: '1h' },
  { label: '磁盘使用率（按挂载点）', query: 'openlog_disk_usage_percent', range: '1h' },
  { label: 'GPU 利用率', query: 'openlog_gpu_utilization_percent', range: '1h' },
  { label: '容器数量', query: 'openlog_docker_containers_total', range: '1h' },
  { label: '时序库规模', query: 'openlog_tsdb_samples_total', range: '6h' },
  { label: '抓取失败次数', query: 'increase(openlog_scrape_failures_total[10m])', range: '6h' },
  { label: '接口 5xx 速率', query: 'sum(rate(openlog_api_requests_5xx_total[5m]))', range: '1h' },
  { label: '接口 P99 延迟', query: 'openlog_api_request_duration_seconds{quantile="0.99"}', range: '1h' },
];

const RANGES = [
  { label: '15 分钟', ms: 15 * 60_000, step: '15s' },
  { label: '1 小时', ms: 3_600_000, step: '30s' },
  { label: '6 小时', ms: 6 * 3_600_000, step: '2m' },
  { label: '1 天', ms: 86_400_000, step: '10m' },
  { label: '7 天', ms: 7 * 86_400_000, step: '1h' },
];

/** Prometheus 返回的单条序列 */
interface PromSeries {
  metric: Record<string, string>;
  values?: Array<[number, string]>;
}

/** 区间查询的响应形状 */
interface QueryRangeResponse {
  status: 'success' | 'error';
  error?: string;
  data?: { resultType: string; result: PromSeries[] };
}

/** 把 Prometheus 的 matrix 结果转成 recharts 能吃的行数组 */
export function toChartRows(result: PromSeries[]) {
  const rows = new Map();
  for (const item of result || []) {
    // 序列名：优先用 __name__，否则用标签拼一个短标识
    const labels = item.metric || {};
    const name = labels.__name__
      || Object.keys(labels).sort().map((k) => `${k}=${labels[k]}`).join(',')
      || 'value';
    for (const [ts, v] of item.values || []) {
      const t = Number(ts) * 1000;
      if (!rows.has(t)) rows.set(t, { ts: t, time: new Date(t).toLocaleTimeString() });
      const num = Number(v);
      rows.get(t)[name] = Number.isFinite(num) ? num : null;
    }
  }
  return [...rows.values()].sort((a, b) => a.ts - b.ts);
}

/** 从结果里提取全部序列名（给 Legend 与 Line 用） */
export function seriesNames(result: PromSeries[]): string[] {
  const names = new Set<string>();
  for (const item of result || []) {
    const labels = item.metric || {};
    names.add(labels.__name__ || Object.keys(labels).sort().map((k) => `${k}=${labels[k]}`).join(',') || 'value');
  }
  return [...names];
}

const SERIES_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16'];

export default function TsdbSection() {
  const [query, setQuery] = useState(PRESETS[0].query);
  const [rangeIdx, setRangeIdx] = useState(1);
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ resultType: string; result: PromSeries[] } | null>(null);

  const range = RANGES[rangeIdx];

  const run = useCallback(async (q = query, r = range) => {
    const text = String(q || '').trim();
    if (!text) { setError('请输入查询语句'); return; }
    setLoading(true);
    setError(null);
    try {
      const end = Math.floor(Date.now() / 1000);
      const start = end - Math.floor(r.ms / 1000);
      // 先试区间查询；纯标量表达式（如 1+1）区间查询也能返回，无需区分
      const data = await apiFetch<QueryRangeResponse>(
        `/api/v1/query_range?query=${encodeURIComponent(text)}&start=${start}&end=${end}&step=${r.step}`,
      );
      if (!data || data.status === 'error') {
        setError(data?.error || '查询失败');
        setResult(null);
        return;
      }
      setResult(data.data ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [query, range]);

  const rows = useMemo(() => (result ? toChartRows(result.result) : []), [result]);
  const names = useMemo(() => (result ? seriesNames(result.result) : []), [result]);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Search className="w-4 h-4 text-gray-500" />
          <h3 className="font-medium">时序库查询</h3>
          <span className="text-xs text-gray-400">PromQL</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setView('chart')}
            className={`p-1.5 rounded ${view === 'chart' ? 'bg-blue-100 text-blue-600 dark:bg-blue-900' : 'text-gray-400'}`}
            title="图表"
          >
            <LineIcon className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => setView('table')}
            className={`p-1.5 rounded ${view === 'table' ? 'bg-blue-100 text-blue-600 dark:bg-blue-900' : 'text-gray-400'}`}
            title="表格"
          >
            <Table2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 查询输入 */}
      <div className="flex gap-2 mb-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') run(); }}
          placeholder='例如 openlog_memory_usage_percent'
          className="flex-1 px-3 py-1.5 text-sm font-mono border border-gray-300 dark:border-gray-600 rounded bg-transparent"
        />
        <select
          value={rangeIdx}
          onChange={(e) => setRangeIdx(Number(e.target.value))}
          className="px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-transparent"
        >
          {RANGES.map((r, i) => <option key={r.label} value={i}>{r.label}</option>)}
        </select>
        <button
          type="button"
          onClick={() => run()}
          disabled={loading}
          className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1"
        >
          {loading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <ChevronRight className="w-3.5 h-3.5" />}
          查询
        </button>
      </div>

      {/* 常用查询 */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => {
              setQuery(p.query);
              const idx = RANGES.findIndex((r) => `${r.ms}ms` === p.range
                || r.label.includes(p.range.replace('h', ' 小时').replace('m', ' 分钟')));
              const next = idx >= 0 ? idx : rangeIdx;
              setRangeIdx(next);
              run(p.query, RANGES[next]);
            }}
            className="px-2 py-0.5 text-xs rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* 错误：原样显示，别包装 */}
      {error && (
        <div className="flex items-start gap-2 p-2 mb-3 text-sm rounded bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <pre className="whitespace-pre-wrap font-mono text-xs">{error}</pre>
        </div>
      )}

      {/* 结果 */}
      {!error && result && (
        <>
          {rows.length === 0 ? (
            <p className="text-sm text-gray-500 py-6 text-center">
              该时间段没有数据。可能指标名不对，或这个区间内还没采集到点。
            </p>
          ) : view === 'chart' ? (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={rows}>
                  <XAxis dataKey="time" tick={{ fontSize: 11 }} minTickGap={40} />
                  <YAxis tick={{ fontSize: 11 }} width={60} />
                  <Tooltip contentStyle={{ fontSize: 12 }} />
                  {names.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
                  {names.map((n, i) => (
                    <Line
                      key={n}
                      type="monotone"
                      dataKey={n}
                      stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                      dot={false}
                      strokeWidth={1.5}
                      connectNulls
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="max-h-64 overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-white dark:bg-gray-800">
                  <tr className="text-left text-gray-500">
                    <th className="py-1 pr-2">时间</th>
                    {names.map((n) => <th key={n} className="py-1 pr-2 text-right">{n}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(-200).map((row) => (
                    <tr key={row.ts as number} className="border-t border-gray-100 dark:border-gray-700">
                      <td className="py-0.5 pr-2 text-gray-500">{row.time as string}</td>
                      {names.map((n) => (
                        <td key={n} className="py-0.5 pr-2 text-right font-mono">
                          {row[n] === undefined || row[n] === null ? '—' : Number(row[n]).toFixed(2)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-xs text-gray-400">
            {rows.length} 个时间点 · {names.length} 条序列
          </p>
        </>
      )}

      {!error && !result && (
        <p className="text-sm text-gray-500 py-6 text-center">
          输入 PromQL 或点上面的常用查询
        </p>
      )}
    </div>
  );
}