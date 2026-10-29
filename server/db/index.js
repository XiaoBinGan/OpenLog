/**
 * 统一数据库层
 * 支持 SQLite（本地默认）、PostgreSQL（连接池）、MySQL（连接池）
 *
 * 设计要点（1000 台服务器场景）：
 *  - PostgreSQL / MySQL 都用**连接池**，不是单连接 —— 单连接会把所有查询串行化，
 *    换库不但没扩容反而更慢；
 *  - SQL 统一用 `?` 占位，PostgreSQL 在适配层转换成 `$1,$2…`（业务代码不用关心方言）；
 *  - 显式配置的数据库连不上时**直接报错**，不再静默回退到本地 SQLite
 *    （生产环境静默回退 = 数据写到了没人知道的地方）；
 *  - 建表用方言化的类型/默认值（SQLite 的 `strftime`、PG 的 `EXTRACT`、MySQL 的 `UNIX_TIMESTAMP`）。
 */

import Database from 'better-sqlite3';
import { errorMessage } from '../errors.js';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { existsSync, mkdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const { Pool: PgPool } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));
// OPENLOG_DATA_DIR 让测试与容器把数据库放到隔离位置；不设置时行为与以前完全一致。
// 没有这个开关时 `npm test` 会直接读写生产库 data/openlog.db。
const DATA_DIR = process.env.OPENLOG_DATA_DIR || join(__dirname, '../../data');
const SQLITE_PATH = join(DATA_DIR, 'openlog.db');

let db = null;
let dbType = null; // 'sqlite' | 'mysql' | 'postgres'
let rawDb = null;  // 原生连接 / 连接池

// ─── 参数与占位符归一 ─────────────────────────────────────────────────────

/**
 * 统一参数形式：既支持 `db.run(sql, a, b)`，也支持 `db.run(sql, [a, b])`。
 * （历史代码两种写法都有，适配层必须都吃下）
 */
export function normalizeParams(params) {
  if (params.length === 1 && Array.isArray(params[0])) return params[0];
  return params;
}

/**
 * 把 `?` 占位符转换成 PostgreSQL 的 `$1, $2…`。
 *
 * 必须跳过字符串字面量与注释里的 `?`（`WHERE note = 'a?b'` 不能被改坏），
 * 所以这里是一个小状态机，而不是简单的 split/join。
 */
export function toPgPlaceholders(sql) {
  const text = String(sql ?? '');
  let out = '';
  let i = 0;
  let n = 0;
  let quote = null; // "'" | '"' | '`'
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      out += ch;
      if (ch === quote) {
        // 处理 '' 转义
        if (text[i + 1] === quote) { out += text[i + 1]; i += 2; continue; }
        quote = null;
      }
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; i += 1; continue; }
    // 行注释
    if (ch === '-' && text[i + 1] === '-') {
      const end = text.indexOf('\n', i);
      if (end === -1) { out += text.slice(i); break; }
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '?') { n += 1; out += `$${n}`; i += 1; continue; }
    out += ch;
    i += 1;
  }
  return out;
}

// ─── SQLite 适配层 ─────────────────────────────────────────────────────────

function adaptSQLite(conn) {
  return {
    run(sql, ...params) {
      // 单条语句
      const cleanSql = sql.replace(/returning.*/i, '').trim();
      const stmt = conn.prepare(cleanSql);
      return { changes: stmt.run(...normalizeParams(params)).changes };
    },
    get(sql, ...params) {
      return conn.prepare(sql).get(...normalizeParams(params));
    },
    all(sql, ...params) {
      return conn.prepare(sql).all(...normalizeParams(params));
    },
    exec(sql) {
      conn.exec(sql);
    }
  };
}

