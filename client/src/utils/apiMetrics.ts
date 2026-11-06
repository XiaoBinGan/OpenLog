/**
 * client/src/utils/apiMetrics.ts —— 接口监控（`GET /api/monitor/api`）前端纯函数
 *
 * 契约见 `docs/monitoring-contract.md` 第 5 节：
 *   `{ enabled, window, qps, errorRate, routes[], slowest[], errorTop[], dropped, storage }`
 *
 * 为什么全写成纯函数：后端聚合走的是 SQL，字段类型在 SQLite / PG 之间不一致
 * （REAL 可能回来是字符串、p95 可能因为样本不足回 NaN、errorRate 忘了乘 100）。
 * 组件里直接 `data.routes.map(...)` 一旦碰到脏数据就是白屏，
 * 所以所有校验/钳位/兜底集中在这里，组件只负责画。
 */

/** 单路由聚合指标（契约 4.x 的 routes[] / slowest[] / errorTop[] 元素） */
export interface ApiRouteStat {
  route: string;
  method: string;
  calls: number;
  err4xx: number;
  err5xx: number;
  /** 该路由的错误率（百分比 0~100） */
  errorRate: number;
  qps: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** 一次接口指标快照（`GET /api/monitor/api` 的响应体） */
export interface ApiSnapshot {
  /** 采集开关；`OPENLOG_METRICS=off` 时后端给 false */
  enabled: boolean;
  window?: string;
  qps?: number;
  /** 全局错误率（百分比 0~100，已钳位） */
  errorRate?: number;
  totalCalls?: number;
  routes?: ApiRouteStat[];
  slowest?: ApiRouteStat[];
  errorTop?: ApiRouteStat[];
  /** 因为基数上限（MAX_ROUTES=300）被丢掉的样本数 */
  dropped?: number;
  storage?: { rows: number; approxBytes: number | null } | null;
}

/** 一分钟后端分钟桶的宽度（ms），与 `api_metrics_minute.bucket_ms` 口径一致 */
const MINUTE_MS = 60_000;

/**
 * 任意值 → 有限数字，取不到就当 0。
 * 后端 REAL 列在部分驱动下会回字符串（"12.5"），所以字符串也尝试解析。
 */
function toNum(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** 计数类字段：负数没有意义，一律抬回 0 并取整 */
function toCount(v: unknown): number {
  return Math.max(0, Math.round(toNum(v)));
}

/** 百分比钳到 0~100：后端漏乘 100 或算出 103% 时不要画出超长进度条 */
function clampPct(v: unknown): number {
  return Math.min(100, Math.max(0, toNum(v)));
}

function toStr(v: unknown, fallback = ''): string {
  return typeof v === 'string' && v.trim() !== '' ? v : fallback;
}

/** 非数组一律当空数组（`routes: null` / 对象 / 数字都见过） */
function toArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** 单条路由：字段缺失/错类型全部落地到安全值，绝不把 undefined 漏给渲染层 */
function normalizeRoute(raw: unknown): ApiRouteStat {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    route: toStr(o.route, '/__unknown__'),
    method: toStr(o.method, 'GET').toUpperCase(),
    calls: toCount(o.calls),
    err4xx: toCount(o.err4xx),
    err5xx: toCount(o.err5xx),
    errorRate: clampPct(o.errorRate),
    qps: Math.max(0, toNum(o.qps)),
    p50: Math.max(0, toNum(o.p50)),
    p95: Math.max(0, toNum(o.p95)),
    p99: Math.max(0, toNum(o.p99)),
    max: Math.max(0, toNum(o.max)),
  };
}

/**
 * 脏数据兜底：把接口返回的任意 JSON 归一成 `ApiSnapshot`。
 *
 * - 数组缺失 / 非数组 → `[]`
 * - 数字 NaN / undefined / 字符串垃圾 → `0`
 * - 百分比钳到 0~100
 * - `storage` 只有对象形状对才保留，否则 `null`（渲染层据此隐藏）
 *
 * @param raw `GET /api/monitor/api` 的原始响应（unknown，可能是任何脏东西）
 * @returns 字段齐全、类型可信的快照
 */
export function normalizeSnapshot(raw: unknown): ApiSnapshot {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const storageRaw = o.storage;
  const storage =
    storageRaw && typeof storageRaw === 'object' && !Array.isArray(storageRaw)
      ? {
          rows: toCount((storageRaw as Record<string, unknown>).rows),
          approxBytes:
            (storageRaw as Record<string, unknown>).approxBytes === null ||
            (storageRaw as Record<string, unknown>).approxBytes === undefined
              ? null
              : Math.max(0, toNum((storageRaw as Record<string, unknown>).approxBytes)),
        }
      : null;

  return {
    // 后端约定是布尔；兼容 "true"/1 这种被中间件序列化过的写法
    enabled: o.enabled === true || o.enabled === 'true' || o.enabled === 1,
    // window 只在后端真的给了字符串时保留，否则 undefined（渲染层退到 '5m'）
    window: typeof o.window === 'string' && o.window.trim() !== '' ? o.window : undefined,
    qps: Math.max(0, toNum(o.qps)),
    errorRate: clampPct(o.errorRate),
    totalCalls: toCount(o.totalCalls),
    routes: toArr(o.routes).map(normalizeRoute),
    slowest: toArr(o.slowest).map(normalizeRoute),
    errorTop: toArr(o.errorTop).map(normalizeRoute),
    dropped: toCount(o.dropped),
    storage,
  };
}

/** 该路由的错误总数（4xx + 5xx），排序/展示共用 */
function errorCount(r: ApiRouteStat): number {
  return r.err4xx + r.err5xx;
}

/**
 * limit 归一：非数字 → 默认 10；显式 0 就是「一条都不要」（调用方切空态用），
 * 不能被 `0 || 10` 这类写法悄悄抬回 10。
 */
function resolveLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return 10;
  return Math.max(0, Math.floor(limit));
}

