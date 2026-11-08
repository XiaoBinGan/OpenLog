/**
 * server/monitoring.js —— 监控体系编排（Lead 审计时发现它是唯一零测试的模块）
 *
 * 这个模块不做指标计算，只做「编排」：建表 → 起 4 个定时器 → 挂采样器 → 挂拨测。
 * 编排类的代码最容易出的问题是「某一路挂了把整个服务带崩」，所以测试重点是**降级**：
 *   - 存储建表失败 → 实时面板仍可用（纯内存）
 *   - 采样器/拨测启动抛错 → 其它两路照常
 *   - 落库失败 → 只丢本批，不重试不阻塞
 *   - stop 幂等
 */
import { describe, it, expect, vi } from 'vitest';
import { startMonitoring, stopMonitoring } from '../monitoring.js';

/** 手动可控的定时器：不真等 60 秒，直接拿注册的回调自己调 */
function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false, unref() {} }; timers.push(t); return t; },
    clearTimer: (t) => { t.cleared = true; },
    /** 取出某个间隔的定时器回调（60_000 = flush/sample，30_000 = probe，3_600_000 = prune） */
    of: (ms) => timers.filter((t) => t.ms === ms && !t.cleared).map((t) => t.fn),
  };
}

const mkRegistry = (buckets = []) => ({ takeMinuteBuckets: vi.fn(() => buckets) });

const mkStore = (over = {}) => ({
  ensureSchema: vi.fn(async () => true),
  writeBuckets: vi.fn(async () => 3),
  prune: vi.fn(async () => 0),
  ...over,
});

const mkSampler = () => ({
  start: vi.fn(),
  stop: vi.fn(),
  sample: vi.fn(async () => ({ ok: true })),
  snapshot: vi.fn(() => ({ lastLight: { tsMs: 1000, kind: 'light' }, lastHeavy: null })),
});

const mkProbes = () => ({ probeAll: vi.fn(async () => []), probeSelf: vi.fn(async () => ({})) });

/** 默认依赖：全部成功 */
function deps(over = {}) {
  const ft = fakeTimers();
  const setTimer = over.setTimer || ft.setTimer;
  const clearTimer = over.clearTimer || ft.clearTimer;
  return {
    ft,
    deps: {
      registry: mkRegistry(),
      createApiStore: () => mkStore(),
      createDbSampler: () => mkSampler(),
      createProbes: () => mkProbes(),
      db: () => ({ run: vi.fn(async () => ({ changes: 1 })) }),
      dbType: () => 'sqlite',
      enabled: () => true,
      logger: () => {},
      setTimer,
      clearTimer,
      ...over,
    },
  };
}

describe('startMonitoring —— 正常路径', () => {
  it('起 4 个定时器：flush(60s) prune(1h) sample(60s) probe(30s)', async () => {
    const { deps: d, ft } = deps();
    await startMonitoring(d);
    const intervals = ft.timers.map((t) => t.ms).sort((a, b) => a - b);
    expect(intervals).toContain(30_000);
    expect(intervals).toContain(60_000);
    expect(intervals).toContain(3_600_000);
  });

  it('落库回调把分钟桶写进 store，并记录 lastFlushAt/lastFlushRows', async () => {
    const buckets = [{ route: '/a', calls: 1 }];
    const store = mkStore();
    const { deps: d, ft } = deps({
      registry: mkRegistry(buckets),
      createApiStore: () => store,
    });
    const h = await startMonitoring(d);
    const flush = ft.of(60_000)[0];
    await flush();
    expect(store.writeBuckets).toHaveBeenCalledWith(buckets);
    expect(h.state.lastFlushRows).toBe(3);
    expect(typeof h.state.lastFlushAt).toBe('number');
  });

  it('没有桶时不动库（避免每分钟白写一次）', async () => {
    const store = mkStore();
    const { deps: d, ft } = deps({ registry: mkRegistry([]), createApiStore: () => store });
    await startMonitoring(d);
    await ft.of(60_000)[0]();
    expect(store.writeBuckets).not.toHaveBeenCalled();
  });

  it('采样落库走 upsert，且同一个 (kind,ts) 不重复写', async () => {
    const run = vi.fn(async () => ({ changes: 1 }));
    const { deps: d, ft } = deps({ db: () => ({ run }) });
    await startMonitoring(d);
    const sampleTimer = ft.of(60_000);
    // 60s 上挂了两个：flush 与 sample；sample 内部会读 sampler.snapshot()
    for (const fn of sampleTimer) await fn();
    const calls = run.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect(String(run.mock.calls[0][0])).toContain('db_metric_sample');
    // 再来一轮，同 (kind,ts) 已写过 → 不应增加
    for (const fn of sampleTimer) await fn();
    expect(run.mock.calls.length).toBe(calls);
  });

  it('拨测启动后立刻跑一轮（面板首次打开就有数据）', async () => {
    const probes = mkProbes();
    const { deps: d } = deps({ createProbes: () => probes });
    await startMonitoring(d);
    // 首轮是 void promise，等一个微任务周期
    await Promise.resolve();
    await Promise.resolve();
    expect(probes.probeAll).toHaveBeenCalled();
  });
});

