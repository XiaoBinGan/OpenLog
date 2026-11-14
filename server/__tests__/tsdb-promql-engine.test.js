import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTsdbStore } from '../tsdb/store.js';
import {
  createEvaluator, rateLike, irateLike, deltaLike, derivLike,
  countChanges, countResets, histogramQuantile, quantile,
  arith, compare, labelReplace, labelJoin, labelKey, DEFAULT_LOOKBACK_MS,
} from '../tsdb/promql-engine.js';

// ────────────────── 纯函数：先测这些，它们是所有查询的地基 ──────────────────

describe('算术', () => {
  it('四则', () => {
    expect(arith('+', 2, 3)).toBe(5);
    expect(arith('-', 2, 3)).toBe(-1);
    expect(arith('*', 2, 3)).toBe(6);
    expect(arith('/', 6, 3)).toBe(2);
    expect(arith('%', 7, 3)).toBe(1);
    expect(arith('^', 2, 3)).toBe(8);
  });

  it('除以零：非零/0 = ±Inf，0/0 = NaN（Prometheus 语义）', () => {
    expect(arith('/', 1, 0)).toBe(Infinity);
    expect(arith('/', -1, 0)).toBe(-Infinity);
    expect(arith('/', 0, 0)).toBeNaN();
    expect(arith('%', 1, 0)).toBeNaN();
  });
});

describe('比较', () => {
  it('bool 模式返回 1/0', () => {
    expect(compare('>', 3, 2, true)).toBe(1);
    expect(compare('>', 2, 3, true)).toBe(0);
  });

  it('非 bool 模式返回是否满足（1/0，供过滤用）', () => {
    expect(compare('==', 2, 2, false)).toBe(1);
    expect(compare('==', 2, 3, false)).toBe(0);
  });
});

describe('quantile', () => {
  it('边界', () => {
    const v = [1, 2, 3, 4, 5];
    expect(quantile(0, v)).toBe(1);
    expect(quantile(1, v)).toBe(5);
  });

  it('中位数（线性插值）', () => {
    expect(quantile(0.5, [1, 2, 3, 4, 5])).toBe(3);
    expect(quantile(0.5, [1, 2, 3, 4])).toBe(2.5);
  });

  it('超出范围返回 ±Inf', () => {
    expect(quantile(-0.1, [1])).toBe(-Infinity);
    expect(quantile(1.1, [1])).toBe(Infinity);
  });

  it('空数组返回 NaN', () => {
    expect(quantile(0.5, [])).toBeNaN();
  });

  it('0.9 分位', () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    // rank = 0.9*9 = 8.1 → 9 + (10-9)*0.1 = 9.1
    expect(quantile(0.9, v)).toBeCloseTo(9.1, 5);
  });
});

describe('rate —— counter 的核心语义', () => {
  const pts = (...vals) => vals.map((v, i) => ({ ts: i * 10_000, value: v }));

  it('线性增长：10s 内 0→10，rate = 1/s', () => {
    expect(rateLike(pts(0, 10), 20_000, false)).toBe(1);
  });

  it('increase 返回总量而不是速率', () => {
    expect(rateLike(pts(0, 10), 20_000, true)).toBe(10);
  });

  it('**counter 重置要补上重置前的量**（否则算出负数）', () => {
    // 0 → 100 → 重置到 5 → 15
    // 真实增量 = 100 (到重置点) + 5 (重置后从0到5) + 10 = 115
    const v = rateLike(pts(0, 100, 5, 15), 30_000, true);
    expect(v).toBe(115);
    expect(v).toBeGreaterThan(0);
  });

  it('重置场景的 rate 不为负', () => {
    const v = rateLike(pts(0, 100, 5, 15), 30_000, false);
    expect(v).toBeGreaterThan(0);
  });

  it('少于两个点返回 null（不输出，而不是输出 0）', () => {
    expect(rateLike(pts(5), 10_000, false)).toBeNull();
    expect(rateLike([], 10_000, false)).toBeNull();
  });

  it('两点时间戳相同返回 null（防除零）', () => {
    expect(rateLike([{ ts: 1000, value: 1 }, { ts: 1000, value: 2 }], 1000, false)).toBeNull();
  });

  it('值时不变 → rate 为 0', () => {
    expect(rateLike(pts(5, 5, 5), 20_000, false)).toBe(0);
  });
});

