/**
 * server/__tests__/metrics-registry.test.js
 *
 * #5 registry 负责人的自测：验证 server/metrics/registry.js 的水位（窗口过期、环形复用）、
 * 错误计数、直方图百分位单调性、分钟桶取走语义、maxRoutes 兜底，以及 10 万次 record 的耗时。
 * 时间全部用注入的假时钟，测试不 sleep、不依赖真实墙上时间。
 */
import { describe, it, expect } from 'vitest';
import { createRegistry, percentile } from '../metrics/registry.js';

const MIN = 60_000;
/** 假时钟：从某个整分钟+30 秒开始，便于验证分钟边界 */
function fakeClock(start = Date.UTC(2025, 0, 1, 0, 0, 30)) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    set: (v) => { t = v; },
  };
}

describe('percentile —— 纯函数边界', () => {
  it('空数组返回 0', () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([], 0.95)).toBe(0);
  });

  it('单元素返回它自己（任意 p）', () => {
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 0.99)).toBe(42);
    expect(percentile([42], 1)).toBe(42);
  });

  it('p=0 取最小值，p=1 取最大值', () => {
    const xs = [3, 9, 27, 81];
    expect(percentile(xs, 0)).toBe(3);
    expect(percentile(xs, 1)).toBe(81);
  });

  it('线性插值：[1,2,3,4] p=0.5 → 2.5', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([1, 2, 3, 4], 0.25)).toBe(1.75);
    expect(percentile([1, 2, 3, 4], 0.75)).toBe(3.25);
    expect(percentile([1, 2, 3, 4], 0.95)).toBeCloseTo(3.85, 10);
  });

  it('p 越界钳制到 [0,1]（0~1 小数语义，不是 0~100）', () => {
    const xs = [10, 20, 30];
    expect(percentile(xs, -1)).toBe(10);
    expect(percentile(xs, 1.5)).toBe(30);
    expect(percentile(xs, Number.NaN)).toBe(10);
  });
});

describe('createRegistry —— 计数与 qps', () => {
  it('record 后 snapshot 的 calls / err4xx / err5xx / qps 正确', () => {
    const reg = createRegistry({ windowMs: 10_000 });
    for (let i = 0; i < 4; i += 1) reg.record('/api/logs', 'GET', 200, 12);
    reg.record('/api/logs', 'GET', 404, 8);

    const snap = reg.snapshot();
    expect(snap.windowMs).toBe(10_000);
    expect(snap.totalCalls).toBe(5);
    expect(snap.totalErrors4xx).toBe(1);
    expect(snap.totalErrors5xx).toBe(0);
    expect(snap.routes.length).toBe(1);
    const r = snap.routes[0];
    expect(r.route).toBe('/api/logs');
    expect(r.method).toBe('GET');
    expect(r.calls).toBe(5);
    expect(r.err4xx).toBe(1);
    expect(r.err5xx).toBe(0);
    // qps = calls / (windowMs/1000) = 5 / 10
    expect(r.qps).toBe(0.5);
    expect(snap.qps).toBe(0.5);
    expect(r.max).toBe(12);
  });

  it('4xx 与 5xx 分开计数，errorRate = (4xx+5xx)/calls 且不为 NaN', () => {
    const reg = createRegistry({ windowMs: 10_000 });
    reg.record('/api/x', 'POST', 200, 5);
    reg.record('/api/x', 'POST', 400, 6);
    reg.record('/api/x', 'POST', 404, 7);
    reg.record('/api/x', 'POST', 500, 300);
    reg.record('/api/x', 'POST', 503, 900);

    const snap = reg.snapshot();
    expect(snap.totalCalls).toBe(5);
    expect(snap.totalErrors4xx).toBe(2);
    expect(snap.totalErrors5xx).toBe(2);
    expect(snap.errorRate).toBe(0.8); // 4/5
    const r = snap.routes[0];
    expect(r.err4xx).toBe(2);
    expect(r.err5xx).toBe(2);
    expect(r.errorRate).toBe(0.8);
    expect(Number.isNaN(r.errorRate)).toBe(false);
    // errorTop 只看 5xx
    expect(snap.errorTop.length).toBe(1);
    expect(snap.errorTop[0].err5xx).toBe(2);
  });

  it('没有流量时 errorRate 为 0（不是 NaN）', () => {
    const reg = createRegistry({ windowMs: 10_000 });
    const snap = reg.snapshot();
    expect(snap.totalCalls).toBe(0);
    expect(snap.errorRate).toBe(0);
    expect(snap.qps).toBe(0);
    expect(snap.routes).toEqual([]);
    expect(snap.slowest).toEqual([]);
    expect(snap.errorTop).toEqual([]);
  });

  it('reserved: 300/400 段之外的 3xx 不计入错误', () => {
    const reg = createRegistry({ windowMs: 10_000 });
    reg.record('/api/y', 'GET', 302, 3);
    const snap = reg.snapshot();
    expect(snap.totalErrors4xx).toBe(0);
    expect(snap.totalErrors5xx).toBe(0);
    expect(snap.errorRate).toBe(0);
  });
});

