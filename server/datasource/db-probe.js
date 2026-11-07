/**
 * server/datasource/db-probe.js —— 连别人的数据库采一次样（只读）
 *
 * 和本机采样器（server/metrics/db-sampler.js）的区别：
 *   - 本机那个常驻、走应用自己的连接池；这个是一次性连接，采完立刻断开
 *   - 这里**只采能确定语义的项**：连通性、版本、连接数、库大小、表体积与死元组
 *   - 权限不足时如实回 `unavailable`，**绝不用 0 冒充**（"看不见"和"没有"是两件事）
 *
 * 安全：只发 SELECT / SHOW，不发任何 DDL/DML；超时由会话级 statement_timeout 兜底，
 * 避免在别人的生产库上挂住。
 */

/** 采样的 SQL：都是只读，且都能在普通权限下跑（pg_stat_activity 需要 pg_monitor，没有就降级） */
export const QUERIES = {
  postgres: {
    version: 'SELECT version() AS v',
    size: 'SELECT pg_database_size(current_database()) AS bytes',
    conns: `SELECT count(*) AS total,
                   sum(CASE WHEN state = 'active' THEN 1 ELSE 0 END) AS active
              FROM pg_stat_activity WHERE pid <> pg_backend_pid()`,
    tables: `SELECT c.relname AS relname, pg_total_relation_size(c.oid) AS bytes,
                    s.n_live_tup AS live_tup, s.n_dead_tup AS dead_tup
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
               LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
              WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
              ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 10`,
    locks: `SELECT count(*) AS waiting FROM pg_locks WHERE NOT granted`,
  },
  mysql: {
    version: 'SELECT VERSION() AS v',
    size: `SELECT ROUND(SUM(data_length + index_length)) AS bytes
             FROM information_schema.tables WHERE table_schema = DATABASE()`,
    conns: `SELECT COUNT(*) AS total,
                   SUM(CASE WHEN COMMAND <> 'Sleep' THEN 1 ELSE 0 END) AS active
              FROM information_schema.processlist`,
    tables: `SELECT table_name AS relname, (data_length + index_length) AS bytes,
                    table_rows AS live_tup, 0 AS dead_tup
               FROM information_schema.tables
              WHERE table_schema = DATABASE()
              ORDER BY (data_length + index_length) DESC LIMIT 10`,
    locks: null,
  },
};

/**
 * 采一次样。
 *
 * @param {object} opts
 * @param {'postgres'|'mysql'} opts.dialect
 * @param {string} opts.host
 * @param {number} opts.port
 * @param {string} opts.user
 * @param {string} opts.password
 * @param {string} opts.database
 * @param {number} [opts.timeoutMs]  连接与语句超时，默认 4000
 * @param {Function} [opts.connect]  注入「造客户端」，测试用
 * @returns {Promise<{ ok: boolean, ms: number, version?: string, sizeBytes?: number|null,
 *   conns?: {total:number|null, active:number|null}, tables?: Array, waitingLocks?: number|null,
 *   unavailable: string[], error?: string }>}
 */