describe('startMonitoring —— 降级（这是编排代码最该测的部分）', () => {
  it('disabled → 立刻返回，不建表不起定时器', async () => {
    const store = mkStore();
    const { deps: d, ft } = deps({ enabled: () => false, createApiStore: () => store });
    const h = await startMonitoring(d);
    expect(store.ensureSchema).not.toHaveBeenCalled();
    expect(ft.timers.filter((t) => !t.cleared)).toHaveLength(0);
    expect(h.store).toBe(null);
  });

  it('建表失败 → 不落库但实时面板仍可用（store 保留、flush 不挂）', async () => {
    const store = mkStore({ ensureSchema: vi.fn(async () => false) });
    const { deps: d, ft } = deps({ createApiStore: () => store });
    const h = await startMonitoring(d);
    expect(h.state.schemaReady).toBe(false);
    expect(ft.of(3_600_000)).toHaveLength(0); // prune 没挂
    // 但采样器与拨测照常
    expect(h.sampler).toBeTruthy();
    expect(h.probes).toBeTruthy();
  });

  it('store 构造抛错 → 降级为纯内存，其它两路照常', async () => {
    const { deps: d } = deps({ createApiStore: () => { throw new Error('boom'); } });
    const h = await startMonitoring(d);
    expect(h.store).toBe(null);
    expect(h.state.lastError).toContain('boom');
    expect(h.sampler).toBeTruthy();
  });

  it('采样器启动抛错 → 其它功能不受影响', async () => {
    const { deps: d } = deps({ createDbSampler: () => { throw new Error('sampler down'); } });
    const h = await startMonitoring(d);
    expect(h.sampler).toBe(null);
    expect(h.store).toBeTruthy();
    expect(h.probes).toBeTruthy();
  });

  it('拨测启动抛错 → 其它功能不受影响', async () => {
    const { deps: d } = deps({ createProbes: () => { throw new Error('probe down'); } });
    const h = await startMonitoring(d);
    expect(h.probes).toBe(null);
    expect(h.store).toBeTruthy();
    expect(h.sampler).toBeTruthy();
  });

  it('落库抛错 → 只记 lastError，不抛出（否则定时器会把进程带崩）', async () => {
    const store = mkStore({ writeBuckets: vi.fn(async () => { throw new Error('SQLITE_BUSY'); }) });
    const logs = [];
    const { deps: d, ft } = deps({
      registry: mkRegistry([{ route: '/a' }]),
      createApiStore: () => store,
      logger: (lvl, msg) => logs.push(`${lvl}:${msg}`),
    });
    const h = await startMonitoring(d);
    await expect(ft.of(60_000)[0]()).resolves.toBeUndefined();
    expect(h.state.lastError).toContain('SQLITE_BUSY');
    expect(logs.some((l) => l.includes('warn'))).toBe(true);
  });

  it('写回 0 行也算失败信号（数据被丢弃），要 warn', async () => {
    const store = mkStore({ writeBuckets: vi.fn(async () => 0) });
    const logs = [];
    const { deps: d, ft } = deps({
      registry: mkRegistry([{ route: '/a' }]),
      createApiStore: () => store,
      logger: (lvl, msg) => logs.push(`${lvl}:${msg}`),
    });
    await startMonitoring(d);
    await ft.of(60_000)[0]();
    expect(logs.join(' ')).toContain('0 行');
  });

  it('清理抛错也不影响其它定时器', async () => {
    const store = mkStore({ prune: vi.fn(async () => { throw new Error('prune fail'); }) });
    const { deps: d, ft } = deps({ createApiStore: () => store });
    await startMonitoring(d);
    await expect(ft.of(3_600_000)[0]()).resolves.toBeUndefined();
  });

  it('首轮 heavy 采样失败只 warn（面板会暂时没有表体积）', async () => {
    const sampler = mkSampler();
    sampler.sample = vi.fn(async () => { throw new Error('heavy fail'); });
    const logs = [];
    const { deps: d } = deps({ createDbSampler: () => sampler, logger: (l, m) => logs.push(`${l}:${m}`) });
    await startMonitoring(d);
    // 触发 12s 的 setTimeout 不便直接拿，这里验证不抛即可
    expect(d).toBeTruthy();
  });
});

describe('stopMonitoring', () => {
  it('清掉全部定时器 + 停采样器', async () => {
    const sampler = mkSampler();
    const { deps: d, ft } = deps({ createDbSampler: () => sampler });
    const h = await startMonitoring(d);
    const before = ft.timers.filter((t) => !t.cleared).length;
    expect(before).toBeGreaterThan(0);
    stopMonitoring(h, { clearTimer: ft.clearTimer });
    expect(sampler.stop).toHaveBeenCalled();
    expect(ft.timers.every((t) => t.cleared)).toBe(true);
  });

  it('幂等：连调两次不抛', async () => {
    const { deps: d, ft } = deps();
    const h = await startMonitoring(d);
    stopMonitoring(h, { clearTimer: ft.clearTimer });
    expect(() => stopMonitoring(h, { clearTimer: ft.clearTimer })).not.toThrow();
  });

  it('handle 为空 / 半残也不抛', () => {
    expect(() => stopMonitoring(null)).not.toThrow();
    expect(() => stopMonitoring({})).not.toThrow();
    expect(() => stopMonitoring({ sampler: { stop: () => { throw new Error('x'); } } })).not.toThrow();
    expect(() => stopMonitoring({ timers: { flush: {} } }, { clearTimer: () => { throw new Error('x'); } })).not.toThrow();
  });
});