describe('createRegistry —— 直方图百分位', () => {
  it('p50 <= p95 <= p99 单调，且都不超过 max', () => {
    const reg = createRegistry({ windowMs: 60_000 });
    const durations = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 25, 40, 60, 90, 150, 260, 700, 1200, 4800];
    for (let i = 0; i < 200; i += 1) {
      reg.record('/api/containers', 'GET', 200, durations[i % durations.length]);
    }
    const r = reg.snapshot().routes[0];
    expect(r.p50).toBeLessThanOrEqual(r.p95);
    expect(r.p95).toBeLessThanOrEqual(r.p99);
    expect(r.p99).toBeLessThanOrEqual(r.max);
    expect(r.p50).toBeGreaterThan(0);
    expect(r.max).toBe(4800);
  });

  it('单样本时 p50/p95/p99 等于该样本，多样本同值时误差不超过档宽', () => {
    const one = createRegistry({ windowMs: 10_000 });
    one.record('/api/a', 'GET', 200, 12);
    const r1 = one.snapshot().routes[0];
    expect(r1.p50).toBe(12);
    expect(r1.p95).toBe(12);
    expect(r1.p99).toBe(12);

    const many = createRegistry({ windowMs: 10_000 });
    for (let i = 0; i < 50; i += 1) many.record('/api/b', 'GET', 200, 12);
    const r2 = many.snapshot().routes[0];
    // 全部 12ms 落在 10~20ms 档内，估算值必须落在该档且不超过真实 max
    for (const v of [r2.p50, r2.p95, r2.p99]) {
      expect(v).toBeGreaterThanOrEqual(10);
      expect(v).toBeLessThanOrEqual(12);
    }
  });
});

describe('createRegistry —— 滑窗过期与环形复用', () => {
  it('windowMs 之外的旧数据不再计入 snapshot', () => {
    const clock = fakeClock();
    const reg = createRegistry({ windowMs: 1000, now: clock.now });
    reg.record('/api/old', 'GET', 200, 10);
    expect(reg.snapshot().totalCalls).toBe(1);

    clock.advance(5_000); // 远超 1s 窗口
    const snap = reg.snapshot();
    expect(snap.totalCalls).toBe(0);
    expect(snap.routes).toEqual([]);
  });

  it('环形桶被复用时旧计数被清零（不残留上上窗口的数据）', () => {
    const clock = fakeClock();
    const reg = createRegistry({ windowMs: 1000, now: clock.now });
    reg.record('/api/ring', 'GET', 200, 10);
    reg.record('/api/ring', 'GET', 200, 11);
    expect(reg.snapshot().totalCalls).toBe(2);

    clock.advance(3_000); // 3 个 bucketMs(100ms) 之后：桶被复用
    reg.record('/api/ring', 'GET', 200, 12);
    const snap = reg.snapshot();
    expect(snap.totalCalls).toBe(1);
    expect(snap.routes[0].calls).toBe(1);
  });
});