function adaptMySQL(conn) {
  return {
    async run(sql, ...params) {
      const [r] = await conn.execute(sql, normalizeParams(params));
      return { changes: r.affectedRows, insertId: r.insertId };
    },
    async get(sql, ...params) {
      const [rows] = await conn.execute(sql, normalizeParams(params));
      return rows[0] || null;
    },
    async all(sql, ...params) {
      const [rows] = await conn.execute(sql, normalizeParams(params));
      return rows;
    },
    async exec(sql) {
      await conn.query(sql);
    }
  };
}

/**
 * PostgreSQL 适配层（连接池）。
 *
 * 关键差异：
 *  - 占位符是 `$1,$2`，业务代码统一写 `?`，这里转换；
 *  - `pool.query()` 会自动从池里取连接并释放，不需要手工 connect/release；
 *  - 多语句 DDL 只有「不带参数」时才能一次执行（简单查询协议），迁移里的建表都走 exec；
 *  - JSONB 字段插入字符串即可（PG 会隐式转换），读出时 pg 已 parse 成对象，
 *    为了和 SQLite 行为一致（SQLite 返回字符串），读 JSON 列时由业务层兜底解析。
 */
function adaptPostgres(pool) {
  return {
    async run(sql, ...params) {
      const r = await pool.query(toPgPlaceholders(sql), normalizeParams(params));
      return { changes: r.rowCount ?? 0, insertId: r.rows?.[0]?.id ?? null };
    },
    async get(sql, ...params) {
      const r = await pool.query(toPgPlaceholders(sql), normalizeParams(params));
      return r.rows[0] || null;
    },
    async all(sql, ...params) {
      const r = await pool.query(toPgPlaceholders(sql), normalizeParams(params));
      return r.rows;
    },
    async exec(sql) {
      await pool.query(sql);
    }
  };
}

// ─── 配置解析（纯函数，便于测试）──────────────────────────────────────────

/**
 * 从环境变量解析数据库配置。
 *
 * 支持：
 *   OPENLOG_DB_TYPE=sqlite|postgres|mysql       显式指定
 *   OPENLOG_DATABASE_URL=postgres://u:p@h:5432/db
 *   OPENLOG_PG_HOST / OPENLOG_PG_PORT / OPENLOG_PG_USER / OPENLOG_PG_PASSWORD / OPENLOG_PG_DATABASE
 *   OPENLOG_PG_POOL_MAX（默认 10）
 *   OPENLOG_MYSQL_HOST / ...（可选）
 *
 * @returns {{ type?:string, connectionString?:string, postgresConfig?:object, mysqlConfig?:object, explicit:boolean }}
 */