export async function probeExternalDb({
  dialect, host, port, user, password, database, timeoutMs = 4000, connect,
}) {
  const t0 = Date.now();
  const unavailable = [];
  const q = QUERIES[dialect];
  if (!q) {
    return { ok: false, ms: 0, unavailable: [`不支持采样 ${dialect}（目前只支持 postgres / mysql）`], error: 'unsupported dialect' };
  }
  if (!host) return { ok: false, ms: 0, unavailable: ['缺少主机地址'], error: 'missing host' };

  let client = null;
  try {
    client = await (connect ? connect({ dialect, host, port, user, password, database, timeoutMs }) : createClient({ dialect, host, port, user, password, database, timeoutMs }));
    const out = { ok: true, ms: 0, unavailable, tables: [] };

    // 版本 + 库大小 + 连接数：任何一项权限不足都单独降级，不整轮失败
    const many = async (sql, key) => {
      if (!sql) return null;
      try {
        const rows = await client.query(sql);
        return Array.isArray(rows) ? rows : [];
      } catch (err) {
        unavailable.push(`${key}: ${short(err)}`);
        return null;
      }
    };
    // 只要首行（单值查询）
    const one = async (sql, key) => {
      const rows = await many(sql, key);
      return rows && rows.length ? rows[0] : null;
    };

    const v = await one(q.version, 'version');
    if (v) out.version = String(v.v || v.VERSION || '').slice(0, 120);

    const sizeRow = await one(q.size, '库大小');
    if (sizeRow) {
      const b = Number(sizeRow.bytes);
      out.sizeBytes = Number.isFinite(b) ? b : null;
    }

    const conns = await one(q.conns, '连接数');
    if (conns) {
      out.conns = {
        total: Number.isFinite(Number(conns.total)) ? Number(conns.total) : null,
        active: Number.isFinite(Number(conns.active)) ? Number(conns.active) : null,
      };
    }

    const tables = await many(q.tables, '表体积');
    if (Array.isArray(tables)) {
      out.tables = tables.map((r) => ({
        relname: String(r.relname ?? r.RELNAME ?? ''),
        bytes: numOrNull(r.bytes ?? r.BYTES),
        liveTup: numOrNull(r.live_tup ?? r.LIVE_TUP),
        deadTup: numOrNull(r.dead_tup ?? r.DEAD_TUP),
      }));
    }

    const locks = await one(q.locks, '锁等待');
    if (locks) out.waitingLocks = numOrNull(locks.waiting);

    out.ms = Date.now() - t0;
    return out;
  } catch (err) {
    return {
      ok: false, ms: Date.now() - t0, unavailable,
      error: explainConnectError(err),
    };
  } finally {
    try { await client?.close?.(); } catch { /* 已断开 */ }
  }
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function short(err) {
  const m = String(err?.message || err || '');
  // 「权限不足」是最常见的一种，单独说人话
  if (/permission denied|access denied|not authorized|no privileges/i.test(m)) return '权限不足';
  if (/does not exist|不存在/i.test(m)) return `对象不存在（${m.slice(0, 60)}）`;
  return m.slice(0, 120);
}

/** 把驱动错误翻译成人能看懂的一句话（界面直接显示它） */
export function explainConnectError(err) {
  const m = String(err?.message || err || '');
  const code = String(err?.code || '');
  if (/ECONNREFUSED/i.test(m)) return '连接被拒绝：端口没有在监听（库没起来，或没发布到这个端口）';
  if (/ETIMEDOUT|timeout/i.test(m)) return '连接超时：网络不通，或防火墙挡了';
  if (/ENOTFOUND|EAI_AGAIN/i.test(m)) return '主机名解析失败';
  if (/client password must be a string|SASL|SCRAM/i.test(m)) return '没有密码：这个库要求密码认证，请在数据源里补上密码后重试';
  if (/password authentication failed|Access denied for user/i.test(m)) return '认证失败：账号或密码不对';
  if (/database .* does not exist|Unknown database/i.test(m)) return '库不存在：库名写错了';
  if (code === '28P01') return '认证失败：账号或密码不对';
  if (code === '3D000') return '库不存在：库名写错了';
  return m.slice(0, 200) || '未知错误';
}

/** 真连一次（驱动延迟加载，没装对应驱动也不影响其它方言） */
async function createClient({ dialect, host, port, user, password, database, timeoutMs }) {
  if (dialect === 'postgres') {
    const { Client } = await import('pg');
    // password 必须是 string 或 undefined：传 null 会让 pg 走 SASL 时报
    // "client password must be a string"（比自己写的一句「连不上」更难排查）
    const client = new Client({
      host, port: port || 5432, user: user || undefined,
      password: password ? String(password) : undefined,
      database: database || undefined,
      connectionTimeoutMillis: timeoutMs,
      statement_timeout: timeoutMs,
      // 只读会话：即使 SQL 写错了也不会动人家数据
      application_name: 'openlog-monitor',
    });
    await client.connect();
    return {
      query: async (sql) => (await client.query(sql)).rows,
      close: async () => client.end(),
    };
  }
  if (dialect === 'mysql') {
    const mysql = (await import('mysql2/promise')).default;
    const conn = await mysql.createConnection({
      host, port: port || 3306, user: user || undefined, password: password || undefined,
      database: database || undefined, connectTimeout: timeoutMs,
    });
    return {
      query: async (sql) => {
        const [rows] = await conn.query({ sql, timeout: timeoutMs });
        return rows;
      },
      close: async () => conn.end(),
    };
  }
  throw new Error(`不支持的方言: ${dialect}`);
}
