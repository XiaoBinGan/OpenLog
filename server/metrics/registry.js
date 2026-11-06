/**
 * server/metrics/registry.js —— 接口监控的「内存滑窗注册表」（契约 4.2，零依赖）
 *
 * 为什么**不**保留原始样本数组：~200 QPS 下 1 分钟窗口就是 12000 个样本，1 小时窗口是几十万个
 * 数字/路由 —— GC、快照遍历、常驻内存都会被拖死。所以每个 (method, route) 只留两块**定长**结构：
 *   1) 环形分桶计数器：桶宽取「整除 60000 的毫秒数」，每个桶完整落在一个自然分钟里，于是
 *      takeMinuteBuckets() 能不重不漏地折叠成分钟落库；桶数 N = windowMs/桶宽，再额外留最多 N 个
 *      桶当「分钟缓冲」，保证上一分钟永远完整。
 *   2) 固定 20 档延迟直方图：p50/p95/p99 由**桶内线性插值**估算，**不是精确值**，误差上限约等于
 *      命中那一档的档宽（100~200ms 档最大偏 ~50ms，5000~10000ms 档是秒级）。换来的是恒定内存：
 *      跑一天和跑一年、1 分钟窗口和 1 小时窗口，每条路由都只有同一块 TypedArray。
 *
 * 内存估算（每条路由 = slots(Int32 12×24×4 ≈ 1.15KB) + ids(Float64 12×8 ≈ 96B) + Entry/Map ≈ 0.6KB）：
 * 实测约 **1.9KB/路由**（heap + ArrayBuffer），maxRoutes=300 → 约 **550KB** 常驻（1 小时窗口 120 桶
 * ≈ 12.6KB/路由）。对照：同样信息用普通 Array<number> 存，光数组头和装箱就 1.5KB 起且随流量增长。
 *
 * 时间来源：默认 Date.now()，可用 opts.now 注入（契约第 0 节第 4 条允许注入 now 便于单测）；
 * record() 每次只读一次 now，保证同一请求落在同一个桶。
 */

/** 直方图 20 档的上界（升序，最后一档 = 溢出档）。
 *  任务点名的 15 条边界（1,2,5,10,20,50,100,200,500,1000,2000,5000,10000,30000,60000）全部保留；
 *  再补 3、7、300、3000 收窄最宽空档（2~5、20~50、100~200、1000~2000）的插值误差凑满 20 档。
 *  语义：第 i 档 = [BOUNDS[i-1], BOUNDS[i])，最后一档 = [60000, +∞)。 */
const HIST_BOUNDS = [1, 2, 3, 5, 7, 10, 20, 50, 100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 30000, 60000];
const HIST_SLOTS = HIST_BOUNDS.length + 1; // 20 档
const S_CALLS = 0, S_ERR4XX = 1, S_ERR5XX = 2, S_MAX = 3, S_HIST = 4;
const PER_BUCKET = S_HIST + HIST_SLOTS; // 每桶 24 个 Int32 槽

const OTHER_ROUTE = '__other__';
const DEFAULT_WINDOW_MS = 60_000, DEFAULT_MAX_ROUTES = 300, MINUTE_MS = 60_000;
const MIN_BUCKETS = 6; // 一个窗口至少切 6 段，否则窗口内时间分辨率太粗
const MAX_BUCKETS = 120; // 桶数硬上限：1 小时窗口 120 桶 ≈ 12.6KB/路由，不再随窗口增长
const DROPPED_KEYS_CAP = 1000; // droppedRoutes 去重集合上限，防随机路径把集合撑成泄漏
// 桶宽候选：全部整除 60000，保证桶不跨自然分钟
const BUCKET_CHOICES = [100, 200, 250, 500, 1000, 2000, 3000, 5000, 6000, 10000, 12000, 15000, 20000, 30000, 60000];

/** 纯函数：百分位（线性插值）。
 *  @param {number[]} sortedAsc 升序数组
 *  @param {number} p **0~1 的小数**（0.5 / 0.95 / 0.99），不是 0~100；越界钳制到 [0,1]
 *  @returns {number} 空数组返回 0，单元素返回它自己 */