export function resolveDbConfig(env = process.env) {
  const raw = String(env.OPENLOG_DB_TYPE || env.DB_TYPE || '').trim().toLowerCase();
  const typeMap = { pg: 'postgres', postgresql: 'postgres', postgres: 'postgres', mysql: 'mysql', sqlite: 'sqlite', sqlite3: 'sqlite' };
  const type = typeMap[raw] || '';
  const url = String(env.OPENLOG_DATABASE_URL || env.DATABASE_URL || '').trim();

  const pgConfig = {
    host: env.OPENLOG_PG_HOST || undefined,
    port: env.OPENLOG_PG_PORT ? Number(env.OPENLOG_PG_PORT) : undefined,
    user: env.OPENLOG_PG_USER || undefined,
    password: env.OPENLOG_PG_PASSWORD || undefined,
    database: env.OPENLOG_PG_DATABASE || undefined,
    max: env.OPENLOG_PG_POOL_MAX ? Number(env.OPENLOG_PG_POOL_MAX) : undefined,
    idleTimeoutMillis: env.OPENLOG_PG_IDLE_TIMEOUT_MS ? Number(env.OPENLOG_PG_IDLE_TIMEOUT_MS) : undefined,
  };
  const hasPgParts = Boolean(pgConfig.host || pgConfig.user || pgConfig.database);

  const mysqlConfig = {
    host: env.OPENLOG_MYSQL_HOST || undefined,
    port: env.OPENLOG_MYSQL_PORT ? Number(env.OPENLOG_MYSQL_PORT) : undefined,
    user: env.OPENLOG_MYSQL_USER || undefined,
    password: env.OPENLOG_MYSQL_PASSWORD || undefined,
    database: env.OPENLOG_MYSQL_DATABASE || undefined,
  };
  const hasMysqlParts = Boolean(mysqlConfig.host || mysqlConfig.user || mysqlConfig.database);

  // URL 的 scheme 决定类型
  let urlType = '';
  if (/^postgres(ql)?:\/\//i.test(url)) urlType = 'postgres';
  else if (/^mysql:\/\//i.test(url)) urlType = 'mysql';

  const effectiveType = type || urlType || (hasPgParts ? 'postgres' : hasMysqlParts ? 'mysql' : '');
  const explicit = Boolean(effectiveType) || Boolean(url) || hasPgParts || hasMysqlParts;

  return {
    type: effectiveType || undefined,
    connectionString: url || undefined,
    postgresConfig: effectiveType === 'postgres' ? pgConfig : undefined,
    mysqlConfig: effectiveType === 'mysql' ? mysqlConfig : undefined,
    explicit,
  };
}

// ─── 初始化 ────────────────────────────────────────────────────────────────

/**
 * 初始化数据库。
 *
 * @param {{ type?:string, connectionString?:string, postgresConfig?:object, mysqlConfig?:object, explicit?:boolean }} [config]
 *   不传则读环境变量；都不配 → SQLite（WAL）。
 *   显式配置的库连不上会 **抛错**，不会静默回退到 SQLite
 *   （否则生产换库时数据库写到了没人知道的地方）。
 */
export async function initDb(config = {}) {
  if (db) return db;

  const envConfig = resolveDbConfig();
  const merged = { ...envConfig, ...config };
  const explicit = config.explicit ?? envConfig.explicit;
  const { type, connectionString, mysqlConfig, postgresConfig } = merged;

  const failures = [];

  if (type === 'postgres' || postgresConfig) {
    try {
      const cfg = postgresConfig || {};
      const pool = new PgPool({
        ...(connectionString ? { connectionString } : {}),
        host: cfg.host || (connectionString ? undefined : 'localhost'),
        port: cfg.port || (connectionString ? undefined : 5432),
        user: cfg.user || (connectionString ? undefined : 'postgres'),
        password: cfg.password ?? (connectionString ? undefined : ''),
        database: cfg.database || (connectionString ? undefined : 'openlog'),
        max: Number(cfg.max) || 10,
        idleTimeoutMillis: Number(cfg.idleTimeoutMillis) || 30_000,
        connectionTimeoutMillis: 5_000,
        // 连接池里出现的问题是异步事件，不能让它变成 uncaughtException
        allowExitOnIdle: false,
      });
      pool.on('error', (err) => console.error('[DB] PostgreSQL 连接池错误:', errorMessage(err)));
      // 立刻探活，连不上就别装作成功
      await pool.query('SELECT 1');
      rawDb = pool;
      dbType = 'postgres';
      db = adaptPostgres(pool);
      console.log(`[DB] PostgreSQL connected: ${connectionString ? '(URL)' : `${cfg.host || 'localhost'}:${cfg.port || 5432}`} 连接池上限 ${(Number(cfg.max) || 10)}`);
    } catch (err) {
      failures.push(`PostgreSQL: ${errorMessage(err)}`);
      if (rawDb) { try { await rawDb.end(); } catch { /* 忽略 */ } }
      rawDb = null; db = null; dbType = null;
    }
  }

  if (!db && (type === 'mysql' || mysqlConfig)) {
    try {
      const cfg = mysqlConfig || {};
      const pool = mysql.createPool({
        ...(connectionString ? { uri: connectionString } : {}),
        host: cfg.host || 'localhost',
        port: cfg.port || 3306,
        user: cfg.user || 'root',
        password: cfg.password || '',
        database: cfg.database || 'openlog',
        waitForConnections: true,
        connectionLimit: Number(cfg.max) || 10,
        queueLimit: 0,
        connectTimeout: 5000,
      });
      await pool.query('SELECT 1');
      rawDb = pool;
      dbType = 'mysql';
      db = adaptMySQL(pool);
      console.log(`[DB] MySQL connected: ${cfg.host || 'localhost'} 连接池上限 ${Number(cfg.max) || 10}`);
    } catch (err) {
      failures.push(`MySQL: ${errorMessage(err)}`);
      if (rawDb) { try { await rawDb.end(); } catch { /* 忽略 */ } }
      rawDb = null; db = null; dbType = null;
    }
  }

  if (!db && type && type !== 'sqlite') {
    // 显式指定了远程库却连不上：直接失败，不静默落回本地 SQLite
    throw new Error(`[DB] 指定的数据库不可用 → ${failures.join('; ') || `未知类型 ${type}`}`);
  }

  if (!db) {
    // 默认：SQLite
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      const conn = new Database(SQLITE_PATH);
      conn.pragma('journal_mode = WAL');
      conn.pragma('foreign_keys = ON');
      // 1000 台场景写入更频繁，NORMAL 比默认 FULL 少一次 fsync，崩溃最多丢最后一个事务
      conn.pragma('synchronous = NORMAL');
      conn.pragma('busy_timeout = 5000');
      rawDb = conn;
      dbType = 'sqlite';
      db = adaptSQLite(conn);
      console.log('[DB] SQLite initialized:', SQLITE_PATH);
    } catch (err) {
      throw new Error(`[DB] 无法初始化数据库: ${errorMessage(err)}`);
    }
  }

  if (explicit && dbType === 'sqlite' && type !== 'sqlite') {
    console.warn('[DB] ⚠️ 未检测到数据库配置，使用本地 SQLite');
  }

  await runMigrations();
  // kv 全量进内存：让 getKv 保持同步语义（异步适配器下也成立）
  await loadKvCache();
  return db;
}

export function getDb() {
  if (!db) throw new Error('DB not initialized. Call initDb() first.');
  return db;
}

export function getDbType() {
  return dbType;
}

/**
 * 数据库概况（健康检查端点用）。
 *
 * 连接池水位直接反映「是不是把池打满了」：`waiting > 0` 持续出现说明池太小，
 * 得调 OPENLOG_PG_POOL_MAX。MySQL 的 mysql2 池把连接数组藏在 `pool.pool._allConnections`
 * 里，所以在 getDbInfo 里做了兜底读取。
 */
export function getDbInfo() {
  const info = { type: dbType || null, ready: Boolean(db) };
  if (!rawDb) return info;

  if (dbType === 'postgres') {
    info.dialect = 'postgresql';
    info.pool = {
      total: rawDb.totalCount ?? null,
      idle: rawDb.idleCount ?? null,
      waiting: rawDb.waitingCount ?? null,
      max: rawDb.options?.max ?? null,
    };
    info.host = rawDb.options?.host || (rawDb.options?.connectionString ? '(URL)' : null);
    info.database = rawDb.options?.database || null;
  } else if (dbType === 'mysql') {
    info.dialect = 'mysql';
    const inner = rawDb.pool || {};
    info.pool = {
      total: inner._allConnections?.length ?? null,
      idle: inner._freeConnections?.length ?? null,
      waiting: inner._connectionQueue?.length ?? null,
      max: inner.config?.connectionLimit ?? null,
    };
    info.host = inner.config?.host || null;
    info.database = inner.config?.database || null;
  } else if (dbType === 'sqlite') {
    info.dialect = 'sqlite';
    info.sqlite = { path: SQLITE_PATH };
    try {
      // 页面日志/库大小，方便判断要不要上 PG
      info.sqlite.fileSize = existsSync(SQLITE_PATH) ? statSync(SQLITE_PATH).size : null;
    } catch { /* 忽略 */ }
  }
  return info;
}

/**
 * 探活：执行一次最轻的查询，返回耗时。
 * 端点用它区分「进程活着但数据库断了」。
 */
export async function pingDb() {
  if (!db) return { ok: false, error: '数据库未初始化' };
  const started = Date.now();
  try {
    if (dbType === 'postgres' || dbType === 'mysql') {
      await db.get('SELECT 1 AS ok');
    } else {
      db.get('SELECT 1 AS ok');
    }
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: errorMessage(err) };
  }
}

