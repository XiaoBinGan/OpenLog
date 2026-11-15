/**
 * 接口指标 → 时序库桥接。
 *
 * 为什么需要：`api_metrics_minute` 表已经有 QPS / 延迟 / 错误率，
 * 但它只用于界面展示 —— 没有告警、没有 PromQL 查询。
 * 时序库就绪之后，把同一份数据再写成指标，用户就能写
 * `sum(rate(openlog_api_requests_5xx_total[5m])) / sum(rate(openlog_api_requests_total[5m])) > 0.05`。
 *
 * 命名遵循 Prometheus 惯例（不自创）：
 *   · counter 以 `_total` 结尾
 *   · 单位进名字，且**时间用秒**而不是毫秒
 *   · 分位数是同一个指标的 `quantile` 标签，不是四个不同指标名
 * 这样 Grafana 里现成的 API 延迟面板能直接套。
 */

/**
 * 把一批 api_metrics_minute 桶转成时序样本。
 *
 * @param {Array<{bucketMs:number, route:string, method:string, calls:number,
 *                err4xx:number, err5xx:number, p50Ms?:number|null,
 *                p95Ms?:number|null, p99Ms?:number|null, maxMs?:number|null}>} buckets
 * @param {object} [opts]
 * @param {string} [opts.prefix] 指标名前缀，默认 `openlog_api`
 * @returns {Array<{name:string, labels:Object, value:number, timestamp:number}>}
 */
export function apiBucketsToSamples(buckets, opts = {}) {
  const prefix = opts.prefix || 'openlog_api';
  const out = [];
  const list = Array.isArray(buckets) ? buckets : [];

  for (const b of list) {
    if (!b) continue;
    const ts = Number(b.bucketMs ?? b.bucket_ms);
    if (!Number.isFinite(ts)) continue;

    // 标签基数控制：route 用的是 route-pattern.js 归一化过的模板
    // （`/api/users/:id` 而不是 `/api/users/12345`），否则每个 ID 都成一条序列
    const labels = {
      route: String(b.route ?? ''),
      method: String(b.method ?? 'GET').toUpperCase(),
    };

    const push = (name, value, extra) => {
      // 先挡住 null / undefined / 空串：Number(null) === 0，直接走 Number()
      // 会把「该分钟没有请求」写成「响应时间 0 秒」—— 那是个假值，
      // 会让 P99 面板出现一条贴地的直线，排查时极具误导性。
      if (value === null || value === undefined || value === '') return;
      const v = Number(value);
      if (!Number.isFinite(v)) return;
      out.push({ name, labels: { ...labels, ...(extra || {}) }, value: v, timestamp: ts });
    };

    push(`${prefix}_requests_total`, b.calls);
    push(`${prefix}_requests_4xx_total`, b.err4xx);
    push(`${prefix}_requests_5xx_total`, b.err5xx);

    // 延迟：毫秒 → 秒。分位数用 quantile 标签，
    // 这样 `histogram_quantile` 那类通用面板也能用
    const durName = `${prefix}_request_duration_seconds`;
    const toSec = (v) => (v === null || v === undefined ? null : Number(v) / 1000);
    push(durName, toSec(b.p50Ms ?? b.p50_ms), { quantile: '0.5' });
    push(durName, toSec(b.p95Ms ?? b.p95_ms), { quantile: '0.95' });
    push(durName, toSec(b.p99Ms ?? b.p99_ms), { quantile: '0.99' });
    push(durName, toSec(b.maxMs ?? b.max_ms), { quantile: '1' });
  }

  return out;
}

/**
 * 从 api-store 的 queryRange 结果构造样本（给定时任务用）。
 *
 * @param {object} store apiStore
 * @param {{sinceMs:number, untilMs:number, limit?:number}} opts
 */
export async function collectApiMetricSamples(store, opts) {
  if (!store || typeof store.queryRange !== 'function') return [];
  const buckets = await store.queryRange({
    fromMs: opts.sinceMs,
    toMs: opts.untilMs,
    limit: Number(opts.limit) > 0 ? Number(opts.limit) : 5000,
  });
  return apiBucketsToSamples(buckets);
}

/**
 * 生成「接口监控」的推荐告警规则。
 *
 * 为什么内置一份：多数用户不知道该定什么阈值才有意义。
 * 这三条是实际用起来最能说明问题的。
 *
 * @param {string} [prefix]
 */
export function recommendedApiRules(prefix = 'openlog_api') {
  return [
    {
      alert: 'HighApiErrorRate',
      // 5 分钟内 5xx 占比超过 5%。clamp_min 防止分母为 0 时变成 Inf
      expr: `sum(rate(${prefix}_requests_5xx_total[5m])) / clamp_min(sum(rate(${prefix}_requests_total[5m])), 0.001) > 0.05`,
      for: '5m',
      labels: { severity: 'critical' },
      annotations: { summary: '接口 5xx 比例 {{ $value }} 超过 5%' },
    },
    {
      alert: 'SlowApiP99',
      expr: `${prefix}_request_duration_seconds{quantile="0.99"} > 1`,
      for: '10m',
      labels: { severity: 'warning' },
      annotations: { summary: '{{ $labels.method }} {{ $labels.route }} 的 P99 延迟 {{ $value }}s 超过 1s' },
    },
    {
      alert: 'ApiTrafficDrop',
      // 流量掉到「一小时前同期」的 10% 以下：服务可能挂了或上游断了
      expr: `sum(rate(${prefix}_requests_total[5m])) < sum(rate(${prefix}_requests_total[1h] offset 1h)) * 0.1`,
      for: '10m',
      labels: { severity: 'warning' },
      annotations: { summary: '接口流量相比一小时前下降超过 90%' },
    },
  ];
}