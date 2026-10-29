/**
 * routes/db-info.js — 数据库健康检查端点。
 *
 * `GET /api/db/info`
 *   返回当前数据库类型、连接池水位、探活延迟、存储占用。
 *   用途：换库/扩容后确认「真的连上了哪个库、池有没有被打满」，
 *   也方便接监控（Prometheus 之类的外部探针直接拉这个 JSON）。
 *
 * `?counts=1` 额外返回关键表行数（慢表 log_records 只做估算/上限，避免大表 COUNT 拖慢服务）。
 *
 * 注意：这是只读诊断端点，不含任何连接串凭据（密码/用户名不返回）。
 */
import express from 'express';
import { getDbInfo, getDb, pingDb, getDbType } from '../db/index.js';

/** 这些表行数便宜（很小），直接 COUNT */
const SMALL_TABLES = ['kv_store', 'skills', 'remote_servers', 'machines', 'alert_configs'];
/** 这些表可能很大，用方言各自的估算，避免全表扫描 */
const LARGE_TABLES = ['log_records', 'analysis_records'];

export function createDbRouter() {
  const router = express.Router();

  router.get('/api/db/info', async (req, res) => {
    const wantCounts = req.query.counts === '1';
    const info = getDbInfo();
    const ping = await pingDb();
    const payload = {
      ...info,
      ok: ping.ok,
      latencyMs: ping.latencyMs ?? null,
      ...(ping.error ? { error: ping.error } : {}),
      timestamp: new Date().toISOString(),
    };

    // 用连接串配置时 options.database 可能为空，直接问数据库自己
    if (ping.ok) {
      try {
        if (info.type === 'postgres') {
          const row = await getDb().get(`SELECT current_database() AS db`);
          payload.database = row?.db ?? payload.database;
        } else if (info.type === 'mysql') {
          const row = await getDb().get(`SELECT DATABASE() AS db`);
          payload.database = row?.db ?? payload.database;
        }
      } catch { /* 忽略 */ }
    }

    // 存储占用
    if (info.type === 'postgres') {
      try {
        const row = await getDb().get(`SELECT pg_database_size(current_database()) AS bytes`);
        payload.storage = { kind: 'database', bytes: Number(row?.bytes || 0) };
      } catch { /* 权限不足时忽略 */ }
    } else if (info.type === 'mysql') {
      try {
        const row = await getDb().get(
          `SELECT SUM(data_length + index_length) AS bytes FROM information_schema.tables WHERE table_schema = DATABASE()`,
        );
        payload.storage = { kind: 'database', bytes: Number(row?.bytes || 0) };
      } catch { /* 忽略 */ }
    } else if (info.type === 'sqlite') {
      payload.storage = { kind: 'file', bytes: info.sqlite?.fileSize ?? null };
    }

    if (wantCounts) {
      const counts = {};
      const countsMeta = {};
      for (const table of SMALL_TABLES) {
        try {
          const row = await getDb().get(`SELECT COUNT(*) AS n FROM ${table}`);
          counts[table] = Number(row?.n || 0);
          countsMeta[table] = 'exact';
        } catch { counts[table] = null; countsMeta[table] = 'error'; }
      }
      for (const table of LARGE_TABLES) {
        const r = await estimateLargeTable(table);
        counts[table] = r.n;
        countsMeta[table] = r.method;
      }
      payload.counts = counts;
      payload.countsMeta = countsMeta;
    }

    res.json(payload);
  });

  return router;
}

/** 大表估算时最多数这么多行（没做过 ANALYZE 的库也不能把服务拖死） */
export const BOUNDED_COUNT_CAP = 200_000;

/**
 * 大表行数：优先用数据库自己的统计值，统计不可用时退到「有上限的精确计数」。
 *
 * 之前直接读 `pg_class.reltuples`：从未 ANALYZE 过的表返回 **-1**，
 * 端点于是吐出 `log_records: -1`（看起来像负数行数，实际是「不知道」）。
 * 现在 -1/0 一律当作「统计不可用」，改用 `LIMIT cap` 的子查询数一次（代价可控）。
 *
 * @returns {Promise<{ n: number|null, method: 'estimate'|'bounded-count'|'exact'|'error' }>}
 */
async function estimateLargeTable(table) {
  const type = getDbType();
  const db = getDb();
  try {
    if (type === 'postgres') {
      const row = await db.get(
        `SELECT reltuples::bigint AS n FROM pg_class WHERE relname = ?`,
        table,
      );
      const n = row ? Number(row.n) : null;
      if (n !== null && n >= 0) return { n, method: 'estimate' };
      // 统计不可用（-1 = 从未 ANALYZE）→ 有上限的精确计数
      const capped = await db.get(
        `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${table} LIMIT ${BOUNDED_COUNT_CAP}) AS t`,
      );
      return { n: Number(capped?.n || 0), method: 'bounded-count' };
    }
    if (type === 'mysql') {
      const row = await db.get(
        `SELECT TABLE_ROWS AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        table,
      );
      const n = row ? Number(row.n) : null;
      if (n !== null && n >= 0) return { n, method: 'estimate' };
      const capped = await db.get(
        `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${table} LIMIT ${BOUNDED_COUNT_CAP}) AS t`,
      );
      return { n: Number(capped?.n || 0), method: 'bounded-count' };
    }
    const row = await db.get(`SELECT COUNT(*) AS n FROM ${table}`);
    return { n: Number(row?.n || 0), method: 'exact' };
  } catch (err) {
    return { n: null, method: 'error' };
  }
}

export default createDbRouter;