describe('createRegistry —— takeMinuteBuckets', () => {
  it('只取已结束的分钟，取走后第二次为空', () => {
    const clock = fakeClock(Date.UTC(2025, 0, 1, 0, 0, 30)); // 00:00:30
    const reg = createRegistry({ windowMs: 60_000, now: clock.now });
    reg.record('/api/logs', 'GET', 200, 12);
    reg.record('/api/logs', 'GET', 500, 800);
    reg.record('/api/other', 'POST', 404, 30);

    // 当前分钟（00:00）还没结束 → 不许落库
    expect(reg.takeMinuteBuckets(clock.now())).toEqual([]);

    clock.set(Date.UTC(2025, 0, 1, 0, 1, 5)); // 00:01:05，00:00 已结束
    const first = reg.takeMinuteBuckets(clock.now());
    expect(first.length).toBe(2);
    const logs = first.find((b) => b.route === '/api/logs');
    expect(logs).toBeTruthy();
    expect(logs.bucketMs).toBe(Date.UTC(2025, 0, 1, 0, 0, 0));
    expect(logs.method).toBe('GET');
    expect(logs.calls).toBe(2);
    expect(logs.err5xx).toBe(1);
    expect(logs.max).toBe(800);
    expect(typeof logs.p95).toBe('number');
    const other = first.find((b) => b.route === '/api/other');
    expect(other.err4xx).toBe(1);

    // 取走即清零，防止重复落库
    expect(reg.takeMinuteBuckets(clock.now())).toEqual([]);
  });

  it('不同分钟的桶分别聚合，且分钟桶号对齐到整分钟', () => {
    const clock = fakeClock(Date.UTC(2025, 0, 1, 0, 0, 10));
    const reg = createRegistry({ windowMs: 300_000, now: clock.now });
    reg.record('/api/m', 'GET', 200, 10);
    clock.set(Date.UTC(2025, 0, 1, 0, 1, 10));
    reg.record('/api/m', 'GET', 200, 20);
    reg.record('/api/m', 'GET', 200, 30);
    clock.set(Date.UTC(2025, 0, 1, 0, 2, 1));
    const buckets = reg.takeMinuteBuckets(clock.now());
    expect(buckets.map((b) => b.bucketMs)).toEqual([
      Date.UTC(2025, 0, 1, 0, 0, 0),
      Date.UTC(2025, 0, 1, 0, 1, 0),
    ]);
    expect(buckets.map((b) => b.calls)).toEqual([1, 2]);
    expect(buckets.every((b) => b.bucketMs % MIN === 0)).toBe(true);
  });
});

describe('createRegistry —— maxRoutes 兜底', () => {
  it('超限路由归入 __other__，droppedRoutes 增加且去重', () => {
    const reg = createRegistry({ windowMs: 10_000, maxRoutes: 2 });
    reg.record('/api/a', 'GET', 200, 5);
    reg.record('/api/b', 'GET', 200, 6);
    reg.record('/api/c', 'GET', 200, 7); // 第 3 条 → __other__
    let snap = reg.snapshot();
    expect(snap.droppedRoutes).toBe(1);
    expect(snap.routes.length).toBe(3);
    const other = snap.routes.find((r) => r.route === '__other__');
    expect(other).toBeTruthy();
    expect(other.calls).toBe(1);

    // 同一条被丢的路由再来，不重复计数
    reg.record('/api/c', 'GET', 200, 7);
    reg.record('/api/d', 'GET', 200, 8);
    snap = reg.snapshot();
    expect(snap.droppedRoutes).toBe(2);
    expect(snap.routes.find((r) => r.route === '__other__').calls).toBe(3);
    // 总量不丢
    expect(snap.totalCalls).toBe(5);
    // 已存在的两条路由仍独立统计
    expect(snap.routes.find((r) => r.route === '/api/a').calls).toBe(1);
  });
});

describe('createRegistry —— 吞吐/退化', () => {
  it('10 万次 record < 200ms（O(1)，不是 O(n) 遍历）', () => {
    const reg = createRegistry({ windowMs: 60_000, maxRoutes: 50 });
    // 预热：让 JIT 和 TypedArray 首次分配稳定下来，再测真实稳态耗时
    for (let i = 0; i < 2_000; i += 1) reg.record('/api/warmup', 'GET', 200, 15);

    const startedAt = performance.now();
    for (let i = 0; i < 100_000; i += 1) {
      reg.record('/api/logs', 'GET', i % 500 === 0 ? 500 : 200, (i % 700) + 1);
    }
    const elapsedMs = performance.now() - startedAt;
    const snap = reg.snapshot(); // 顺带确认快照仍然可用
    console.log(`[registry] 100k record 实测耗时 ${elapsedMs.toFixed(1)}ms`);
    expect(snap.routes.find((r) => r.route === '/api/logs').calls).toBe(100_000);
    expect(elapsedMs).toBeLessThan(200);
  });
});
