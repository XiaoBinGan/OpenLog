/**
 * server/demo/fixtures-infra.js —— 演示模式的「基础设施面板」假数据
 *
 * 负责四张在演示机上最容易空着的运维面板（契约见 /tmp/demo-contract.md）：
 *
 *   · 数据库监控：`/api/monitor/db`、`/api/monitor/db/{history,slow-queries,tables}`、
 *     `/api/db/info` —— 真实实现读的是**本机连的那个库**的 pg_stat_activity / 采样表，
 *     演示机上那个库要么是空 sqlite、要么根本没起。
 *   · 接口监控：`/api/monitor/api` —— 真实实现读内存滑窗注册表，演示进程刚启动，
 *     窗口里一条流量都没有（qps=0、routes=[]），页面会显示成「服务没人访问」。
 *   · 外部数据源：`/api/monitor/datasources` —— 真实实现读登记表，演示库是空的。
 *
 * 三条硬约束（与 fixtures.js / fixtures-runtime.js / fixtures-observability.js 相同）：
 *
 * 1. **形状照抄真实实现**：每一组字段都对照真实响应逐字段抄下来，每个导出上面的注释
 *    写清了「照哪个文件抄的」。少一个字段就会让前端换一条渲染分支（比如 DB 面板
 *    按 `storage.rows` / `storage.approxBytes` 分支，按 `tables[].relname` 渲染表名）。
 * 2. **纯函数 + 常量表**：不 import 任何模块、不读文件、不联网、不读环境变量；
 *    时间锚点在这里重新声明一份（值与其它 fixture 的 DEMO_NOW 相同）——
 *    fixture 文件互不依赖，任何一个改坏都不会把另一个带崩。
 * 3. **确定性 + 自洽**：时间全部从 DEMO_INFRA_NOW 派生（不是 Date.now()），噪声用固定
 *    种子的线性同余；qps / 错误率 / p95 是从同一张路由表**算出来**的，不是各写一个
 *    常量 —— 否则「qps 61.46 但 calls 加起来 18437」这种对不上的数字比空面板更糟。
 *    同一函数调两次必须 deepEqual（前端 30 秒轮询时曲线不能自己乱抖，测试也要能断言）。
 *
 * 数据视角：这台演示机跑着一个 **PostgreSQL 16**（OpenLog 自己的库）+ 一整套
 * GPU 推理集群的采集（远程 4090×4 机 / 8 个容器 / K8s 1 节点 8 Pod），
 * 单机 QPS 约 61，DB 连接池 10 个连接里 4 个在用。表体积/行数的比例按「PG 真实
 * 数据行宽度」写：ts_sample ≈ 273 B/行、log_records ≈ 611 B/行（带原始日志文本）。
 */

// ─── 时间基准 ──────────────────────────────────────────────────────────────

/** 时间锚点（与 fixtures.js 的 DEMO_NOW 取同一个值：演示数据讲同一个故事） */
export const DEMO_INFRA_NOW = '2026-06-08T09:48:37.000Z';

const NOW_MS = Date.parse(DEMO_INFRA_NOW);
const SECOND = 1000;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const round2 = (v) => Math.round(v * 100) / 100;
const round4 = (v) => Math.round(v * 1e4) / 1e4;

/** 确定性伪随机（线性同余，与 fixtures.js 同款）：同 seed 永远同一串值 */
function seededNoise(seed, count) {
  let state = (seed >>> 0) || 1;
  const out = [];
  for (let i = 0; i < count; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out.push(state / 4294967296);
  }
  return out;
}

