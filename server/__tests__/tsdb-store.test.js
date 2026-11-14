/**
 * TSDB 存储层的真实数据库测试。
 *
 * 为什么用真的 better-sqlite3 而不是 mock：
 * 存储层的绝大部分复杂度在**SQL 本身**（方言、冲突子句、参数顺序、索引）。
 * mock 掉 db 只能验证「我调用了几次 run」，验证不了「这条 SQL 在真库里跑得通」。
 * 之前 api-store 的教训就是 mock 全绿但 PG 上主键冲突静默丢数据。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTsdbStore } from '../tsdb/store.js';
import { tsdbDdl, sampleInsertSql, seriesInsertSql } from '../tsdb/schema.js';

/** 把 better-sqlite3 包成项目里的异步适配层形状（run/get/all 全 async） */
function makeAsyncAdapter(sqlite) {
  return {
    async run(sql, ...params) {
      const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
      const info = sqlite.prepare(sql).run(...flat);
      return { changes: info.changes, lastID: info.lastInsertRowid };
    },
    async get(sql, ...params) {
      const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
      return sqlite.prepare(sql).get(...flat);
    },
    async all(sql, ...params) {
      const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
      return sqlite.prepare(sql).all(...flat);
    },
  };
}

let sqlite;
let store;
let clock = 1_700_000_000_000;

beforeEach(() => {
  sqlite = new Database(':memory:');
  clock = 1_700_000_000_000;
  const adapter = makeAsyncAdapter(sqlite);
  store = createTsdbStore({
    getDb: () => adapter,
    getDbType: () => 'sqlite',
    now: () => clock,
  });
});

describe('建表', () => {
  it('幂等：重复调用不报错', async () => {
    expect(await store.ensureSchema()).toBe(true);
    expect(await store.ensureSchema()).toBe(true);
    expect(await store.ensureSchema()).toBe(true);
  });

  it('建出预期的表', async () => {
    await store.ensureSchema();
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ts_%' ORDER BY name")
      .all()
      .map((r) => r.name);
    expect(tables).toEqual(['ts_sample', 'ts_series', 'ts_target']);
  });

  it('ts_sample 的主键是 (series_id, ts_ms)', async () => {
    await store.ensureSchema();
    const info = sqlite.prepare('PRAGMA table_info(ts_sample)').all();
    const pk = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    expect(pk).toEqual(['series_id', 'ts_ms']);
  });

  it('db 未就绪时返回 false 而不是抛错', async () => {
    const s = createTsdbStore({ getDb: () => null, getDbType: () => 'sqlite' });
    expect(await s.ensureSchema()).toBe(false);
    expect((await s.stats()).error).toBeTruthy();
  });
});

