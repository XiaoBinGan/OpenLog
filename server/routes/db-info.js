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
import { errorMessage } from '../errors.js';
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
      for (const table of SMALL_TABLES) {
        try {
          const row = await getDb().get(`SELECT COUNT(*) AS n FROM ${table}`);
          counts[table] = Number(row?.n || 0);
        } catch { counts[table] = null; }
      }
      for (const table of LARGE_TABLES) {
        counts[table] = await estimateLargeTable(table);
      }
      payload.counts = counts;
    }

    res.json(payload);
  });

  return router;
}

/**
 * 大表行数估算：
 *  - PostgreSQL：读 pg_class.reltuples（analyze 后的统计值，0 表示还没 analyze）
 *  - MySQL：读 information_schema.TABLES.TABLE_ROWS（InnoDB 估算值）
 *  - SQLite：没有估算，直接 COUNT（SQLite 单机大表 COUNT 也还行，但限流用）
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
      return row ? Number(row.n) : null;
    }
    if (type === 'mysql') {
      const row = await db.get(
        `SELECT TABLE_ROWS AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        table,
      );
      return row ? Number(row.n) : null;
    }
    const row = await db.get(`SELECT COUNT(*) AS n FROM ${table}`);
    return Number(row?.n || 0);
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export default createDbRouter;