describe('irate', () => {
  it('只用最后两个点', () => {
    const p = [{ ts: 0, value: 0 }, { ts: 10_000, value: 100 }, { ts: 20_000, value: 110 }];
    // 最后两点：100 → 110，10s，rate = 1/s
    expect(irateLike(p)).toBe(1);
  });

  it('不到两点返回 null', () => {
    expect(irateLike([{ ts: 0, value: 1 }])).toBeNull();
  });

  it('重置时用当前值当增量', () => {
    const p = [{ ts: 0, value: 100 }, { ts: 10_000, value: 5 }];
    expect(irateLike(p)).toBe(0.5);
  });
});

describe('delta / deriv', () => {
  const pts = (...vals) => vals.map((v, i) => ({ ts: i * 1000, value: v }));

  it('delta 是首尾差', () => {
    expect(deltaLike(pts(1, 5, 3), false)).toBe(2);
  });

  it('idelta 是最后两点差', () => {
    expect(deltaLike(pts(1, 5, 3), true)).toBe(-2);
  });

  it('deriv 是最小二乘斜率（每秒）', () => {
    // 每秒 +2
    expect(derivLike(pts(0, 2, 4, 6))).toBeCloseTo(2, 6);
  });

  it('点数不足返回 null', () => {
    expect(deltaLike(pts(1), false)).toBeNull();
    expect(derivLike(pts(1))).toBeNull();
  });
});

describe('changes / resets', () => {
  const pts = (...vals) => vals.map((v, i) => ({ ts: i * 1000, value: v }));

  it('changes 数变化次数', () => {
    expect(countChanges(pts(1, 1, 2, 2, 3))).toBe(2);
  });

  it('resets 数下降次数', () => {
    expect(countResets(pts(1, 5, 2, 8, 3))).toBe(2);
  });

  it('单点返回 0', () => {
    expect(countChanges(pts(1))).toBe(0);
    expect(countResets(pts(1))).toBe(0);
  });
});

describe('histogram_quantile', () => {
  const mk = (le, count) => ({ labels: { le: String(le) }, value: count });

  it('从累积 bucket 插值', () => {
    // 0-1: 10, 1-2: 20 (cum 30), 2-+Inf: 30 (cum 60)
    const series = [mk('1', 10), mk('2', 30), mk('+Inf', 60)];
    const r = histogramQuantile(0.5, series);
    // 目标 = 0.5 * 60 = 30 → 落在 le=2 的桶，从 prevCount=10 到 30
    expect(r.series).toHaveLength(1);
    expect(r.series[0].value).toBeGreaterThan(1);
    expect(r.series[0].value).toBeLessThanOrEqual(2);
  });

  it('按非 le 标签分组', () => {
    const series = [
      { labels: { le: '1', job: 'a' }, value: 10 },
      { labels: { le: '+Inf', job: 'a' }, value: 20 },
      { labels: { le: '1', job: 'b' }, value: 5 },
      { labels: { le: '+Inf', job: 'b' }, value: 10 },
    ];
    const r = histogramQuantile(0.5, series);
    expect(r.series).toHaveLength(2);
    for (const s of r.series) expect(s.labels.le).toBeUndefined();
  });

  it('bucket 少于 2 个不输出', () => {
    expect(histogramQuantile(0.5, [mk('1', 10)]).series).toHaveLength(0);
  });

  it('总数为 0 不输出', () => {
    expect(histogramQuantile(0.5, [mk('1', 0), mk('+Inf', 0)]).series).toHaveLength(0);
  });

  it('落在 +Inf 桶时退回上一个上界', () => {
    const series = [mk('1', 1), mk('+Inf', 100)];
    const r = histogramQuantile(0.99, series);
    expect(r.series[0].value).toBe(1);
  });
});

