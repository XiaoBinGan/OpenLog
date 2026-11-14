/**
 * 时序存储层 —— 序列注册、采样写入、区间读取、过期清理。
 *
 * 设计上的四个关键决定：
 *
 * 1) **序列 id 走内存缓存**。抓取是热路径，每条序列每轮都要拿 id。
 *    每次都查 `ts_series` 会让一轮抓取变成 N 次往返。这里维护
 *    fingerprint → id 的 Map，未命中才落库。进程重启后第一次全量重建，
 *    之后一直是 O(1)。
 *
 * 2) **批量写入，一条语句多个点**。逐点 INSERT 在 SQLite 上是 N 次语句
 *    + N 次 fsync 排队，写锁被拉长，主服务的读请求全堵在后面。
 *    这与 api-store 的取舍一致。
 *
 * 3) **写失败只丢这一批，绝不重试**。监控是旁路数据，重试等于在库已经
 *    吃紧时再加压力。丢了下一轮还有。
 *
 * 4) **标签过滤在内存做，时间范围在 SQL 做**。标签是 JSON，SQL 里做
 *    过滤要全表反序列化；而时间范围有索引，走 SQL 最快。
 *    代价是「选择器很窄 + 时间窗很大」时要把窗口内的点全读出来，
 *    所以读路径有硬上限（见 MAX_READ_ROWS）。
 */

import { normalizeDbType } from '../metrics/sql-dialect.js';
import { tsdbDdl, sampleInsertSql, seriesInsertSql } from './schema.js';
import { normalizeLabels, makeSeries, matchesLabels } from './labels.js';

/** 单次写入最多拼多少个点。太大容易撞参数上限（SQLite 默认 32766），太小失去批处理意义 */
const MAX_ROWS_PER_INSERT = 500;

/** 读路径单次最多返回多少行。防止一个宽时间窗把内存打爆 */
export const MAX_READ_ROWS = 200_000;

/**
 * @param {object} deps
 * @param {() => ({run:Function,get:Function,all:Function})|null} deps.getDb 取适配层
 * @param {() => string} [deps.getDbType] 取数据库类型
 * @param {() => number} [deps.now] 时钟（测试注入）
 */
