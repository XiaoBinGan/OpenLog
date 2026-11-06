/**
 * client/src/components/monitor/DbSection.tsx —— Monitor 页「数据库」区块（自包含，不接 props；
 * Lead 用一行 `<DbSection />` 即可接线，轮询走 usePolling，隐藏时暂停、切回补一次）。
 * 三条渲染铁律（契约 §5 + sampler 约定）：1. `unavailable[]` 非空必须显眼警示，绝不能静默当正常
 * （那些字段是 null 不是 0，静默展示等于告诉值班的人「数据库很闲」）；2. `enabled === false` 明说
 * 「数据库监控未启用」；3. 请求失败给「数据库指标不可用：原因」+ 重试，不吞异常。
 */
import { useCallback, useMemo, useState } from 'react';
import { AlertTriangle, Database, Loader2, RefreshCw } from 'lucide-react';
import { apiFetch } from '../../api/client';
import { usePolling } from '../../utils/usePolling';
import {
  buildProbeSeries, formatBytes, formatIndexHit, normalizeDbSnapshot, poolLevel, poolUsage,
  topTables, unavailableReason,
} from '../../utils/dbMetrics';
import type { DbSnapshot } from '../../utils/dbMetrics';

const POLL_MS = 30_000; // 与后端 light 采样同频，比这更勤只是重复读同一份快照
const TOP_N = 10;
const SLOW_LIMIT = 20;

interface SlowQueryItem {
  ts_ms?: number;
  tsMs?: number;
  fingerprint?: string;
  ms?: number;
  source?: string | null;
  sample?: string | null;
}

/** `/api/monitor/db/slow-queries` 的响应形状（失败时用同一形状的空值兜底，避免 catch 出联合类型） */
interface SlowQueryResponse {
  threshold?: number;
  items?: SlowQueryItem[];
  unavailable?: string;
}

const LEVEL_TEXT = { ok: 'text-emerald-400', warn: 'text-yellow-400', bad: 'text-red-400' } as const;
const LEVEL_BAR = { ok: 'bg-emerald-500', warn: 'bg-yellow-500', bad: 'bg-red-500' } as const;

const dash = (v: number | null | undefined): string =>
  v === null || v === undefined || Number.isNaN(v) ? '—' : String(v);
const formatMs = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : v < 10 ? `${v.toFixed(1)} ms` : `${Math.round(v)} ms`;
const formatCount = (v: number | null): string => (v === null ? '—' : Math.round(v).toLocaleString('en-US'));

