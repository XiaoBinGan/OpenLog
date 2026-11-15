/**
 * 保留期分层 —— 原始数据保留短，降采样保留长。
 *
 * 为什么必须做：Prometheus 15 秒抓一次，一台机器 ~200 条序列，
 * 一天就是 1.15M 个点，7 天 8M。如果 64 核机器 + 20 台被监控，
 * 一个月就到几亿点 —— SQLite 撑不住，PG 也会慢。
 *
 * 但运维真正关心的是「上个季度磁盘什么时候涨上来的」这种粗粒度问题，
 * 不需要 15 秒精度。所以：
 *
 *   raw        15s 精度，保留 7 天（可配）
 *   downsample 5m 精度（每 20 个原始点聚合成 1 个），保留 90 天（可配）
 *
 * 聚合用 **max + avg + min + count** 四个值而不是只存一个平均值：
 * 只留 avg 会把「CPU 瞬间打满」这种尖峰抹平 —— 而那恰恰是排查时最想看的。
 * 四个值多占 4 倍空间，但比原始点少 20 倍，净省 5 倍。
 *
 * 存储方式：降采样结果也存在 ts_sample 里，但用独立的序列
 * （指标名加 `:5m` 后缀 + 标签里标记聚合方式）。这样不用改表结构，
 * 现有的查询路径直接能用，用户写 `openlog_cpu_usage_percent:5m_max` 就能查到。
 */

/** 默认的降采样档位 */
export const DEFAULT_TIERS = [
  { resolutionMs: 5 * 60_000, retentionDays: 90, sourceRetentionDays: 7 },
];

/** 聚合方式：四个值各存一条序列 */
export const AGGREGATIONS = ['max', 'min', 'avg', 'count'];

/**
 * 给降采样序列生成指标名。
 * `openlog_cpu_usage_percent` + `5m` + `max` → `openlog_cpu_usage_percent:5m_max`
 */
export function downsampledName(baseName, resolutionMs, agg) {
  return `${baseName}:${formatResolution(resolutionMs)}_${agg}`;
}

/** 把分辨率毫秒转成 Prometheus 风格的短写（300000 → 5m） */
export function formatResolution(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '0s';
  if (n % 3_600_000 === 0) return `${n / 3_600_000}h`;
  if (n % 60_000 === 0) return `${n / 60_000}m`;
  if (n % 1000 === 0) return `${n / 1000}s`;
  return `${n}ms`;
}

/**
 * 从降采样指标名反解出基名（用于「查不到时提示可以用哪个粗粒度指标」）。
 */
export function parseDownsampledName(name) {
  const m = /^(.+):(\d+[smh])_(max|min|avg|count)$/.exec(String(name));
  if (!m) return null;
  return { baseName: m[1], resolution: m[2], aggregation: m[3] };
}

/**
 * 把一个时间桶内的原始点聚合成一个值。
 * @param {Array<{ts:number, value:number}>} points
 * @param {string} agg
 */
export function aggregate(points, agg) {
  const vals = (points || []).map((p) => Number(p.value)).filter((v) => Number.isFinite(v));
  if (vals.length === 0) return null;
  switch (agg) {
    case 'max': return Math.max(...vals);
    case 'min': return Math.min(...vals);
    case 'avg': return vals.reduce((a, b) => a + b, 0) / vals.length;
    case 'count': return vals.length;
    case 'sum': return vals.reduce((a, b) => a + b, 0);
    default: return null;
  }
}

/**
 * 把一批序列按分辨率分桶聚合。
 *
 * @param {Array<{name:string, labels:Object, points:Array<{ts:number,value:number}>}>} series
 * @param {number} resolutionMs 桶宽
 * @param {Array<string>} [aggs] 要产出哪些聚合
 * @returns {Array<{name:string, labels:Object, value:number, timestamp:number}>} 可直接写入的样本
 */