/**
 * 慢接口 Top N：按 p95 降序，p95 相同按 calls 降序（调用量大更值得先修）。
 *
 * @param snapshot 已归一的快照
 * @param limit 取前几条，默认 10
 * @returns 新数组（不改动入参），不足 limit 时有多少返回多少
 */
export function topSlow(snapshot: ApiSnapshot, limit = 10): ApiRouteStat[] {
  const cap = resolveLimit(limit);
  return [...(snapshot.routes ?? [])]
    .sort((a, b) => b.p95 - a.p95 || b.calls - a.calls)
    .slice(0, cap);
}

/**
 * 错误接口 Top N：按 (4xx+5xx) 降序，同值按 calls 降序。
 * 零错误的路由不进榜 —— 那不是「错误 Top」，是噪音。
 *
 * @param snapshot 已归一的快照
 * @param limit 取前几条，默认 10
 * @returns 新数组，只含至少有一次 4xx/5xx 的路由
 */
export function topErrors(snapshot: ApiSnapshot, limit = 10): ApiRouteStat[] {
  const cap = resolveLimit(limit);
  return [...(snapshot.routes ?? [])]
    .filter((r) => errorCount(r) > 0)
    .sort((a, b) => errorCount(b) - errorCount(a) || b.calls - a.calls)
    .slice(0, cap);
}

/**
 * 延迟格式化：`999 → '999ms'`、`1500 → '1.5s'`、`60000 → '60s'`。
 * 非数字（NaN/null/字符串/负数）统一给 `'—'`，避免表格里出现 "NaNms"。
 *
 * @param ms 毫秒
 * @returns 人类可读的延迟字符串
 */
export function formatMs(ms: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < MINUTE_MS) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

/**
 * QPS 格式化：保留两位小数并去掉无意义的尾零。`2.345 → '2.35'`、`0 → '0'`。
 * 大屏上 QPS 是扫一眼的数字，两位小数足够，再多就是抖动的噪音。
 *
 * @param qps 每秒请求数
 * @returns 字符串（非法值 → `'0'`）
 */
export function formatQps(qps: number): string {
  if (typeof qps !== 'number' || !Number.isFinite(qps) || qps < 0) return '0';
  const rounded = Number(qps.toFixed(2));
  return rounded === 0 ? '0' : String(rounded);
}

/**
 * 字节格式化：`null → '—'`、`1024 → '1.0KB'`、`0 → '0B'`。
 * `approxBytes` 在 SQLite 下拿不到（null），这里必须给占位符而不是 "0KB"，
 * 否则看起来像「存储是空的」而其实只是「算不出来」。
 *
 * @param bytes 字节数，可为 null
 * @returns 人类可读的大小
 */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return '—';
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)}B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)}${units[unit]}`;
}

/**
 * 错误率档位：`<1% ok`、`<5% warn`、`>=5% bad`。
 * 组件按这档上色（accent / yellow / red），阈值写在一处免得两处不一致。
 *
 * @param rate 百分比（0~100）
 * @returns `'ok' | 'warn' | 'bad'`
 */
export function errorRateLevel(rate: number): 'ok' | 'warn' | 'bad' {
  const r = typeof rate === 'number' && Number.isFinite(rate) ? rate : 0;
  if (r >= 5) return 'bad';
  if (r >= 1) return 'warn';
  return 'ok';
}

/**
 * 把分钟桶聚合成画图用的序列：同一分钟内多条累加，缺的分钟补 0。
 *
 * 后端 `GET /api/monitor/api` 只给汇总值（没有时间轴），这条函数给的是
 * **前端自己攒的最小趋势条**：每轮轮询把当前分钟的估算 calls 写进 `rows`，
 * 于是「最近 5 分钟哪一分钟是空的」能直接看出来（说明服务停过或者轮询被挂起）。
 *
 * @param rows 分钟桶样本（`bucketMs` 是桶内任意时间戳，按分钟向下取整归并）
 * @param windowMs 窗口宽度（ms），按 `windowMs / 60000` 决定输出多少个点
 * @returns 升序时间序列 `{ t: 桶起点(ms), v: 该分钟 calls }`；没有样本时返回 `[]`
 */
export function buildQpsSeries(
  rows: Array<{ bucketMs: number; calls: number }>,
  windowMs: number,
): Array<{ t: number; v: number }> {
  const slots = Math.min(240, Math.max(1, Math.round(toNum(windowMs) / MINUTE_MS) || 1));
  const buckets = new Map<number, number>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const ms = toNum(row?.bucketMs);
    if (ms <= 0) continue; // 0/负时间戳是脏数据，归并进去会污染时间轴
    const key = Math.floor(ms / MINUTE_MS);
    buckets.set(key, (buckets.get(key) ?? 0) + Math.max(0, toNum(row?.calls)));
  }
  if (buckets.size === 0) return [];
  let end = -Infinity;
  for (const key of buckets.keys()) if (key > end) end = key;
  const out: Array<{ t: number; v: number }> = [];
  for (let i = slots - 1; i >= 0; i -= 1) {
    const key = end - i;
    out.push({ t: key * MINUTE_MS, v: buckets.get(key) ?? 0 });
  }
  return out;
}