export default function DbSection() {
  const [snapshot, setSnapshot] = useState<DbSnapshot | null>(null);
  const [slowQueries, setSlowQueries] = useState<SlowQueryItem[]>([]);
  const [slowThreshold, setSlowThreshold] = useState<number | null>(null);
  const [slowNote, setSlowNote] = useState<string | null>(null);
  // 存原始采样（tsMs/probeMs），渲染时再归一：过滤/排序规则只留在 dbMetrics 一处
  const [probeSamples, setProbeSamples] = useState<Array<{ tsMs: number; probeMs: number | null }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [dbRaw, slowRaw] = await Promise.all([
        apiFetch<unknown>('/api/monitor/db'),
        // 慢查询是附加信息：它失败不该把整块拖进错误态，DB 主指标仍然有价值
        apiFetch<SlowQueryResponse>(`/api/monitor/db/slow-queries?limit=${SLOW_LIMIT}`)
          .catch((): SlowQueryResponse => ({ items: [] })),
      ]);

      const next = normalizeDbSnapshot(dbRaw);
      const now = Date.now();
      const lightTs = typeof next.lastLight?.tsMs === 'number' ? next.lastLight.tsMs : now;

      setSnapshot(next);
      setProbeSamples((prev) => [...prev, { tsMs: lightTs, probeMs: next.probeMs ?? null }].slice(-24));
      setSlowQueries(Array.isArray(slowRaw?.items) ? slowRaw.items : []);
      setSlowThreshold(typeof slowRaw?.threshold === 'number' ? slowRaw.threshold : null);
      setSlowNote(typeof slowRaw?.unavailable === 'string' ? slowRaw.unavailable : null);
      setError(null);
      setUpdatedAt(now);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : '请求失败');
    } finally {
      setLoading(false);
    }
  }, []);

  usePolling(load, POLL_MS, []);

  const s = snapshot;
  const pool = s?.pool ?? null;
  // 先抽成纯值再比较：可选链与比较混写时 TS 的收窄不可靠，而且这里要复用多次
  const probeMs = s?.probeMs ?? null;
  const light = s?.lastLight ?? null;
  const waiting = pool?.waiting ?? null;
  const usage = useMemo(() => poolUsage(pool), [pool]);
  const level = poolLevel(usage.ratio, waiting);
  const tables = useMemo(() => topTables(s?.tables, TOP_N), [s?.tables]);
  const unavailable = s?.unavailable ?? [];
  const warning = unavailable.length > 0 ? unavailableReason(unavailable) : '';
  const probePoints = useMemo(() => buildProbeSeries(probeSamples, 12), [probeSamples]);
  const maxProbe = probePoints.reduce((m, p) => Math.max(m, p.v), 0);

  return (
    <div className="glass rounded-xl p-4 space-y-4">
      {/* 头部：类型 + 刷新 */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Database className="w-5 h-5 text-accent-500 shrink-0" />
          <h3 className="text-lg font-semibold">数据库</h3>
          <span className="px-2 py-0.5 rounded bg-dark-900 text-xs text-dark-300 font-mono">{s?.type ?? '—'}</span>
          <span className="text-xs text-dark-500">{updatedAt ? `更新于 ${new Date(updatedAt).toLocaleTimeString()}` : '尚未取到数据'}</span>
        </div>
        <button
          onClick={load}
          disabled={loading}
          title="立即刷新（每 30s 自动刷新）"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-dark-400 hover:text-dark-200 hover:bg-dark-800/50 transition-colors disabled:opacity-60"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </button>
      </div>

      {/* 失败：一行原因 + 重试 */}
      {error && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2">
          <span className="flex items-center gap-2 min-w-0 text-sm text-red-300">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span className="truncate">数据库指标不可用：{error}</span>
          </span>
          <button
            onClick={load}
            className="shrink-0 px-2.5 py-1 rounded-md text-xs text-red-200 border border-red-500/40 hover:bg-red-500/20 transition-colors"
          >
            重试
          </button>
        </div>
      )}

      {/* 部分指标采不到：显眼警示，不允许静默 */}
      {warning && (
        <div className="flex items-start gap-2 rounded-lg border border-yellow-500/50 bg-yellow-500/10 px-3 py-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-yellow-400" />
          <div className="min-w-0 text-sm text-yellow-300">
            <div className="font-medium">部分指标采不到 —— 是「看不到」，不是「值为 0」</div>
            <div className="text-xs text-yellow-200/80 break-words mt-0.5">{warning}</div>
          </div>
        </div>
      )}

      {s?.enabled === false ? (
        <div className="text-center py-8 text-dark-400">
          <p className="text-sm font-medium">数据库监控未启用</p>
          <p className="text-xs text-dark-500 mt-1">环境变量 <span className="font-mono">OPENLOG_METRICS=off</span> 或采样器未接线时不会采集 DB 指标</p>
        </div>
      ) : (
        <>
          {/* 概览卡：连接池 / 探针延迟 */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="bg-dark-900/60 rounded-lg p-3">
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-dark-400">连接池</span>
                <span className={`text-xl font-bold ${LEVEL_TEXT[level]}`}>
                  {usage.ratio === null ? '—' : `${(usage.ratio * 100).toFixed(0)}%`}
                </span>
              </div>
              <div className="text-xs text-dark-400 font-mono mt-1 truncate" title={usage.label}>{usage.label}</div>
              <div className="h-2 bg-dark-800 rounded-full overflow-hidden mt-2">
                <div
                  className={`h-full transition-all duration-500 ${LEVEL_BAR[level]}`}
                  style={{ width: `${usage.ratio === null ? 0 : usage.ratio * 100}%` }}
                />
              </div>
              <div className="grid grid-cols-4 gap-1 mt-2 text-xs font-mono">
                <span className="text-dark-500">total <span className="text-dark-300">{dash(pool?.total)}</span></span>
                <span className="text-dark-500">max <span className="text-dark-300">{dash(pool?.max)}</span></span>
                <span className="text-dark-500">idle <span className="text-dark-300">{dash(pool?.idle)}</span></span>
                <span className={waiting !== null && waiting > 0 ? 'text-red-400 font-medium' : 'text-dark-500'}>
                  waiting <span className="text-inherit">{dash(waiting)}</span>
                </span>
              </div>
            </div>

            <div className="bg-dark-900/60 rounded-lg p-3">
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-dark-400">探针延迟</span>
                <span className={`text-xl font-bold ${probeMs !== null && probeMs > 50 ? 'text-yellow-400' : 'text-accent-400'}`}>
                  {formatMs(probeMs)}
                </span>
              </div>
              <div className="text-xs text-dark-500 mt-1">
                {light
                  ? `light 采样 · ${typeof light.tsMs === 'number' ? new Date(light.tsMs).toLocaleTimeString() : '—'}`
                  : '尚无 light 采样'}
              </div>
              {/* 探针延迟 sparkline：柱高按窗口内最大值归一 */}
              <div className="flex items-end gap-0.5 h-8 mt-2">
                {probePoints.length === 0 ? (
                  <span className="text-xs text-dark-600">暂无采样</span>
                ) : (
                  probePoints.map((p) => (
                    <div
                      key={p.t}
                      className="flex-1 bg-accent-500/60 rounded-sm min-h-[2px]"
                      style={{ height: `${maxProbe > 0 ? Math.max(6, (p.v / maxProbe) * 100) : 6}%` }}
                      title={`${new Date(p.t).toLocaleTimeString()} · ${formatMs(p.v)}`}
                    />
                  ))
                )}
              </div>
            </div>
          </div>

          {/* 表体积 Top 10 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-medium text-dark-200">表体积 Top {TOP_N}</h4>
              <span className="text-xs text-dark-500">{s?.tables?.length ?? 0} 张表</span>
            </div>
            {tables.length === 0 ? (
              <div className="text-center py-6 text-dark-500 text-sm">
                {loading && !s ? (
                  <Loader2 className="w-5 h-5 animate-spin mx-auto" />
                ) : (
                  '暂无表数据（PG 需 pg_class 读权限；SQLite 只报体积）'
                )}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-dark-400 border-b border-dark-800">
                      <th className="pb-2 font-medium">表名</th>
                      <th className="pb-2 font-medium text-right">体积</th>
                      <th className="pb-2 font-medium text-right">行数</th>
                      <th className="pb-2 font-medium text-right">死元组</th>
                      <th className="pb-2 font-medium text-right">索引命中</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-dark-800/50">
                    {tables.map((t) => (
                      <tr key={t.name} className="hover:bg-dark-800/30">
                        <td className="py-2 text-dark-200 font-mono text-xs max-w-[240px] truncate" title={t.name}>{t.name}</td>
                        <td className="py-2 text-right text-dark-300">{formatBytes(t.bytes)}</td>
                        <td className="py-2 text-right text-dark-400 font-mono text-xs">{formatCount(t.liveTup)}</td>
                        <td className="py-2 text-right font-mono text-xs">
                          <span className={t.deadTup !== null && t.deadTup > 10_000 ? 'text-yellow-400' : 'text-dark-400'}>{formatCount(t.deadTup)}</span>
                        </td>
                        <td className="py-2 text-right font-mono text-xs">
                          <span className={t.indexHitRate !== null && t.indexHitRate < 0.9 ? 'text-yellow-400' : 'text-dark-300'}>{formatIndexHit(t.indexHitRate)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* 慢查询 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-medium text-dark-200">慢查询</h4>
              <span className="text-xs text-dark-500">
                {slowQueries.length} 条{slowThreshold !== null ? `（阈值 ${slowThreshold} ms）` : ''}
              </span>
            </div>
            {slowNote && <div className="text-xs text-yellow-400/80 mb-2">{slowNote}</div>}
            {slowQueries.length === 0 ? (
              <div className="text-center py-6 text-dark-500 text-sm">最近没有超过阈值的慢查询</div>
            ) : (
              <ul className="space-y-2 max-h-80 overflow-y-auto pr-1">
                {slowQueries.map((q, i) => {
                  const ts = q.tsMs ?? q.ts_ms;
                  return (
                    <li key={`${q.fingerprint ?? 'q'}-${i}`} className="bg-dark-900/60 rounded-lg p-2">
                      <div className="flex items-center gap-3 text-xs text-dark-400 mb-1">
                        <span className="text-yellow-400 font-medium">{formatMs(q.ms)}</span>
                        <span className="truncate">来源 {q.source || '未知'}</span>
                        <span className="ml-auto text-dark-600 shrink-0">
                          {typeof ts === 'number' ? new Date(ts).toLocaleTimeString() : '—'}
                        </span>
                      </div>
                      <pre className="font-mono text-xs text-dark-300 whitespace-pre-wrap break-all max-h-16 overflow-auto">
                        {q.fingerprint || q.sample || '—'}
                      </pre>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
