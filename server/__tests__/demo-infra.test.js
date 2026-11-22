/**
 * demo-infra.test.js —— 演示模式的「基础设施面板」（DB 监控 / 接口监控 / 库信息 / 外部数据源）
 *
 * 覆盖的端点：
 *   读：GET /api/monitor/db、/api/monitor/db/history、/api/monitor/db/slow-queries、
 *       /api/monitor/db/tables、/api/monitor/api、/api/db/info、/api/monitor/datasources
 *   写：POST /api/monitor/db/sample、DELETE /api/monitor/db/slow-queries、
 *       POST /api/monitor/datasources/{adopt,test,probe-docs,:id/probe}、PUT/DELETE /:id
 *   启动：startMonitor() 在演示模式下不采真机、不广播
 *
 * 这个文件要证明四件事，少一件演示模式就不算做对：
 *   1. **演示模式下真实依赖一次都不碰**。这些端点的真实依赖是「本机那个库」（getDbInfo /
 *      pingDb / db.all）、DB 采样器、api-store、慢查询环形缓冲、注册表、以及外部数据源
 *      的探测（pg/mysql2 驱动、fetch）。全部打桩，演示分支跑完断言调用次数为 0 ——
 *      否则「演示模式」在别人机器上依然会去打开 sqlite、连 5432、拉别人的 swagger。
 *   2. **数据自洽**。qps 与每条路由的 calls、错误率与 err4xx+err5xx、表的行数与体积、
 *      采样时间与固定锚点必须互相对得上 —— 「编得很像」和「编得对不上」是两件事，
 *      后者会让第一次读数的人得出结论「这监控坏了」。
 *   3. **确定性**。固定锚点 + 固定种子：同一请求两次 deepEqual（前端 30 秒轮询时，
 *      曲线和数字不能自己乱抖）。
 *   4. **关掉开关完全回到原行为**：真实依赖被调用、响应里没有 `demo` 字段。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

// ─── 真实依赖打桩（演示模式下应保持 0 次调用）─────────────────────────────
//
// 1) 本机数据库适配层：db-info 直接 import 它（getDbInfo/pingDb/getDb/getDbType）。
//    打桩之后，db-info 一旦走了真实分支就会留下调用记录 —— 这正是我们要断言的东西。
const dbIndexMock = {
  getDbInfo: vi.fn(),
  pingDb: vi.fn(),
  getDb: vi.fn(),
  getDbType: vi.fn(),
};
vi.mock('../db/index.js', () => dbIndexMock);

// 2) 三种驱动：本仓库的 db 适配层与 datasource/db-probe 都从这里取连接。
//    给最小桩，保证「演示模式下真的没加载/没建连接」。
vi.mock('better-sqlite3', () => ({ default: vi.fn(() => { throw new Error('演示模式不应打开 sqlite'); }) }));
vi.mock('pg', () => ({
  default: { Client: vi.fn(() => { throw new Error('演示模式不应连接 PostgreSQL'); }) },
  Client: vi.fn(() => { throw new Error('演示模式不应连接 PostgreSQL'); }),
}));
vi.mock('mysql2/promise', () => ({
  default: { createConnection: vi.fn(() => { throw new Error('演示模式不应连接 MySQL'); }) },
  createConnection: vi.fn(() => { throw new Error('演示模式不应连接 MySQL'); }),
}));

// 3) 机器指标与远程集中采集：startMonitor/statsScheduler 的真实依赖。
const siMock = {
  currentLoad: vi.fn(),
  mem: vi.fn(),
  fsSize: vi.fn(),
  networkStats: vi.fn(),
};
vi.mock('systeminformation', () => ({ default: siMock, ...siMock }));

const statsSchedulerMock = { createStatsScheduler: vi.fn() };
vi.mock('../stats-scheduler.js', () => statsSchedulerMock);

const { default: createDbMonitorRouter } = await import('../routes/db-monitor.js');
const { default: createApiMonitorRouter } = await import('../routes/api-monitor.js');
const { default: createDbRouter } = await import('../routes/db-info.js');
const { default: createDatasourceRouter } = await import('../routes/datasource.js');
const { DEMO_INFRA_NOW_MS, DEMO_DB_TABLE_NAMES } = await import('../demo/fixtures-infra.js');

// ─── 注入依赖的桩（每个用例重建，便于断言「一次都没调用」）─────────────────

/** `/api/monitor/db` 的采样器/存储/慢查询日志桩 */
function makeDbDeps() {
  const tables = [{ relname: 'log_records', bytes: 9_000, liveTup: 12, deadTup: 0, indexHitRate: 0.9 }];
  return {
    sampler: {
      snapshot: vi.fn(() => ({
        lastLight: { tsMs: 1_700_000_000_000, kind: 'light', probeMs: 2.5, pool: { total: 3, idle: 2, waiting: 0, max: 5 } },
        lastHeavy: { tsMs: 1_700_000_000_000, kind: 'heavy', tables },
        unavailable: [],
      })),
      sample: vi.fn(async () => ({ ok: true, kind: 'light', tsMs: 1, probeMs: 1, unavailable: [] })),
    },
    store: { stats: vi.fn(async () => ({ rows: 3, approxBytes: 900, tables: [] })) },
    slowQueryLog: {
      thresholdMs: 200,
      list: vi.fn(() => [{ ts_ms: 1_700_000_000_000, fingerprint: 'select ?', ms: 900, source: 'db.all', sample: 'select ?' }]),
      reset: vi.fn(),
    },
    dbInfo: vi.fn(() => ({ type: 'sqlite', pool: null, sqlite: { path: '/tmp/real.db' } })),
    db: { all: vi.fn(async () => [{ ts_ms: 1_700_000_000_000, kind: 'light', payload: '{"probeMs":1}' }]) },
    slowQueryThresholdMs: 200,
  };
}

