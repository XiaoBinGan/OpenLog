/**
 * client/src/utils/apiMetrics.test.ts —— 接口指标纯函数测试（#15 ui-api）
 *
 * 重点是**脏数据**：后端聚合来自 SQLite/PG 两条链路，字段类型不稳定
 * （REAL 回字符串、样本不足回 NaN、百分比漏乘 100）。这些都会在白屏上体现，
 * 所以归一化函数必须逐字段验证，而不是只测 happy path。
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeSnapshot,
  topSlow,
  topErrors,
  formatMs,
  formatQps,
  formatBytes,
  errorRateLevel,
  buildQpsSeries,
  type ApiRouteStat,
} from './apiMetrics';

const M = 60_000;
const BASE = Math.floor(1_717_000_000_000 / M) * M; // 对齐到分钟边界的固定时间戳

/** 造一条路由，默认值够用，只覆盖需要变的字段 */
const route = (over: Partial<ApiRouteStat> = {}): ApiRouteStat => ({
  route: '/api/monitor/stats',
  method: 'GET',
  calls: 10,
  err4xx: 0,
  err5xx: 0,
  errorRate: 0,
  qps: 0.17,
  p50: 8,
  p95: 20,
  p99: 40,
  max: 90,
  ...over,
});

describe('normalizeSnapshot —— 保真', () => {
  it('完整快照的字段原样保留', () => {
    const raw = {
      enabled: true,
      window: '5m',
      qps: 2.35,
      errorRate: 1.4,
      totalCalls: 703,
      routes: [route({ route: '/api/monitor/stats', calls: 700, p95: 12.5 })],
      slowest: [route({ route: '/api/docker/containers' })],
      errorTop: [route({ route: '/api/remote/servers', err4xx: 3, err5xx: 1 })],
      dropped: 7,
      storage: { rows: 12_345, approxBytes: 2048 },
    };
    const s = normalizeSnapshot(raw);
    expect(s.enabled).toBe(true);
    expect(s.window).toBe('5m');
    expect(s.qps).toBe(2.35);
    expect(s.errorRate).toBe(1.4);
    expect(s.totalCalls).toBe(703);
    expect(s.routes).toHaveLength(1);
    expect(s.routes![0].p95).toBe(12.5);
    expect(s.errorTop![0].err4xx).toBe(3);
    expect(s.dropped).toBe(7);
    expect(s.storage).toEqual({ rows: 12_345, approxBytes: 2048 });
  });

  it('数字型字符串也能解析（REAL 列在部分驱动下回字符串）', () => {
    const s = normalizeSnapshot({ enabled: true, qps: '1.5', totalCalls: '42', routes: [{ route: '/a', p95: '9.5', calls: '3' }] });
    expect(s.qps).toBe(1.5);
    expect(s.totalCalls).toBe(42);
    expect(s.routes![0].p95).toBe(9.5);
    expect(s.routes![0].calls).toBe(3);
  });
});