// ─── 迁移 ─────────────────────────────────────────────────────────────────

/**
 * 各方言的类型/默认值映射。
 *
 * 差异点（踩过才知道）：
 *  - 时间戳用「秒」存整数：SQLite INTEGER、PG/MySQL BIGINT（INTEGER 32 位会在 2038 溢出）
 *  - 默认值：SQLite `strftime('%s','now')`、PG `EXTRACT(EPOCH FROM now())::BIGINT`、MySQL `UNIX_TIMESTAMP()`
 *  - MySQL 的 TEXT 不能直接做主键 → 主键/键列用 VARCHAR
 *  - JSON：PG 用 JSONB（可索引）、MySQL/SQLite 用 JSON
 */
export function schemaDialect(type) {
  if (type === 'postgres') {
    return {
      id: 'TEXT', key: 'TEXT', text: 'TEXT', json: 'JSONB', epoch: 'BIGINT',
      now: 'EXTRACT(EPOCH FROM now())::BIGINT',
    };
  }
  if (type === 'mysql') {
    return {
      id: 'VARCHAR(64)', key: 'VARCHAR(191)', text: 'LONGTEXT', json: 'JSON', epoch: 'BIGINT',
      now: 'UNIX_TIMESTAMP()',
    };
  }
  return {
    id: 'TEXT', key: 'TEXT', text: 'TEXT', json: 'JSON', epoch: 'INTEGER',
    now: "strftime('%s', 'now')",
  };
}