// ─── 库表体积（/api/monitor/db、/api/monitor/db/tables、/api/db/info 共用）──
//
// 形状照 `metrics/db-sampler.js#summarizeTables` 的输出（PG heavy 采样那条 SQL 的
// 结果经 summarizeTables 归一）：`{ relname, idxScan, seqScan, bytes, liveTup,
// deadTup, indexHitRate }`，按 bytes 降序。
//
// 行宽（bytes / liveTup）都落在 PG 的真实区间里：
//   ts_sample           273 B/行（(series_id, ts_ms) 主键 + 8 字节 double）
//   log_records         611 B/行（message + metadata + level/timestamp 索引）
//   api_metrics_minute  332 B/行（route 文本 + 5 个计数）
//   db_metric_sample     535 B/行（payload 是 JSON 快照，真实库里就这个量级）
//   analysis_records   1490 B/行（analysis 是几 KB 的 markdown 结论）
//   ts_series           404 B/行（fingerprint 64 字符 + labels JSON）
//
// ts_series / ts_sample 是 TSDB 的表：7 天保留 × 15s 抓取 × 十几个指标，量级最大，
// 所以在体积榜上稳居第一/末位（ts_series 行少但每行小，排最后）。
const DB_TABLE_SEED = [
  { relname: 'ts_sample', bytes: 3_412_000_000, liveTup: 12_480_000, deadTup: 18_240, idxScan: 9_984_000, seqScan: 16_000 },
  { relname: 'log_records', bytes: 1_126_000_000, liveTup: 1_842_660, deadTup: 42_180, idxScan: 7_372_000, seqScan: 204_000 },
  { relname: 'api_metrics_minute', bytes: 431_000_000, liveTup: 1_296_000, deadTup: 8_640, idxScan: 1_036_800, seqScan: 12_960 },
  { relname: 'db_metric_sample', bytes: 46_200_000, liveTup: 86_400, deadTup: 720, idxScan: 345_600, seqScan: 2_160 },
  { relname: 'analysis_records', bytes: 18_600_000, liveTup: 12_480, deadTup: 312, idxScan: 62_400, seqScan: 9_360 },
  { relname: 'ts_series', bytes: 3_400_000, liveTup: 8_420, deadTup: 96, idxScan: 1_010_400, seqScan: 4_210 },
];

/** 演示库的表数：就是上面这 6 张（其余都是空表，体积榜上不出现） */
export const DEMO_DB_TABLE_COUNT = DB_TABLE_SEED.length;

/** 单张表的行宽（bytes/行）。按行数缩放体积时用它，保证 rows 与 bytes 永远同一比例 */
const DB_TABLE_BYTES_PER_ROW = Object.fromEntries(
  DB_TABLE_SEED.map((t) => [t.relname, t.bytes / t.liveTup]),
);

/**
 * `summarizeTables()` 形状的 6 张表（按 bytes 降序）。
 * `indexHitRate` 由 idxScan/seqScan **算出来**而不是手写常量：真实实现就是这么算的
 * （分母为 0 才是 null），手写迟早和两个计数对不上。
 *
 * @param {number} [scale] 行数缩放系数（历史采样用：1 = 当前）
 * @returns {Array<object>}
 */
function tableStats(scale = 1) {
  const k = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return DB_TABLE_SEED.map((t) => {
    const liveTup = k === 1 ? t.liveTup : Math.round(t.liveTup * k);
    const bytes = k === 1 ? t.bytes : Math.round(liveTup * DB_TABLE_BYTES_PER_ROW[t.relname]);
    const scans = t.idxScan + t.seqScan;
    return {
      relname: t.relname,
      idxScan: Math.round(t.idxScan * k),
      seqScan: Math.round(t.seqScan * k),
      bytes,
      liveTup,
      deadTup: Math.round(t.deadTup * k),
      indexHitRate: scans > 0 ? round4(t.idxScan / scans) : null,
    };
  }).sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
}

/** 库级大小（pg_database_size）：表体积之和 + 索引/系统表/空闲页的余量 */
const DB_TOTAL_BYTES = DB_TABLE_SEED.reduce((sum, t) => sum + t.bytes, 0) + 126_440_832;

// ─── 连接池与采样时间 ─────────────────────────────────────────────────────

/**
 * 连接池水位，形状照 `db/index.js#getDbInfo()` 的 `pool`：
 * `{ total, idle, waiting, max }`（PG 的 pg-pool 计数）。
 *
 * total 10 = max 10（池子吃满但没排队），idle 6 → **活跃 4 条**，
 * 与下面 `lastLight.activity.byState` 的 `{active:4, idle:6}` 严格对上 ——
 * 两个字段都来自同一个 pg_stat_activity，对不上就说明数据是编的。
 */
const DB_POOL = Object.freeze({ total: 10, idle: 6, waiting: 0, max: 10 });

/** 探活延迟（`SELECT 1`，单机 unix socket / 127.0.0.1 的量级） */
const DB_PROBE_MS = 1.8;