export function createTsdbStore(deps = {}) {
  const getDb = deps.getDb || (() => null);
  const getDbType = deps.getDbType || (() => 'sqlite');
  const now = deps.now || (() => Date.now());

  /** fingerprint → series id */
  const idCache = new Map();
  /** series id → { fingerprint, name, labels } */
  const seriesCache = new Map();
  let schemaReady = false;
  /** 上次 schema 初始化失败的原因，供 /api/tsdb/status 报告 */
  let schemaError = null;

  function dbType() {
    try {
      return normalizeDbType(getDbType());
    } catch {
      return 'sqlite';
    }
  }

  /**
   * 建表。幂等，重复调用无副作用。
   *
   * MySQL 不支持 `CREATE INDEX IF NOT EXISTS`，会报 "Duplicate key name"，
   * 这里按错误文本容忍 —— 这与 api-store 的做法一致。
   */
  async function ensureSchema() {
    if (schemaReady) return true;
    const db = getDb();
    if (!db) {
      schemaError = 'db 未就绪';
      return false;
    }
    try {
      for (const stmt of tsdbDdl(dbType())) {
        try {
          await db.run(stmt);
        } catch (err) {
          const msg = String(err?.message || err);
          // 索引/约束已存在是正常情况（MySQL 没有 IF NOT EXISTS）
          if (/already exists|Duplicate key name|UNIQUE constraint.*already/i.test(msg)) continue;
          throw err;
        }
      }
      schemaReady = true;
      schemaError = null;
      return true;
    } catch (err) {
      schemaError = String(err?.message || err);
      return false;
    }
  }

  /** 清空内存索引（进程重启后第一次访问会重建） */
  function resetCache() {
    idCache.clear();
    seriesCache.clear();
  }

  /**
   * 拿序列 id。命中内存直接返回，未命中落库（或复用已有行）。
   * @returns {Promise<number|null>}
   */
  async function ensureSeries(series) {
    const { fingerprint, name, labels } = series;
    if (idCache.has(fingerprint)) return idCache.get(fingerprint);

    const db = getDb();
    if (!db) return null;

    // 可能是别的进程/上次运行已经建过这条序列：先查
    try {
      const row = await db.get('SELECT id FROM ts_series WHERE fingerprint = ?', fingerprint);
      if (row && row.id != null) {
        const id = Number(row.id);
        idCache.set(fingerprint, id);
        seriesCache.set(id, { fingerprint, name, labels });
        return id;
      }
    } catch {
      // 查询失败就往下走插入路径，插入也会失败则返回 null
    }

    try {
      const sql = seriesInsertSql(dbType());
      const row = await db.get(sql, fingerprint, name, JSON.stringify(labels));
      // PG/SQLite 走 RETURNING 拿到 id；MySQL 的 LAST_INSERT_ID 由适配层补
      let id = row && row.id != null ? Number(row.id) : null;
      if (id == null) {
        const back = await db.get('SELECT id FROM ts_series WHERE fingerprint = ?', fingerprint);
        id = back && back.id != null ? Number(back.id) : null;
      }
      if (id == null) return null;
      idCache.set(fingerprint, id);
      seriesCache.set(id, { fingerprint, name, labels });
      return id;
    } catch {
      return null;
    }
  }

  /**
   * 批量写入采样点。
   *
   * @param {Array<{name:string, labels?:Object, value:number, timestamp?:number}>} samples
   * @param {{timestamp?:number}} [opts] 统一时间戳（抓取时刻），单点 timestamp 优先
   * @returns {Promise<{ written:number, series:number, skipped:number }>}
   */
  async function writeSamples(samples, opts = {}) {
    const list = Array.isArray(samples) ? samples : [];
    if (list.length === 0) return { written: 0, series: 0, skipped: 0 };

    const db = getDb();
    if (!db) return { written: 0, series: 0, skipped: 0, error: 'db 未就绪' };
    if (!(await ensureSchema())) {
      return { written: 0, series: 0, skipped: 0, error: schemaError || 'schema 未就绪' };
    }

    const fallbackTs = Number.isFinite(opts.timestamp) ? Number(opts.timestamp) : now();

    // 按序列聚合：同一序列在同一批里可能有多个点（不同时间戳）
    const rows = [];
    const seenSeries = new Set();
    let skipped = 0;

    for (const s of list) {
      if (!s || typeof s.name !== 'string') { skipped += 1; continue; }
      const value = Number(s.value);
      // NaN / ±Inf 是合法值（Prometheus 允许），但 Infinity 存进 REAL 列在
      // SQLite 会变成 NULL。这里保留 NaN/Inf 的语义代价太高，统一按跳过处理，
      // 与「坏点不该污染序列」的取舍一致。
      if (!Number.isFinite(value)) { skipped += 1; continue; }

      let series;
      try {
        series = makeSeries(s.name, s.labels || {});
      } catch {
        skipped += 1;
        continue;
      }

      const ts = Number.isFinite(s.timestamp) ? Number(s.timestamp) : fallbackTs;
      const id = await ensureSeries(series);
      if (id == null) { skipped += 1; continue; }
      seenSeries.add(id);
      rows.push({ series_id: id, ts_ms: Math.floor(ts), value });
    }

    if (rows.length === 0) return { written: 0, series: 0, skipped };

    let written = 0;
    const t = dbType();
    for (let i = 0; i < rows.length; i += MAX_ROWS_PER_INSERT) {
      const chunk = rows.slice(i, i + MAX_ROWS_PER_INSERT);
      const sql = sampleInsertSql(t, chunk.length);
      const params = [];
      for (const r of chunk) params.push(r.series_id, r.ts_ms, r.value);
      try {
        await db.run(sql, ...params);
        written += chunk.length;
      } catch (err) {
        // 写失败只丢这一批。监控数据不是业务数据，重试会拖垮主服务。
        return { written, series: seenSeries.size, skipped, error: String(err?.message || err) };
      }
    }

    return { written, series: seenSeries.size, skipped };
  }

  /**
   * 只列出匹配的序列，**不读任何采样点**。
   *
   * 为什么单独开一个方法：`/api/v1/series` 只关心「有哪些序列」，
   * 用 queryRange 再配个 limit 会掉进两个坑 ——
   * limit 是**总点数**上限，配成 1 就只返回一条序列；
   * 配大了又会把成千上万个点读出来再丢掉，纯浪费。
   *
   * @param {{metricName?:string, matchers?:Array}} q
   * @returns {Promise<Array<{fingerprint:string,name:string,labels:Object}>>}
   */
  async function listSeries(q = {}) {
    const db = getDb();
    if (!db) return [];
    if (!(await ensureSchema())) return [];
    let rows;
    try {
      if (typeof q.metricName === 'string' && q.metricName) {
        rows = await db.all('SELECT id, fingerprint, name, labels FROM ts_series WHERE name = ?', q.metricName);
      } else {
        rows = await db.all('SELECT id, fingerprint, name, labels FROM ts_series');
      }
    } catch {
      return [];
    }
    const matchers = Array.isArray(q.matchers) ? q.matchers : [];
    const out = [];
    for (const r of rows || []) {
      let labels = {};
      try {
        labels = typeof r.labels === 'string' ? JSON.parse(r.labels) : (r.labels || {});
      } catch {
        labels = {};
      }
      if (!matchesLabels(labels, matchers)) continue;
      out.push({ fingerprint: r.fingerprint, name: r.name, labels });
    }
    return out;
  }

  /**
   * 按标签选择器与时间范围读点。
   *
   * @param {object} q
   * @param {Array<{name:string,op:string,value:string}>} [q.matchers] 标签选择器
   * @param {string} [q.metricName] 指标名（等值）
   * @param {number} q.start 起始毫秒（含）
   * @param {number} q.end 结束毫秒（含）
   * @param {number} [q.limit] 最多返回点数
   * @returns {Promise<{ series: Array<{fingerprint:string,name:string,labels:Object,points:Array<{ts:number,value:number}>}>,
   *                     truncated: boolean, scannedSeries: number }>}
   */
  async function queryRange(q = {}) {
    const db = getDb();
    const empty = { series: [], truncated: false, scannedSeries: 0 };
    if (!db) return { ...empty, error: 'db 未就绪' };
    if (!(await ensureSchema())) return { ...empty, error: schemaError || 'schema 未就绪' };

    const start = Number.isFinite(q.start) ? Number(q.start) : 0;
    const end = Number.isFinite(q.end) ? Number(q.end) : now();
    if (end < start) return empty;

    // 1) 先圈出候选序列：指标名走 SQL 索引，标签在内存过滤
    let candidates;
    try {
      if (typeof q.metricName === 'string' && q.metricName) {
        candidates = await db.all(
          'SELECT id, fingerprint, name, labels FROM ts_series WHERE name = ?',
          q.metricName,
        );
      } else {
        candidates = await db.all('SELECT id, fingerprint, name, labels FROM ts_series');
      }
    } catch (err) {
      return { ...empty, error: String(err?.message || err) };
    }

    const matchers = Array.isArray(q.matchers) ? q.matchers : [];
    const matched = [];
    for (const c of candidates || []) {
      let labels = {};
      try {
        labels = typeof c.labels === 'string' ? JSON.parse(c.labels) : (c.labels || {});
      } catch {
        labels = {};
      }
      if (!matchesLabels(labels, matchers)) continue;
      matched.push({ id: Number(c.id), fingerprint: c.fingerprint, name: c.name, labels });
    }

    if (matched.length === 0) return { series: [], truncated: false, scannedSeries: 0 };

    // 2) 按时间范围读点。序列多时按 id 分批，避免占位符数量爆掉
    const limit = Number.isFinite(q.limit) && q.limit > 0 ? Math.min(Number(q.limit), MAX_READ_ROWS) : MAX_READ_ROWS;
    const t = dbType();
    const byId = new Map();
    for (const m of matched) byId.set(m.id, { ...m, points: [] });

    const ID_CHUNK = 500;
    let total = 0;
    let truncated = false;

    for (let i = 0; i < matched.length; i += ID_CHUNK) {
      if (total >= limit) { truncated = true; break; }
      const chunk = matched.slice(i, i + ID_CHUNK);
      // 占位符顺序必须与参数顺序严格一致。这里把时间范围写在前面，
      // 于是 params 自然是 [start, end, ...ids] —— 之前把 IN 写在前、
      // 参数按 [start, end, ...] 传，三处错位，查询恒返回空集。
      const ph = chunk.map((_, k) => (t === 'postgres' ? `$${k + 3}` : '?')).join(',');
      const p1 = t === 'postgres' ? '$1' : '?';
      const p2 = t === 'postgres' ? '$2' : '?';
      const sql = `SELECT series_id, ts_ms, value FROM ts_sample
WHERE ts_ms >= ${p1} AND ts_ms <= ${p2} AND series_id IN (${ph})
ORDER BY series_id, ts_ms
LIMIT ${limit - total}`;
      const params = [start, end, ...chunk.map((c) => c.id)];
      let rows;
      try {
        rows = await db.all(sql, ...params);
      } catch (err) {
        return { ...empty, error: String(err?.message || err) };
      }
      for (const r of rows || []) {
        const bucket = byId.get(Number(r.series_id));
        if (!bucket) continue;
        bucket.points.push({ ts: Number(r.ts_ms), value: Number(r.value) });
        total += 1;
      }
      if (total >= limit) { truncated = true; break; }
    }

    const series = [];
    for (const s of byId.values()) {
      if (s.points.length === 0) continue;
      series.push({ fingerprint: s.fingerprint, name: s.name, labels: s.labels, points: s.points });
    }
    return { series, truncated, scannedSeries: matched.length };
  }

  /**
   * 列出所有指标名（去重）。
   * @returns {Promise<string[]>}
   */
  async function listMetricNames() {
    const db = getDb();
    if (!db) return [];
    if (!(await ensureSchema())) return [];
    try {
      const rows = await db.all('SELECT DISTINCT name FROM ts_series ORDER BY name');
      return (rows || []).map((r) => r.name);
    } catch {
      return [];
    }
  }

  /**
   * 列出某指标（或全部）的标签键值分布 —— `/api/v1/label/<name>/values` 与
   * Grafana 的变量查询都依赖它。
   *
   * @param {string} labelName 标签名；`__name__` 特指指标名
   * @returns {Promise<string[]>}
   */
  async function labelValues(labelName) {
    const db = getDb();
    if (!db) return [];
    if (!(await ensureSchema())) return [];

    if (labelName === '__name__') return listMetricNames();

    try {
      const rows = await db.all('SELECT labels FROM ts_series');
      const seen = new Set();
      for (const r of rows || []) {
        let labels;
        try {
          labels = typeof r.labels === 'string' ? JSON.parse(r.labels) : r.labels;
        } catch {
          continue;
        }
        if (labels && Object.prototype.hasOwnProperty.call(labels, labelName)) {
          seen.add(String(labels[labelName]));
        }
      }
      return [...seen].sort();
    } catch {
      return [];
    }
  }

  /**
   * 清理过期采样点。
   *
   * 只删 ts_sample，不删 ts_series —— 序列一旦消失，历史数据就没法解读了；
   * 而且序列数量远小于点数，留着不占空间。孤儿序列（有点被删光）由
   * 调用方定期用 `pruneOrphanSeries` 收拾。
   *
   * @param {number} retentionMs 保留多久
   * @returns {Promise<{deleted:number}>}
   */
  async function pruneSamples(retentionMs) {
    const db = getDb();
    if (!db) return { deleted: 0 };
    if (!(await ensureSchema())) return { deleted: 0 };
    const cutoff = now() - Math.max(0, Number(retentionMs) || 0);
    try {
      const res = await db.run('DELETE FROM ts_sample WHERE ts_ms < ?', cutoff);
      return { deleted: Number(res?.changes) || 0 };
    } catch {
      return { deleted: 0 };
    }
  }

  /**
   * 删除没有任何采样点的序列。
   * 为什么需要：抓取目标删掉后，它的序列会一直留在 ts_series 里，
   * 让 `listMetricNames` 和标签值列表混进已消失的目标。
   */
  async function pruneOrphanSeries() {
    const db = getDb();
    if (!db) return { deleted: 0 };
    if (!(await ensureSchema())) return { deleted: 0 };
    try {
      const res = await db.run(
        'DELETE FROM ts_series WHERE id NOT IN (SELECT DISTINCT series_id FROM ts_sample)',
      );
      resetCache();
      return { deleted: Number(res?.changes) || 0 };
    } catch {
      return { deleted: 0 };
    }
  }

  /** 存储概况（/api/tsdb/status 用） */
  async function stats() {
    const db = getDb();
    const out = {
      ready: schemaReady,
      error: schemaError,
      dbType: dbType(),
      seriesCount: null,
      sampleCount: null,
      oldestMs: null,
      newestMs: null,
      cachedSeries: idCache.size,
    };
    if (!db) return out;
    if (!(await ensureSchema())) return out;
    try {
      const s = await db.get('SELECT COUNT(*) AS n FROM ts_series');
      out.seriesCount = Number(s?.n) || 0;
      const p = await db.get('SELECT COUNT(*) AS n, MIN(ts_ms) AS lo, MAX(ts_ms) AS hi FROM ts_sample');
      out.sampleCount = Number(p?.n) || 0;
      out.oldestMs = p?.lo != null ? Number(p.lo) : null;
      out.newestMs = p?.hi != null ? Number(p.hi) : null;
    } catch (err) {
      out.error = String(err?.message || err);
    }
    return out;
  }

  return {
    ensureSchema,
    resetCache,
    writeSamples,
    queryRange,
    listSeries,
    listMetricNames,
    labelValues,
    pruneSamples,
    pruneOrphanSeries,
    stats,
  };
}

export { normalizeLabels };