export function percentile(sortedAsc, p) {
  if (!Array.isArray(sortedAsc) || sortedAsc.length === 0) return 0;
  const n = sortedAsc.length;
  if (n === 1) return sortedAsc[0];
  const idx = clamp01(p) * (n - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

/** 直方图估算百分位：整档跳过直到命中档，档内按 (idx-cum+1)/(count+1) 插值。
 *  上界取 min(档上界, 实测 max)：样本全挤在一档时（如全部 12ms 落在 10~20 档）结果不会超过实际
 *  观测到的最大值，避免凭空造出比真实请求还慢的数字。 */
function histPercentile(hist, total, p, maxMs) {
  if (total <= 0) return 0;
  if (total === 1) return maxMs; // 只有 1 个样本时 max 就是精确值
  const idx = clamp01(p) * (total - 1);
  let cum = 0;
  for (let i = 0; i < HIST_SLOTS; i += 1) {
    const c = hist[i];
    if (c <= 0) continue;
    if (cum + c > idx) {
      const lo = i === 0 ? 0 : HIST_BOUNDS[i - 1];
      const top = i < HIST_BOUNDS.length ? HIST_BOUNDS[i] : Number.POSITIVE_INFINITY;
      return lo + (Math.max(lo, Math.min(top, maxMs)) - lo) * clamp01((idx - cum + 1) / (c + 1));
    }
    cum += c;
  }
  return maxMs;
}

/** 延迟毫秒 → 档号（二分；19 条边界，溢出档 19） */
function binIndex(ms) {
  let lo = 0, hi = HIST_BOUNDS.length - 1, ans = HIST_BOUNDS.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ms < HIST_BOUNDS[mid]) { ans = mid; hi = mid - 1; } else { lo = mid + 1; }
  }
  return ans;
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > 1 ? 1 : n;
}

/** 比率：分母 0 时返回 0（绝不允许 NaN 流到 HTTP 响应里）；保留 4 位小数 */
const rate = (num, den) => (den > 0 ? Math.round((num / den) * 1e4) / 1e4 : 0);

/** 保留 digits 位小数 */
const round = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;

/** 桶号数组：-1 = 空桶。必须 Float64 —— bucketId 是绝对值（100ms 桶下约 1.7e10），Int32 会溢出
 *  成负数，导致整窗被判定过期、快照恒为 0。 */
const newIds = (count) => new Float64Array(count).fill(-1);

/** 选桶宽与桶数：桶宽 ≤ windowMs/6（取最大可行值以省内存），再加最多一倍的分钟缓冲桶 */
function planBuckets(windowMs) {
  const target = windowMs / MIN_BUCKETS;
  let bucketMs = BUCKET_CHOICES[0];
  for (const c of BUCKET_CHOICES) if (c <= target) bucketMs = c;
  const base = Math.max(MIN_BUCKETS, Math.ceil(windowMs / bucketMs));
  return { bucketMs, count: Math.min(MAX_BUCKETS, base + Math.min(base, Math.floor(MINUTE_MS / bucketMs))) };
}

/**
 * 创建内存滑窗注册表。
 * @param {{windowMs?: number, maxRoutes?: number, now?: () => number}} [opts]
 *   windowMs 默认 60000；maxRoutes 默认 300；now 仅测试注入
 * @returns {{record: Function, snapshot: Function, takeMinuteBuckets: Function, reset: Function}}
 */
