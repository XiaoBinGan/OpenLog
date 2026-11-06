/**
 * #12 api-router 单测：server/routes/api-monitor.js
 * 真实 express + http.createServer + 原生 fetch（项目惯例同 metrics-middleware.test.js，
 * 没装 supertest）。所有 deps 都是**假对象**：不连库、不建真实 registry、不拨测。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createApiMonitorRouter, evaluateAlertRules, DEFAULT_THRESHOLDS, WINDOW_MS } from '../routes/api-monitor.js';
afterEach(() => { vi.unstubAllEnvs(); });
/** 假 registry：记录被问过的窗口 + 返回固定快照（或按窗口生成的快照） */
function makeRegistry(factory) {
  const calls = [];
  return {
    calls,
    snapshot(opts = {}) { calls.push(opts); return typeof factory === 'function' ? factory(opts) : factory; },
    takeMinuteBuckets: () => [],
  };
}
/** 路由行：字段与 registry.snapshot 的 routes[] 一致 */
const routeRow = (over = {}) => ({ route: '/api/x', method: 'GET', calls: 100, err4xx: 0, err5xx: 0, errorRate: 0, qps: 0.33, p50: 10, p95: 40, p99: 60, max: 80, ...over });
/** 快照：默认健康数据，按需覆盖 */
function snapshotOf(over = {}) {
  const routes = over.routes || [];
  const totalCalls = over.totalCalls == null ? routes.reduce((n, r) => n + r.calls, 0) : over.totalCalls;
  const totalErrors5xx = over.totalErrors5xx == null ? routes.reduce((n, r) => n + r.err5xx, 0) : over.totalErrors5xx;
  const windowMs = over.windowMs || 300000;
  return {
    windowMs, totalCalls, totalErrors5xx, totalErrors4xx: 0,
    errorRate: totalCalls ? totalErrors5xx / totalCalls : 0, qps: totalCalls / (windowMs / 1000),
    routes, slowest: routes.slice().sort((a, b) => b.p95 - a.p95).slice(0, 10),
    errorTop: routes.filter((r) => r.err5xx > 0).slice(0, 10), droppedRoutes: 0, ...over,
  };
}
const makeStore = (over = {}) => ({
  stats: over.stats || (async () => ({ rows: 42, approxBytes: 4096, tables: [{ table: 'api_metrics_minute', rows: 42 }] })),
  queryRange: over.queryRange || (async () => []),
});
async function startApp(deps) {
  const app = express();
  app.use(createApiMonitorRouter({ app, ...deps }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
const getJson = async (url) => { const res = await fetch(url); return { status: res.status, body: await res.json() }; };
/** 起一个临时 app、打一发、关掉；省掉每个用例的 try/finally 样板 */
async function req(deps, path) {
  const app = await startApp(deps);
  try { return await getJson(`${app.base}${path}`); } finally { await app.close(); }
}

describe('GET /api/monitor/api', () => {
  it('window=5m → 结构完整（字段名与契约一致）', async () => {
    const registry = makeRegistry(snapshotOf({
      routes: [routeRow({ route: '/api/a', calls: 200, p95: 120 }), routeRow({ route: '/api/b', calls: 100, err5xx: 6, p95: 900 })],
    }));
    const { status, body } = await req({ registry, store: makeStore() }, '/api/monitor/api?window=5m');
    expect(status).toBe(200);
    expect(registry.calls[0]).toEqual({ windowMs: WINDOW_MS['5m'] });
    expect(body).toMatchObject({ enabled: true, window: '5m', windowMs: 300000, totalCalls: 300 });
    expect(typeof body.qps).toBe('number');
    expect(typeof body.errorRate).toBe('number');
    expect(body.routes).toHaveLength(2);
    expect(body.routes[0]).toMatchObject({ route: '/api/a', method: 'GET', calls: 200 });
    expect(body.slowest[0].route).toBe('/api/b'); // p95 降序
    expect(body.errorTop.map((r) => r.route)).toEqual(['/api/b']);
    expect(body).toMatchObject({ dropped: 0, droppedRoutes: 0, unavailable: [] });
    expect(body.storage).toMatchObject({ rows: 42 });
    expect(Object.keys(body).sort()).toEqual(['dropped', 'droppedRoutes', 'enabled', 'errorRate', 'errorTop',
      'qps', 'routes', 'slowest', 'storage', 'totalCalls', 'unavailable', 'window', 'windowMs']);
  });
  it('window=bogus → 回退 5m 且 200（不 400，界面别崩）；window=1h 正常透传', async () => {
    const reg = makeRegistry(snapshotOf({ routes: [routeRow()] }));
    const bad = await req({ registry: reg, store: makeStore() }, '/api/monitor/api?window=bogus');
    expect(bad.status).toBe(200);
    expect(bad.body).toMatchObject({ window: '5m', windowMs: 300000 });
    expect(reg.calls[0]).toEqual({ windowMs: 300000 });
    const reg2 = makeRegistry((opts) => snapshotOf({ routes: [routeRow()], windowMs: opts.windowMs }));
    const hour = await req({ registry: reg2, store: makeStore() }, '/api/monitor/api?window=1h');
    expect(hour.body).toMatchObject({ window: '1h', windowMs: WINDOW_MS['1h'] });
    expect(reg2.calls[0]).toEqual({ windowMs: WINDOW_MS['1h'] });
  });
  it('store.stats() 抛错 → 200 且 storage=null（不拿 0 冒充干净）', async () => {
    const store = makeStore({ stats: async () => { throw new Error('db down'); } });
    const { status, body } = await req({ registry: makeRegistry(snapshotOf({ routes: [routeRow()] })), store }, '/api/monitor/api');
    expect(status).toBe(200);
    expect(body.storage).toBeNull();
    expect(body.unavailable).toContain('store.stats');
    expect(body.routes).toHaveLength(1); // 指标部分照常返回
  });
  it('registry 为 null → 指标字段降级为 null/[]，仍然 200', async () => {
    const { status, body } = await req({ registry: null, store: makeStore() }, '/api/monitor/api');
    expect(status).toBe(200);
    expect(body).toMatchObject({ qps: null, errorRate: null, totalCalls: null, droppedRoutes: null });
    expect(body.routes).toEqual([]);
    expect(body.unavailable).toContain('registry');
  });
});

describe('OPENLOG_METRICS=off', () => {
  it('六个路由全部 200 + enabled:false（不 404/500），且完全不碰 registry', async () => {
    const registry = makeRegistry(snapshotOf({ routes: [routeRow()] }));
    const deps = {
      registry, store: makeStore(), probes: { snapshot: () => ({ results: [], uptime: {} }) },
      collectRoutes: () => [{ method: 'GET', path: '/api/a' }],
    };
    const app = await startApp(deps);
    vi.stubEnv('OPENLOG_METRICS', 'off');
    try {
      for (const path of ['/api/monitor/api', '/api/monitor/api/history', '/api/monitor/api/alerts', '/api/monitor/coverage', '/api/monitor/probes']) {
        const { status, body } = await getJson(`${app.base}${path}`);
        expect(status).toBe(200);
        expect(body).toEqual({ enabled: false });
      }
      const st = await getJson(`${app.base}/api/monitor/status`);
      expect(st.status).toBe(200);
      expect(st.body).toMatchObject({ enabled: false, metricsEnabled: false, storage: null, lastFlushAt: null });
      expect(registry.calls).toHaveLength(0);
    } finally { await app.close(); }
  });
});

describe('GET /api/monitor/api/history', () => {
  it('缺省 from/to/limit，limit 上限 5000，rows 透传', async () => {
    const rows = [{ bucketMs: 1700000000000, route: '/api/a', method: 'GET', calls: 5 }];
    const store = makeStore({ queryRange: async (q) => { store.lastQuery = q; return rows; } });
    const nowMs = 1_700_000_100_000;
    const { status, body } = await req({ registry: makeRegistry(snapshotOf()), store, now: () => nowMs }, '/api/monitor/api/history?limit=999999');
    expect(status).toBe(200);
    expect(body).toMatchObject({ limit: 5000, to: nowMs, from: nowMs - 86_400_000 });
    expect(body.rows).toHaveLength(1);
    expect(store.lastQuery).toMatchObject({ fromMs: nowMs - 86_400_000, toMs: nowMs, limit: 5000, route: null });
  });
  it('store.queryRange 抛错 → rows:[] + 200', async () => {
    const store = makeStore({ queryRange: async () => { throw new Error('boom'); } });
    const { status, body } = await req({ registry: makeRegistry(snapshotOf()), store }, '/api/monitor/api/history');
    expect(status).toBe(200);
    expect(body.rows).toEqual([]);
    expect(body.unavailable).toContain('store.queryRange');
  });
});

describe('GET /api/monitor/api/alerts', () => {
  const ids = (fired) => fired.map((r) => r.id);
  it('5xx 比例 10%（calls 100）→ fired 含 err5xx', async () => {
    const registry = makeRegistry(snapshotOf({ totalCalls: 100, totalErrors5xx: 10, routes: [routeRow({ calls: 100, err5xx: 10, p95: 30 })] }));
    const { status, body } = await req({ registry, store: makeStore() }, '/api/monitor/api/alerts');
    expect(status).toBe(200);
    expect(body.shadow).toBe(false);
    expect(ids(body.fired)).toContain('err5xx');
    const r = body.rules.find((x) => x.id === 'err5xx');
    expect(r).toMatchObject({ level: 'error', fired: true });
    expect(r.meta).toMatchObject({ totalCalls: 100, ratio: 0.1 });
    expect(typeof r.title).toBe('string');
    expect(typeof r.detail).toBe('string');
  });
  it('p95=3000ms（calls 100）→ fired 含 latency', async () => {
    const registry = makeRegistry(snapshotOf({ routes: [routeRow({ route: '/api/slow', calls: 100, p95: 3000, max: 5000 })] }));
    const { body } = await req({ registry, store: makeStore() }, '/api/monitor/api/alerts');
    expect(ids(body.fired)).toContain('latency');
    expect(body.rules.find((x) => x.id === 'latency').meta.routes[0]).toMatchObject({ route: '/api/slow', p95: 3000 });
  });
  it('正常数据 → fired 为空数组；缺 statusCounts 时 429 规则 skipped', async () => {
    const registry = makeRegistry(snapshotOf({ routes: [routeRow({ calls: 500, err5xx: 1, p95: 60 }), routeRow({ route: '/api/b', calls: 500, p95: 90 })] }));
    const { status, body } = await req({ registry, store: makeStore() }, '/api/monitor/api/alerts?shadow=1');
    expect(status).toBe(200);
    expect(body.shadow).toBe(true);
    expect(body.fired).toEqual([]);
    expect(body.rules).toHaveLength(4);
    expect(body.rules.find((r) => r.id === 'rateLimited').meta.skipped).toBe(true);
    // 本轮快照里两条路由都有流量 → 有历史但不静默，结论是「无静默路由」
    expect(body.rules.find((r) => r.id === 'silent')).toMatchObject({ fired: false, meta: { silentRoutes: [], checked: 2 } });
  });
  it('statusCounts 注入时 429 规则生效（shadow 不影响计算）', async () => {
    const registry = makeRegistry(snapshotOf({ routes: [routeRow({ calls: 100 })] }));
    const { body } = await req({ registry, store: makeStore(), statusCounts: { 429: 21 } }, '/api/monitor/api/alerts?shadow=1');
    expect(body.shadow).toBe(true);
    expect(ids(body.fired)).toContain('rateLimited');
    expect(body.rules.find((r) => r.id === 'rateLimited').meta).toMatchObject({ status: 429, count: 21 });
  });
});

describe('evaluateAlertRules（纯函数）', () => {
  const firedIds = (snap, opts) => evaluateAlertRules(snap, opts).fired.map((r) => r.id);
  it('err5xx 边界：calls 必须 > 50，比例必须 > 5%（等于不算）', () => {
    expect(firedIds(snapshotOf({ totalCalls: 50, totalErrors5xx: 10, routes: [] }))).not.toContain('err5xx'); // 次数不够
    expect(firedIds(snapshotOf({ totalCalls: 51, totalErrors5xx: 3, routes: [] }))).toContain('err5xx'); // 51 次 + 5.88%
    expect(firedIds(snapshotOf({ totalCalls: 100, totalErrors5xx: 5, routes: [] }))).not.toContain('err5xx'); // 正好 5%
    expect(DEFAULT_THRESHOLDS.err5xx).toEqual({ ratio: 0.05, minCalls: 50 });
  });
  it('latency 边界：p95 必须 > 2000 且 calls > 20', () => {
    expect(firedIds(snapshotOf({ routes: [routeRow({ calls: 100, p95: 2000, max: 2000 })] }))).not.toContain('latency');
    expect(firedIds(snapshotOf({ routes: [routeRow({ calls: 20, p95: 2001, max: 2001 })] }))).not.toContain('latency');
    expect(firedIds(snapshotOf({ routes: [routeRow({ calls: 21, p95: 2001, max: 2001 })] }))).toContain('latency');
  });
  it('阈值可被 opts.thresholds 覆盖；calls 不足一律不报', () => {
    const snap = snapshotOf({ totalCalls: 12, totalErrors5xx: 1, routes: [routeRow({ calls: 12, p95: 400 })] });
    expect(firedIds(snap)).toEqual([]);
    expect(firedIds(snap, { thresholds: { err5xx: { ratio: 0.05, minCalls: 10 }, latency: { p95Ms: 300, minCalls: 10 } } }))
      .toEqual(['err5xx', 'latency']);
    expect(evaluateAlertRules(snapshotOf({ routes: [routeRow({ calls: 1, p95: 9000, max: 9000, err5xx: 1 })] })).fired).toEqual([]);
  });
  it('shadow 不改变计算结果，只透出标记', () => {
    const snap = snapshotOf({ totalCalls: 100, totalErrors5xx: 10, routes: [routeRow({ calls: 100, err5xx: 10, p95: 4000 })] });
    const off = evaluateAlertRules(snap, { shadow: false });
    const on = evaluateAlertRules(snap, { shadow: true });
    expect([on.shadow, off.shadow]).toEqual([true, false]);
    expect(on.fired.map((r) => r.id)).toEqual(off.fired.map((r) => r.id));
    expect(on.fired.map((r) => r.id)).toEqual(['err5xx', 'latency']);
  });
  it('silent：给了历史名单且当前快照没有它 → 报；不给历史 → 跳过', () => {
    const snap = snapshotOf({ routes: [routeRow({ route: '/api/alive', calls: 10 })] });
    expect(evaluateAlertRules(snap).rules.find((r) => r.id === 'silent')).toMatchObject({ fired: false, meta: { skipped: true } });
    const got = evaluateAlertRules(snap, { seenRoutes: [{ method: 'GET', route: '/api/alive' }, { method: 'GET', route: '/api/gone' }] });
    const silent = got.rules.find((r) => r.id === 'silent');
    expect(silent.fired).toBe(true);
    expect(silent.meta.silentRoutes).toEqual([{ method: 'GET', route: '/api/gone' }]);
    expect(got.fired.map((r) => r.id)).toContain('silent');
  });
  it('rateLimited：429 > 20 才报，数据源缺失时 skipped 且不报', () => {
    const snap = snapshotOf({ routes: [routeRow({ calls: 100 })] });
    expect(evaluateAlertRules(snap).rules.find((r) => r.id === 'rateLimited').meta.skipped).toBe(true);
    expect(firedIds(snap, { statusCounts: { 429: 20 } })).not.toContain('rateLimited');
    expect(firedIds(snap, { statusCounts: { 429: 21 } })).toContain('rateLimited');
    expect(firedIds({ ...snap, statusCounts: { 429: 30 } })).toContain('rateLimited'); // 快照自带的也认
  });
  it('snapshot 为 null → 四条规则都在但都不 fired', () => {
    const out = evaluateAlertRules(null);
    expect(out.rules).toHaveLength(4);
    expect(out.fired).toEqual([]);
    expect(out.rules.map((r) => r.id)).toEqual(['err5xx', 'latency', 'silent', 'rateLimited']);
  });
});

describe('GET /api/monitor/coverage', () => {
  const inventory = [{ method: 'GET', path: '/api/a' }, { method: 'GET', path: '/api/b' }, { method: 'POST', path: '/api/c' }];
  it('清单 3 条 + 流量 2 条 → coverageRate 正确', async () => {
    const store = makeStore({
      queryRange: async () => ([
        { bucketMs: 1_700_000_000_000, route: '/api/a', method: 'GET', calls: 7 },
        { bucketMs: 1_700_000_060_000, route: '/api/a', method: 'GET', calls: 5 },
        { bucketMs: 1_700_000_060_000, route: '/api/b', method: 'GET', calls: 3 },
      ]),
    });
    const { status, body } = await req({ registry: makeRegistry(snapshotOf()), store, collectRoutes: () => inventory }, '/api/monitor/coverage');
    expect(status).toBe(200);
    expect(body).toMatchObject({ available: true, total: 3, used: 2, unused: 1, coverageRate: 66.7, windowDays: 7, unavailable: [] });
    const rowA = body.rows.find((r) => r.path === '/api/a');
    expect(rowA.calls).toBe(12); // 同一路由多行按分钟聚合
    expect(rowA.lastSeenMs).toBe(1_700_000_060_000); // 取最大的分钟桶
    expect(body.unusedRoutes).toEqual([{ method: 'POST', path: '/api/c' }]);
    expect(body.unknownTraffic).toEqual([]);
  });
  it('collectRoutes 为 null → { available:false } 且 200（不是 0% 覆盖率）', async () => {
    const { status, body } = await req({ registry: makeRegistry(snapshotOf()), store: makeStore(), collectRoutes: null }, '/api/monitor/coverage');
    expect(status).toBe(200);
    expect(body.available).toBe(false);
    expect(typeof body.reason).toBe('string');
    expect(body.coverageRate).toBeUndefined();
  });
  it('collectRoutes 抛错 → { available:false } 且 200', async () => {
    const deps = { registry: makeRegistry(snapshotOf()), store: makeStore(), collectRoutes: () => { throw new Error('route walk 炸了'); } };
    const { status, body } = await req(deps, '/api/monitor/coverage');
    expect(status).toBe(200);
    expect(body).toMatchObject({ available: false, reason: 'route walk 炸了' });
  });
});

describe('GET /api/monitor/probes 与 /status', () => {
  it('probes 为 null → { available:false } 且 200', async () => {
    const { status, body } = await req({ registry: makeRegistry(snapshotOf()), store: makeStore(), probes: null }, '/api/monitor/probes');
    expect(status).toBe(200);
    expect(body).toMatchObject({ available: false });
  });
  it('probes 正常 → results/uptime 透传；probes 抛错 → available:false', async () => {
    const probes = { snapshot: () => ({ results: [{ id: 'self', kind: 'http', ok: true, ms: 12 }], uptime: { self: { ok: 9, fail: 1, rate: 90 } } }) };
    const ok = await req({ registry: makeRegistry(snapshotOf()), store: makeStore(), probes }, '/api/monitor/probes');
    expect(ok.body).toMatchObject({ enabled: true, available: true });
    expect(ok.body.results).toHaveLength(1);
    expect(ok.body.uptime.self).toEqual({ ok: 9, fail: 1, rate: 90 });
    const boom = await req({ registry: makeRegistry(snapshotOf()), store: makeStore(), probes: { snapshot: () => { throw new Error('probe boom'); } } }, '/api/monitor/probes');
    expect(boom.status).toBe(200);
    expect(boom.body).toMatchObject({ available: false, reason: 'probe boom' });
  });
  it('/status → 总览四字段（storage 来自 store.stats，lastFlushAt 由 deps 注入）', async () => {
    const { status, body } = await req({ registry: makeRegistry(snapshotOf()), store: makeStore(), lastFlushAt: 1_700_000_000_000 }, '/api/monitor/status');
    expect(status).toBe(200);
    expect(body).toMatchObject({ enabled: true, metricsEnabled: true, lastFlushAt: 1_700_000_000_000 });
    expect(body.storage).toMatchObject({ rows: 42 });
  });
});