describe('normalizeSnapshot —— 兜底', () => {
  it('非对象输入不抛错，返回全部安全默认值', () => {
    for (const bad of [null, undefined, 'oops', 42, [1, 2, 3]]) {
      const s = normalizeSnapshot(bad);
      expect(s.enabled).toBe(false);
      expect(s.qps).toBe(0);
      expect(s.errorRate).toBe(0);
      expect(s.totalCalls).toBe(0);
      expect(s.routes).toEqual([]);
      expect(s.slowest).toEqual([]);
      expect(s.errorTop).toEqual([]);
      expect(s.storage).toBeNull();
    }
  });

  it('NaN / undefined / 垃圾字符串一律变 0', () => {
    const s = normalizeSnapshot({ enabled: true, qps: NaN, errorRate: undefined, totalCalls: 'abc', dropped: NaN });
    expect(s.qps).toBe(0);
    expect(s.errorRate).toBe(0);
    expect(s.totalCalls).toBe(0);
    expect(s.dropped).toBe(0);
  });

  it('百分比钳到 0~100（后端算错 103% 或忘了乘 100）', () => {
    expect(normalizeSnapshot({ errorRate: 103.7 }).errorRate).toBe(100);
    expect(normalizeSnapshot({ errorRate: -8 }).errorRate).toBe(0);
    expect(normalizeSnapshot({ routes: [{ errorRate: 250 }] }).routes![0].errorRate).toBe(100);
  });

  it('数组缺失或非数组 → []，元素里的脏字段落地成安全值', () => {
    const s = normalizeSnapshot({
      enabled: true,
      routes: 'not-an-array',
      slowest: null,
      errorTop: [null, { route: '/x', method: 'post', calls: -5, err4xx: '2', p95: NaN }],
    });
    expect(s.routes).toEqual([]);
    expect(s.slowest).toEqual([]);
    expect(s.errorTop).toHaveLength(2);
    expect(s.errorTop![0].route).toBe('/__unknown__');
    expect(s.errorTop![0].method).toBe('GET');
    expect(s.errorTop![1].method).toBe('POST');
    expect(s.errorTop![1].calls).toBe(0); // 负数没有意义
    expect(s.errorTop![1].err4xx).toBe(2);
    expect(s.errorTop![1].p95).toBe(0);
  });

  it('storage 形状不对就是 null，approxBytes 缺失也是 null', () => {
    expect(normalizeSnapshot({ storage: 5 }).storage).toBeNull();
    expect(normalizeSnapshot({ storage: [] }).storage).toBeNull();
    expect(normalizeSnapshot({ enabled: true }).storage).toBeNull();
    expect(normalizeSnapshot({ storage: { rows: 8 } }).storage).toEqual({ rows: 8, approxBytes: null });
  });

  it('enabled 兼容 true / "true" / 1，其余一律 false', () => {
    expect(normalizeSnapshot({ enabled: 'true' }).enabled).toBe(true);
    expect(normalizeSnapshot({ enabled: 1 }).enabled).toBe(true);
    expect(normalizeSnapshot({ enabled: 'false' }).enabled).toBe(false);
    expect(normalizeSnapshot({ enabled: 0 }).enabled).toBe(false);
  });
});

describe('topSlow —— 按 p95 降序，同值按 calls 降序', () => {
  const snap = normalizeSnapshot({
    enabled: true,
    routes: [
      route({ route: '/fast', p95: 12, calls: 900 }),
      route({ route: '/slow', p95: 880, calls: 3 }),
      route({ route: '/mid-high-calls', p95: 200, calls: 500 }),
      route({ route: '/mid-low-calls', p95: 200, calls: 4 }),
    ],
  });

  it('排序正确：p95 大在前，p95 相同 calls 大在前', () => {
    expect(topSlow(snap).map((r) => r.route)).toEqual(['/slow', '/mid-high-calls', '/mid-low-calls', '/fast']);
  });

  it('limit 生效且不改动入参', () => {
    const before = snap.routes!.map((r) => r.route);
    expect(topSlow(snap, 2)).toHaveLength(2);
    expect(topSlow(snap, 2)[0].route).toBe('/slow');
    expect(snap.routes!.map((r) => r.route)).toEqual(before); // 原数组顺序未被 sort 破坏
    expect(topSlow(snap, 0)).toEqual([]);
  });

  it('没有路由时返回空数组', () => {
    expect(topSlow(normalizeSnapshot({ enabled: true }))).toEqual([]);
  });
});

describe('topErrors —— 按 (4xx+5xx) 降序，零错误的路由不进榜', () => {
  const snap = normalizeSnapshot({
    enabled: true,
    routes: [
      route({ route: '/no-error', calls: 1000 }),
      route({ route: '/five', err4xx: 1, err5xx: 9, calls: 50 }),
      route({ route: '/four-many', err4xx: 6, err5xx: 0, calls: 70 }),
      route({ route: '/four-few-highcalls', err4xx: 3, err5xx: 0, calls: 800 }),
    ],
  });

  it('排序按错误总数降序，同值按 calls 降序', () => {
    expect(topErrors(snap).map((r) => r.route)).toEqual(['/five', '/four-many', '/four-few-highcalls']);
  });

  it('limit 与空态', () => {
    expect(topErrors(snap, 1).map((r) => r.route)).toEqual(['/five']);
    expect(topErrors(normalizeSnapshot({ routes: [route()] }))).toEqual([]);
  });
});

