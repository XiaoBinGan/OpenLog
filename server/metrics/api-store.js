/**
 * 接口监控落库层（#7 store）。契约：docs/monitoring-contract.md 4.4。
 *
 * 三条硬设计：
 *  1) **只批量写**：一分钟的全部路由聚合合成一条多值 INSERT。逐行写会把 SQLite 的写锁切成 N 段，
 *     主服务的读请求全排在后面；合成一条后写放大只有一次，PG 上也少 N 次往返。
 *  2) **写失败只丢这一批，绝不重试**：监控是旁路数据，重试等于在库已经吃紧时再加压力；
 *     SQLITE_BUSY 时 busy_timeout 已经等过了，再等只会让主服务的写事务更难拿锁。
 *  3) **容忍 db 为 null**（库没就绪 / OPENLOG_METRICS=off）：返回空或 0，不抛，绝不拖挂主服务。
 */
import { ddlFor, insertSlowQuerySql, normalizeDbType, placeholder, upsertSql } from './sql-dialect.js';

// 契约 4.4 把 ddlFor 写在 api-store 名下，实现放在 sql-dialect.js；这里转出，两种 import 都能用
export { ddlFor };

/** SQLite 是本机盘，保留短一点；PG/MySQL 有专门运维，沿用 7 天 */
export function defaultKeepDays(dbType) {
  return dbType === 'sqlite' ? 3 : 7;
}

/** 行数硬上限：极端基数下 1 分钟 300 路由 × 1440 = 43 万行/天，光靠时间淘汰挡不住 */
export const DEFAULT_MAX_ROWS = 200_000;

/** 单条语句最多塞 500 行：SQLite 变量上限 32766 / 10 列 ≈ 3276，留足余量 */
const MAX_ROWS_PER_STATEMENT = 500;

/**
 * 把外部 db 归一成 { run, get, all, exec }：生产传 server/db 适配层，
 * 测试直接传 better-sqlite3 的 Database 也能用。
 */
function asAdapter(db) {
  if (!db) return null;
  if (typeof db.run === 'function' && typeof db.all === 'function' && typeof db.exec === 'function') return db;
  if (typeof db.prepare !== 'function') return null;
  const args = (p) => (Array.isArray(p[0]) ? p[0] : p);
  return {
    run: (sql, ...p) => db.prepare(sql).run(...args(p)),
    get: (sql, ...p) => db.prepare(sql).get(...args(p)) ?? null,
    all: (sql, ...p) => db.prepare(sql).all(...args(p)),
    exec: (sql) => db.exec(sql),
  };
}

/** 取数，非法值回落（空响应算 0，但字节数另外单独处理，不用 0 冒充正常） */
function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 参数顺序必须与 UPSERT_COLUMNS 一致 */
function toRowValues(b) {
  return [
    num(b.bucketMs ?? b.bucket_ms), String(b.route ?? ''), String(b.method ?? 'GET').toUpperCase(),
    num(b.calls), num(b.err4xx), num(b.err5xx),
    b.p50 ?? b.p50Ms ?? b.p50_ms ?? null, b.p95 ?? b.p95Ms ?? b.p95_ms ?? null,
    b.p99 ?? b.p99Ms ?? b.p99_ms ?? null, b.max ?? b.maxMs ?? b.max_ms ?? null,
  ];
}

/** DB 行 → camelCase（U 层直接吃，不用猜列名） */
function toBucket(r) {
  return {
    bucketMs: num(r.bucket_ms), route: r.route, method: r.method, calls: num(r.calls),
    err4xx: num(r.err4xx), err5xx: num(r.err5xx),
    p50Ms: r.p50_ms ?? null, p95Ms: r.p95_ms ?? null, p99Ms: r.p99_ms ?? null, maxMs: r.max_ms ?? null,
  };
}

/**
 * 创建 api-store。
 * @param {{ db: any, dbType: string, keepDays?: number, maxRows?: number }} [opts]
 *   db 为 null 全部方法走空实现；maxRows 默认 200000，只给测试/极端场景注入。
 * @returns {object} ApiStore
 */