/** 建表/建索引：方言化 DDL（纯函数，便于测试生成结果） */
export function buildSchemaSql(type) {
  const d = schemaDialect(type);
  const statements = [];

  statements.push(`
    CREATE TABLE IF NOT EXISTS machines (
      id ${d.id} PRIMARY KEY,
      type ${d.text} NOT NULL DEFAULT 'local',
      name ${d.text} NOT NULL,
      host ${d.text},
      port INTEGER,
      ssh_user ${d.text},
      log_path ${d.text},
      created_at ${d.epoch} DEFAULT (${d.now}),
      updated_at ${d.epoch} DEFAULT (${d.now})
    )
  `);

  statements.push(`
    CREATE TABLE IF NOT EXISTS log_records (
      id ${d.id} PRIMARY KEY,
      machine_id ${d.text} NOT NULL,
      source_type ${d.text} NOT NULL,
      source_name ${d.text} NOT NULL,
      content ${d.text} NOT NULL,
      severity ${d.text} NOT NULL DEFAULT 'error',
      timestamp ${d.epoch},
      parsed ${d.json},
      created_at ${d.epoch} DEFAULT (${d.now}),
      FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
    )
  `);

  statements.push(`
    CREATE TABLE IF NOT EXISTS analysis_records (
      id ${d.id} PRIMARY KEY,
      log_record_id ${d.text} NOT NULL,
      machine_id ${d.text} NOT NULL,
      diagnosis ${d.text} NOT NULL,
      suggestion ${d.text},
      severity ${d.text},
      model ${d.text},
      token_used INTEGER,
      created_at ${d.epoch} DEFAULT (${d.now}),
      FOREIGN KEY (log_record_id) REFERENCES log_records(id) ON DELETE CASCADE,
      FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
    )
  `);

  statements.push(`
    CREATE TABLE IF NOT EXISTS alert_configs (
      id ${d.id} PRIMARY KEY,
      machine_id ${d.text} NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      patterns ${d.text} NOT NULL DEFAULT '*.log',
      severity_filter ${d.text} DEFAULT 'error',
      cooldown_minutes INTEGER DEFAULT 5,
      webhook_url ${d.text},
      created_at ${d.epoch} DEFAULT (${d.now}),
      updated_at ${d.epoch} DEFAULT (${d.now}),
      FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
    )
  `);

  statements.push(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key ${d.key} PRIMARY KEY,
      value ${d.text} NOT NULL,
      updated_at ${d.epoch} DEFAULT (${d.now})
    )
  `);

  statements.push(`
    CREATE TABLE IF NOT EXISTS skills (
      id ${d.id} PRIMARY KEY,
      name ${d.text} NOT NULL,
      command ${d.text} NOT NULL,
      description ${d.text} DEFAULT '',
      content ${d.text} DEFAULT '',
      category ${d.text} DEFAULT '通用',
      is_default INTEGER DEFAULT 0,
      created_at ${d.epoch} DEFAULT (${d.now}),
      updated_at ${d.epoch} DEFAULT (${d.now})
    )
  `);

  return statements;
}

const CREATE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_log_records_machine ON log_records(machine_id)`,
  `CREATE INDEX IF NOT EXISTS idx_log_records_timestamp ON log_records(timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_analysis_records_log ON analysis_records(log_record_id)`,
];