describe('formatMs —— 各档位与非法值', () => {
  it('毫秒档', () => {
    expect(formatMs(0)).toBe('0ms');
    expect(formatMs(7.4)).toBe('7ms');
    expect(formatMs(999)).toBe('999ms');
  });

  it('秒档与分钟以上', () => {
    expect(formatMs(1000)).toBe('1.0s');
    expect(formatMs(1500)).toBe('1.5s');
    expect(formatMs(59_900)).toBe('59.9s');
    expect(formatMs(60_000)).toBe('60s');
    expect(formatMs(90_000)).toBe('90s');
  });

  it('非法值 → —', () => {
    expect(formatMs(NaN)).toBe('—');
    expect(formatMs(null as unknown as number)).toBe('—');
    expect(formatMs('12' as unknown as number)).toBe('—');
    expect(formatMs(-5)).toBe('—');
    expect(formatMs(Infinity)).toBe('—');
  });
});

describe('formatQps', () => {
  it('两位小数、去尾零', () => {
    expect(formatQps(2.345)).toBe('2.35');
    expect(formatQps(2.344)).toBe('2.34');
    expect(formatQps(7)).toBe('7');
    expect(formatQps(0.5)).toBe('0.5');
  });

  it('0 与非法值 → 0', () => {
    expect(formatQps(0)).toBe('0');
    expect(formatQps(0.001)).toBe('0');
    expect(formatQps(NaN)).toBe('0');
    expect(formatQps(-3)).toBe('0');
    expect(formatQps(undefined as unknown as number)).toBe('0');
  });
});

describe('formatBytes', () => {
  it('null / 0 / 各量级', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(0)).toBe('0B');
    expect(formatBytes(512)).toBe('512B');
    expect(formatBytes(1024)).toBe('1.0KB');
    expect(formatBytes(1536)).toBe('1.5KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0MB');
    expect(formatBytes(1024 ** 3)).toBe('1.0GB');
    expect(formatBytes(1024 ** 4)).toBe('1.0TB');
  });

  it('大数与非法值', () => {
    expect(formatBytes(1024 ** 5 * 3)).toBe('3.0PB'); // PB 是最后一档，不再进位
    expect(formatBytes(NaN)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
  });
});

describe('errorRateLevel —— 三档边界', () => {
  it('0.99 ok / 1 warn / 4.99 warn / 5 bad', () => {
    expect(errorRateLevel(0)).toBe('ok');
    expect(errorRateLevel(0.99)).toBe('ok');
    expect(errorRateLevel(1)).toBe('warn');
    expect(errorRateLevel(4.99)).toBe('warn');
    expect(errorRateLevel(5)).toBe('bad');
    expect(errorRateLevel(88)).toBe('bad');
  });

  it('NaN 当作 0（不要因为一条脏数据显示成红色告警）', () => {
    expect(errorRateLevel(NaN)).toBe('ok');
  });
});

describe('buildQpsSeries —— 按分钟聚合与补 0', () => {
  it('同一分钟的多条累加，缺失的分钟补 0', () => {
    const series = buildQpsSeries(
      [
        { bucketMs: BASE, calls: 10 },
        { bucketMs: BASE + 30_000, calls: 5 }, // 同一分钟
        { bucketMs: BASE + 2 * M, calls: 3 },
      ],
      5 * M,
    );
    expect(series.map((p) => p.t)).toEqual([BASE - 2 * M, BASE - M, BASE, BASE + M, BASE + 2 * M]);
    expect(series.map((p) => p.v)).toEqual([0, 0, 15, 0, 3]);
  });

  it('窗口比样本跨度小时只取最近几分钟', () => {
    const series = buildQpsSeries(
      [
        { bucketMs: BASE, calls: 9 },
        { bucketMs: BASE + 2 * M, calls: 4 },
      ],
      2 * M,
    );
    expect(series).toHaveLength(2);
    expect(series.map((p) => p.v)).toEqual([0, 4]);
  });

  it('空样本 / 脏样本 → 空数组或安全值', () => {
    expect(buildQpsSeries([], 5 * M)).toEqual([]);
    expect(buildQpsSeries([{ bucketMs: 0, calls: 5 }], 5 * M)).toEqual([]); // 0 时间戳是脏数据
    expect(buildQpsSeries([{ bucketMs: BASE, calls: -4 }, { bucketMs: BASE, calls: NaN }], M)).toEqual([
      { t: BASE, v: 0 },
    ]);
  });

  it('windowMs 非法时至少给一个点', () => {
    const series = buildQpsSeries([{ bucketMs: BASE, calls: 6 }], NaN);
    expect(series).toEqual([{ t: BASE, v: 6 }]);
  });
});
