/**
 * #7 store 测试：真实 SQLite（better-sqlite3 :memory:），不打桩数据库。
 * 只跑这一个文件：cmd /c "npx vitest run server/__tests__/metrics-store.test.js"
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createApiStore, DEFAULT_MAX_ROWS, defaultKeepDays } from '../metrics/api-store.js';
import { ddlFor, upsertSql, insertSlowQuerySql, placeholder, normalizeDbType } from '../metrics/sql-dialect.js';

const MIN = 60_000;
const NOW = 1_760_000_000_000; // 固定基准时间，避免测试依赖真实时钟

function memoryStore(opts = {}) {
  const conn = new Database(':memory:');
  const store = createApiStore({ db: conn, dbType: 'sqlite', ...opts });
  return { conn, store };
}

function bucket(bucketMs, route = '/api/health', method = 'GET', extra = {}) {
  return {
    bucketMs,
    route,
    method,
    calls: 12,
    err4xx: 2,
    err5xx: 1,
    p50: 10.5,
    p95: 20.25,
    p99: 30.75,
    max: 41.5,
    ...extra,
  };
}

function countRows(conn, table = 'api_metrics_minute') {
  return conn.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

describe('ensureSchema', () => {
  it('建出 3 张表和索引，重复调用幂等', async () => {
    const { conn, store } = memoryStore();
    expect(await store.ensureSchema()).toBe(true);
    expect(await store.ensureSchema()).toBe(true);

    const tables = conn
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name)
      .sort();
    expect(tables).toEqual(['api_metrics_minute', 'db_metric_sample', 'slow_query_log']);

    const indexes = conn
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
      .all()
      .map((r) => r.name)
      .sort();
    expect(indexes).toEqual(['idx_api_metrics_minute_bucket', 'idx_slow_query_log_ts']);
  });
});

describe('writeBuckets / queryRange', () => {
  it('写入 3 条后能查出来，字段值正确', async () => {
    const { store } = memoryStore();
    await store.ensureSchema();

    const buckets = [
      bucket(NOW, '/api/health', 'GET', { calls: 3, err4xx: 0, err5xx: 0, p95: 8 }),
      bucket(NOW, '/api/docker/containers', 'POST', { calls: 7, err5xx: 2, p99: 99.5 }),
      bucket(NOW + MIN, '/api/remote/servers/:id', 'DELETE', { calls: 1, err4xx: 1, p50: 5 }),
    ];
    expect(await store.writeBuckets(buckets)).toBe(3);

    const rows = await store.queryRange({ fromMs: NOW - 1, toMs: NOW + 2 * MIN });
    expect(rows).toHaveLength(3);

    const post = rows.find((r) => r.method === 'POST');
    expect(post.route).toBe('/api/docker/containers');
    expect(post.bucketMs).toBe(NOW);
    expect(post.calls).toBe(7);
    expect(post.err4xx).toBe(2); // 来自 fixture 默认值
    expect(post.err5xx).toBe(2);
    expect(post.p99Ms).toBe(99.5);

    // route 过滤 + limit
    const filtered = await store.queryRange({ fromMs: NOW - 1, toMs: NOW + 2 * MIN, route: '/api/health' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].calls).toBe(3);
    expect(await store.queryRange({ fromMs: NOW - 1, toMs: NOW + 2 * MIN, limit: 1 })).toHaveLength(1);
    expect(await store.queryRange({ fromMs: NOW + 10 * MIN, toMs: NOW + 20 * MIN })).toEqual([]);
  });

  it('空数组直接返回 0，不发语句', async () => {
    const { store } = memoryStore();
    await store.ensureSchema();
    expect(await store.writeBuckets([])).toBe(0);
    expect(await store.writeBuckets(undefined)).toBe(0);
  });

  it('同 (bucket, method, route) 重复写 → upsert 覆盖不新增', async () => {
    const { conn, store } = memoryStore();
    await store.ensureSchema();
    const first = [bucket(NOW, '/api/a'), bucket(NOW, '/api/b'), bucket(NOW, '/api/c')];
    expect(await store.writeBuckets(first)).toBe(3);
    expect(countRows(conn)).toBe(3);

    const again = [bucket(NOW, '/api/a', 'GET', { calls: 99 }), bucket(NOW, '/api/b', 'GET', { calls: 98 }), bucket(NOW, '/api/c', 'GET', { calls: 97 })];
    expect(await store.writeBuckets(again)).toBe(3);
    expect(countRows(conn)).toBe(3);

    const rows = await store.queryRange({ fromMs: NOW - 1, toMs: NOW + MIN });
    expect(rows.map((r) => r.calls).sort((a, b) => a - b)).toEqual([97, 98, 99]);
  });
});

describe('prune', () => {
  it('删掉超过保留期的数据并返回删除行数', async () => {
    const { conn, store } = memoryStore(); // sqlite 默认保留 3 天
    await store.ensureSchema();
    const old = NOW - 5 * 86_400_000;
    await store.writeBuckets([
      bucket(old, '/api/old1'),
      bucket(old + MIN, '/api/old2'),
      bucket(NOW, '/api/fresh'),
    ]);
    expect(countRows(conn)).toBe(3);

    expect(await store.prune(NOW)).toBe(2);
    expect(countRows(conn)).toBe(1);
    const rows = await store.queryRange({ fromMs: NOW - 8 * 86_400_000, toMs: NOW + MIN });
    expect(rows.map((r) => r.route)).toEqual(['/api/fresh']);
  });

  it('慢查询表也按保留期清理', async () => {
    const { conn, store } = memoryStore();
    await store.ensureSchema();
    await store.insertSlowQuery({ tsMs: NOW - 10 * 86_400_000, fingerprint: 'select ? from t', ms: 900 });
    await store.insertSlowQuery({ tsMs: NOW, fingerprint: 'select ? from t2', ms: 800 });
    expect(countRows(conn, 'slow_query_log')).toBe(2);
    expect(await store.prune(NOW)).toBe(1);
    expect(countRows(conn, 'slow_query_log')).toBe(1);
  });

  it('行数硬上限：maxRows 注入后，写入超限自动删最旧的', async () => {
    const { conn, store } = memoryStore({ maxRows: 6 });
    await store.ensureSchema();
    const routes = ['/api/a', '/api/b', '/api/c'];
    const buckets = [];
    for (let i = 0; i < 3; i += 1) {
      for (const r of routes) buckets.push(bucket(NOW + i * MIN, r));
    }
    expect(await store.writeBuckets(buckets)).toBe(9);
    expect(countRows(conn)).toBe(6); // 超出的 3 行（最旧一个桶）被自动删掉

    const rows = await store.queryRange({ fromMs: NOW - MIN, toMs: NOW + 3 * MIN });
    expect(rows.some((r) => r.bucketMs === NOW)).toBe(false);
    expect(rows.every((r) => r.bucketMs >= NOW + MIN)).toBe(true);

    // prune 里同样会压上限（外部直接灌数据的情况）
    const dump = [];
    for (let i = 0; i < 20; i += 1) dump.push(bucket(NOW + 100 * MIN + i * MIN, '/api/x'));
    expect(await store.writeBuckets(dump)).toBe(20);
    expect(countRows(conn)).toBeLessThanOrEqual(6);
    expect(await store.prune(NOW)).toBe(0); // 已经在限内，prune 不误删
    expect(countRows(conn)).toBeLessThanOrEqual(6);
  });
});

describe('db 不可用 / 写冲突', () => {
  it('db = null 时各方法都返回空或 0，不抛', async () => {
    const store = createApiStore({ db: null, dbType: 'sqlite' });
    await expect(store.ensureSchema()).resolves.toBe(false);
    await expect(store.writeBuckets([bucket(NOW)])).resolves.toBe(0);
    await expect(store.queryRange({ fromMs: 0, toMs: NOW })).resolves.toEqual([]);
    await expect(store.prune(NOW)).resolves.toBe(0);
    await expect(store.insertSlowQuery({ ms: 1 })).resolves.toBe(false);
    await expect(store.stats()).resolves.toMatchObject({ rows: 0, approxBytes: null });
  });

  it('db.exec 抛 SQLITE_BUSY → writeBuckets 返回 0 且不抛不写脏数据', async () => {
    const { conn, store } = memoryStore();
    await store.ensureSchema();
    const realExec = conn.exec.bind(conn);
    conn.exec = () => {
      const err = new Error('SQLITE_BUSY: database is locked');
      err.code = 'SQLITE_BUSY';
      throw err;
    };
    await expect(store.writeBuckets([bucket(NOW, '/api/busy')])).resolves.toBe(0);
    conn.exec = realExec;
    expect(countRows(conn)).toBe(0);
  });

  it('INSERT 阶段抛 SQLITE_BUSY → 只丢这一批，事务回滚后不留半行', async () => {
    const { conn, store } = memoryStore();
    await store.ensureSchema();
    const realPrepare = conn.prepare.bind(conn);
    conn.prepare = (sql) => {
      if (/INSERT INTO api_metrics_minute/i.test(sql)) {
        const err = new Error('SQLITE_BUSY: database is locked');
        err.code = 'SQLITE_BUSY';
        throw err;
      }
      return realPrepare(sql);
    };
    await expect(store.writeBuckets([bucket(NOW, '/api/a'), bucket(NOW, '/api/b')])).resolves.toBe(0);
    conn.prepare = realPrepare;
    expect(countRows(conn)).toBe(0);
    expect(conn.inTransaction).toBe(false);
  });
});

describe('stats', () => {
  it('返回 rows 数字，approxBytes 是 number 或 null', async () => {
    const { store } = memoryStore();
    await store.ensureSchema();
    await store.writeBuckets([bucket(NOW, '/api/a'), bucket(NOW, '/api/b')]);

    const s = await store.stats();
    expect(typeof s.rows).toBe('number');
    expect(s.rows).toBe(2);
    expect(s.approxBytes === null || typeof s.approxBytes === 'number').toBe(true);
    if (s.approxBytes !== null) expect(s.approxBytes).toBeGreaterThan(0);
    expect(Array.isArray(s.tables)).toBe(true);
  });

  it('体积探测失败 → approxBytes 为 null，不返回 0', async () => {
    const { conn, store } = memoryStore();
    await store.ensureSchema();
    const realPrepare = conn.prepare.bind(conn);
    conn.prepare = (sql) => {
      if (/PRAGMA/i.test(sql)) throw new Error('no such pragma');
      return realPrepare(sql);
    };
    const s = await store.stats();
    conn.prepare = realPrepare;
    expect(s.approxBytes).toBeNull();
  });
});

describe('契约 4.4 导出面', () => {
  it('api-store 也导出 ddlFor（契约把它写在这），与 sql-dialect 是同一函数', async () => {
    const mod = await import('../metrics/api-store.js');
    expect(typeof mod.ddlFor).toBe('function');
    expect(mod.ddlFor).toBe(ddlFor);
    expect(mod.ddlFor('sqlite')).toHaveLength(5);
  });
});

describe('SQLite 1 万行写入实测', () => {
  it('10000 行（20 批 × 500 行）能在合理时间内写完', async () => {
    const { conn, store } = memoryStore();
    await store.ensureSchema();
    const rows = [];
    for (let i = 0; i < 10_000; i += 1) {
      rows.push(bucket(NOW + Math.floor(i / 300) * MIN, `/api/route-${i % 300}`, i % 2 ? 'GET' : 'POST'));
    }
    const t0 = performance.now();
    const written = await store.writeBuckets(rows);
    const cost = Math.round(performance.now() - t0);
    expect(written).toBe(10_000);
    expect(countRows(conn)).toBe(10_000);
    console.log(`[bench] SQLite 内存库写入 10000 行耗时 ${cost}ms`);
    expect(cost).toBeLessThan(10_000);
  });
});

describe('sql-dialect DDL', () => {
  it('PG 版含 BIGSERIAL 与 ON CONFLICT，SQLite 版不含 BIGSERIAL', () => {
    const pg = ddlFor('postgres').join('\n');
    expect(pg).toContain('BIGSERIAL');
    expect(pg).toContain('BIGINT');
    expect(pg).toContain('CREATE INDEX IF NOT EXISTS idx_api_metrics_minute_bucket');
    expect(upsertSql('postgres', 2)).toContain('ON CONFLICT (bucket_ms, method, route) DO UPDATE');
    expect(upsertSql('postgres')).toContain('$1');

    const lite = ddlFor('sqlite').join('\n');
    expect(lite).not.toContain('BIGSERIAL');
    expect(lite).toContain('INTEGER PRIMARY KEY AUTOINCREMENT');
    expect(lite).toContain('bucket_ms INTEGER NOT NULL');
    expect(upsertSql('sqlite')).toContain('ON CONFLICT');
    expect(upsertSql('sqlite')).toContain('?');

    const my = ddlFor('mysql').join('\n');
    expect(my).toContain('AUTO_INCREMENT');
    expect(upsertSql('mysql')).toContain('ON DUPLICATE KEY UPDATE');
    expect(insertSlowQuerySql('postgres')).toContain('$5');
    expect(insertSlowQuerySql('sqlite')).toContain('?');
  });

  it('占位符与类型归一辅助', () => {
    expect(placeholder('postgres', 3)).toBe('$3');
    expect(placeholder('sqlite', 3)).toBe('?');
    expect(normalizeDbType('pg')).toBe('postgres');
    expect(normalizeDbType('sqlite3')).toBe('sqlite');
    expect(defaultKeepDays('sqlite')).toBe(3);
    expect(defaultKeepDays('postgres')).toBe(7);
    expect(DEFAULT_MAX_ROWS).toBe(200_000);
  });
});
