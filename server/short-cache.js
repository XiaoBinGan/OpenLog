/**
 * short-cache.js —— 极短 TTL 的内存缓存（几秒级），用于「多个页面/多个客户端
 * 同时拉同一个重接口」的场景。
 *
 * 为什么需要：`/api/docker/containers` 实测 224~322ms / 73KB（82 个容器），
 * 而它会被顶栏、Docker 页、远程页、以及多开标签页同时请求 —— 每次都要重新
 * 遍历所有 Docker 源（本地 dockerode + 每台远程 SSH）。加一个 3 秒缓存可以把
 * 并发尖峰合并成一次真实查询，代价是最多 3 秒的陈旧数据（容器列表本来也是准实时）。
 *
 * 设计要点：
 *   - 只缓存「成功」结果，失败不缓存（故障恢复要立刻可见）
 *   - 支持按 key 细分（不同筛选条件互不干扰）
 *   - 可显式失效（容器启停/操作后立刻刷新）
 */

/**
 * @param {{ttlMs?: number, now?: () => number, maxEntries?: number}} [opts]
 */
export function createShortCache(opts = {}) {
  const ttlMs = Math.max(100, Number(opts.ttlMs) || 3000);
  const now = opts.now || (() => Date.now());
  const maxEntries = Math.max(1, Number(opts.maxEntries) || 50);
  /** key → { value, at } */
  const store = new Map();
  let hits = 0;
  let misses = 0;

  return {
    /** 取缓存；未命中/过期返回 undefined */
    get(key) {
      const hit = store.get(key);
      if (!hit) { misses += 1; return undefined; }
      if (now() - hit.at > ttlMs) { store.delete(key); misses += 1; return undefined; }
      hits += 1;
      return hit.value;
    },
    /** 写缓存（成功结果才调用；超过容量时清掉最老的） */
    set(key, value) {
      store.set(key, { value, at: now() });
      if (store.size > maxEntries) {
        const oldest = [...store.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) store.delete(oldest[0]);
      }
      return value;
    },
    /** 显式失效：不传 key 清全部 */
    invalidate(key) {
      if (key === undefined) store.clear();
      else store.delete(key);
    },
    /** 统计（调试/健康检查用） */
    stats() {
      return { size: store.size, hits, misses, ttlMs };
    },
  };
}

/**
 * 包装一个异步取数函数：命中缓存直接返回，否则执行并缓存成功结果。
 *
 * @template T
 * @param {ReturnType<typeof createShortCache>} cache
 * @param {string} key
 * @param {() => Promise<T>} loader
 * @returns {Promise<T>}
 */
export async function cached(cache, key, loader) {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = await loader();
  if (value !== undefined && value !== null) cache.set(key, value);
  return value;
}
