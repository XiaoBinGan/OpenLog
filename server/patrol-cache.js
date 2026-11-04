/**
 * patrol-cache.js —— 巡检结果缓存的更新规则。
 *
 * 背景（真实 bug）：原实现是「有新结果才覆盖」——
 *   `if (results.length > 0) lastPatrolResults = results`
 * 本意是「别让空巡检把上一次有效数据冲掉」，但实际语义错了：
 * 巡检**成功**返回空，代表「这次没发现问题」，不是「没查到」。
 * 于是容器异常被修好后，旧异常会一直留在缓存里，`/api/docker/patrol/last`、
 * 健康诊断、通知列表会持续报已经不存在的异常（用户反馈过「明明没异常却说有异常」）。
 *
 * 正确规则：
 *   - 巡检成功 → 整体覆盖，**空结果也覆盖**（清掉已修复的异常）；
 *   - 巡检失败（抛异常/超时）→ 保留上一次数据（宁可留旧数据，也不要把「查不到」当成「没问题」）。
 */

/**
 * @param {Array} prev 上一次缓存
 * @param {Array} results 本次巡检结果
 * @param {{succeeded?: boolean}} [opts] 本次巡检是否成功（默认 true）
 * @returns {Array} 新的缓存
 */
export function applyPatrolResults(prev, results, opts = {}) {
  const succeeded = opts.succeeded !== false;
  if (!succeeded) return Array.isArray(prev) ? prev : [];
  return Array.isArray(results) ? results : [];
}