describe('label_replace / label_join', () => {
  const vec = (labels, value = 1) => ({ kind: 'vector', series: [{ labels, value }] });
  const str = (v) => ({ kind: 'string', value: v });

  it('label_replace 用正则捕获组替换', () => {
    const r = labelReplace([vec({ instance: 'host1:9100' }), str('host'), str('$1'), str('instance'), str('(.*):\\d+')]);
    expect(r.series[0].labels.host).toBe('host1');
    expect(r.series[0].labels.instance).toBe('host1:9100');
  });

  it('label_replace 不匹配时不动', () => {
    const r = labelReplace([vec({ instance: 'x' }), str('h'), str('$1'), str('instance'), str('(\\d+)')]);
    expect(r.series[0].labels.h).toBeUndefined();
  });

  it('label_replace 替换为空则删除标签', () => {
    const r = labelReplace([vec({ a: 'x', b: 'y' }), str('b'), str(''), str('a'), str('x')]);
    expect(r.series[0].labels.b).toBeUndefined();
  });

  it('label_replace 坏正则抛错', () => {
    expect(() => labelReplace([vec({ a: 'x' }), str('b'), str(''), str('a'), str('[')])).toThrow(/正则非法/);
  });

  it('label_join 拼接多个标签', () => {
    const r = labelJoin([vec({ a: '1', b: '2' }), str('c'), str('-'), str('a'), str('b')]);
    expect(r.series[0].labels.c).toBe('1-2');
  });

  it('label_join 结果为空则删除标签', () => {
    const r = labelJoin([vec({ a: '1', x: 'y' }), str('x'), str('-'), str('missing')]);
    expect(r.series[0].labels.x).toBeUndefined();
  });
});

describe('labelKey', () => {
  it('标签顺序无关', () => {
    expect(labelKey({ a: '1', b: '2' })).toBe(labelKey({ b: '2', a: '1' }));
  });

  it('不同值不同 key', () => {
    expect(labelKey({ a: '1' })).not.toBe(labelKey({ a: '2' }));
  });
});

// ────────────────── 端到端：真库 + 真查询 ──────────────────

function makeAdapter(sqlite) {
  return {
    async run(sql, ...p) { const f = p.length === 1 && Array.isArray(p[0]) ? p[0] : p; const i = sqlite.prepare(sql).run(...f); return { changes: i.changes }; },
    async get(sql, ...p) { const f = p.length === 1 && Array.isArray(p[0]) ? p[0] : p; return sqlite.prepare(sql).get(...f); },
    async all(sql, ...p) { const f = p.length === 1 && Array.isArray(p[0]) ? p[0] : p; return sqlite.prepare(sql).all(...f); },
  };
}

const T0 = 1_700_000_000_000;

