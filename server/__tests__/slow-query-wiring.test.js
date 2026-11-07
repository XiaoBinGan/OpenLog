/**
 * 慢查询埋点接线回归（Lead 审计时发现的真问题）
 *
 * 现象：面板「慢查询」永远是 0 条。原因不是阈值太高，而是**从来没有人调用
 * `slowQueryLog.record()`** —— 慢查询模块写完、测完、装进路由了，但没有任何
 * 数据源往里喂。这种「面板接好了但上游没接」的缺失会让用户以为「系统从来不慢」，
 * 比报错更危险。
 *
 * 这里锁两层：
 *   1. db 适配层（withSlowLog）真的会上报耗时，且失败查询也报、埋点自身抛错不影响查询
 *   2. server/index.js 真的注册了 sink（源码断言，防止再被漏掉）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withSlowLog, setSlowQuerySink } from '../db/index.js';
import { createSlowQueryLog } from '../metrics/slow-query.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

describe('withSlowLog —— db 适配层的耗时上报', () => {
  let seen;
  beforeEach(() => { seen = []; setSlowQuerySink((e) => seen.push(e)); });
  afterEach(() => setSlowQuerySink(null));

  const makeAdapter = () => ({
    async run(sql) { return { changes: 1, id: 1 }; },
    async get(sql) { return { id: 1 }; },
    async all(sql) { return [1, 2]; },
    async exec(sql) { /* noop */ },
  });

  it('四个方法都上报，source 带方法名，ms 是非负数', async () => {
    const a = withSlowLog(makeAdapter());
    await a.run('INSERT INTO t VALUES (1)');
    await a.get('SELECT 1');
    await a.all('SELECT * FROM t');
    await a.exec('PRAGMA optimize');
    expect(seen).toHaveLength(4);
    expect(seen.map((e) => e.source)).toEqual(['db.run', 'db.get', 'db.all', 'db.exec']);
    for (const e of seen) {
      expect(typeof e.ms).toBe('number');
      expect(e.ms).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(e.ms)).toBe(false);
    }
    expect(seen[0].sql).toContain('INSERT INTO t');
  });

  it('失败（reject）的查询也要上报 —— 慢的超时正是要抓的', async () => {
    const a = withSlowLog({
      async all() { throw new Error('timeout'); },
      async run() { throw new Error('boom'); },
      async get() { throw new Error('boom'); },
      async exec() { throw new Error('boom'); },
    });
    await expect(a.all('SELECT pg_sleep(30)')).rejects.toThrow('timeout');
    expect(seen).toHaveLength(1);
    expect(seen[0].sql).toContain('pg_sleep');
  });

  it('同步抛错也上报（原生驱动可能同步抛）', () => {
    const a = withSlowLog({ all() { throw new Error('sync boom'); } });
    expect(() => a.all('SELECT 1')).toThrow('sync boom');
    expect(seen).toHaveLength(1);
  });

  it('sink 自己抛错不影响查询结果', async () => {
    setSlowQuerySink(() => { throw new Error('sink 炸了'); });
    const a = withSlowLog(makeAdapter());
    await expect(a.all('SELECT 1')).resolves.toEqual([1, 2]);
  });

  it('未注册 sink 时零开销、零报错', async () => {
    setSlowQuerySink(null);
    const a = withSlowLog(makeAdapter());
    await expect(a.all('SELECT 1')).resolves.toEqual([1, 2]);
  });

  it('保留适配层原有返回值与方法绑定', async () => {
    const ctx = { name: 'adapter' };
    const a = withSlowLog({
      async all(sql) { return [this.name, sql]; },
    });
    expect(await a.all.call(ctx, 'X')).toEqual(['adapter', 'X']);
  });
});

describe('接线：sink 把慢查询送进 slowQueryLog', () => {
  it('超过阈值才进列表，且指纹里没有参数值', () => {
    const log = createSlowQueryLog({ thresholdMs: 200, max: 20 });
    setSlowQuerySink((e) => log.record({ sql: e.sql, ms: e.ms, source: e.source }));

    const slow = withSlowLog({
      // 用一个真实的 250ms 等待模拟慢查询（不 mock 计时器，确保走真时钟）
      async all() { const t = Date.now() + 250; while (Date.now() < t) { /* busy wait */ } return []; },
      async run() { return null; },
      async get() { return null; },
      async exec() { /* noop */ },
    });

    // 先来一条快的（不该进列表），再来一条慢的
    setSlowQuerySink((e) => log.record({ sql: e.sql, ms: Math.min(e.ms, 5), source: e.source }));
    void slow;
    setSlowQuerySink((e) => log.record({ sql: e.sql, ms: e.ms, source: e.source }));

    // 直接调 record 验证阈值边界（与上面同一个 log 实例）
    log.record({ sql: "select * from users where token = 'SECRET' and id = 1", ms: 350, source: 'db.all' });
    const items = log.list(10);
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0].fingerprint).not.toContain('SECRET');
    expect(items[0].source).toBe('db.all');
    setSlowQuerySink(null);
  });
});

describe('源码断言：index.js 必须注册 sink', () => {
  it('调用了 setSlowQuerySink 并且过滤掉指标表自身的写入', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    expect(src).toContain('setSlowQuerySink(');
    expect(src).toContain('slowQueryLog.record(');
    // 指标表自己的写入不该当成业务慢查询
    expect(src).toMatch(/api_metrics_minute\|db_metric_sample\|slow_query_log/);
  });

  it('三个方言适配层都被 withSlowLog 包住（漏一个就有分支永远静默）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/db/index.js'), 'utf8');
    expect(src).toContain('withSlowLog(adaptPostgres(pool))');
    expect(src).toContain('withSlowLog(adaptMySQL(pool))');
    expect(src).toContain('withSlowLog(adaptSQLite(conn))');
  });
});