/** 最近一次 light 采样时间 = 锚点本身（30s 一轮，刚跑完） */
const LIGHT_TS = NOW_MS;
/** 最近一次 heavy 采样时间：2m48s 前（heavy 是 5min 一轮） */
const HEAVY_TS = NOW_MS - 168 * SECOND;

/** 当前最长事务（一条按 series_id + 时间范围扫 ts_sample 的查询） */
const LONGEST_QUERY = 'SELECT ts_ms, value FROM ts_sample WHERE series_id = $1 AND ts_ms >= $2 ORDER BY ts_ms';

/** light 采样快照，形状照 `metrics/db-sampler.js#samplePg` 的 `snap` + `finalize()` 补的 `unavailable/ok` */
function lightSnapshot(tsMs, { probeMs = DB_PROBE_MS, pool = DB_POOL, longestMs = 4_820 } = {}) {
  return {
    tsMs,
    kind: 'light',
    probeMs,
    pool: { total: pool.total, idle: pool.idle, waiting: pool.waiting, max: pool.max },
    activity: {
      byState: { active: pool.total - pool.idle, idle: pool.idle },
      longestMs,
      longestQuery: LONGEST_QUERY,
      // pg_stat_activity 的 wait_event：idle 连接在等客户端（ClientRead），活跃的在等 IO
      waitEvents: [{ event: 'ClientRead', count: pool.idle }, { event: 'DataFileRead', count: 1 }],
    },
    locks: { waiting: 0, blocking: 0 },
    tables: null,
    unavailable: [],
    ok: true,
  };
}

/** heavy 采样快照：只有表体积（heavy 的 SQL 就查 pg_class + pg_stat_user_tables） */
function heavySnapshot(tsMs, scale = 1) {
  return {
    tsMs,
    kind: 'heavy',
    probeMs: null,
    pool: null,
    activity: null,
    locks: null,
    tables: tableStats(scale),
    unavailable: [],
    ok: true,
  };
}

/**
 * `api-store` 的 `stats()`（`metrics/api-store.js#stats`）：
 * 三张监控表的行数 + api_metrics_minute 的体积。
 * 慢查询那 4 条还在内存环形缓冲里（`source: 'memory'`），所以 slow_query_log 是 0 行 ——
 * 这解释了 `/api/monitor/db/slow-queries` 为什么回 `source: 'memory'`。
 */
function storageStats() {
  const tables = [
    { table: 'api_metrics_minute', rows: 1_296_000 },
    { table: 'db_metric_sample', rows: 86_400 },
    { table: 'slow_query_log', rows: 0 },
  ];
  return {
    rows: tables.reduce((sum, t) => sum + (t.rows ?? 0), 0),
    approxBytes: 477_200_000,
    tables,
  };
}

// ─── 1. GET /api/monitor/db ───────────────────────────────────────────────

/**
 * `GET /api/monitor/db` 的响应体。
 *
 * 照 `routes/db-monitor.js` 的第一个 handler 逐字段抄：
 *   `{ enabled, type, pool, lastLight, lastHeavy, unavailable, tables, probeMs, storage }`
 *
 * `tables` 是顶层那份（= `lastHeavy.tables`），前端 `normalizeDbSnapshot` 两个位置都读。
 */
export function demoDbMonitor() {
  const light = lightSnapshot(LIGHT_TS);
  const heavy = heavySnapshot(HEAVY_TS);
  return {
    enabled: true,
    type: 'postgres',
    pool: { ...DB_POOL },
    lastLight: light,
    lastHeavy: heavy,
    // 空数组 = 没有权限不足/读不到的项目（真实实现里这是唯一出口）
    unavailable: [],
    tables: heavy.tables,
    probeMs: light.probeMs,
    storage: storageStats(),
  };
}

// ─── 2. GET /api/monitor/db/history ──────────────────────────────────────

/** 历史点数：与 Monitor 页要的 60 点一致 */
export const DEMO_DB_HISTORY_POINTS = 60;
/** light 30s 一轮 → 60 点覆盖最近 30 分钟 */
const LIGHT_STEP_MS = 30 * SECOND;
/** heavy 5min 一轮 → 60 点覆盖最近 5 小时 */
const HEAVY_STEP_MS = 5 * MINUTE;

