/**
 * 统一数据库层
 * 支持 SQLite（本地默认）、MySQL、PostgreSQL
 * 自动检测可用数据库，按优先级适配
 */

import Database from 'better-sqlite3';
import mysql from 'mysql2/promise';
import { Client as PgClient } from 'pg';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../../data');
const SQLITE_PATH = join(DATA_DIR, 'openlog.db');

let db = null;
let dbType = null; // 'sqlite' | 'mysql' | 'postgres'
let rawDb = null;  // 原生连接

// ─── SQLite 适配层 ─────────────────────────────────────────────────────────

function adaptSQLite(conn) {
  return {
    run(sql, ...params) {
      // 单条语句
      const cleanSql = sql.replace(/returning.*/i, '').trim();
      const stmt = conn.prepare(cleanSql);
      return { changes: stmt.run(...params).changes };
    },
    get(sql, ...params) {
      return conn.prepare(sql).get(...params);
    },
    all(sql, ...params) {
      return conn.prepare(sql).all(...params);
    },
    exec(sql) {
      conn.exec(sql);
    }
  };
}

function adaptMySQL(conn) {
  return {
    async run(sql, ...params) {
      const [r] = await conn.execute(sql, params);
      return { changes: r.affectedRows, insertId: r.insertId };
    },
    async get(sql, ...params) {
      const [rows] = await conn.execute(sql, params);
      return rows[0] || null;
    },
    async all(sql, ...params) {
      const [rows] = await conn.execute(sql, params);
      return rows;
    },
    async exec(sql) {
      await conn.query(sql);
    }
  };
}

function adaptPostgres(conn) {
  return {
    async run(sql, ...params) {
      const r = await conn.query(sql, params);
      return { changes: r.rowCount, insertId: r.rows[0]?.id || null };
    },
    async get(sql, ...params) {
      const r = await conn.query(sql, params);
      return r.rows[0] || null;
    },
    async all(sql, ...params) {
      const r = await conn.query(sql, params);
      return r.rows;
    },
    async exec(sql) {
      await conn.query(sql);
    }
  };
}

// ─── 初始化 ────────────────────────────────────────────────────────────────

export async function initDb(config = {}) {
  // config 格式: { type: 'sqlite'|'mysql'|'postgres', path?, connectionString? }
  const { type, connectionString, mysqlConfig, postgresConfig } = config;

  if (db) return db;

  // 优先级：用户指定 > 自动探测
  if (type === 'mysql' || mysqlConfig) {
    try {
      const cfg = mysqlConfig || {};
      const conn = await mysql.createConnection({
        host: cfg.host || 'localhost',
        port: cfg.port || 3306,
        user: cfg.user || 'root',
        password: cfg.password || '',
        database: cfg.database || 'openlog',
        connectTimeout: 3000,
      });
      await conn.execute(`CREATE DATABASE IF NOT EXISTS \`${cfg.database || 'openlog'}\``);
      await conn.execute(`USE \`${cfg.database || 'openlog'}\``);
      rawDb = conn;
      dbType = 'mysql';
      db = await adaptMySQL(conn);
      console.log('[DB] MySQL connected:', cfg.host || 'localhost');
    } catch (err) {
      console.warn('[DB] MySQL 连接失败:', err.message, '→ 尝试下一种...');
      rawDb = null; db = null; dbType = null;
    }
  }

  if (!db && (type === 'postgres' || postgresConfig)) {
    try {
      const cfg = postgresConfig || {};
      const conn = new PgClient({
        host: cfg.host || 'localhost',
        port: cfg.port || 5432,
        user: cfg.user || 'postgres',
        password: cfg.password || '',
        database: cfg.database || 'openlog',
        connectionTimeoutMillis: 3000,
      });
      await conn.connect();
      rawDb = conn;
      dbType = 'postgres';
      db = adaptPostgres(conn);
      console.log('[DB] PostgreSQL connected:', cfg.host || 'localhost');
    } catch (err) {
      console.warn('[DB] PostgreSQL 连接失败:', err.message, '→ 尝试下一种...');
      if (rawDb) { try { rawDb.end(); } catch {} }
      rawDb = null; db = null; dbType = null;
    }
  }

  if (!db) {
    // 默认：SQLite
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      const conn = new Database(SQLITE_PATH);
      conn.pragma('journal_mode = WAL');
      conn.pragma('foreign_keys = ON');
      rawDb = conn;
      dbType = 'sqlite';
      db = adaptSQLite(conn);
      console.log('[DB] SQLite initialized:', SQLITE_PATH);
    } catch (err) {
      throw new Error(`[DB] 无法初始化数据库: ${err.message}`);
    }
  }

  await runMigrations();
  return db;
}