async function runMigrations() {
  if (!db) return;

  // 建表（逐条 exec：PostgreSQL 的多语句只在不带参数时可用，但单条更好定位错误）
  for (const sql of buildSchemaSql(dbType)) {
    await db.exec(sql);
  }

  // 索引：MySQL 不支持 CREATE INDEX IF NOT EXISTS，统一用 try/catch 兜住「已存在」
  for (const sql of CREATE_INDEXES) {
    try { await db.exec(sql); } catch { /* 已存在 */ }
  }

  // 兼容旧数据：补列（各库都不支持 ADD COLUMN IF NOT EXISTS）
  for (const sql of [
    `ALTER TABLE skills ADD COLUMN content ${schemaDialect(dbType).text} DEFAULT ''`,
    `ALTER TABLE skills ADD COLUMN is_default INTEGER DEFAULT 0`,
  ]) {
    try { await db.exec(sql); } catch { /* 列已存在 */ }
  }
}

// ─── CRUD helpers ────────────────────────────────────────────────────────────

export function upsertMachine(machine) {
  const now = Math.floor(Date.now() / 1000);
  return db.run(
    `INSERT INTO machines (id, type, name, host, port, ssh_user, log_path, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type=excluded.type, name=excluded.name, host=excluded.host,
       port=excluded.port, ssh_user=excluded.ssh_user, log_path=excluded.log_path,
       updated_at=excluded.updated_at`,
    [machine.id, machine.type, machine.name, machine.host, machine.port,
     machine.ssh_user, machine.log_path, now]
  );
}

export function getMachine(id) {
  return db.get(`SELECT * FROM machines WHERE id = ?`, id);
}

export function listMachines() {
  return db.all(`SELECT * FROM machines ORDER BY created_at DESC`);
}

export function deleteMachine(id) {
  return db.run(`DELETE FROM machines WHERE id = ?`, id);
}

export function insertLogRecord(record) {
  return db.run(
    `INSERT INTO log_records (id, machine_id, source_type, source_name, content, severity, timestamp, parsed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [record.id, record.machine_id, record.source_type, record.source_name,
     record.content, record.severity, record.timestamp, record.parsed ? JSON.stringify(record.parsed) : null]
  );
}

export function listLogRecords({ machine_id, severity, limit = 100, offset = 0 } = {}) {
  let sql = `SELECT * FROM log_records WHERE 1=1`;
  const params = [];
  if (machine_id) { sql += ` AND machine_id = ?`; params.push(machine_id); }
  if (severity) { sql += ` AND severity = ?`; params.push(severity); }
  sql += ` ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);
  return db.all(sql, ...params);
}