export function createApiStore(opts = {}) {
  const dbType = normalizeDbType(opts.dbType);
  const keepDays = Number.isFinite(Number(opts.keepDays)) ? Number(opts.keepDays) : defaultKeepDays(dbType);
  const rawMax = Number(opts.maxRows);
  const maxRows = Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : DEFAULT_MAX_ROWS;
  const conn = asAdapter(opts.db);
  // 进程内行数估算：决定「这批写完后要不要压上限」，避免每次写都 COUNT 全表
  let rowEstimate = 0;
  let estimated = false;

  /** 建表：失败不抛（监控建不出来时主服务必须照常起），返回是否成功 */
  async function ensureSchema() {
    if (!conn) return false;
    let ok = true;
    for (const sql of ddlFor(dbType)) {
      try {
        await conn.exec(sql);
      } catch (err) {
        // MySQL 不支持 CREATE INDEX IF NOT EXISTS，「已存在」属于正常
        if (!/already exist|duplicate/i.test(String(err?.message || ''))) ok = false;
      }
    }
    return ok;
  }

  /** 行数上限：删最旧的直到降下来。PG 用复合主键子查询，MySQL 需再套派生表 */
  async function trimToMaxRows() {
    const total = num((await conn.get('SELECT COUNT(*) AS n FROM api_metrics_minute'))?.n);
    if (total <= maxRows) return 0;
    const cols = 'SELECT bucket_ms, method, route FROM api_metrics_minute ORDER BY bucket_ms ASC LIMIT';
    const sql = dbType === 'postgres'
      ? `DELETE FROM api_metrics_minute WHERE (bucket_ms, method, route) IN (${cols} ${placeholder(dbType, 1)})`
      : dbType === 'mysql'
        ? `DELETE FROM api_metrics_minute WHERE (bucket_ms, method, route) IN (SELECT * FROM (${cols} ?) t_old)`
        : `DELETE FROM api_metrics_minute WHERE rowid IN (SELECT rowid FROM api_metrics_minute ORDER BY bucket_ms ASC LIMIT ?)`;
    const r = await conn.run(sql, [total - maxRows]);
    return num(r?.changes);
  }

  /**
   * 批量 upsert：超长时按 500 行切块，失败返回 0。
   * SQLite 单连接 + WAL，写锁排他 → 显式 BEGIN/COMMIT，多块要么全成要么全废；
   * PG/MySQL 是多连接池，BEGIN 与 INSERT 可能落在不同连接，所以靠单条语句自身原子性。
   */
  async function writeBuckets(buckets) {
    if (!conn) return 0;
    const list = Array.isArray(buckets) ? buckets : [];
    if (list.length === 0) return 0;

    let inTx = false;
    try {
      if (dbType === 'sqlite') {
        await conn.exec('BEGIN');
        inTx = true;
      }
      for (let i = 0; i < list.length; i += MAX_ROWS_PER_STATEMENT) {
        const chunk = list.slice(i, i + MAX_ROWS_PER_STATEMENT);
        const params = [];
        for (const b of chunk) params.push(...toRowValues(b));
        await conn.run(upsertSql(dbType, chunk.length), params);
      }
      if (inTx) {
        await conn.exec('COMMIT');
        inTx = false;
      }
    } catch {
      // 只丢这一批：不重试（见文件头），事务能回滚就回滚，回滚不了也算丢完
      if (inTx) {
        try { await conn.exec('ROLLBACK'); } catch { /* SQLite 可能已自动回滚 */ }
      }
      return 0;
    }

    // 写入后自己兜一次行数上限，别等定时 prune（极端基数一天就能撑爆盘）
    try {
      if (!estimated) {
        rowEstimate = num((await conn.get('SELECT COUNT(*) AS n FROM api_metrics_minute'))?.n);
        estimated = true;
      }
      rowEstimate += list.length;
      if (rowEstimate > maxRows) rowEstimate = Math.max(0, rowEstimate - (await trimToMaxRows()));
    } catch { /* 压上限失败不影响本批已写入的数据 */ }
    return list.length;
  }

  /** 区间查询：route 精确匹配，limit 兜住前端手滑；按时间升序返回 */
  async function queryRange({ fromMs, toMs, route, limit } = {}) {
    if (!conn) return [];
    const ph = (i) => placeholder(dbType, i);
    const where = [`bucket_ms >= ${ph(1)}`, `bucket_ms <= ${ph(2)}`];
    const params = [num(fromMs), num(toMs, Date.now())];
    if (route) {
      where.push(`route = ${ph(params.length + 1)}`);
      params.push(String(route));
    }
    const cap = Math.min(Math.max(num(limit, 500), 1), 5000);
    const sql = `SELECT bucket_ms, route, method, calls, err4xx, err5xx, p50_ms, p95_ms, p99_ms, max_ms
      FROM api_metrics_minute WHERE ${where.join(' AND ')} ORDER BY bucket_ms ASC LIMIT ${cap}`;
    try {
      return (await conn.all(sql, params) || []).map(toBucket);
    } catch {
      return [];
    }
  }

  /**
   * 淘汰：先按保留期删，再压行数上限，返回删除总行数。
   * db_metric_sample 故意不在这里按保留期删 —— 那是 #8 sampler 的采样历史，窗口归 db 侧管。
   * @param {number} [nowMs]
   */
  async function prune(nowMs = Date.now()) {
    if (!conn) return 0;
    const cutoff = num(nowMs, Date.now()) - keepDays * 86_400_000;
    let deleted = 0;
    for (const [table, col] of [['api_metrics_minute', 'bucket_ms'], ['slow_query_log', 'ts_ms']]) {
      try {
        const r = await conn.run(`DELETE FROM ${table} WHERE ${col} < ${placeholder(dbType, 1)}`, [cutoff]);
        deleted += num(r?.changes);
      } catch { /* 单表失败不影响别的表 */ }
    }
    try { deleted += await trimToMaxRows(); } catch { /* 下轮再压 */ }
    return deleted;
  }

  /** 行数 + 近似字节；拿不到真实体积就 null，不拿 0 冒充「很干净」 */
  async function stats() {
    if (!conn) return { rows: 0, approxBytes: null, tables: [] };
    const tables = [];
    for (const table of ['api_metrics_minute', 'db_metric_sample', 'slow_query_log']) {
      try { tables.push({ table, rows: num((await conn.get(`SELECT COUNT(*) AS n FROM ${table}`))?.n) }); }
      catch { tables.push({ table, rows: null }); }
    }
    let approxBytes = null;
    try {
      if (dbType === 'postgres') {
        const r = await conn.get(`SELECT pg_total_relation_size('api_metrics_minute') AS bytes`);
        if (r?.bytes != null) approxBytes = num(r.bytes, null);
      } else if (dbType === 'mysql') {
        const r = await conn.get(`SELECT (data_length + index_length) AS bytes FROM information_schema.tables
          WHERE table_schema = DATABASE() AND table_name = 'api_metrics_minute'`);
        if (r?.bytes != null) approxBytes = num(r.bytes, null);
      } else {
        const pages = num((await conn.get('PRAGMA page_count'))?.page_count, NaN);
        const size = num((await conn.get('PRAGMA page_size'))?.page_size, NaN);
        if (Number.isFinite(pages) && Number.isFinite(size)) approxBytes = pages * size;
      }
    } catch { approxBytes = null; }
    return { rows: tables.reduce((s, t) => s + (t.rows ?? 0), 0), approxBytes, tables };
  }

  /** 慢查询落库（#9 slowquery 用）：单行插入，失败返回 false */
  async function insertSlowQuery(entry = {}) {
    if (!conn) return false;
    try {
      await conn.run(insertSlowQuerySql(dbType), [
        num(entry.ts_ms ?? entry.tsMs, Date.now()), String(entry.fingerprint ?? ''), num(entry.ms),
        entry.source == null ? null : String(entry.source),
        entry.sample == null ? null : String(entry.sample).slice(0, 2000),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  return { ensureSchema, writeBuckets, queryRange, prune, stats, insertSlowQuery };
}
