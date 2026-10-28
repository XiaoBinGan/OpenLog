/**
 * stats-scheduler.js — 服务端集中采集远程服务器状态（替代前端 1000 路扇出）。
 *
 * 旧做法：算力监控页每 30s 对**每台**已连接服务器发 2 个请求（stats + mfu），
 * 用 `Promise.all` 无并发上限。1000 台 = 每 30s 2000 个并发请求 → 服务端
 * 对应 2000 次 SSH exec；浏览器和 Node 事件循环一起崩。
 *
 * 新做法：服务端定时、限并发地采集，结果进内存缓存；前端只发**一个**请求拿全量快照。
 *   - 并发上限可配（默认 16），采集一轮的真实耗时 = 服务器数 × 单次耗时 / 并发
 *   - 间隔自适应：一轮跑太久就自动拉长间隔，避免任务堆积（不重叠执行）
 *   - 单台失败只标记该台 error，不影响整批
 *   - MFU 单独低频采集（默认 60s），且只采「上一轮 stats 里发现 GPU」的机器
 *
 * 纯逻辑 + 注入依赖，便于单测。
 */

export const DEFAULT_STATS_INTERVAL_MS = 30_000;
export const DEFAULT_MFU_INTERVAL_MS = 60_000;
export const DEFAULT_CONCURRENCY = 16;
/** 缓存多久算过期（前端请求时可触发即时刷新） */
export const DEFAULT_FRESH_MS = 10_000;
/** 一轮超过间隔的这个比例就自动放宽间隔（避免 tick 堆积） */
export const OVERRUN_FACTOR = 1.5;

/**
 * @param {object} deps
 * @param {() => Array<{id:string,status:string,name:string}>} deps.getServers
 * @param {(id:string) => Promise<object>} deps.getStats
 * @param {(id:string) => Promise<object>} [deps.getMfu]
 * @param {(snapshot:object) => void} [deps.onSnapshot] 每轮采集完成回调（可用来 WS 广播）
 * @param {number} [deps.intervalMs]
 * @param {number} [deps.mfuIntervalMs]
 * @param {number} [deps.concurrency]
 * @param {() => number} [deps.now]
 */