/** `/api/monitor/api` 的注册表/存储桩 */
function makeApiDeps() {
  return {
    registry: {
      snapshot: vi.fn(() => ({
        windowMs: 300_000, totalCalls: 42, totalErrors5xx: 1, totalErrors4xx: 1,
        errorRate: 0.0476, qps: 0.14, routes: [{ route: '/api/real', method: 'GET', calls: 42, err4xx: 1, err5xx: 1 }],
        slowest: [], errorTop: [], droppedRoutes: 0,
      })),
    },
    store: { stats: vi.fn(async () => ({ rows: 1, approxBytes: 10, tables: [] })) },
    probes: { snapshot: vi.fn(() => ({ results: [], uptime: {} })) },
    enabled: () => true,
  };
}

/** 外部数据源的 store / 探测桩 */
function makeDatasourceDeps() {
  return {
    store: {
      list: vi.fn(async () => [{ id: 'real-ds', kind: 'service', label: '真实数据源' }]),
      get: vi.fn(async () => null),
      getSecret: vi.fn(async () => ({ id: 'real-ds', kind: 'service', baseUrl: 'http://real' })),
      upsert: vi.fn(async () => ({ ok: true })),
      remove: vi.fn(async () => true),
      recordProbe: vi.fn(async () => true),
    },
    listContainers: vi.fn(async () => []),
    inspectContainer: vi.fn(async () => null),
    getDockerConfig: vi.fn(async () => ({})),
    dockerSources: () => [{ id: 'srv-4090-a', label: '4090×4' }],
    hostHintFor: () => '10.0.12.31',
    probeDb: vi.fn(async () => ({ ok: true, ms: 3 })),
    probeDocs: vi.fn(async () => ({ ok: true, ms: 5, paths: [] })),
    fetchImpl: vi.fn(async () => { throw new Error('演示模式不应发起外部请求'); }),
    enabled: () => true,
  };
}

// ─── 测试脚手架 ────────────────────────────────────────────────────────────

/**
 * 与 index.js 的挂载方式一致：四个工厂 + 各自的注入依赖。
 * `deps` 传进来是为了在断言里拿到同一批 spy（演示模式下它们必须 0 次调用）。
 */