/** history 的 limit 语义照 `routes/db-monitor.js#boundedInt`：非正/非数按默认，超限夹到上限 */
function boundedInt(raw, fallback, max) {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

/**
 * `GET /api/monitor/db/history` 的响应体：`{ kind, samples }`。
 *
 * 元素形状照 `db_metric_sample` 表读出来的行经路由 map 后的样子：
 * `{ tsMs, kind, data }`，其中 `data` 就是当轮采样快照（payload 反序列化）。
 *
 * 采样时间从锚点**往回**排：最新一点正好是 `lastLight.tsMs` / `lastHeavy.tsMs`，
 * 所以「最近采样时间」这张卡片和历史曲线右端永远对得上。
 *
 * @param {{kind?: string, limit?: number|string}} [opts]
 * @returns {{kind: 'light'|'heavy', samples: Array<{tsMs:number, kind:string, data:object}>}}
 */
export function demoDbHistory(opts = {}) {
  const kind = opts.kind === 'heavy' ? 'heavy' : 'light';
  const limit = boundedInt(opts.limit, 120, 500);
  const step = kind === 'heavy' ? HEAVY_STEP_MS : LIGHT_STEP_MS;
  const newest = kind === 'heavy' ? HEAVY_TS : LIGHT_TS;
  const noise = seededNoise(kind === 'heavy' ? 0xdb5 : 0xdb1, DEMO_DB_HISTORY_POINTS);

  const samples = [];
  for (let i = 0; i < DEMO_DB_HISTORY_POINTS; i += 1) {
    const isLast = i === DEMO_DB_HISTORY_POINTS - 1;
    const tsMs = newest - (DEMO_DB_HISTORY_POINTS - 1 - i) * step;
    if (kind === 'heavy') {
      // 行数随保留策略缓慢增长：最旧一点是当前的 98.5%，最新一点正好等于当前
      const scale = isLast ? 1 : 0.985 + 0.015 * (i / (DEMO_DB_HISTORY_POINTS - 1));
      samples.push({ tsMs, kind, data: heavySnapshot(tsMs, scale) });
      continue;
    }
    // light：池水位在 5~7 个 idle 之间晃（活跃 3~5 条），探活延迟 1.2~3.4ms，
    // 偶发一次排队（waiting=1）。最新一点强制回落成规范值，与 /api/monitor/db 对齐。
    const idle = isLast ? 6 : 6 + Math.round((noise[i] - 0.5) * 4);
    const waiting = isLast ? 0 : (noise[i] > 0.88 ? 1 : 0);
    const pool = { total: 10, idle, waiting, max: 10 };
    const probeMs = isLast ? DB_PROBE_MS : round2(1.8 + (noise[i] - 0.5) * 1.6);
    const longestMs = isLast ? 4_820 : Math.round(1_200 + noise[i] * 6_400);
    samples.push({ tsMs, kind, data: lightSnapshot(tsMs, { probeMs, pool, longestMs }) });
  }

  return { kind, samples: samples.slice(-limit) };
}

// ─── 3. GET /api/monitor/db/slow-queries ─────────────────────────────────

/** 慢查询阈值：index.js 注入的就是 200ms（`slowQueryThresholdMs`） */
export const DEMO_SLOW_QUERY_THRESHOLD_MS = 200;

/**
 * 5 条慢查询，形状照 `metrics/slow-query.js#record()` push 进环形缓冲的对象：
 * `{ ts_ms, fingerprint, ms, source, sample }` —— `source` 是 `db.${方法名}`
 * （`db/index.js#withSlowLog` 里 `db.all` / `db.get`），`sample` 在真实实现里
 * 就是指纹本身（SQL 文本里不留参数值）。
 *
 * 内容是这个系统真实会慢的地方：TSDB 大范围查询、日志表分页全扫、表体积统计。
 * 顺序即 `list()` 的返回顺序（最新在前）。
 */
const SLOW_QUERIES = [
  {
    ts_msAgo: 96 * SECOND,
    fingerprint: 'select ts_ms, value from ts_sample where series_id = ? and ts_ms >= ? order by ts_ms',
    ms: 1_482,
    source: 'db.all',
  },
  {
    ts_msAgo: 214 * SECOND,
    fingerprint: 'select id, timestamp, level, message, source from log_records where level = ? order by timestamp desc limit ?',
    ms: 864,
    source: 'db.all',
  },
  {
    ts_msAgo: 402 * SECOND,
    fingerprint: 'select c.relname as relname, pg_total_relation_size(c.oid) as bytes, s.n_live_tup as live_tup from pg_class c join pg_namespace n on n.oid = c.relnamespace left join pg_stat_user_tables s on s.relid = c.oid where c.relkind = ? and n.nspname not in (?, ?) order by pg_total_relation_size(c.oid) desc limit ?',
    ms: 512,
    source: 'db.all',
  },
  {
    ts_msAgo: 688 * SECOND,
    fingerprint: 'select count(*) as n from log_records where timestamp >= ? and level = ?',
    ms: 296,
    source: 'db.get',
  },
  {
    ts_msAgo: 1_240 * SECOND,
    fingerprint: 'select fingerprint, sum(ms) as total_ms, count(*) as n from slow_query_log where ts_ms >= ? group by fingerprint order by total_ms desc limit ?',
    ms: 218,
    source: 'db.all',
  },
];

/**
 * `GET /api/monitor/db/slow-queries` 的响应体：`{ threshold, items, source }`。
 *
 * `source: 'memory'` —— 环形缓冲里的数据（不是从 slow_query_log 表回落的），
 * 与 `storageStats()` 里那张表 0 行的事实一致。
 *
 * @param {{limit?: number|string}} [opts]
 * @returns {{threshold: number, items: Array<object>, source: 'memory'}}
 */
export function demoSlowQueries(opts = {}) {
  const limit = boundedInt(opts.limit, 50, 500);
  const items = SLOW_QUERIES.map((q) => ({
    ts_ms: NOW_MS - q.ts_msAgo,
    fingerprint: q.fingerprint,
    ms: q.ms,
    source: q.source,
    sample: q.fingerprint,
  }));
  return {
    threshold: DEMO_SLOW_QUERY_THRESHOLD_MS,
    items: items.slice(0, limit),
    source: 'memory',
  };
}

// ─── 4. GET /api/monitor/db/tables ──────────────────────────────────────

/**
 * `GET /api/monitor/db/tables` 的响应体：`{ available, tsMs, total, tables }`。
 *
 * 路由是从 `lastHeavy.tables` 里 map 出 `{ relname, bytes, liveTup, deadTup,
 * indexHitRate }` 再按 bytes 降序切前 limit 条；这里直接给出同一个形状
 * （多出来的 idxScan/seqScan 会被前端忽略，但它们在快照里本来就存在）。
 *
 * `total` = 演示库的表数（6），与 `/api/db/info` 的 `tableCount` 同一个数。
 *
 * @param {{limit?: number|string}} [opts]
 * @returns {{available: boolean, tsMs: number, total: number, tables: Array<object>}}
 */
export function demoDbTables(opts = {}) {
  const limit = boundedInt(opts.limit, 20, 50);
  const all = tableStats();
  return {
    available: true,
    tsMs: HEAVY_TS,
    total: all.length,
    tables: all.slice(0, limit),
  };
}

// ─── 5. GET /api/monitor/api ────────────────────────────────────────────

/** 窗口别名 → 毫秒，与 `routes/api-monitor.js#WINDOW_MS` 完全一致 */
export const DEMO_API_WINDOW_MS = Object.freeze({ '1m': MINUTE, '5m': 5 * MINUTE, '1h': HOUR });
const DEFAULT_API_WINDOW = '5m';
/** 5m 窗口的总调用数（18_435 / 300s = 61.45 QPS，一台跑着 3 台远程机 + 8 容器采集的实例就是这个量级）。
 *  取 5 的整数倍：1m / 5m / 1h 三个窗口的 calls 都能整除，QPS 在三个窗口里严格相等。 */
const API_TOTAL_CALLS_5M = 18_435;

/**
 * 8 条真实路由的流量画像。
 *
 * `weight` 之和为 1（分到各窗口的总调用数）；`p50/p95/p99/max` 是毫秒。
 * 错误率按**比例**给，实际条数由 calls 算出来 —— 这样 1m / 5m / 1h 三个窗口的
 * 错误率保持一致，而错误条数随窗口缩放（真实滑窗就是这个行为）。
 *
 * 画像依据：
 *   · `/api/monitor/stats` 被前端每 5s 轮询一次 → 份额最大，但 systeminformation
 *     走 3s 缓存，所以 p95 只有 42ms；
 *   · `/api/docker/containers` 要打 docker daemon，240ms p95，容器重启期间开始 5xx；
 *   · `/api/k8s/clusters/:id/overview` 最慢（要并发查 nodes/pods/events），720ms p95，
 *     少量 4xx 是前端传错 clusterId / 未授权；
 *   · `/api/tsdb/query` 的 4xx 来自 PromQL 语法错误与时间范围越界（用户手输的表达式）。
 */
const API_ROUTES = [
  {
    method: 'GET', route: '/api/monitor/stats', weight: 0.30,
    p50: 8.6, p95: 42.5, p99: 96.2, max: 480, err4Rate: 0, err5Rate: 0,
  },
  {
    method: 'GET', route: '/api/docker/containers', weight: 0.16,
    p50: 68.4, p95: 240.6, p99: 486.0, max: 1_820, err4Rate: 0.0008, err5Rate: 0.0025,
  },
  {
    method: 'GET', route: '/api/monitor/history', weight: 0.13,
    p50: 4.2, p95: 18.4, p99: 41.6, max: 210, err4Rate: 0, err5Rate: 0,
  },
  {
    method: 'GET', route: '/api/remote/servers', weight: 0.12,
    p50: 3.1, p95: 9.8, p99: 22.4, max: 120, err4Rate: 0.0009, err5Rate: 0,
  },
  {
    method: 'POST', route: '/api/tsdb/query', weight: 0.09,
    p50: 42.8, p95: 183.6, p99: 402.4, max: 980, err4Rate: 0.0035, err5Rate: 0,
  },
  {
    method: 'GET', route: '/api/logs/tail', weight: 0.08,
    p50: 12.4, p95: 35.2, p99: 88.6, max: 460, err4Rate: 0, err5Rate: 0,
  },
  {
    method: 'GET', route: '/api/k8s/clusters/:id/overview', weight: 0.07,
    p50: 186.2, p95: 720.4, p99: 1_540.8, max: 3_020, err4Rate: 0.0022, err5Rate: 0.0015,
  },
  {
    method: 'GET', route: '/api/monitor/api', weight: 0.05,
    p50: 6.1, p95: 24.8, p99: 62.4, max: 190, err4Rate: 0, err5Rate: 0,
  },
];

/**
 * 把 total 按 weight 切成整数，且**和严格等于 total**。
 * 先取整再按小数部分从大到小补余数（同输入同输出，不依赖 Math.random）。
 * @param {number} total @param {number[]} shares @returns {number[]}
 */
function distribute(total, shares) {
  const raw = shares.map((s) => total * s);
  const out = raw.map((v) => Math.floor(v));
  const rest = total - out.reduce((a, b) => a + b, 0);
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < rest; k += 1) out[order[k % order.length].i] += 1;
  return out;
}