export function createStatsScheduler({
  getServers, getStats, getMfu,
  onSnapshot,
  intervalMs = DEFAULT_STATS_INTERVAL_MS,
  mfuIntervalMs = DEFAULT_MFU_INTERVAL_MS,
  concurrency = DEFAULT_CONCURRENCY,
  now = Date.now,
} = {}) {
  /** id → { stats, statsAt, statsError, mfu, mfuAt } */
  const cache = new Map();
  let timer = null;
  let mfuTimer = null;
  let running = false;
  let mfuRunning = false;
  let effectiveInterval = intervalMs;
  let lastPass = null; // { startedAt, durationMs, total, ok, failed }

  /** 当前需要采集的 id（只采已连接的） */
  function connectedIds() {
    return (getServers() || []).filter(s => s.status === 'connected').map(s => s.id);
  }

  /** 从批量结果里读一台机器（含缓存时间） */
  function get(id) {
    const entry = cache.get(id);
    if (!entry) return null;
    return {
      stats: entry.stats,
      statsAt: entry.statsAt,
      statsError: entry.statsError,
      mfu: entry.mfu || null,
      mfuAt: entry.mfuAt || null,
    };
  }

  /** 是否新鲜 */
  function isFresh(id, freshMs = DEFAULT_FRESH_MS) {
    const entry = cache.get(id);
    return Boolean(entry && entry.statsAt && now() - entry.statsAt < freshMs);
  }

  /**
   * 采集一批服务器（限并发）。
   * @param {string[]} ids
   * @returns {Promise<{ok:number, failed:number, durationMs:number}>}
   */
  async function collect(ids) {
    if (!ids.length) return { ok: 0, failed: 0, durationMs: 0 };
    const startedAt = now();
    let ok = 0;
    let failed = 0;
    // 手动分批并发：不引第三方依赖
    const size = Math.max(1, Math.floor(concurrency) || 1);
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const idx = cursor++;
        if (idx >= ids.length) return;
        const id = ids[idx];
        try {
          const stats = await getStats(id);
          cache.set(id, { ...(cache.get(id) || {}), stats, statsAt: now(), statsError: null });
          ok += 1;
        } catch (err) {
          failed += 1;
          cache.set(id, {
            ...(cache.get(id) || {}),
            statsAt: now(),
            statsError: err?.message || String(err),
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(size, ids.length) }, () => worker()));
    return { ok, failed, durationMs: now() - startedAt };
  }

  /** 采集一轮 stats（不重叠） */
  async function pass() {
    if (running) return lastPass;
    running = true;
    try {
      const ids = connectedIds();
      const res = await collect(ids);
      lastPass = { startedAt: now() - res.durationMs, ...res, total: ids.length };
      // 自适应：一轮耗时超过间隔的 1.5 倍 → 放宽间隔，避免 tick 越积越多
      if (res.durationMs > effectiveInterval * OVERRUN_FACTOR) {
        effectiveInterval = Math.min(res.durationMs * 2, 5 * 60 * 1000);
        console.warn(
          `[Stats] 一轮采集 ${res.durationMs}ms 超过间隔，自动放宽到 ${effectiveInterval}ms（${ids.length} 台，并发 ${concurrency}）`,
        );
        restartTimer();
      }
      if (onSnapshot) {
        try { onSnapshot(snapshot()); } catch { /* 广播失败不影响采集 */ }
      }
      return lastPass;
    } finally {
      running = false;
    }
  }

  /** 采集一轮 MFU：只采「stats 里发现 GPU」的机器（MFU 本身有采样缓存） */
  async function mfuPass() {
    if (mfuRunning || !getMfu) return null;
    mfuRunning = true;
    try {
      const ids = connectedIds().filter(id => {
        const stats = cache.get(id)?.stats;
        return Array.isArray(stats?.gpus) && stats.gpus.length > 0;
      });
      if (!ids.length) return null;
      const startedAt = now();
      await collectMfu(ids);
      return { total: ids.length, durationMs: now() - startedAt };
    } finally {
      mfuRunning = false;
    }
  }

  async function collectMfu(ids) {
    const size = Math.max(1, Math.floor(concurrency) || 1);
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const idx = cursor++;
        if (idx >= ids.length) return;
        const id = ids[idx];
        try {
          const mfu = await getMfu(id);
          cache.set(id, { ...(cache.get(id) || {}), mfu, mfuAt: now() });
        } catch { /* 单台 MFU 失败忽略 */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(size, ids.length) }, () => worker()));
  }

  function restartTimer() {
    if (timer) clearInterval(timer);
    timer = setInterval(() => { pass().catch(() => {}); }, effectiveInterval);
    if (timer.unref) timer.unref();
  }

  function start() {
    if (timer) return;
    restartTimer();
    if (getMfu) {
      mfuTimer = setInterval(() => { mfuPass().catch(() => {}); }, mfuIntervalMs);
      if (mfuTimer.unref) mfuTimer.unref();
      // 首轮 stats 采完才知道哪些机器有 GPU，等 10s 再采一次 MFU，
      // 否则页面头 60s 里 MFU 一直是空的（用户以为坏了）
      const firstMfu = setTimeout(() => { mfuPass().catch(() => {}); }, 10_000);
      if (firstMfu.unref) firstMfu.unref();
    }
    pass().catch(() => {});
    console.log(`[Stats] 集中采集已启动（间隔 ${effectiveInterval}ms，并发 ${concurrency}，MFU ${getMfu ? `${mfuIntervalMs}ms` : '关闭'}）`);
  }

  function stop() {
    if (timer) clearInterval(timer);
    if (mfuTimer) clearInterval(mfuTimer);
    timer = null;
    mfuTimer = null;
  }

  /** 全量快照（前端一次请求拿所有机器） */
  function snapshot() {
    const servers = (getServers() || []).filter(s => s.status === 'connected');
    return {
      servers: servers.map(s => {
        const entry = cache.get(s.id);
        return {
          serverId: s.id,
          serverName: s.name,
          stats: entry?.stats ?? null,
          statsAt: entry?.statsAt ?? null,
          statsError: entry?.statsError ?? null,
          mfu: entry?.mfu ?? null,
          mfuAt: entry?.mfuAt ?? null,
        };
      }),
      meta: {
        total: servers.length,
        intervalMs: effectiveInterval,
        concurrency,
        lastPass,
        collectedAt: now(),
      },
    };
  }

  /** 按需拉一批（前端指定 id 且缓存不新鲜时） */
  async function ensure(ids, freshMs = DEFAULT_FRESH_MS) {
    const need = (ids || []).filter(id => !isFresh(id, freshMs));
    if (need.length) await collect(need);
    return (ids || []).map(id => ({ serverId: id, ...(get(id) || {}) }));
  }

  /** 测试用：清空缓存 */
  function _reset() {
    cache.clear();
    lastPass = null;
    effectiveInterval = intervalMs;
  }

  return {
    start, stop, pass, mfuPass, snapshot, get, ensure, isFresh, _reset,
    get lastPass() { return lastPass; },
    get effectiveInterval() { return effectiveInterval; },
    get cacheSize() { return cache.size; },
  };
}

export default createStatsScheduler;