export function createRegistry(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const maxRoutes = Math.max(1, Math.floor(Number(opts.maxRoutes) || DEFAULT_MAX_ROUTES));
  const windowMsCfg = Math.max(1, Math.floor(Number(opts.windowMs) || DEFAULT_WINDOW_MS));
  const { bucketMs, count } = planBuckets(windowMsCfg);
  const retentionMs = count * bucketMs; // 桶覆盖的总时长（窗口上限）
  const entries = new Map(); // key = `${METHOD} ${route}`
  const droppedKeys = new Set(); // 被挤进 __other__ 的原始 key，size 即 droppedRoutes
  const scratchHist = new Int32Array(HIST_SLOTS); // 快照复用，避免每次 new 数组

  function makeEntry(route, method) {
    return { route, method, slots: new Int32Array(count * PER_BUCKET), ids: newIds(count) };
  }

  /** 取或建条目；超过 maxRoutes 的新路由归到 __other__（按 method 分别聚合） */
  function obtain(route, method) {
    const key = `${method} ${route}`;
    const found = entries.get(key);
    if (found) return found;
    if (entries.size < maxRoutes || route === OTHER_ROUTE) {
      const fresh = makeEntry(route, method);
      entries.set(key, fresh);
      return fresh;
    }
    // 只统计「有多少条不同路由被丢」：同一 key 重复打进来不重复计数；集合本身有上限，
    // 否则随机路径就能把这本账撑成内存泄漏（报告值最多 DROPPED_KEYS_CAP）。
    if (!droppedKeys.has(key) && droppedKeys.size < DROPPED_KEYS_CAP) droppedKeys.add(key);
    const otherKey = `${method} ${OTHER_ROUTE}`;
    const other = entries.get(otherKey);
    if (other) return other;
    const fresh = makeEntry(OTHER_ROUTE, method);
    entries.set(otherKey, fresh);
    return fresh;
  }

  /**
   * 记一次请求。O(1)：一次 Map 查找 + 环形槽位判断 + 二分开档，不做任何遍历。
   * @param {string} route 已归一化模板；@param {string} method 自动大写
   * @param {number} statusCode 状态码（非 4xx/5xx 只计 calls）
   * @param {number} durationMs 延迟毫秒
   * @returns {void}
   */
  function record(route, method, statusCode, durationMs) {
    const entry = obtain(String(route || '/'), String(method || 'GET').toUpperCase());
    const status = Number(statusCode) || 0;
    const raw = Number(durationMs);
    const ms = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0;

    const bucketId = Math.floor(now() / bucketMs);
    const pos = ((bucketId % count) + count) % count; // 负时间也只落合法槽位
    const base = pos * PER_BUCKET;
    const { slots, ids } = entry;
    if (ids[pos] !== bucketId) {
      ids[pos] = bucketId; // 环形复用：换新桶前整块清零，杜绝上上窗口残留
      slots.fill(0, base, base + PER_BUCKET);
    }
    slots[base + S_CALLS] += 1;
    if (status >= 400 && status < 500) slots[base + S_ERR4XX] += 1;
    else if (status >= 500 && status < 600) slots[base + S_ERR5XX] += 1;
    if (ms > slots[base + S_MAX]) slots[base + S_MAX] = ms;
    slots[base + S_HIST + binIndex(ms)] += 1;
  }

  /**
   * 当前窗口快照。窗口按桶对齐，最多多算不到一个桶宽的数据。
   * @param {{windowMs?: number, limit?: number}} [snapOpts] windowMs 超 retention 自动钳制；
   *   limit 缺省返回全部（基数已被 maxRoutes 兜住）
   * @returns {object} {windowMs,totalCalls,totalErrors5xx,totalErrors4xx,errorRate,qps,routes,
   *   slowest,errorTop,droppedRoutes}
   */
  function snapshot(snapOpts = {}) {
    const asked = Number(snapOpts && snapOpts.windowMs);
    const windowMs = Math.min(retentionMs, Math.max(1, Math.floor(Number.isFinite(asked) && asked > 0 ? asked : windowMsCfg)));
    const minBucketId = Math.floor((now() - windowMs) / bucketMs);
    const askedLimit = Number(snapOpts && snapOpts.limit);
    const limit = Number.isFinite(askedLimit) && askedLimit > 0 ? Math.floor(askedLimit) : Number.MAX_SAFE_INTEGER;
    const seconds = windowMs / 1000;
    const routes = [];
    let totalCalls = 0, totalErrors4xx = 0, totalErrors5xx = 0;

    for (const entry of entries.values()) {
      const { slots, ids } = entry;
      scratchHist.fill(0);
      let calls = 0, e4 = 0, e5 = 0, max = 0;
      for (let p = 0; p < count; p += 1) {
        if (ids[p] < minBucketId) continue; // 过期桶（含 ids=-1 的空桶）跳过
        const base = p * PER_BUCKET;
        const c = slots[base + S_CALLS];
        if (c === 0) continue;
        calls += c;
        e4 += slots[base + S_ERR4XX];
        e5 += slots[base + S_ERR5XX];
        const m = slots[base + S_MAX];
        if (m > max) max = m;
        for (let i = 0; i < HIST_SLOTS; i += 1) scratchHist[i] += slots[base + S_HIST + i];
      }
      if (calls === 0) continue; // 窗口内无流量的路由不占快照体积
      totalCalls += calls;
      totalErrors4xx += e4;
      totalErrors5xx += e5;
      routes.push({
        route: entry.route, method: entry.method, calls, err4xx: e4, err5xx: e5,
        // 4xx 也算错，但与 5xx **分开**给：前端自己决定展示「真故障」还是「参数写错」
        errorRate: rate(e4 + e5, calls),
        qps: round(calls / seconds, 2),
        p50: round(histPercentile(scratchHist, calls, 0.5, max), 2),
        p95: round(histPercentile(scratchHist, calls, 0.95, max), 2),
        p99: round(histPercentile(scratchHist, calls, 0.99, max), 2),
        max,
      });
    }

    routes.sort((a, b) => b.calls - a.calls || a.route.localeCompare(b.route));
    const slowest = routes.slice().sort((a, b) => b.p95 - a.p95 || b.calls - a.calls).slice(0, 10);
    const errorTop = routes.filter((r) => r.err5xx > 0).slice()
      .sort((a, b) => b.err5xx - a.err5xx || b.errorRate - a.errorRate).slice(0, 10);

    return {
      windowMs, totalCalls, totalErrors5xx, totalErrors4xx,
      errorRate: rate(totalErrors4xx + totalErrors5xx, totalCalls),
      qps: round(totalCalls / seconds, 2),
      routes: routes.slice(0, limit),
      slowest,
      errorTop,
      droppedRoutes: droppedKeys.size,
    };
  }

  /**
   * 取走**已结束**分钟的聚合（供 api-store 落库），取走即清零，避免重复落库。
   * 只返回 minuteStart < floor(nowMs/60000)*60000 的分钟，本分钟数据保持原样。调用方至少每分钟
   * 调一次（桶只保留 window+分钟缓冲，落后太多会被环形覆盖）；被取走的分钟同时退出内存窗口，
   * 所以历史窗口统计以落库数据为准。
   * @param {number} [nowMs] 时钟（测试注入）
   * @returns {Array<object>} [{bucketMs,route,method,calls,err4xx,err5xx,p50,p95,p99,max}]
   */
  function takeMinuteBuckets(nowMs = now()) {
    const currentMinute = Math.floor(Number(nowMs) / MINUTE_MS) * MINUTE_MS;
    const out = [];
    for (const entry of entries.values()) {
      const { slots, ids } = entry;
      const byMinute = new Map();
      for (let p = 0; p < count; p += 1) {
        const id = ids[p];
        if (id < 0) continue;
        const minuteMs = Math.floor((id * bucketMs) / MINUTE_MS) * MINUTE_MS;
        if (minuteMs >= currentMinute) continue; // 本分钟还没结束，不许落库
        let agg = byMinute.get(minuteMs);
        if (!agg) {
          agg = { calls: 0, e4: 0, e5: 0, max: 0, hist: new Int32Array(HIST_SLOTS) };
          byMinute.set(minuteMs, agg);
        }
        const base = p * PER_BUCKET;
        agg.calls += slots[base + S_CALLS];
        agg.e4 += slots[base + S_ERR4XX];
        agg.e5 += slots[base + S_ERR5XX];
        const m = slots[base + S_MAX];
        if (m > agg.max) agg.max = m;
        for (let i = 0; i < HIST_SLOTS; i += 1) agg.hist[i] += slots[base + S_HIST + i];
        slots.fill(0, base, base + PER_BUCKET); // 取走即清零
        ids[p] = -1;
      }
      for (const [minuteMs, agg] of byMinute) {
        if (agg.calls === 0) continue;
        out.push({
          bucketMs: minuteMs, route: entry.route, method: entry.method,
          calls: agg.calls, err4xx: agg.e4, err5xx: agg.e5,
          p50: round(histPercentile(agg.hist, agg.calls, 0.5, agg.max), 2),
          p95: round(histPercentile(agg.hist, agg.calls, 0.95, agg.max), 2),
          p99: round(histPercentile(agg.hist, agg.calls, 0.99, agg.max), 2),
          max: agg.max,
        });
      }
    }
    out.sort((a, b) => a.bucketMs - b.bucketMs || a.route.localeCompare(b.route));
    return out;
  }

  /** 清空全部状态（测试 / 热重载用） */
  function reset() {
    entries.clear();
    droppedKeys.clear();
  }

  return { record, snapshot, takeMinuteBuckets, reset };
}