/** 窗口归一：只认 1m/5m/1h，其余回退 5m（与路由的 parseWindow 同口径） */
const parseApiWindow = (raw) => (Object.prototype.hasOwnProperty.call(DEMO_API_WINDOW_MS, String(raw ?? ''))
  ? String(raw)
  : DEFAULT_API_WINDOW);

/**
 * `GET /api/monitor/api` 的响应体。
 *
 * 照 `routes/api-monitor.js` 第一个 handler 的 `res.status(200).json({...})` 逐字段抄：
 * `{ enabled, window, windowMs, qps, errorRate, totalCalls, routes, slowest, errorTop,
 *    dropped, droppedRoutes, storage, sinceMs, source, unavailable }`
 *
 * 其中 `routes[]` 的元素是 `metrics/registry.js#snapshot()` 的形状
 * （method/route/calls/err4xx/err5xx/errorRate/qps/p50/p95/p99/max），
 * 全局 qps/errorRate 与路由明细**由同一组 calls 算出**，所以永远对得上。
 *
 * `sinceMs` 是「内存滑窗从什么时候开始累计」= 锚点 - 进程 uptime；
 * uptime 取 12 天，与 fixtures-runtime 里本机 `uptime`（1_036_800s）一致。
 *
 * @param {{window?: string}} [opts]
 * @returns {object}
 */
