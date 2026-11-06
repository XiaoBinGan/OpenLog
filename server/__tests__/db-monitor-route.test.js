/**
 * #13 db-router 单测：server/routes/db-monitor.js
 *
 * 真实 express + http.createServer + 原生 fetch（项目惯例，见 metrics-middleware.test.js）。
 * deps 全部用假对象：这里要验证的是「依赖缺失/抛错时端点仍然 200 且字段可判读」，
 * 而不是采样/落库本身的正确性（那由各模块自己的单测覆盖）。
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import http from 'http';
import { createDbMonitorRouter, summarizeSample } from '../routes/db-monitor.js';

/** 起一个真 app：路由自己写全路径，所以直接 app.use，不加前缀 */
async function startApp(deps) {
  const app = express();
  app.use(createDbMonitorRouter(deps));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

/** 假 sampler：snapshot 的返回/抛错都由用例决定 */
function makeSampler({ snap, throws } = {}) {
  return {
    sample: vi.fn(async () => ({ ok: true, kind: 'light', tsMs: 1700000000000, probeMs: 0.42, unavailable: [] })),
    snapshot: vi.fn(() => {
      if (throws) throw new Error('snapshot boom');
      return snap;
    }),
  };
}

const LIGHT = { tsMs: 1700000000000, kind: 'light', probeMs: 0.7, sqlite: { pageCount: 10 }, unavailable: [] };
const HEAVY = {
  tsMs: 1699999000000, kind: 'heavy',
  tables: [
    { relname: 'log_records', bytes: 900, liveTup: 12, deadTup: 1, idxScan: 3, seqScan: 1, indexHitRate: 0.75 },
    { relname: 'kv_store', bytes: 2048, liveTup: 4, deadTup: 0, idxScan: 9, seqScan: 0, indexHitRate: 1 },
  ],
};

const SNAP_OK = { lastLight: LIGHT, lastHeavy: HEAVY, lastError: null, samples: 7, unavailable: ['pg_stat_activity'], running: false };

const STORE = { stats: vi.fn(async () => ({ rows: 3, approxBytes: 4096, tables: [{ table: 'api_metrics_minute', rows: 3 }] })) };
const dbInfo = () => ({ type: 'sqlite', pool: null, sqlite: { path: '/tmp/x.db' } });

describe('GET /api/monitor/db', () => {
  it('正常返回结构；unavailable 原样透出（权限不足的唯一出口）', async () => {
    const { base, close } = await startApp({ sampler: makeSampler({ snap: SNAP_OK }), store: STORE, dbInfo });
    try {
      const res = await fetch(`${base}/api/monitor/db`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.enabled).toBe(true);
      expect(body.type).toBe('sqlite');
      expect(body.pool).toBe(null);
      expect(body.lastLight).toEqual(LIGHT);
      expect(body.lastHeavy).toEqual(HEAVY);
      // 原样透出：不合并、不过滤、不改成 0
      expect(body.unavailable).toEqual(['pg_stat_activity']);
      expect(body.tables).toEqual(HEAVY.tables);
      expect(body.probeMs).toBe(0.7);
      expect(body.storage).toEqual({ rows: 3, approxBytes: 4096, tables: [{ table: 'api_metrics_minute', rows: 3 }] });
    } finally { await close(); }
  });

  it('sampler.snapshot() 抛错 → 200，lastLight/lastHeavy 为 null，原因进 unavailable', async () => {
    const { base, close } = await startApp({ sampler: makeSampler({ throws: true }), store: STORE, dbInfo });
    try {
      const res = await fetch(`${base}/api/monitor/db`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.lastLight).toBe(null);
      expect(body.lastHeavy).toBe(null);
      expect(body.probeMs).toBe(null);
      expect(body.tables).toEqual([]);
      expect(body.unavailable).toHaveLength(1);
      expect(body.unavailable[0]).toContain('sampler.snapshot');
    } finally { await close(); }
  });

  it('store.stats() 抛错 → 200 且 storage 为 null（不是 0 行）', async () => {
    const store = { stats: vi.fn(async () => { throw new Error('stats boom'); }) };
    const { base, close } = await startApp({ sampler: makeSampler({ snap: SNAP_OK }), store, dbInfo });
    try {
      const res = await fetch(`${base}/api/monitor/db`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.storage).toBe(null);
      expect(body.lastLight).toEqual(LIGHT);
    } finally { await close(); }
  });

  it('依赖全为 null → 200 且各字段 null / 空数组', async () => {
    const { base, close } = await startApp({});
    try {
      const res = await fetch(`${base}/api/monitor/db`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.enabled).toBe(true);
      expect(body.type).toBe(null);
      expect(body.pool).toBe(null);
      expect(body.storage).toBe(null);
      expect(body.unavailable).toEqual(['sampler 未接入']);
    } finally { await close(); }
  });

  it('enabled() false → 所有端点都只回 {enabled:false}', async () => {
    const { base, close } = await startApp({
      sampler: makeSampler({ snap: SNAP_OK }), store: STORE, slowQueryLog: { list: () => [], reset: vi.fn() }, enabled: () => false,
    });
    try {
      for (const [path, init] of [
        ['/api/monitor/db', {}],
        ['/api/monitor/db/history?kind=light', {}],
        ['/api/monitor/db/slow-queries', {}],
        ['/api/monitor/db/tables', {}],
        ['/api/monitor/db/slow-queries', { method: 'DELETE' }],
        ['/api/monitor/db/sample', { method: 'POST' }],
      ]) {
        const res = await fetch(`${base}${path}`, init);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ enabled: false });
      }
    } finally { await close(); }
  });
});