describe('端到端查询', () => {
  let sqlite, store, ev;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    const adapter = makeAdapter(sqlite);
    store = createTsdbStore({ getDb: () => adapter, getDbType: () => 'sqlite', now: () => T0 });
    ev = createEvaluator({ store, now: () => T0 });
    await store.ensureSchema();

    // 两个实例的 counter，每 15s 一个点
    const samples = [];
    for (let i = 0; i <= 8; i += 1) {
      const ts = T0 - 120_000 + i * 15_000;
      samples.push({ name: 'http_requests_total', labels: { instance: 'a', job: 'web' }, value: i * 10, timestamp: ts });
      samples.push({ name: 'http_requests_total', labels: { instance: 'b', job: 'web' }, value: i * 20, timestamp: ts });
    }
    // 两个 gauge
    for (let i = 0; i <= 4; i += 1) {
      const ts = T0 - 40_000 + i * 10_000;
      samples.push({ name: 'cpu_usage', labels: { instance: 'a' }, value: 0.5 + i * 0.1, timestamp: ts });
      samples.push({ name: 'cpu_usage', labels: { instance: 'b' }, value: 0.2 + i * 0.05, timestamp: ts });
    }
    await store.writeSamples(samples);
  });

  it('瞬时选择器返回最新值', async () => {
    const r = await ev.query('cpu_usage', { time: T0 });
    expect(r.error).toBeUndefined();
    expect(r.resultType).toBe('vector');
    expect(r.result).toHaveLength(2);
    // 实例 a 最后点是 0.5+0.4 = 0.9
    const a = r.result.find((x) => x.metric.instance === 'a');
    expect(Number(a.value[1])).toBeCloseTo(0.9, 5);
  });

  it('标签过滤', async () => {
    const r = await ev.query('cpu_usage{instance="a"}', { time: T0 });
    expect(r.result).toHaveLength(1);
    expect(r.result[0].metric.instance).toBe('a');
  });

  it('正则过滤', async () => {
    const r = await ev.query('cpu_usage{instance=~"a|b"}', { time: T0 });
    expect(r.result).toHaveLength(2);
  });

  it('rate 算出每秒增量', async () => {
    // instance a：8 个间隔 × 10 = 80，跨度 120s → 0.667/s
    const r = await ev.query('rate(http_requests_total[2m])', { time: T0 });
    expect(r.error).toBeUndefined();
    const a = r.result.find((x) => x.metric.instance === 'a');
    expect(Number(a.value[1])).toBeCloseTo(80 / 120, 2);
  });

  it('sum 聚合', async () => {
    const r = await ev.query('sum(rate(http_requests_total[2m]))', { time: T0 });
    expect(r.result).toHaveLength(1);
    expect(r.result[0].metric).toEqual({});
    // a: 0.667 + b: 1.333 = 2
    expect(Number(r.result[0].value[1])).toBeCloseTo(2, 1);
  });

  it('sum by (job)', async () => {
    const r = await ev.query('sum by (job) (rate(http_requests_total[2m]))', { time: T0 });
    expect(r.result).toHaveLength(1);
    expect(r.result[0].metric).toEqual({ job: 'web' });
  });

  it('sum without (instance)', async () => {
    const r = await ev.query('sum without (instance) (http_requests_total)', { time: T0 });
    expect(r.result).toHaveLength(1);
    expect(r.result[0].metric).toEqual({ job: 'web' });
    // 最后值：a=80, b=160 → 240
    expect(Number(r.result[0].value[1])).toBe(80 + 160);
  });

  it('向量 / 向量', async () => {
    const r = await ev.query('cpu_usage / cpu_usage', { time: T0 });
    expect(r.result.length).toBe(2);
    for (const x of r.result) expect(Number(x.value[1])).toBeCloseTo(1, 6);
  });

  it('向量 / 标量', async () => {
    const r = await ev.query('cpu_usage / 2', { time: T0 });
    const a = r.result.find((x) => x.metric.instance === 'a');
    expect(Number(a.value[1])).toBeCloseTo(0.45, 5);
  });

  it('比较运算符过滤', async () => {
    const r = await ev.query('cpu_usage > 0.5', { time: T0 });
    for (const x of r.result) expect(Number(x.value[1])).toBeGreaterThan(0.5);
  });

  it('bool 修饰保留全部并输出 1/0', async () => {
    const r = await ev.query('cpu_usage > bool 0.5', { time: T0 });
    expect(r.result).toHaveLength(2);
    for (const x of r.result) expect(['0', '1']).toContain(x.value[1]);
  });

  it('标量表达式', async () => {
    const r = await ev.query('2 * 3', { time: T0 });
    expect(r.resultType).toBe('scalar');
    expect(r.result[1]).toBe('6');
  });

  it('topk 取前 N', async () => {
    const r = await ev.query('topk(1, cpu_usage)', { time: T0 });
    expect(r.result).toHaveLength(1);
    expect(r.result[0].metric.instance).toBe('a'); // a 更高
  });

  it('bottomk 取后 N', async () => {
    const r = await ev.query('bottomk(1, cpu_usage)', { time: T0 });
    expect(r.result[0].metric.instance).toBe('b');
  });

  it('count', async () => {
    const r = await ev.query('count(cpu_usage)', { time: T0 });
    expect(Number(r.result[0].value[1])).toBe(2);
  });

  it('avg', async () => {
    const r = await ev.query('avg(cpu_usage)', { time: T0 });
    expect(Number(r.result[0].value[1])).toBeCloseTo((0.9 + 0.4) / 2, 5);
  });

  it('max / min', async () => {
    const mx = await ev.query('max(cpu_usage)', { time: T0 });
    expect(Number(mx.result[0].value[1])).toBeCloseTo(0.9, 5);
    const mn = await ev.query('min(cpu_usage)', { time: T0 });
    expect(Number(mn.result[0].value[1])).toBeCloseTo(0.4, 5);
  });

  it('count_values', async () => {
    const r = await ev.query('count_values("v", cpu_usage)', { time: T0 });
    expect(r.result.length).toBeGreaterThan(0);
    for (const x of r.result) expect(x.metric.v).toBeDefined();
  });

  it('and 取交集', async () => {
    const r = await ev.query('cpu_usage and cpu_usage{instance="a"}', { time: T0 });
    expect(r.result).toHaveLength(1);
    expect(r.result[0].metric.instance).toBe('a');
  });

  it('unless 取差集', async () => {
    const r = await ev.query('cpu_usage unless cpu_usage{instance="a"}', { time: T0 });
    expect(r.result).toHaveLength(1);
    expect(r.result[0].metric.instance).toBe('b');
  });

  it('or 合并', async () => {
    const r = await ev.query('cpu_usage{instance="a"} or cpu_usage{instance="b"}', { time: T0 });
    expect(r.result).toHaveLength(2);
  });

  it('abs', async () => {
    const r = await ev.query('abs(cpu_usage - 1)', { time: T0 });
    for (const x of r.result) expect(Number(x.value[1])).toBeGreaterThan(0);
  });

  it('absent：序列存在时返回空', async () => {
    const r = await ev.query('absent(cpu_usage)', { time: T0 });
    expect(r.result).toHaveLength(0);
  });

  it('absent：序列不存在时返回 1', async () => {
    const r = await ev.query('absent(nonexistent_metric)', { time: T0 });
    expect(r.result).toHaveLength(1);
    expect(r.result[0].value[1]).toBe('1');
  });

  it('offset 往前取', async () => {
    const r = await ev.query('cpu_usage offset 30s', { time: T0 });
    const a = r.result.find((x) => x.metric.instance === 'a');
    // 30s 前是 0.5+0.1 = 0.6
    expect(Number(a.value[1])).toBeCloseTo(0.6, 5);
  });

  it('未知函数报错而不是静默返回空', async () => {
    const r = await ev.query('nonexistent_fn(cpu_usage)', { time: T0 });
    expect(r.error).toBeDefined();
    expect(r.error.message).toMatch(/未知函数/);
  });

  it('子查询明确报不支持', async () => {
    const r = await ev.query('rate(cpu_usage[5m:1m])', { time: T0 });
    expect(r.error).toBeDefined();
    expect(r.error.message).toMatch(/子查询/);
  });

  it('lookback 之外的点被视为序列消失', async () => {
    const r = await ev.query('cpu_usage', { time: T0 + 10 * 60_000 });
    expect(r.result).toHaveLength(0);
  });

  it('DEFAULT_LOOKBACK_MS 是 5 分钟', () => {
    expect(DEFAULT_LOOKBACK_MS).toBe(300_000);
  });
});