export function demoApiMonitor(opts = {}) {
  const window = parseApiWindow(opts?.window);
  const windowMs = DEMO_API_WINDOW_MS[window];
  const seconds = windowMs / SECOND;
  // 5m 是基准窗口，其它窗口按比例缩放总调用数（QPS 保持 61.46 不变）
  const totalCalls = windowMs === DEMO_API_WINDOW_MS[DEFAULT_API_WINDOW]
    ? API_TOTAL_CALLS_5M
    : Math.round((API_TOTAL_CALLS_5M * windowMs) / DEMO_API_WINDOW_MS[DEFAULT_API_WINDOW]);

  const calls = distribute(totalCalls, API_ROUTES.map((r) => r.weight));
  let sum4xx = 0;
  let sum5xx = 0;
  const routes = API_ROUTES.map((r, i) => {
    const n = calls[i];
    const err4xx = Math.round(n * r.err4Rate);
    const err5xx = Math.round(n * r.err5Rate);
    sum4xx += err4xx;
    sum5xx += err5xx;
    return {
      route: r.route,
      method: r.method,
      calls: n,
      err4xx,
      err5xx,
      errorRate: n > 0 ? round4((err4xx + err5xx) / n) : 0,
      qps: round2(n / seconds),
      p50: r.p50,
      p95: r.p95,
      p99: r.p99,
      max: r.max,
    };
  }).sort((a, b) => b.calls - a.calls || a.route.localeCompare(b.route));

  // 慢接口 Top5 / 错误 Top（registry 里的 slowest 是 p95 降序，errorTop 只收 5xx）
  const slowest = routes.slice()
    .sort((a, b) => b.p95 - a.p95 || b.calls - a.calls)
    .slice(0, 5);
  const errorTop = routes.filter((r) => r.err5xx > 0).slice()
    .sort((a, b) => b.err5xx - a.err5xx || b.errorRate - a.errorRate);

  return {
    enabled: true,
    window,
    windowMs,
    qps: round2(totalCalls / seconds),
    errorRate: totalCalls > 0 ? round4((sum4xx + sum5xx) / totalCalls) : 0,
    totalCalls,
    routes,
    slowest,
    errorTop,
    dropped: 0,
    droppedRoutes: 0,
    storage: storageStats(),
    sinceMs: NOW_MS - 1_036_800 * SECOND,
    source: 'memory',
    unavailable: [],
  };
}