export function insertAnalysis(record) {
  return db.run(
    `INSERT INTO analysis_records (id, log_record_id, machine_id, diagnosis, suggestion, severity, model, token_used)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [record.id, record.log_record_id, record.machine_id, record.diagnosis,
     record.suggestion, record.severity, record.model, record.token_used]
  );
}

/**
 * 清理过期记录（保留策略）。
 *
 * 之前 logPersistenceMaxAge（默认 7 天）只在手动 `DELETE /api/logs/history` 时生效，
 * 没有任何定时任务 —— 开了持久化 + 几千台机器时，log_records 会无上限增长，
 * 最终把磁盘和查询都拖死。这个函数给后台维护任务调用。
 *
 * @param {{ logDays?: number, analysisDays?: number }} [opts]
 * @returns {Promise<{ logs:number, analyses:number }>}
 */
export async function pruneOldRecords({ logDays = 7, analysisDays = 30 } = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const results = { logs: 0, analyses: 0 };
  if (logDays > 0) {
    // log_records 的 timestamp 是毫秒；旧数据可能为空，用 created_at 兜底
    const cutoffMs = (nowSec - logDays * 86400) * 1000;
    const cutoffSec = nowSec - logDays * 86400;
    const r = await db.run(
      `DELETE FROM log_records WHERE (timestamp IS NOT NULL AND timestamp < ?) OR (timestamp IS NULL AND created_at < ?)`,
      cutoffMs, cutoffSec,
    );
    results.logs = r?.changes || 0;
  }
  if (analysisDays > 0) {
    const cutoffSec = nowSec - analysisDays * 86400;
    const r = await db.run(`DELETE FROM analysis_records WHERE created_at < ?`, cutoffSec);
    results.analyses = r?.changes || 0;
  }
  return results;
}

/** WAL checkpoint：长时间高频写之后把 WAL 收敛回主库，避免 -wal 无限增长 */
export async function checkpoint() {
  try {
    if (dbType !== 'sqlite' || !rawDb) return false;
    rawDb.pragma('wal_checkpoint(TRUNCATE)');
    return true;
  } catch {
    return false;
  }
}

export async function listAnalysis({ machine_id, log_record_id, limit = 50 } = {}) {
  let sql = `SELECT * FROM analysis_records WHERE 1=1`;
  const params = [];
  if (machine_id) { sql += ` AND machine_id = ?`; params.push(machine_id); }
  if (log_record_id) { sql += ` AND log_record_id = ?`; params.push(log_record_id); }
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);
  return db.all(sql, ...params);
}

// ─── KV Store (settings 等) ─────────────────────────────────────────────────
//
// 为什么加内存缓存：`getKv` 被 `loadSettings()` / `ensureSettings()` 这类**同步**函数调用，
// 而 MySQL / PostgreSQL 适配层是异步的 —— 直接 `db.get()` 会返回 Promise，
// 于是 PG 下读到的配置全是 undefined（真实 bug）。
// 做法：启动时把整表读进 Map，读走内存（同步），写先更新内存再异步落库。
// kv_store 存的是配置/小数据（几十条），全量缓存完全划算。

const kvCache = new Map();
let kvCacheLoaded = false;
let kvFlushChain = Promise.resolve();

/** 启动时加载 kv 全表到内存（异步）。SQLite 也走这条路，保持行为一致。 */
export async function loadKvCache() {
  const rows = await db.all(`SELECT key, value FROM kv_store`);
  kvCache.clear();
  for (const row of rows || []) {
    let parsed;
    try { parsed = JSON.parse(row.value); } catch { parsed = row.value; }
    kvCache.set(row.key, parsed);
  }
  kvCacheLoaded = true;
  return kvCache.size;
}

/** 测试用：清空缓存状态 */
export function _resetKvCache() {
  kvCache.clear();
  kvCacheLoaded = false;
  kvFlushChain = Promise.resolve();
}

/** 同步读（内存）。未加载时返回 null。 */
export function getKv(key) {
  return kvCache.has(key) ? kvCache.get(key) : null;
}

/** 写：更新内存 + 异步落库（返回 Promise 便于需要确定性的调用方 await） */
export function setKv(key, value) {
  kvCache.set(key, value);
  const now = Math.floor(Date.now() / 1000);
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  const write = () => db.run(
    `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    [key, str, now]
  );
  // 串行化：同一 key 连续写时保持落库顺序
  const p = kvFlushChain.then(write).catch(err => {
    console.error('[DB] kv 落库失败:', errorMessage(err));
  });
  kvFlushChain = p;
  return p;
}