describe('写入', () => {
  beforeEach(async () => {
    await store.ensureSchema();
  });

  it('写入单点', async () => {
    const r = await store.writeSamples([{ name: 'up', labels: { job: 'a' }, value: 1, timestamp: clock }]);
    expect(r).toMatchObject({ written: 1, series: 1, skipped: 0 });
    const { series } = await store.queryRange({ start: clock - 1, end: clock + 1 });
    expect(series).toHaveLength(1);
    expect(series[0].points).toEqual([{ ts: clock, value: 1 }]);
  });

  it('同一序列多点', async () => {
    await store.writeSamples([
      { name: 'm', labels: {}, value: 1, timestamp: clock },
      { name: 'm', labels: {}, value: 2, timestamp: clock + 1000 },
      { name: 'm', labels: {}, value: 3, timestamp: clock + 2000 },
    ]);
    const { series } = await store.queryRange({ start: clock, end: clock + 3000 });
    expect(series).toHaveLength(1);
    expect(series[0].points.map((p) => p.value)).toEqual([1, 2, 3]);
  });

  it('同毫秒重复写入不产生重复点（ON CONFLICT DO NOTHING）', async () => {
    await store.writeSamples([{ name: 'm', labels: {}, value: 1, timestamp: clock }]);
    await store.writeSamples([{ name: 'm', labels: {}, value: 999, timestamp: clock }]);
    const { series } = await store.queryRange({ start: clock, end: clock });
    expect(series[0].points).toHaveLength(1);
    // 保留先到的那个：补抓不该改写历史
    expect(series[0].points[0].value).toBe(1);
  });

  it('不同标签 = 不同序列', async () => {
    await store.writeSamples([
      { name: 'm', labels: { a: '1' }, value: 1, timestamp: clock },
      { name: 'm', labels: { a: '2' }, value: 2, timestamp: clock },
    ]);
    const { series } = await store.queryRange({ start: clock, end: clock });
    expect(series).toHaveLength(2);
  });

  it('标签顺序不同但内容相同 = 同一序列（指纹稳定）', async () => {
    await store.writeSamples([
      { name: 'm', labels: { a: '1', b: '2' }, value: 1, timestamp: clock },
      { name: 'm', labels: { b: '2', a: '1' }, value: 2, timestamp: clock + 1000 },
    ]);
    const { series } = await store.queryRange({ start: clock, end: clock + 2000 });
    expect(series).toHaveLength(1);
  });

  it('NaN / Infinity 被跳过（REAL 列存不了）', async () => {
    const r = await store.writeSamples([
      { name: 'm', labels: {}, value: NaN, timestamp: clock },
      { name: 'm', labels: {}, value: Infinity, timestamp: clock },
      { name: 'm', labels: {}, value: 1, timestamp: clock },
    ]);
    expect(r.written).toBe(1);
    expect(r.skipped).toBe(2);
  });

  it('非法指标名被跳过', async () => {
    const r = await store.writeSamples([{ name: '1bad', labels: {}, value: 1, timestamp: clock }]);
    expect(r.written).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it('空输入不报错', async () => {
    expect(await store.writeSamples([])).toMatchObject({ written: 0 });
    expect(await store.writeSamples(null)).toMatchObject({ written: 0 });
  });

  it('用统一时间戳兜底（单点没给 timestamp）', async () => {
    await store.writeSamples([{ name: 'm', labels: {}, value: 1 }], { timestamp: clock });
    const { series } = await store.queryRange({ start: clock, end: clock });
    expect(series[0].points[0].ts).toBe(clock);
  });

  it('大批量写入正确分块（超过单语句行数上限）', async () => {
    const many = [];
    for (let i = 0; i < 1200; i += 1) {
      many.push({ name: 'm', labels: { i: String(i % 10) }, value: i, timestamp: clock + i });
    }
    const r = await store.writeSamples(many);
    expect(r.written).toBe(1200);
    expect(r.series).toBe(10);
  });

  it('序列 id 缓存命中（第二次写同一序列不查 ts_series）', async () => {
    await store.writeSamples([{ name: 'm', labels: { a: '1' }, value: 1, timestamp: clock }]);
    const before = (await store.stats()).cachedSeries;
    await store.writeSamples([{ name: 'm', labels: { a: '1' }, value: 2, timestamp: clock + 1000 }]);
    const after = (await store.stats()).cachedSeries;
    expect(after).toBe(before);
    // ts_series 里只有一行（没有因为重复写入而插入新序列）
    const n = sqlite.prepare('SELECT COUNT(*) n FROM ts_series').get().n;
    expect(n).toBe(1);
  });
});

describe('查询', () => {
  beforeEach(async () => {
    await store.ensureSchema();
    await store.writeSamples([
      { name: 'http_requests', labels: { status: '200', method: 'GET' }, value: 10, timestamp: clock },
      { name: 'http_requests', labels: { status: '500', method: 'GET' }, value: 2, timestamp: clock },
      { name: 'http_requests', labels: { status: '200', method: 'POST' }, value: 5, timestamp: clock },
      { name: 'cpu_usage', labels: { core: '0' }, value: 0.5, timestamp: clock },
    ]);
  });

  it('按指标名过滤', async () => {
    const { series } = await store.queryRange({ metricName: 'cpu_usage', start: clock - 1, end: clock + 1 });
    expect(series).toHaveLength(1);
    expect(series[0].name).toBe('cpu_usage');
  });

  it('按标签等值过滤', async () => {
    const { series } = await store.queryRange({
      metricName: 'http_requests',
      matchers: [{ name: 'status', op: '=', value: '200' }],
      start: clock - 1, end: clock + 1,
    });
    expect(series).toHaveLength(2);
    for (const s of series) expect(s.labels.status).toBe('200');
  });

  it('按标签正则过滤', async () => {
    const { series } = await store.queryRange({
      matchers: [{ name: 'method', op: '=~', value: 'GET|POST' }],
      start: clock - 1, end: clock + 1,
    });
    expect(series.length).toBeGreaterThanOrEqual(3);
  });

  it('时间范围是闭区间', async () => {
    const exact = await store.queryRange({ start: clock, end: clock });
    expect(exact.series.length).toBeGreaterThan(0);
    const before = await store.queryRange({ start: clock - 5000, end: clock - 1 });
    expect(before.series).toHaveLength(0);
  });

  it('end < start 返回空', async () => {
    const r = await store.queryRange({ start: clock + 1000, end: clock });
    expect(r.series).toEqual([]);
  });

  it('无匹配返回空且不报错', async () => {
    const r = await store.queryRange({ metricName: 'nope', start: clock - 1, end: clock + 1 });
    expect(r.series).toEqual([]);
    expect(r.error).toBeUndefined();
  });

  it('序列内的点按时间升序', async () => {
    const { series } = await store.queryRange({ metricName: 'http_requests', start: 0, end: clock + 1 });
    for (const s of series) {
      const ts = s.points.map((p) => p.ts);
      expect(ts).toEqual([...ts].sort((a, b) => a - b));
    }
  });

  it('limit 生效并标记 truncated', async () => {
    const r = await store.queryRange({ start: 0, end: clock + 1, limit: 2 });
    const total = r.series.reduce((n, s) => n + s.points.length, 0);
    expect(total).toBeLessThanOrEqual(2);
    expect(r.truncated).toBe(true);
  });

  it('标签 JSON 坏掉时不崩（按无标签处理）', async () => {
    sqlite.prepare('UPDATE ts_series SET labels = ? WHERE fingerprint IN (SELECT fingerprint FROM ts_series LIMIT 1)').run('{not json');
    const r = await store.queryRange({ start: 0, end: clock + 1 });
    expect(r.error).toBeUndefined();
  });
});

describe('元数据查询', () => {
  beforeEach(async () => {
    await store.ensureSchema();
    await store.writeSamples([
      { name: 'a', labels: { env: 'prod', region: 'cn' }, value: 1, timestamp: clock },
      { name: 'b', labels: { env: 'dev' }, value: 1, timestamp: clock },
    ]);
  });

  it('listMetricNames 去重且排序', async () => {
    expect(await store.listMetricNames()).toEqual(['a', 'b']);
  });

  it('labelValues 取某标签的全部值', async () => {
    expect(await store.labelValues('env')).toEqual(['dev', 'prod']);
  });

  it('labelValues("__name__") 返回指标名', async () => {
    expect(await store.labelValues('__name__')).toEqual(['a', 'b']);
  });

  it('不存在的标签返回空数组', async () => {
    expect(await store.labelValues('nope')).toEqual([]);
  });
});

describe('过期清理', () => {
  beforeEach(async () => {
    await store.ensureSchema();
    await store.writeSamples([
      { name: 'old', labels: {}, value: 1, timestamp: clock - 10_000 },
      { name: 'new', labels: {}, value: 2, timestamp: clock },
    ]);
  });

  it('删掉保留期之外的点', async () => {
    const r = await store.pruneSamples(5_000);
    expect(r.deleted).toBe(1);
    const after = await store.queryRange({ start: 0, end: clock + 1 });
    expect(after.series.map((s) => s.name)).toEqual(['new']);
  });

  it('序列本身不删（历史还能解读）', async () => {
    await store.pruneSamples(5_000);
    const n = sqlite.prepare('SELECT COUNT(*) n FROM ts_series').get().n;
    expect(n).toBe(2);
  });

  it('pruneOrphanSeries 删掉没有点的序列', async () => {
    await store.pruneSamples(5_000);
    const r = await store.pruneOrphanSeries();
    expect(r.deleted).toBe(1);
    expect(await store.listMetricNames()).toEqual(['new']);
  });

  it('保留期为 0 时删掉所有早于当前时刻的点', async () => {
    // cutoff = now - 0 = now，所以 ts < now 的点全删；正好落在 now 的还留着。
    // 这正是 `ts_ms < cutoff` 的语义（左开），不是 bug —— 测试要跟着语义写。
    clock += 1;
    await store.pruneSamples(0);
    const n = sqlite.prepare('SELECT COUNT(*) n FROM ts_sample').get().n;
    expect(n).toBe(0);
  });
});

describe('存储概况', () => {
  it('返回序列数、点数、时间边界', async () => {
    await store.ensureSchema();
    await store.writeSamples([
      { name: 'a', labels: {}, value: 1, timestamp: clock },
      { name: 'a', labels: {}, value: 2, timestamp: clock + 5000 },
    ]);
    const s = await store.stats();
    expect(s.ready).toBe(true);
    expect(s.seriesCount).toBe(1);
    expect(s.sampleCount).toBe(2);
    expect(s.oldestMs).toBe(clock);
    expect(s.newestMs).toBe(clock + 5000);
  });
});

describe('SQL 方言生成', () => {
  it('SQLite 用 ? 占位符与 DO NOTHING', () => {
    const sql = sampleInsertSql('sqlite', 2);
    expect(sql).toContain('VALUES (?, ?, ?), (?, ?, ?)');
    expect(sql).toContain('ON CONFLICT (series_id, ts_ms) DO NOTHING');
  });

  it('PG 用 $n 占位符且不指名冲突列', () => {
    const sql = sampleInsertSql('postgres', 2);
    expect(sql).toContain('VALUES ($1, $2, $3), ($4, $5, $6)');
    expect(sql).toContain('ON CONFLICT DO NOTHING');
    expect(sql).not.toContain('ON CONFLICT (');
  });

  it('MySQL 用 ON DUPLICATE KEY', () => {
    const sql = sampleInsertSql('mysql', 1);
    expect(sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(sql).toContain('VALUES (?, ?, ?)');
  });

  it('PG 序列插入带 RETURNING id', () => {
    expect(seriesInsertSql('postgres')).toContain('RETURNING id');
  });

  it('MySQL 序列插入用 LAST_INSERT_ID(id) 技巧', () => {
    expect(seriesInsertSql('mysql')).toContain('LAST_INSERT_ID(id)');
  });

  it('三种方言都能生成完整 DDL', () => {
    for (const t of ['sqlite', 'postgres', 'mysql']) {
      const ddl = tsdbDdl(t);
      expect(ddl.some((s) => s.includes('ts_series'))).toBe(true);
      expect(ddl.some((s) => s.includes('ts_sample'))).toBe(true);
      expect(ddl.some((s) => s.includes('ts_target'))).toBe(true);
    }
  });

  it('MySQL 的 TEXT 主键收窄成 VARCHAR', () => {
    const ddl = tsdbDdl('mysql').join('\n');
    expect(ddl).toContain('VARCHAR');
  });
});