export function downsampleSeries(series, resolutionMs, aggs = AGGREGATIONS) {
  const res = Number(resolutionMs);
  if (!Number.isFinite(res) || res <= 0) return [];
  const out = [];

  for (const s of series || []) {
    if (!s || !s.name || !Array.isArray(s.points) || s.points.length === 0) continue;

    // 按桶归组：桶下界 = floor(ts / res) * res，保证同一时刻总是同一个桶
    const buckets = new Map();
    for (const p of s.points) {
      const ts = Number(p.ts);
      const value = Number(p.value);
      if (!Number.isFinite(ts) || !Number.isFinite(value)) continue;
      const bucket = Math.floor(ts / res) * res;
      if (!buckets.has(bucket)) buckets.set(bucket, []);
      buckets.get(bucket).push({ ts, value });
    }

    for (const [bucket, pts] of buckets) {
      for (const agg of aggs) {
        const v = aggregate(pts, agg);
        if (v === null || !Number.isFinite(v)) continue;
        out.push({
          name: downsampledName(s.name, res, agg),
          labels: { ...(s.labels || {}) },
          value: v,
          timestamp: bucket,
        });
      }
    }
  }

  return out;
}

/**
 * 创建分层保留管理器。
 *
 * @param {object} deps
 * @param {object} deps.store TSDB store
 * @param {() => number} [deps.now]
 * @param {(msg:string) => void} [deps.log]
 */