export function deleteKv(key) {
  kvCache.delete(key);
  const p = kvFlushChain.then(() => db.run(`DELETE FROM kv_store WHERE key = ?`, key)).catch(err => {
    console.error('[DB] kv 删除失败:', errorMessage(err));
  });
  kvFlushChain = p;
  return p;
}

/** 等待所有 kv 写入落库（退出/测试用） */
export function flushKvWrites() {
  return kvFlushChain;
}

// ─── Skills ────────────────────────────────────────────────────────────────

export function listSkills() {
  return db.all(`SELECT * FROM skills ORDER BY category, name`);
}

export function getSkill(id) {
  return db.get(`SELECT * FROM skills WHERE id = ?`, id);
}

export function createSkill(skill) {
  const now = Math.floor(Date.now() / 1000);
  return db.run(
    `INSERT INTO skills (id, name, command, description, content, category, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [skill.id, skill.name, skill.command, skill.description || '', skill.content || '', skill.category || '通用', skill.is_default ? 1 : 0, now, now]
  );
}

export function updateSkill(id, skill) {
  const now = Math.floor(Date.now() / 1000);
  return db.run(
    `UPDATE skills SET name=?, command=?, description=?, content=?, category=?, updated_at=? WHERE id=?`,
    [skill.name, skill.command, skill.description || '', skill.content || '', skill.category || '通用', now, id]
  );
}

export function deleteSkill(id) {
  return db.run(`DELETE FROM skills WHERE id = ?`, id);
}

/** kv 列表（内存缓存；prefix 过滤） */
export function listKv(prefix = '') {
  const out = [];
  for (const [key, value] of kvCache) {
    if (prefix && !key.startsWith(prefix)) continue;
    out.push({ key, value: typeof value === 'string' ? value : JSON.stringify(value) });
  }
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

// ─── Alert Configs ─────────────────────────────────────────────────────────

export function getAlertConfig(machine_id) {
  return db.get(`SELECT * FROM alert_configs WHERE machine_id = ?`, machine_id);
}

export function upsertAlertConfig(config) {
  const now = Math.floor(Date.now() / 1000);
  return db.run(
    `INSERT INTO alert_configs (id, machine_id, enabled, patterns, severity_filter, cooldown_minutes, webhook_url, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       enabled=excluded.enabled, patterns=excluded.patterns,
       severity_filter=excluded.severity_filter, cooldown_minutes=excluded.cooldown_minutes,
       webhook_url=excluded.webhook_url, updated_at=excluded.updated_at`,
    [config.id, config.machine_id, config.enabled ? 1 : 0, config.patterns,
     config.severity_filter, config.cooldown_minutes, config.webhook_url, now]
  );
}

export function listAlertConfigs() {
  return db.all(`SELECT * FROM alert_configs ORDER BY machine_id`);
}

/**
 * 关闭数据库。
 * 连接池的 `end()` 是异步的，这里返回 Promise 方便优雅退出时 await；
 * 老调用点（不 await）依然可用。
 */
export function closeDb() {
  if (!rawDb) return Promise.resolve();
  const conn = rawDb;
  const type = dbType;
  rawDb = null; db = null; dbType = null;
  try {
    if (type === 'mysql') return Promise.resolve(conn.end()).catch(() => {});
    if (type === 'postgres') return Promise.resolve(conn.end()).catch(() => {});
    conn.close();
  } catch { /* 忽略 */ }
  return Promise.resolve();
}
