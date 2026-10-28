/**
 * concurrency.js — 并发控制小工具（不引第三方依赖）。
 *
 * 为什么需要：1000 台服务器时，所有「对每台机器做一件事」的循环都必须有并发上限，
 * 否则会同时开出上千个 SSH exec / Docker API 请求，把事件循环和远端 sshd 一起打满。
 *
 * 提供两个东西：
 *   mapLimit(items, limit, fn)  —— 分批并发执行，保持结果顺序
 *   createLimiter(limit)        —— 可复用的信号量（用于分散在不同代码路径的任务）
 */

/**
 * 分批并发执行，结果顺序与 items 一致。
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit 并发上限（<=0 视为 1）
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  const size = Math.max(1, Math.floor(Number(limit) || 1));
  const results = new Array(list.length);
  let next = 0;

  async function worker() {
    for (;;) {
      const index = next++;
      if (index >= list.length) return;
      results[index] = await fn(list[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(size, list.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * 简单信号量：同时最多 limit 个任务。
 * run(fn) 会在有空位时执行 fn，返回其结果。
 */
export function createLimiter(limit) {
  const size = Math.max(1, Math.floor(Number(limit) || 1));
  let active = 0;
  const waiting = [];

  const next = () => {
    if (active >= size || waiting.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = waiting.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };

  return {
    run(fn) {
      return new Promise((resolve, reject) => {
        waiting.push({ fn, resolve, reject });
        next();
      });
    },
    get active() { return active; },
    get pending() { return waiting.length; },
    get limit() { return size; },
  };
}

export default { mapLimit, createLimiter };