export function createTieredRetention(deps = {}) {
  const store = deps.store;
  const now = deps.now || (() => Date.now());
  const log = deps.log || ((m) => console.log(`[TSDB/Retention] ${m}`));

  /**
   * 跑一轮降采样 + 清理。
   *
   * 顺序很重要：**先降采样再删原始数据**。
   * 反过来会出现「原始已删、降采样还没算出来」的空洞 —— 那段历史永久丢失。
   *
   * 窗口为什么是自适应而不是固定一天：如果进程停了几天（升级、故障），
   * 固定窗口只会处理「刚好要过期的那一天」，剩下的会直接被删掉 ——
   * 那正是最需要粗粒度历史的时候。这里从**最老的原始点**开始，
   * 按 batchDays 分块往后推进，直到追上 sourceCutoff。
   *
   * 每轮最多推 maxChunks 块：一次跑完几个月的降采样会把 DB 锁住很久，
   * 分几轮跑完结果一样，但对线上影响小得多。
   *
   * @param {Array<{resolutionMs:number, retentionDays:number, sourceRetentionDays:number}>} tiers
   * @param {{rawRetentionDays?:number, batchDays?:number, maxChunks?:number}} [opts]
   */
  async function run(tiers = DEFAULT_TIERS, opts = {}) {
    const t = now();
    const batchDays = Number(opts.batchDays) > 0 ? Number(opts.batchDays) : 1;
    const maxChunks = Number(opts.maxChunks) > 0 ? Number(opts.maxChunks) : 30;
    const rawRetentionDays = Number(opts.rawRetentionDays) > 0 ? Number(opts.rawRetentionDays) : 7;
    const result = { tiers: [], rawDeleted: 0, tierDeleted: 0, downsampleWritten: 0, chunks: 0, errors: [] };

    for (const tier of tiers) {
      const res = Number(tier.resolutionMs);
      if (!Number.isFinite(res) || res <= 0) { result.errors.push(`非法分辨率: ${tier.resolutionMs}`); continue; }

      const sourceDays = Number(tier.sourceRetentionDays) > 0 ? Number(tier.sourceRetentionDays) : rawRetentionDays;
      const sourceCutoff = t - sourceDays * 86_400_000;

      let written = 0;
      let chunks = 0;

      // 起点：优先用已降采样到的水位线，没有才从最老的原始点开始。
      //
      // 为什么必须用水位线：降采样没追平时**不能删原始数据**（否则丢历史），
      // 而原始数据不删，下一轮的「最老原始点」还是同一个 ——
      // 只按最老点算起点的话，每轮都在重复处理同一段，永远推进不了。
      let cursor;
      try {
        const oldest = await store.oldestRawTimestamp();
        // 没有原始数据 → 没什么可降采样的，直接进入清理阶段。
        // 不能因为「有旧的降采样数据」就把 cursor 卡在很久以前 ——
        // 那会让清理永远等一个不存在的降采样任务。
        if (oldest === null || oldest === undefined) {
          result.tiers.push({ resolutionMs: res, written: 0, chunks: 0, reachedCutoff: true });
          continue;
        }
        const watermark = await store.downsampledWatermark(formatResolution(res));
        cursor = watermark !== null && watermark !== undefined && watermark > oldest ? watermark : oldest;
      } catch (err) {
        result.errors.push(`读取水位线失败: ${String(err?.message || err)}`);
        continue;
      }

      while (cursor < sourceCutoff && chunks < maxChunks) {
        const from = cursor;
        const to = Math.min(cursor + batchDays * 86_400_000, sourceCutoff);
        try {
          const raw = await store.queryRange({ start: from, end: to, limit: 500_000 });
          if (raw.error) { result.errors.push(`读取失败: ${raw.error}`); break; }

          // 排除已经是降采样产物的指标（避免二次降采样）
          const originals = raw.series.filter((s) => !parseDownsampledName(s.name));
          const samples = downsampleSeries(originals, res);
          if (samples.length) {
            const w = await store.writeSamples(samples, { timestamp: to });
            written += w.written || 0;
            if (w.error) result.errors.push(`降采样写入失败: ${w.error}`);
          }
        } catch (err) {
          result.errors.push(`降采样异常: ${String(err?.message || err)}`);
          break;
        }
        cursor = to;
        chunks += 1;
        // from === to 说明这个批次的边界没有推进，防止死循环
        if (to <= from) break;
      }

      result.downsampleWritten += written;
      result.chunks += chunks;
      result.tiers.push({ resolutionMs: res, written, chunks, reachedCutoff: cursor >= sourceCutoff });
    }

    // 只有当**所有**档位都追上了 sourceCutoff，才允许删原始数据。
    // 否则「降采样还没做完就把原始删了」会丢掉还没处理的那段历史。
    const allCaughtUp = result.tiers.length > 0 && result.tiers.every((x) => x.reachedCutoff !== false);
    if (!allCaughtUp) {
      result.rawDeletedSkipped = '降采样尚未追平，本轮不删原始数据';
      return finish(result);
    }

    const rawCutoff = t - rawRetentionDays * 86_400_000;
    try {
      const r = await store.pruneSamplesBefore(rawCutoff);
      result.rawDeleted = r.deleted || 0;
      if (result.rawDeleted > 0) {
        log(`清理原始数据 ${result.rawDeleted} 个点（早于 ${new Date(rawCutoff).toISOString()}）`);
      }
    } catch (err) {
      result.errors.push(`清理原始数据失败: ${String(err?.message || err)}`);
    }

    // 再按各档位的保留期清理降采样数据
    for (const tier of tiers) {
      const res = Number(tier.resolutionMs);
      const keepDays = Number(tier.retentionDays) > 0 ? Number(tier.retentionDays) : 90;
      const cutoff = t - keepDays * 86_400_000;
      try {
        const r = await store.pruneDownsampledBefore(res, cutoff);
        result.tierDeleted += r.deleted || 0;
      } catch (err) {
        result.errors.push(`清理降采样失败(${formatResolution(res)}): ${String(err?.message || err)}`);
      }
    }

    return finish(result);
  }

  /** 收尾：清理孤立序列 */
  async function finish(result) {
    try {
      const orphans = await store.pruneOrphanSeries();
      result.orphansDeleted = orphans.deleted || 0;
    } catch (err) {
      result.errors.push(`清理孤立序列失败: ${String(err?.message || err)}`);
    }
    return result;
  }

  return { run };
}