async function startApp({ dbDeps, apiDeps, dsDeps } = {}) {
  const d = {
    dbDeps: dbDeps || makeDbDeps(),
    apiDeps: apiDeps || makeApiDeps(),
    dsDeps: dsDeps || makeDatasourceDeps(),
  };

  const app = express();
  app.use(express.json());
  app.use(createDbMonitorRouter(d.dbDeps));
  app.use(createApiMonitorRouter(d.apiDeps));
  app.use(createDbRouter());
  app.use(createDatasourceRouter(d.dsDeps));

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (pathname, init) => {
    const res = await fetch(`${base}${pathname}`, init);
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  };
  const post = (pathname, body) => call(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

  return {
    call,
    post,
    deps: d,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** 演示模式下这些真实依赖必须一次都没被调用 */
function expectNoRealDbDeps(d) {
  expect(d.sampler.snapshot, 'sampler.snapshot 不应被调用').not.toHaveBeenCalled();
  expect(d.sampler.sample, 'sampler.sample 不应被调用').not.toHaveBeenCalled();
  expect(d.store.stats, 'api-store.stats 不应被调用').not.toHaveBeenCalled();
  expect(d.slowQueryLog.list, 'slowQueryLog.list 不应被调用').not.toHaveBeenCalled();
  expect(d.slowQueryLog.reset, 'slowQueryLog.reset 不应被调用').not.toHaveBeenCalled();
  expect(d.dbInfo, 'dbInfo 不应被调用').not.toHaveBeenCalled();
  expect(d.db.all, 'db_metric_sample 查询不应执行').not.toHaveBeenCalled();
}

function expectNoRealDbIndex() {
  expect(dbIndexMock.getDbInfo).not.toHaveBeenCalled();
  expect(dbIndexMock.pingDb).not.toHaveBeenCalled();
  expect(dbIndexMock.getDb).not.toHaveBeenCalled();
  expect(dbIndexMock.getDbType).not.toHaveBeenCalled();
}

beforeEach(() => {
  for (const fn of Object.values(siMock)) fn.mockReset();
  siMock.currentLoad.mockResolvedValue({ currentLoad: 12.5 });
  siMock.mem.mockResolvedValue({ used: 1, total: 2, free: 1 });
  siMock.fsSize.mockResolvedValue([{ fs: '/dev/real', used: 1, size: 2, use: 50 }]);
  siMock.networkStats.mockResolvedValue([{ iface: 'eth0', rx_sec: 1, tx_sec: 2 }]);

  dbIndexMock.getDbInfo.mockReset().mockReturnValue({ type: 'sqlite', ready: true, dialect: 'sqlite', sqlite: { fileSize: 4096 } });
  dbIndexMock.pingDb.mockReset().mockResolvedValue({ ok: true, latencyMs: 0.4 });
  dbIndexMock.getDbType.mockReset().mockReturnValue('sqlite');
  dbIndexMock.getDb.mockReset().mockReturnValue({ get: vi.fn(async () => null), all: vi.fn(async () => []) });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── 演示模式：7 个读端点 ─────────────────────────────────────────────────

describe('演示模式 · DB 监控总览 GET /api/monitor/db', () => {
  beforeEach(() => vi.stubEnv('OPENLOG_DEMO', '1'));

  it('回一台 PG 16：池 10 上限 / 4 活跃，与 pg_stat_activity 对得上，且不读本机库', async () => {
    const { call, deps, close } = await startApp();
    try {
      const r = await call('/api/monitor/db');
      expect(r.status).toBe(200);
      expect(r.body.demo).toBe(true);

      expect(r.body.enabled).toBe(true);
      expect(r.body.type).toBe('postgres');
      expect(r.body.pool).toEqual({ total: 10, idle: 6, waiting: 0, max: 10 });

      // 池水位与活性计数必须自洽：活跃 = total - idle = byState.active
      const active = r.body.pool.total - r.body.pool.idle;
      expect(active).toBe(4);
      expect(r.body.lastLight.activity.byState.active).toBe(active);
      expect(r.body.lastLight.activity.byState.idle).toBe(r.body.pool.idle);

      // light/heavy 两种采样同形但内容不同
      expect(r.body.lastLight.kind).toBe('light');
      expect(r.body.lastLight.tables).toBeNull();
      expect(r.body.lastHeavy.kind).toBe('heavy');
      expect(r.body.lastHeavy.tables).toHaveLength(6);
      expect(r.body.lastLight.unavailable).toEqual([]);
      expect(r.body.unavailable).toEqual([]);
      expect(r.body.probeMs).toBe(r.body.lastLight.probeMs);

      // 顶层 tables 就是 lastHeavy.tables（前端两处都读）
      expect(r.body.tables).toEqual(r.body.lastHeavy.tables);

      // 采样时间来自固定锚点，不是 Date.now()
      expect(r.body.lastLight.tsMs).toBe(DEMO_INFRA_NOW_MS);
      expect(r.body.lastHeavy.tsMs).toBeLessThan(r.body.lastLight.tsMs);

      // 存储计数：rows 是明细之和，不另编一个数
      const sumRows = r.body.storage.tables.reduce((s, t) => s + (t.rows ?? 0), 0);
      expect(r.body.storage.rows).toBe(sumRows);
      expect(r.body.storage.approxBytes).toBeGreaterThan(0);

      // 每张表的行宽（bytes/行）落在 PG 的真实区间
      for (const t of r.body.tables) {
        expect(t.liveTup).toBeGreaterThan(0);
        expect(t.bytes).toBeGreaterThan(0);
        const bytesPerRow = t.bytes / t.liveTup;
        expect(bytesPerRow).toBeGreaterThan(150);
        expect(bytesPerRow).toBeLessThan(2_000);
        // 小表被全表扫是正常的（analysis_records 的 seq_scan 占比就很高），
        // 所以只要求「索引仍占多数」，不要求 99%
        expect(t.indexHitRate).toBeGreaterThan(0.8);
        expect(t.indexHitRate).toBeLessThanOrEqual(1);
      }

      expectNoRealDbDeps(deps.dbDeps);
      expectNoRealDbIndex();
    } finally { await close(); }
  });

  it('两次调用 deepEqual', async () => {
    const { call, close } = await startApp();
    try {
      const a = await call('/api/monitor/db');
      const b = await call('/api/monitor/db');
      expect(a.body).toEqual(b.body);
    } finally { await close(); }
  });
});

describe('演示模式 · 采样历史 GET /api/monitor/db/history', () => {
  beforeEach(() => vi.stubEnv('OPENLOG_DEMO', '1'));

  it('回 60 点 light 采样，最新一点 = 总览里的 lastLight.tsMs', async () => {
    const { call, deps, close } = await startApp();
    try {
      const overview = await call('/api/monitor/db');
      const r = await call('/api/monitor/db/history');
      expect(r.status).toBe(200);
      expect(r.body.demo).toBe(true);
      expect(r.body.kind).toBe('light');
      expect(r.body.samples).toHaveLength(60);

      const [first] = r.body.samples;
      const last = r.body.samples[59];
      expect(Object.keys(first).sort()).toEqual(['data', 'kind', 'tsMs']);
      expect(first.kind).toBe('light');
      // 元素 data 就是那一轮的采样快照（payload 反序列化的形状）
      expect(first.data.kind).toBe('light');
      expect(first.data.pool.max).toBe(10);

      // 时间升序、最新一点与总览的 lastLight 对齐、相邻间隔 30s
      expect(last.tsMs).toBe(overview.body.lastLight.tsMs);
      expect(last.data).toEqual(overview.body.lastLight);
      expect(r.body.samples[1].tsMs - r.body.samples[0].tsMs).toBe(30_000);
      expect(first.tsMs).toBeLessThan(last.tsMs);
      expect(last.tsMs).toBeLessThanOrEqual(DEMO_INFRA_NOW_MS);

      expectNoRealDbDeps(deps.dbDeps);
      expectNoRealDbIndex();
    } finally { await close(); }
  });

  it('kind=heavy 走 heavy 采样（带表体积），时间与 lastHeavy 对齐', async () => {
    const { call, close } = await startApp();
    try {
      const overview = await call('/api/monitor/db');
      const r = await call('/api/monitor/db/history?kind=heavy&limit=12');
      expect(r.body.kind).toBe('heavy');
      expect(r.body.samples).toHaveLength(12);
      const last = r.body.samples[11];
      expect(last.tsMs).toBe(overview.body.lastHeavy.tsMs);
      expect(last.data.tables).toHaveLength(6);
      // heavy 是 5min 一轮
      expect(r.body.samples[1].tsMs - r.body.samples[0].tsMs).toBe(300_000);
    } finally { await close(); }
  });

  it('limit 生效，非法 limit 回满 60 点（不是空数组）', async () => {
    const { call, close } = await startApp();
    try {
      expect((await call('/api/monitor/db/history?limit=5')).body.samples).toHaveLength(5);
      expect((await call('/api/monitor/db/history?limit=abc')).body.samples).toHaveLength(60);
      expect((await call('/api/monitor/db/history?limit=-3')).body.samples).toHaveLength(60);
    } finally { await close(); }
  });

  it('两次调用 deepEqual', async () => {
    const { call, close } = await startApp();
    try {
      const a = await call('/api/monitor/db/history');
      const b = await call('/api/monitor/db/history');
      expect(a.body).toEqual(b.body);
    } finally { await close(); }
  });
});

describe('演示模式 · 慢查询 GET /api/monitor/db/slow-queries', () => {
  beforeEach(() => vi.stubEnv('OPENLOG_DEMO', '1'));

  it('回 5 条真实感慢查询：SQL 摘要 + 耗时 > 阈值 + 次数（时间倒序）', async () => {
    const { call, deps, close } = await startApp();
    try {
      const r = await call('/api/monitor/db/slow-queries');
      expect(r.status).toBe(200);
      expect(r.body.demo).toBe(true);
      expect(r.body.threshold).toBe(200);
      expect(r.body.source).toBe('memory');
      expect(r.body.items.length).toBeGreaterThanOrEqual(3);
      expect(r.body.items.length).toBeLessThanOrEqual(5);

      for (const item of r.body.items) {
        expect(Object.keys(item).sort()).toEqual(['fingerprint', 'ms', 'sample', 'source', 'ts_ms']);
        expect(item.ms).toBeGreaterThan(r.body.threshold); // 低于阈值的不会进慢查询
        expect(typeof item.fingerprint).toBe('string');
        expect(item.fingerprint.length).toBeGreaterThan(20);
        // 指纹里不能留参数值（真实实现就是为了脱敏才指纹化）
        expect(item.fingerprint).not.toMatch(/'[^']*'/);
        expect(item.source).toMatch(/^db\.(all|get|run)$/);
        expect(item.ts_ms).toBeLessThanOrEqual(DEMO_INFRA_NOW_MS);
      }
      // 最新在前
      const times = r.body.items.map((i) => i.ts_ms);
      expect([...times].sort((a, b) => b - a)).toEqual(times);

      expectNoRealDbDeps(deps.dbDeps);
    } finally { await close(); }
  });

  it('limit 生效', async () => {
    const { call, close } = await startApp();
    try {
      expect((await call('/api/monitor/db/slow-queries?limit=2')).body.items).toHaveLength(2);
    } finally { await close(); }
  });
});

describe('演示模式 · 表体积 GET /api/monitor/db/tables', () => {
  beforeEach(() => vi.stubEnv('OPENLOG_DEMO', '1'));

  it('回 6 张表（含 ts_sample / ts_series 大数据表），体积降序、时间与 heavy 采样一致', async () => {
    const { call, deps, close } = await startApp();
    try {
      const overview = await call('/api/monitor/db');
      const r = await call('/api/monitor/db/tables');
      expect(r.status).toBe(200);
      expect(r.body.demo).toBe(true);
      expect(r.body.available).toBe(true);
      expect(r.body.total).toBe(6);
      expect(r.body.tables).toHaveLength(6);
      expect(r.body.tsMs).toBe(overview.body.lastHeavy.tsMs);

      const names = r.body.tables.map((t) => t.relname);
      expect(names).toEqual(DEMO_DB_TABLE_NAMES);
      expect(names).toContain('ts_sample');
      expect(names).toContain('ts_series');
      // 大数据表排第一（体积降序）
      expect(names[0]).toBe('ts_sample');

      // 体积降序、行数正数、命中率在 (0,1]
      const bytes = r.body.tables.map((t) => t.bytes);
      expect([...bytes].sort((a, b) => b - a)).toEqual(bytes);
      for (const t of r.body.tables) {
        expect(Object.keys(t).sort()).toEqual(
          ['bytes', 'deadTup', 'idxScan', 'indexHitRate', 'liveTup', 'relname', 'seqScan'],
        );
        expect(t.liveTup).toBeGreaterThan(0);
        expect(t.deadTup).toBeLessThan(t.liveTup);
      }

      expectNoRealDbDeps(deps.dbDeps);
    } finally { await close(); }
  });

  it('limit 生效，total 仍是全表数', async () => {
    const { call, close } = await startApp();
    try {
      const r = await call('/api/monitor/db/tables?limit=3');
      expect(r.body.tables).toHaveLength(3);
      expect(r.body.total).toBe(6);
    } finally { await close(); }
  });
});

describe('演示模式 · 接口监控 GET /api/monitor/api', () => {
  beforeEach(() => vi.stubEnv('OPENLOG_DEMO', '1'));

  it('qps / 错误率 / p95 与路由明细自洽，慢接口 Top5 按 p95 降序', async () => {
    const { call, deps, close } = await startApp();
    try {
      const r = await call('/api/monitor/api');
      expect(r.status).toBe(200);
      expect(r.body.demo).toBe(true);
      expect(r.body.enabled).toBe(true);
      expect(r.body.window).toBe('5m');
      expect(r.body.windowMs).toBe(300_000);
      expect(r.body.source).toBe('memory');

      // 总调用数 = 各路由 calls 之和；qps = 总调用数 / 窗口秒数
      const sumCalls = r.body.routes.reduce((s, x) => s + x.calls, 0);
      expect(sumCalls).toBe(r.body.totalCalls);
      expect(r.body.qps).toBe(Math.round((r.body.totalCalls / (r.body.windowMs / 1000)) * 100) / 100);

      // 错误率 = (4xx + 5xx) / 总调用数
      const sum4 = r.body.routes.reduce((s, x) => s + x.err4xx, 0);
      const sum5 = r.body.routes.reduce((s, x) => s + x.err5xx, 0);
      expect(r.body.errorRate).toBe(Math.round((sum4 + sum5) / r.body.totalCalls * 1e4) / 1e4);

      // 每条路由：延迟分位单调、errorRate 自洽、qps 自洽
      for (const x of r.body.routes) {
        expect(x.p50).toBeLessThanOrEqual(x.p95);
        expect(x.p95).toBeLessThanOrEqual(x.p99);
        expect(x.p99).toBeLessThanOrEqual(x.max);
        expect(x.qps).toBe(Math.round((x.calls / (r.body.windowMs / 1000)) * 100) / 100);
        if (x.calls > 0) expect(x.errorRate).toBe(Math.round(((x.err4xx + x.err5xx) / x.calls) * 1e4) / 1e4);
      }

      // 慢接口 Top5：p95 降序，最慢的是 K8s overview
      expect(r.body.slowest).toHaveLength(5);
      const slowP95 = r.body.slowest.map((x) => x.p95);
      expect([...slowP95].sort((a, b) => b - a)).toEqual(slowP95);
      expect(r.body.slowest[0].route).toBe('/api/k8s/clusters/:id/overview');
      expect(r.body.slowest[0].p95).toBeGreaterThan(500);

      // 错误榜只收 5xx
      expect(r.body.errorTop.length).toBeGreaterThan(0);
      for (const x of r.body.errorTop) expect(x.err5xx).toBeGreaterThan(0);

      // 存储统计与 DB 面板同一份口径
      expect(r.body.storage.rows).toBe(1_382_400);
      expect(r.body.dropped).toBe(0);
      expect(r.body.unavailable).toEqual([]);

      expect(deps.apiDeps.registry.snapshot).not.toHaveBeenCalled();
      expect(deps.apiDeps.store.stats).not.toHaveBeenCalled();
      expect(deps.apiDeps.probes.snapshot).not.toHaveBeenCalled();
    } finally { await close(); }
  });

  it('三个窗口的 QPS 一致，总调用数随窗口缩放', async () => {
    const { call, close } = await startApp();
    try {
      const five = await call('/api/monitor/api?window=5m');
      const one = await call('/api/monitor/api?window=1m');
      const hour = await call('/api/monitor/api?window=1h');
      expect(one.body.windowMs).toBe(60_000);
      expect(hour.body.windowMs).toBe(3_600_000);
      expect(one.body.qps).toBe(five.body.qps);
      expect(hour.body.qps).toBe(five.body.qps);
      expect(one.body.totalCalls).toBeLessThan(five.body.totalCalls);
      expect(hour.body.totalCalls).toBeGreaterThan(five.body.totalCalls);
      // 非法窗口回退 5m
      expect((await call('/api/monitor/api?window=42d')).body.window).toBe('5m');
    } finally { await close(); }
  });

  it('两次调用 deepEqual', async () => {
    const { call, close } = await startApp();
    try {
      const a = await call('/api/monitor/api');
      const b = await call('/api/monitor/api');
      expect(a.body).toEqual(b.body);
    } finally { await close(); }
  });
});

describe('演示模式 · 库信息 GET /api/db/info', () => {
  beforeEach(() => vi.stubEnv('OPENLOG_DEMO', '1'));

  it('回 type=postgres / ready=true，体积与表数自洽，且不碰本机库', async () => {
    const { call, close } = await startApp();
    try {
      const r = await call('/api/db/info');
      expect(r.status).toBe(200);
      expect(r.body.demo).toBe(true);
      expect(r.body.type).toBe('postgres');
      expect(r.body.dialect).toBe('postgresql');
      expect(r.body.ready).toBe(true);
      expect(r.body.ok).toBe(true);
      expect(r.body.pool).toEqual({ total: 10, idle: 6, waiting: 0, max: 10 });
      expect(r.body.tableCount).toBe(6);
      expect(r.body.version).toContain('PostgreSQL 16');
      expect(r.body.storage.kind).toBe('database');
      // 库级大小 > 表体积之和（索引/系统表/空闲页），这正是真实库里的关系
      expect(r.body.storage.bytes).toBeGreaterThan(5_000_000_000);
      expect(r.body.timestamp).toBe(new Date(DEMO_INFRA_NOW_MS).toISOString());

      expectNoRealDbIndex();
    } finally { await close(); }
  });

  it('?counts=1 附带关键表行数，且与表体积面板同一批表', async () => {
    const { call, close } = await startApp();
    try {
      const r = await call('/api/db/info?counts=1');
      expect(r.body.counts).toBeTruthy();
      const names = Object.keys(r.body.counts);
      for (const t of DEMO_DB_TABLE_NAMES) expect(names).toContain(t);
      expect(r.body.counts.ts_sample).toBe(12_480_000);
      expect(r.body.countsMeta.ts_sample).toBe('estimate');
      expect(r.body.countsMeta.analysis_records).toBe('exact');
    } finally { await close(); }
  });

  it('两次调用 deepEqual', async () => {
    const { call, close } = await startApp();
    try {
      const a = await call('/api/db/info?counts=1');
      const b = await call('/api/db/info?counts=1');
      expect(a.body).toEqual(b.body);
    } finally { await close(); }
  });
});

describe('演示模式 · 外部数据源 GET /api/monitor/datasources', () => {
  beforeEach(() => vi.stubEnv('OPENLOG_DEMO', '1'));

  it('回 2 个数据源（Prometheus + HTTP 服务），带状态与最近抓取时间，不读登记表', async () => {
    const { call, deps, close } = await startApp();
    try {
      const r = await call('/api/monitor/datasources');
      expect(r.status).toBe(200);
      expect(r.body.demo).toBe(true);
      expect(r.body.available).toBe(true);
      expect(r.body.items).toHaveLength(2);

      const [prom, http] = r.body.items;
      expect(prom.baseUrl).toContain(':9090');
      expect(prom.kind).toBe('service');
      expect(http.baseUrl).toContain(':8000');
      expect(http.lastStatus).toBe('error');
      expect(http.lastError).toBeTruthy();

      for (const item of r.body.items) {
        expect(item).toMatchObject({
          kind: 'service', enabled: true, hasPassword: false, passwordMasked: '',
        });
        expect(['ok', 'error']).toContain(item.lastStatus);
        expect(item.lastProbeAt).toBeLessThanOrEqual(DEMO_INFRA_NOW_MS);
        expect(item.createdAt).toBeLessThan(item.lastProbeAt);
        // 绝不出现明文密码字段
        expect(item.password).toBeUndefined();
      }

      expect(deps.dsDeps.store.list).not.toHaveBeenCalled();
    } finally { await close(); }
  });

  it('discover 不扫真实容器：候选为空但字段齐全', async () => {
    const { call, deps, close } = await startApp();
    try {
      const r = await call('/api/monitor/datasources/discover');
      expect(r.status).toBe(200);
      expect(r.body.demo).toBe(true);
      expect(r.body.available).toBe(true);
      expect(r.body.dbCandidates).toEqual([]);
      expect(r.body.serviceCandidates).toEqual([]);
      expect(r.body.errors).toEqual([]);
      expect(deps.dsDeps.listContainers).not.toHaveBeenCalled();
      expect(deps.dsDeps.inspectContainer).not.toHaveBeenCalled();
      expect(deps.dsDeps.getDockerConfig).not.toHaveBeenCalled();
    } finally { await close(); }
  });
});

// ─── 演示模式：写端点一律 409 ─────────────────────────────────────────────

describe('演示模式 · 写操作一律 409 DEMO_DISABLED', () => {
  beforeEach(() => vi.stubEnv('OPENLOG_DEMO', '1'));

  const WRITES = [
    ['POST', '/api/monitor/db/sample'],
    ['DELETE', '/api/monitor/db/slow-queries'],
    ['POST', '/api/monitor/datasources/adopt'],
    ['POST', '/api/monitor/datasources/test'],
    ['POST', '/api/monitor/datasources/probe-docs'],
    ['POST', '/api/monitor/datasources/ds-1/probe'],
    ['PUT', '/api/monitor/datasources/ds-1'],
    ['DELETE', '/api/monitor/datasources/ds-1'],
  ];

  for (const [method, pathname] of WRITES) {
    it(`${method} ${pathname} → 409`, async () => {
      const { call, deps, close } = await startApp();
      try {
        const r = await call(pathname, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: method === 'DELETE' ? undefined : JSON.stringify({ id: 'ds-1', containerId: 'abc' }),
        });
        expect(r.status).toBe(409);
        expect(r.body).toEqual({ demo: true, error: '演示模式：该操作已被禁用' });
      } finally { await close(); }
    });
  }

  it('写操作既不采样本、也不落库、也不发起外部连接', async () => {
    const { post, deps, close } = await startApp();
    try {
      await post('/api/monitor/db/sample', {});
      await post('/api/monitor/datasources/test', { kind: 'db', host: '10.0.0.9', port: 5432 });
      await post('/api/monitor/datasources/probe-docs', { baseUrl: 'http://10.0.0.9:9090' });

      expect(deps.dbDeps.sampler.sample).not.toHaveBeenCalled();
      expect(deps.dsDeps.probeDb).not.toHaveBeenCalled();
      expect(deps.dsDeps.probeDocs).not.toHaveBeenCalled();
      expect(deps.dsDeps.store.upsert).not.toHaveBeenCalled();
      expect(deps.dsDeps.store.remove).not.toHaveBeenCalled();
      expect(deps.dsDeps.store.recordProbe).not.toHaveBeenCalled();
      expect(deps.dsDeps.fetchImpl).not.toHaveBeenCalled();
      expectNoRealDbIndex();
    } finally { await close(); }
  });
});

// ─── 关闭开关：必须回到真实分支（无 demo 字段）────────────────────────────

describe('关闭演示模式 · 读端点走真实分支', () => {
  it('OPENLOG_DEMO 未设置时 /api/monitor/db 读 sampler，且响应无 demo 字段', async () => {
    const { call, deps, close } = await startApp();
    try {
      const r = await call('/api/monitor/db');
      expect(r.status).toBe(200);
      expect(r.body.demo).toBeUndefined();
      expect(r.body.enabled).toBe(true);
      expect(r.body.type).toBe('sqlite');
      expect(r.body.pool).toBeNull();
      expect(r.body.lastLight.tsMs).toBe(1_700_000_000_000);
      expect(deps.dbDeps.sampler.snapshot).toHaveBeenCalled();
      expect(deps.dbDeps.store.stats).toHaveBeenCalled();
      expect(deps.dbDeps.dbInfo).toHaveBeenCalled();
    } finally { await close(); }
  });

  it('history 真的去查 db_metric_sample', async () => {
    const { call, deps, close } = await startApp();
    try {
      const r = await call('/api/monitor/db/history?limit=10');
      expect(r.body.demo).toBeUndefined();
      expect(r.body.kind).toBe('light');
      expect(r.body.samples).toHaveLength(1);
      expect(r.body.samples[0].data).toEqual({ probeMs: 1 });
      expect(deps.dbDeps.db.all).toHaveBeenCalled();
    } finally { await close(); }
  });

  it('slow-queries / tables 读内存缓冲与 heavy 快照', async () => {
    const { call, deps, close } = await startApp();
    try {
      const slow = await call('/api/monitor/db/slow-queries');
      expect(slow.body.demo).toBeUndefined();
      expect(slow.body.source).toBe('memory');
      expect(slow.body.items[0].fingerprint).toBe('select ?');
      expect(deps.dbDeps.slowQueryLog.list).toHaveBeenCalled();

      const tables = await call('/api/monitor/db/tables');
      expect(tables.body.demo).toBeUndefined();
      expect(tables.body.available).toBe(true);
      expect(tables.body.tables[0].relname).toBe('log_records');
    } finally { await close(); }
  });

  it('/api/monitor/api 读 registry 快照', async () => {
    const { call, deps, close } = await startApp();
    try {
      const r = await call('/api/monitor/api');
      expect(r.body.demo).toBeUndefined();
      expect(r.body.totalCalls).toBe(42);
      expect(r.body.routes[0].route).toBe('/api/real');
      expect(deps.apiDeps.registry.snapshot).toHaveBeenCalled();
      expect(deps.apiDeps.store.stats).toHaveBeenCalled();
    } finally { await close(); }
  });

  it('/api/db/info 读本机库', async () => {
    const { call, close } = await startApp();
    try {
      const r = await call('/api/db/info');
      expect(r.body.demo).toBeUndefined();
      expect(r.body.type).toBe('sqlite');
      expect(r.body.storage).toEqual({ kind: 'file', bytes: 4096 });
      expect(dbIndexMock.getDbInfo).toHaveBeenCalled();
      expect(dbIndexMock.pingDb).toHaveBeenCalled();
    } finally { await close(); }
  });

  it('/api/monitor/datasources 读登记表；写操作真的写', async () => {
    const { call, post, deps, close } = await startApp();
    try {
      const list = await call('/api/monitor/datasources');
      expect(list.body.demo).toBeUndefined();
      expect(list.body.items[0].id).toBe('real-ds');
      expect(deps.dsDeps.store.list).toHaveBeenCalled();

      const adopt = await post('/api/monitor/datasources/adopt', { containerId: 'abc' });
      expect(adopt.status).toBe(200);
      expect(deps.dsDeps.inspectContainer).toHaveBeenCalled();
    } finally { await close(); }
  });
});

// ─── startMonitor()：演示模式下不采真机、不广播 ───────────────────────────
//
// 这一段**必须起真进程**：startMonitor 是 server/index.js 里的模块级函数（没有导出，
// 顶层还会 initDatabase + listen），vi.mock 只能改写本进程的模块图，改不了子进程里
// `import * as si from 'systeminformation'` 的行为。所以照 api.test.js 的做法，
// 用 `--import <data:URL>` 在子进程模块图加载**之前**把 si 换成一个「调用就记账」的桩：
//   · 记账写进临时文件 —— 演示模式下这个文件必须一行都没有；
//   · WS 连上去听 7 秒（刷新间隔 5s，正常情况至少广播一次）—— 不能出现 {type:'monitor'}；
//   · stdout 里必须有「演示模式：跳过本机指标采集与远程采集」这一行。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/** 子进程的固定 token（wss 的 verifyClient 没有回环旁路，握手必须带 token） */
const DEMO_WS_TOKEN = 'demo-infra-test-token';

/** 连主 WS：token 走 Sec-WebSocket-Protocol（`openlog.v1` + `token.<token>`），不用 query */
function openMainWs(port) {
  return new WebSocket(`ws://127.0.0.1:${port}/ws`, ['openlog.v1', `token.${DEMO_WS_TOKEN}`]);
}

/** 生成给子进程用的 si 桩（data:URL）：每次调用都往 logFile 追加一行 */
function buildSiSpyUrl(logFile) {
  const serverEntry = pathToFileURL(path.join(PROJECT_ROOT, 'server', 'index.js')).href;
  const src = [
    "import { createRequire } from 'node:module';",
    "import fs from 'node:fs';",
    `const require = createRequire(${JSON.stringify(serverEntry)});`,
    "const si = require('systeminformation');",
    `const log = (name) => { try { fs.appendFileSync(${JSON.stringify(logFile)}, name + '\\n'); } catch {} };`,
    // 记账 + 返回**可用**的假数据：故意不抛错 —— startMonitor 的真实分支要能跑完
    // 一轮才会 broadcast，负向对照（关闭演示模式）才有东西可断言。
    'si.currentLoad = async () => { log("currentLoad"); return { currentLoad: 12.5, cpus: [{ load: 10 }, { load: 15 }] }; };',
    'si.mem = async () => { log("mem"); return { used: 1e9, total: 8e9, free: 7e9 }; };',
    'si.fsSize = async () => { log("fsSize"); return [{ fs: "/dev/stub0", mount: "/", used: 1e9, size: 4e9, use: 25 }]; };',
    'si.networkStats = async () => { log("networkStats"); return [{ iface: "eth0", rx_sec: 1000, tx_sec: 500 }]; };',
  ].join('\n');
  return 'data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64');
}

/** 找一个空闲端口：写死端口会在并行跑测试时和别人的调试进程撞上 */
async function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** 轮询等子进程就绪（/api/demo 无鉴权，且演示模式一定回 {demo:true}） */
async function waitReady(base, timeoutMs, getLog) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${base}/api/demo`);
      if (res.status === 200) return await res.json();
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`演示服务未在 ${timeoutMs}ms 内就绪，子进程日志：\n${getLog()}`);
}

describe('演示模式 · startMonitor() 不采真机、不广播', () => {
  it('7 秒内没有 {type:"monitor"} 广播、si 一次没调、日志只打一行跳过说明', { timeout: 60_000 }, async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openlog-demo-infra-'));
    const siLog = path.join(tmpDir, 'si-calls.log');
    const port = await findFreePort();
    const base = `http://127.0.0.1:${port}`;

    let out = '';
    const child = spawn('node', ['--import', buildSiSpyUrl(siLog), 'server/index.js'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: 'test',
        OPENLOG_DEMO: '1',
        // 集中采集与 TSDB 自采集都会碰真实主机/本机指标：本用例只考察 startMonitor，
        // 把它们关掉，si 的记账文件才有「只可能来自 startMonitor」的确定含义。
        OPENLOG_TOKEN: DEMO_WS_TOKEN,
        OPENLOG_METRICS: 'off',
        OPENLOG_TSDB: 'off',
        OPENLOG_DATA_DIR: path.join(tmpDir, 'data'),
        OPENLOG_SETTINGS_PATH: path.join(tmpDir, 'settings.json'),
        REMOTE_CONFIG_PATH: path.join(tmpDir, 'remote-servers.json'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    const getLog = () => out;

    const frames = [];
    let ws;
    try {
      const health = await waitReady(base, 40_000, getLog);
      expect(health).toEqual({ demo: true });

      // 连主 WS：正常模式下 startMonitor 每 5s 会推一次 {type:'monitor'}
      ws = openMainWs(port);
      ws.on('message', (raw) => {
        try { frames.push(JSON.parse(raw.toString())); } catch { /* 非 JSON 帧忽略 */ }
      });
      await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });

      // 7s > 默认刷新间隔 5s：真实模式下这里至少会收到一条 monitor 帧
      await new Promise((r) => setTimeout(r, 7_000));

      // ① 没有任何 monitor 广播
      expect(frames.filter((f) => f && f.type === 'monitor')).toEqual([]);
      // ② systeminformation 一次都没被调（桩会记账）
      expect(fs.existsSync(siLog) ? fs.readFileSync(siLog, 'utf8') : '').toBe('');
      // ③ 日志里那行跳过说明
      expect(out).toContain('演示模式：跳过本机指标采集与远程采集');
      // ④ 演示模式下 statsScheduler 不注册：子进程有自己的模块图（这里的 spy 看不见它），
      //    所以这条约束落在下面的源码断言上。
    } finally {
      try { ws?.close(); } catch { /* ignore */ }
      child.kill('SIGKILL');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('源码约束 · index.js 的两个采集定时器都被演示模式短路', () => {
  const src = fs.readFileSync(path.join(PROJECT_ROOT, 'server', 'index.js'), 'utf8');

  it('startMonitor 的第一条语句是演示模式早退', () => {
    const body = src.slice(src.indexOf('function startMonitor()'));
    const guardAt = body.indexOf('isDemoMode()');
    const intervalAt = body.indexOf('setInterval');
    expect(guardAt).toBeGreaterThan(-1);
    expect(intervalAt).toBeGreaterThan(-1);
    // 早退必须发生在注册定时器之前，且早退块里确实 return 了
    expect(guardAt).toBeLessThan(intervalAt);
    expect(body.slice(guardAt, intervalAt)).toMatch(/return;/);
  });

  it('statsScheduler.start() 被 !isDemoMode() 守着', () => {
    expect(src).toMatch(/if \(!isDemoMode\(\)\) statsScheduler\.start\(\);/);
    expect(src).not.toMatch(/^\s*statsScheduler\.start\(\);$/m);
  });
});

// ─── 不启动演示模式时，子进程仍应正常采集（负向对照）──────────────────────
//
// 只验证「打开开关让采集停下」是不够的：如果 startMonitor 被写成了永远不跑，
// 上面那组断言照样全绿。这里做一次负向对照 —— 关掉开关，7 秒内必须能看到
// {type:'monitor'} 帧（说明定时器确实在工作，只是被演示模式短路了）。
describe('负向对照 · 关闭演示模式时 startMonitor 照常广播', () => {
  it('7 秒内收到 {type:"monitor"}，且 si 被调用', { timeout: 60_000 }, async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openlog-real-infra-'));
    const siLog = path.join(tmpDir, 'si-calls.log');
    const port = await findFreePort();
    const base = `http://127.0.0.1:${port}`;

    let out = '';
    const child = spawn('node', ['--import', buildSiSpyUrl(siLog), 'server/index.js'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: 'test',
        OPENLOG_DEMO: '0',
        OPENLOG_TOKEN: DEMO_WS_TOKEN,
        OPENLOG_METRICS: 'off',
        OPENLOG_TSDB: 'off',
        OPENLOG_DATA_DIR: path.join(tmpDir, 'data'),
        OPENLOG_SETTINGS_PATH: path.join(tmpDir, 'settings.json'),
        REMOTE_CONFIG_PATH: path.join(tmpDir, 'remote-servers.json'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });

    const frames = [];
    let ws;
    try {
      await waitReady(base, 40_000, () => out);
      ws = openMainWs(port);
      ws.on('message', (raw) => {
        try { frames.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
      });
      await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });

      // 5s 的刷新间隔 → 等 8s 一定至少有一轮
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline && frames.filter((f) => f && f.type === 'monitor').length === 0) {
        await new Promise((r) => setTimeout(r, 250));
      }

      const monitorFrames = frames.filter((f) => f && f.type === 'monitor');
      expect(monitorFrames.length).toBeGreaterThan(0);
      // 真实分支被走到时 si 一定被调（桩会抛错 → startMonitor 的 catch 打 Monitor error）
      expect(fs.existsSync(siLog) && fs.readFileSync(siLog, 'utf8').length > 0).toBe(true);
      expect(out).not.toContain('演示模式：跳过本机指标采集与远程采集');
    } finally {
      try { ws?.close(); } catch { /* ignore */ }
      child.kill('SIGKILL');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