describe('区间查询', () => {
  let store, ev;

  beforeEach(async () => {
    const sqlite = new Database(':memory:');
    store = createTsdbStore({ getDb: () => makeAdapter(sqlite), getDbType: () => 'sqlite', now: () => T0 });
    ev = createEvaluator({ store, now: () => T0 });
    await store.ensureSchema();
    const samples = [];
    for (let i = 0; i <= 10; i += 1) {
      samples.push({ name: 'g', labels: {}, value: i, timestamp: T0 - 100_000 + i * 10_000 });
    }
    await store.writeSamples(samples);
  });

  it('返回 matrix 且每个序列一条', async () => {
    const r = await ev.queryRange('g', T0 - 30_000, T0, 10_000);
    expect(r.resultType).toBe('matrix');
    expect(r.result).toHaveLength(1);
    expect(r.result[0].values.length).toBeGreaterThan(1);
  });

  it('step <= 0 报错', async () => {
    const r = await ev.queryRange('g', T0 - 30_000, T0, 0);
    expect(r.error).toBeDefined();
  });

  it('end < start 报错', async () => {
    const r = await ev.queryRange('g', T0, T0 - 30_000, 10_000);
    expect(r.error).toBeDefined();
  });

  it('点数过多时报错而不是把服务拖死', async () => {
    const r = await ev.queryRange('g', T0 - 10_000_000, T0, 1);
    expect(r.error).toBeDefined();
    expect(r.error.message).toMatch(/超过上限/);
  });

  it('时间戳输出为秒', async () => {
    const r = await ev.queryRange('g', T0 - 10_000, T0, 10_000);
    for (const v of r.result[0].values) {
      expect(v[0]).toBeLessThan(1e11); // 秒级，不是毫秒
    }
  });
});