export function getDb() {
  if (!db) throw new Error('DB not initialized. Call initDb() first.');
  return db;
}

export function getDbType() {
  return dbType;
}

// ─── 迁移 ─────────────────────────────────────────────────────────────────

async function runMigrations() {
  if (!db) return;

  // machines 表
  await db.exec(`
    CREATE TABLE IF NOT EXISTS machines (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'local', -- 'local' | 'remote' | 'docker'
      name TEXT NOT NULL,
      host TEXT,
      port INTEGER,
      ssh_user TEXT,
      log_path TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);

  // log_records 表
  await db.exec(`
    CREATE TABLE IF NOT EXISTS log_records (
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL,
      source_type TEXT NOT NULL, -- 'file' | 'docker' | 'container'
      source_name TEXT NOT NULL,
      content TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'error', -- 'error' | 'warn' | 'info'
      timestamp INTEGER,
      parsed JSON,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
    )
  `);

  // analysis_records 表
  await db.exec(`
    CREATE TABLE IF NOT EXISTS analysis_records (
      id TEXT PRIMARY KEY,
      log_record_id TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      diagnosis TEXT NOT NULL,
      suggestion TEXT,
      severity TEXT,
      model TEXT,
      token_used INTEGER,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (log_record_id) REFERENCES log_records(id) ON DELETE CASCADE,
      FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
    )
  `);

  // alert_configs 表
  await db.exec(`
    CREATE TABLE IF NOT EXISTS alert_configs (
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      patterns TEXT NOT NULL DEFAULT '*.log',
      severity_filter TEXT DEFAULT 'error',
      cooldown_minutes INTEGER DEFAULT 5,
      webhook_url TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
    )
  `);

  // 索引
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_log_records_machine ON log_records(machine_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_log_records_timestamp ON log_records(timestamp)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_analysis_records_log ON analysis_records(log_record_id)`);

  // kv_store 表（用于 settings 等键值存储）
  await db.exec(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);
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

export function listAnalysis({ machine_id, log_record_id, limit = 50 } = {}) {
  let sql = `SELECT * FROM analysis_records WHERE 1=1`;
  const params = [];
  if (machine_id) { sql += ` AND machine_id = ?`; params.push(machine_id); }
  if (log_record_id) { sql += ` AND log_record_id = ?`; params.push(log_record_id); }
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);
  return db.all(sql, ...params);
}

// ─── KV Store (settings 等) ─────────────────────────────────────────────────

export function getKv(key) {
  const row = db.get(`SELECT value FROM kv_store WHERE key = ?`, key);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

export function setKv(key, value) {
  const now = Math.floor(Date.now() / 1000);
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  return db.run(
    `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    [key, str, now]
  );
}

export function deleteKv(key) {
  return db.run(`DELETE FROM kv_store WHERE key = ?`, key);
}

export function listKv(prefix = '') {
  if (prefix) {
    return db.all(`SELECT * FROM kv_store WHERE key LIKE ? ORDER BY key`, prefix + '%');
  }
  return db.all(`SELECT * FROM kv_store ORDER BY key`);
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

export function closeDb() {
  if (rawDb) {
    try {
      if (dbType === 'mysql') rawDb.end();
      else if (dbType === 'postgres') rawDb.end();
      else rawDb.close();
    } catch {}
    rawDb = null; db = null; dbType = null;
  }
}