// ─── 6. GET /api/db/info ────────────────────────────────────────────────

/** PG 版本串（`SELECT version()` 的真实格式，带 Debian 打包后缀） */
const PG_VERSION = 'PostgreSQL 16.4 (Debian 16.4-1.pgdg120+1) on x86_64-pc-linux-gnu, compiled by gcc (Debian 12.2.0-14) 12.2.0, 64-bit';

/**
 * `GET /api/db/info` 的响应体。
 *
 * 照 `routes/db-info.js` 的 payload 组装顺序：
 *   `{ ...getDbInfo(), ok, latencyMs, timestamp }` → 再补 `database` / `storage` / `counts*`。
 * `getDbInfo()` 给的是 `{ type, ready, dialect, pool, host, database }`（PG 分支）。
 *
 * 在真实实现之上多两件事（都是**只增不改**，前端不消费也不会坏）：
 *   · `version` / `tableCount`：这个端点的用途是「换库后确认真的连上了哪个库」，
 *     只有 type 没有版本串很难确认；`tableCount` 与 `/api/monitor/db/tables` 的 `total`
 *     取同一个数（6）。
 *   · `storage.bytes` 是**库级**大小（pg_database_size），比 6 张表体积之和大一点点
 *     （索引 / 系统表 / 空闲页），这正是真实库里两者的关系。
 *
 * `timestamp` 用锚点而不是 `new Date()`：演示响应必须确定性（两次调用 deepEqual）。
 *
 * @param {{counts?: boolean}} [opts]
 * @returns {object}
 */
export function demoDbInfo(opts = {}) {
  const wantCounts = opts?.counts === true;
  const payload = {
    type: 'postgres',
    ready: true,
    dialect: 'postgresql',
    pool: { ...DB_POOL },
    host: '127.0.0.1',
    database: 'openlog',
    version: PG_VERSION,
    tableCount: DEMO_DB_TABLE_COUNT,
    ok: true,
    latencyMs: 0.7,
    timestamp: DEMO_INFRA_NOW,
    storage: { kind: 'database', bytes: DB_TOTAL_BYTES },
  };
  if (wantCounts) {
    const counts = {};
    const countsMeta = {};
    for (const t of DB_TABLE_SEED) {
      counts[t.relname] = t.liveTup;
      // 大表走 pg_class.reltuples 估算，小表是精确 COUNT（真实实现的两种 method）
      countsMeta[t.relname] = t.liveTup >= 100_000 ? 'estimate' : 'exact';
    }
    // 慢查询表存在但 0 行（见 storageStats 的说明），COUNT 是精确的
    counts.slow_query_log = 0;
    countsMeta.slow_query_log = 'exact';
    payload.counts = counts;
    payload.countsMeta = countsMeta;
  }
  return payload;
}