describe('GET /api/monitor/db/history', () => {
  it('没有注入 db → samples 空 + unavailable 说明，HTTP 200', async () => {
    const { base, close } = await startApp({ sampler: makeSampler({ snap: SNAP_OK }) });
    try {
      const res = await fetch(`${base}/api/monitor/db/history?kind=heavy&limit=10`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.kind).toBe('heavy');
      expect(body.samples).toEqual([]);
      expect(body.unavailable).toBe('db_metric_sample 读取未接入');
    } finally { await close(); }
  });

  it('注入 db 后读 db_metric_sample：倒序取回、升序返回、payload 解析成 data', async () => {
    const all = vi.fn(async () => ([
      { ts_ms: 2000, kind: 'light', payload: JSON.stringify({ probeMs: 2 }) },
      { ts_ms: 1000, kind: 'light', payload: 'not-json' },
    ]));
    const { base, close } = await startApp({ sampler: makeSampler({ snap: SNAP_OK }), db: { all } });
    try {
      const res = await fetch(`${base}/api/monitor/db/history?kind=light&limit=9999`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(all).toHaveBeenCalledTimes(1);
      const sql = all.mock.calls[0][0];
      expect(sql).toContain('db_metric_sample');
      expect(sql).toContain('WHERE kind = ?'); // 未注入 dbType → 按 sqlite 方言
      expect(sql).toContain('LIMIT 500'); // limit 上限 500
      expect(body.samples).toEqual([
        { tsMs: 1000, kind: 'light', data: null },
        { tsMs: 2000, kind: 'light', data: { probeMs: 2 } },
      ]);
    } finally { await close(); }
  });

  it('db.all 抛错 → 200 + samples 空 + 失败原因', async () => {
    const db = { all: vi.fn(async () => { throw new Error('permission denied for table db_metric_sample'); }) };
    const { base, close } = await startApp({ db });
    try {
      const res = await fetch(`${base}/api/monitor/db/history`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.kind).toBe('light');
      expect(body.samples).toEqual([]);
      expect(body.unavailable).toContain('permission denied');
    } finally { await close(); }
  });
});

describe('GET/DELETE /api/monitor/db/slow-queries', () => {
  it('list 返回 3 条 → 原样透出；阈值来自循环依赖实例/deps', async () => {
    const items = [
      { ts_ms: 3, fingerprint: 'select * from t where id = ?', ms: 900, source: null, sample: 'select * from t where id = ?' },
      { ts_ms: 2, fingerprint: 'select * from a', ms: 700, source: 'remote.files', sample: 'select * from a' },
      { ts_ms: 1, fingerprint: 'select * from b', ms: 400, source: null, sample: 'select * from b' },
    ];
    const list = vi.fn(() => items);
    const { base, close } = await startApp({ slowQueryLog: { list, reset: vi.fn() }, slowQueryThresholdMs: 200 });
    try {
      const res = await fetch(`${base}/api/monitor/db/slow-queries?limit=3`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.threshold).toBe(200);
      expect(body.items).toEqual(items);
      expect(list).toHaveBeenCalledWith(3);
    } finally { await close(); }
  });

  it('slowQueryLog 未接入 → 200 + items 空 + unavailable', async () => {
    const { base, close } = await startApp({});
    try {
      const res = await fetch(`${base}/api/monitor/db/slow-queries`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.threshold).toBe(null);
      expect(body.items).toEqual([]);
      expect(body.unavailable).toBe('slowQueryLog 未接入');
    } finally { await close(); }
  });

  it('DELETE 调用 reset() 并回 {cleared:true}', async () => {
    const reset = vi.fn();
    const { base, close } = await startApp({ slowQueryLog: { list: () => [], reset } });
    try {
      const res = await fetch(`${base}/api/monitor/db/slow-queries`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ cleared: true });
      expect(reset).toHaveBeenCalledTimes(1);
    } finally { await close(); }
  });
});