// ─── 7. GET /api/monitor/datasources ────────────────────────────────────

/**
 * 两个已登记的外部数据源，形状照 `datasource/store.js#toPublic()` 逐字段抄
 * （`passwordMasked` 只给打码值，`hasPassword` 说有没有密码，绝不给明文）。
 *
 * 一个 `ok`（Prometheus 抓得到）、一个 `error`（vLLM 容器正在重启，8000 端口拒绝）：
 * 面板要能同时演示「正常」和「上次探测失败」两种状态，否则排障 UI 永远是绿的。
 * `lastProbeAt` 是毫秒时间戳（表里就是 BIGINT），不是 ISO 串。
 */
const DATASOURCE_SEED = [
  {
    id: 'svc:local:prometheus',
    kind: 'service',
    collection: 'local',
    label: '本机 Prometheus',
    baseUrl: 'http://127.0.0.1:9090',
    enabled: true,
    lastProbeMs: 42,
    lastStatus: 'ok',
    lastError: null,
    lastProbeAgo: 92 * SECOND,
    createdAgo: 6 * DAY + 3 * HOUR,
  },
  {
    id: 'svc:srv-4090-a:vllm',
    kind: 'service',
    collection: 'srv-4090-a',
    label: 'vllm-4090-a 接口',
    baseUrl: 'http://10.0.12.31:8000',
    enabled: true,
    lastProbeMs: 1_204,
    lastStatus: 'error',
    lastError: 'connect ECONNREFUSED 10.0.12.31:8000（容器 vllm-4090-a 正在重启）',
    lastProbeAgo: 158 * SECOND,
    createdAgo: 4 * DAY + 7 * HOUR,
  },
];

/**
 * `GET /api/monitor/datasources` 的响应体：`{ available, items }`。
 * @returns {{available: boolean, items: Array<object>}}
 */
export function demoDatasources() {
  const items = DATASOURCE_SEED.map((d) => ({
    id: d.id,
    kind: d.kind,
    collection: d.collection,
    label: d.label,
    // 服务型数据源没有方言/端口/账号：真实实现里这些字段是 null / ''
    dialect: null,
    host: '',
    port: null,
    user: '',
    database: '',
    baseUrl: d.baseUrl,
    enabled: d.enabled,
    hasPassword: false,
    passwordMasked: '',
    lastProbeMs: d.lastProbeMs,
    lastStatus: d.lastStatus,
    lastError: d.lastError,
    lastProbeAt: NOW_MS - d.lastProbeAgo,
    createdAt: NOW_MS - d.createdAgo,
  }));
  return { available: true, items };
}

/**
 * `GET /api/monitor/datasources/discover` 的响应体（演示模式专用）。
 *
 * 真实实现要 inspect 每个 Docker 源里的容器（连 daemon / SSH 隧道），演示模式一律不连，
 * 所以候选是空的 —— 但字段给全，面板渲染的是「没有发现可采纳的候选」而不是报错。
 * 想演示「采纳」流程请看 fixtures.js 的容器表：那个流程在演示下返回 409。
 *
 * @returns {object}
 */
export function demoDatasourceDiscover() {
  return {
    available: true,
    scannedSources: 1,
    dbCandidates: [],
    serviceCandidates: [],
    errors: [],
    // 额外字段（真实实现没有）：前端/人一眼能看出「不是没扫到，是演示模式不扫」
    note: '演示模式：未扫描真实容器',
  };
}

/** 供测试与文档引用：演示库的表清单（按体积降序的表名） */
export const DEMO_DB_TABLE_NAMES = DB_TABLE_SEED.map((t) => t.relname);

/** 供测试引用：锚点的 ISO 串已在上方导出为 DEMO_INFRA_NOW，这里补一个毫秒版本 */
export const DEMO_INFRA_NOW_MS = NOW_MS;