describe('POST /api/monitor/db/sample', () => {
  it('触发 sampler.sample("light") 并返回摘要', async () => {
    const sampler = makeSampler({ snap: SNAP_OK });
    const { base, close } = await startApp({ sampler });
    try {
      const res = await fetch(`${base}/api/monitor/db/sample`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(sampler.sample).toHaveBeenCalledWith('light');
      expect(body).toEqual({ ok: true, kind: 'light', tsMs: 1700000000000, probeMs: 0.42, unavailable: [] });
    } finally { await close(); }
  });

  it('sample 抛错 → 200 + error 字段（不是 500）', async () => {
    const sampler = { sample: vi.fn(async () => { throw new Error('sample boom'); }), snapshot: vi.fn(() => SNAP_OK) };
    const { base, close } = await startApp({ sampler });
    try {
      const res = await fetch(`${base}/api/monitor/db/sample`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain('sample boom');
    } finally { await close(); }
  });

  it('summarizeSample：sampler 自己返回 ok:false/error 时也要显式带出', () => {
    expect(summarizeSample({ ok: false, kind: 'light', error: 'pw 权限不足' }))
      .toMatchObject({ ok: false, error: 'pw 权限不足', unavailable: [] });
    expect(summarizeSample({ ok: true, kind: 'light', busy: true, skipped: true }))
      .toMatchObject({ ok: true, busy: true, skipped: true, tsMs: null });
    expect(summarizeSample(null)).toMatchObject({ ok: false, error: 'sampler.sample() 无返回值' });
  });
});

describe('GET /api/monitor/db/tables', () => {
  it('lastHeavy 为空 → {available:false} + 原因（不是空数组冒充「没有表」）', async () => {
    const snap = { lastLight: LIGHT, lastHeavy: { tsMs: 1, kind: 'heavy', quickCheck: { skipped: true } }, unavailable: [] };
    const { base, close } = await startApp({ sampler: makeSampler({ snap }) });
    try {
      const res = await fetch(`${base}/api/monitor/db/tables`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.available).toBe(false);
      expect(body.tables).toEqual([]);
      expect(body.unavailable).toEqual(['lastHeavy 尚无表统计']);
    } finally { await close(); }
  });

  it('lastHeavy 有表 → 按体积降序取 top N', async () => {
    const { base, close } = await startApp({ sampler: makeSampler({ snap: SNAP_OK }) });
    try {
      const res = await fetch(`${base}/api/monitor/db/tables?limit=1`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.available).toBe(true);
      expect(body.total).toBe(2);
      expect(body.tsMs).toBe(HEAVY.tsMs);
      expect(body.tables).toEqual([{ relname: 'kv_store', bytes: 2048, liveTup: 4, deadTup: 0, indexHitRate: 1 }]);
    } finally { await close(); }
  });
});
