/**
 * remote-store.js — 远程服务器的关系型持久化（替代原来 kv 里的整块 JSON）。
 *
 * 旧的存法：所有服务器塞进 `kv_store` 的一个 key（`remote_servers`），
 * 任何一台机器状态变化都要序列化+重写整个数组。1000 台时：
 *   - 每次写 ≈ 332KB JSON + SQLite 同步写（实测 1.7ms，5000 台 8.5ms）
 *   - better-sqlite3 是同步 API → 直接阻塞事件循环
 *   - 重连抖动时每秒可能写多次，事件循环被反复打断
 *
 * 现在：一台机器一行，状态变化只 UPDATE 一行，写操作走「合并 + 微批」队列，
 * 同一台机器 100ms 内的多次状态变更只落库一次；配置类修改（增/删/改）可 flush 等落库完成。
 *
 * 兼容性：
 *   - 首次启动检测到旧 kv 数据 → 自动迁移到表，旧 key 保留为备份（`remote_servers_legacy`）
 *   - 数据库适配层可能是同步（SQLite）或异步（MySQL/PostgreSQL），两种都处理
 */

import { getDb, getDbType, getKv, setKv, schemaDialect } from './db/index.js';
import { errorMessage } from './errors.js';

/** 服务器表名：不要和 log_records 的 machines 表混淆（那张表用于日志归属） */
export const SERVERS_TABLE = 'remote_servers';

/** 显式列；不认识的字段进 extra（JSON），保证加字段不用改表 */
const COLUMNS = [
  'id', 'name', 'host', 'port', 'username', 'password',
  'private_key', 'private_key_path', 'log_path', 'watch_files',
  'status', 'last_error', 'last_error_at', 'last_connected',
  'extra', 'created_at', 'updated_at',
];

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_remote_servers_status ON ${SERVERS_TABLE}(status)`,
  `CREATE INDEX IF NOT EXISTS idx_remote_servers_host ON ${SERVERS_TABLE}(host)`,
];

/** 方言化建表语句（MySQL 的 TEXT 不能做 PK，PG/MySQL 时间戳用 BIGINT） */
export function buildServersDdl(type) {
  const d = schemaDialect(type);
  return `
CREATE TABLE IF NOT EXISTS ${SERVERS_TABLE} (
  id ${d.id} PRIMARY KEY,
  name ${d.text} NOT NULL,
  host ${d.text} NOT NULL,
  port INTEGER,
  username ${d.text},
  password ${d.text},
  private_key ${d.text},
  private_key_path ${d.text},
  log_path ${d.text},
  watch_files ${d.text},
  status ${d.text},
  last_error ${d.text},
  last_error_at ${d.text},
  last_connected ${d.text},
  extra ${d.text},
  created_at ${d.epoch},
  updated_at ${d.epoch}
)`;
}

let tableReady = false;

/** 建表（幂等，首次调用执行一次） */
export async function ensureServersTable() {
  if (tableReady) return;
  const db = getDb();
  await db.exec(buildServersDdl(getDbType()));
  for (const idx of INDEXES) {
    try { await db.exec(idx); } catch { /* 索引已存在或方言差异，忽略 */ }
  }
  tableReady = true;
}

/** 测试用：重置建表状态 */
export function _resetTableReady() {
  tableReady = false;
}

/** 服务器对象 → 行 */
export function serverToRow(server, encryptPassword) {
  const known = new Set(['id', 'name', 'host', 'port', 'username', 'password', 'privateKey', 'privateKeyPath', 'logPath', 'watchFiles', 'status', 'lastError', 'lastErrorAt', 'lastConnected', 'createdAt']);
  const extra = {};
  for (const [k, v] of Object.entries(server || {})) {
    if (!known.has(k) && v !== undefined) extra[k] = v;
  }
  const now = Math.floor(Date.now() / 1000);
  return {
    id: server.id,
    name: server.name || server.host || server.id,
    host: server.host || '',
    port: server.port ?? 22,
    username: server.username ?? null,
    password: server.password ? encryptPassword(server.password) : null,
    private_key: server.privateKey ?? null,
    private_key_path: server.privateKeyPath ?? null,
    log_path: server.logPath ?? null,
    watch_files: server.watchFiles != null ? JSON.stringify(server.watchFiles) : null,
    status: server.status ?? 'disconnected',
    last_error: server.lastError ?? null,
    last_error_at: server.lastErrorAt ?? null,
    last_connected: server.lastConnected ?? null,
    extra: Object.keys(extra).length ? JSON.stringify(extra) : null,
    created_at: server.createdAt ?? now,
    updated_at: now,
  };
}

/** 行 → 服务器对象 */
export function rowToServer(row, decryptPassword) {
  if (!row) return null;
  let extra = {};
  try {
    if (row.extra) extra = typeof row.extra === 'string' ? JSON.parse(row.extra) : row.extra;
  } catch { extra = {}; }
  let watchFiles = row.watch_files ?? '*.log';
  if (typeof watchFiles === 'string' && watchFiles.startsWith('[')) {
    try { watchFiles = JSON.parse(watchFiles); } catch { /* 保持原样 */ }
  }
  return {
    ...extra,
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port ?? 22,
    username: row.username ?? undefined,
    password: row.password ? decryptPassword(row.password) : undefined,
    privateKey: row.private_key ?? undefined,
    privateKeyPath: row.private_key_path ?? undefined,
    logPath: row.log_path ?? '/var/log',
    watchFiles,
    status: row.status || 'disconnected',
    lastError: row.last_error ?? null,
    lastErrorAt: row.last_error_at ?? null,
    lastConnected: row.last_connected ?? null,
    createdAt: row.created_at ?? undefined,
  };
}

/** 读全部行（未解密） */
export async function listServerRows() {
  await ensureServersTable();
  const db = getDb();
  const rows = await db.all(`SELECT ${COLUMNS.join(', ')} FROM ${SERVERS_TABLE}`);
  return Array.isArray(rows) ? rows : [];
}

export async function countServerRows() {
  await ensureServersTable();
  const db = getDb();
  const row = await db.get(`SELECT COUNT(*) AS n FROM ${SERVERS_TABLE}`);
  return Number(row?.n || 0);
}

/**
 * 生成多行 INSERT 的 SQL 与参数（纯函数，便于测试）。
 * 1000 行如果逐个 INSERT，走远程 PostgreSQL 就是 1000 次网络往返
 * （实测 20s+）；按 100 行一批可以降到 10 次左右。
 */
export function buildBulkInsertSql(rows) {
  const values = rows.map(() => `(${COLUMNS.map(() => '?').join(', ')})`).join(', ');
  const params = [];
  for (const row of rows) {
    for (const c of COLUMNS) params.push(row[c] ?? null);
  }
  return {
    sql: `INSERT INTO ${SERVERS_TABLE} (${COLUMNS.join(', ')}) VALUES ${values}`,
    params,
  };
}

/** 批量导入时每批行数：兼顾往返次数与单条 SQL 大小 */
export const BULK_INSERT_CHUNK = 100;

/** 整体替换（仅用于迁移/导入） */
export async function replaceAllServerRows(rows) {
  await ensureServersTable();
  const db = getDb();
  await db.run(`DELETE FROM ${SERVERS_TABLE}`);
  const list = Array.isArray(rows) ? rows : [];
  for (let i = 0; i < list.length; i += BULK_INSERT_CHUNK) {
    const chunk = list.slice(i, i + BULK_INSERT_CHUNK);
    const { sql, params } = buildBulkInsertSql(chunk);
    await db.run(sql, params);
  }
}

// ─── 写队列：同一台机器的多次状态变更合并成一次落库 ──────────────────────

const pending = new Map();          // id → { row, deleted }
let flushTimer = null;
let flushing = null;
const FLUSH_DELAY_MS = 100;

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushPending().catch(err => console.error('[RemoteStore] 落库失败:', errorMessage(err)));
  }, FLUSH_DELAY_MS);
  if (flushTimer.unref) flushTimer.unref();
}

/**
 * 把一台服务器的当前状态排入写队列。
 * @param {object} row serverToRow() 的结果
 */
export function queueServerWrite(row) {
  pending.set(row.id, { row, deleted: false });
  scheduleFlush();
}

/** 删除一台服务器（排队） */
export function queueServerDelete(id) {
  pending.set(id, { row: null, deleted: true });
  scheduleFlush();
}

/** 立刻把队列写掉（返回 Promise，供配置变更/测试/退出时等待） */
export async function flushServerWrites() {
  if (flushing) await flushing;
  flushing = flushPending();
  try {
    await flushing;
  } finally {
    flushing = null;
  }
}

async function flushPending() {
  if (pending.size === 0) return;
  const batch = [...pending.entries()];
  pending.clear();
  const db = getDb();
  await ensureServersTable();

  for (const [id, { row, deleted }] of batch) {
    try {
      if (deleted) {
        await db.run(`DELETE FROM ${SERVERS_TABLE} WHERE id = ?`, id);
      } else {
        // 方言通用的 upsert：先试 UPDATE，没命中再 INSERT
        const res = await db.run(
          `UPDATE ${SERVERS_TABLE} SET ${COLUMNS.filter(c => c !== 'id').map(c => `${c} = ?`).join(', ')} WHERE id = ?`,
          ...COLUMNS.filter(c => c !== 'id').map(c => row[c] ?? null),
          id,
        );
        if (!res || !res.changes) {
          await db.run(
            `INSERT INTO ${SERVERS_TABLE} (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`,
            ...COLUMNS.map(c => row[c] ?? null),
          );
        }
      }
    } catch (err) {
      console.error(`[RemoteStore] 写服务器 ${id} 失败:`, errorMessage(err));
    }
  }
}

/** 测试用：当前待写数量 */
export function _pendingWriteCount() {
  return pending.size;
}

// ─── 旧 kv 数据迁移 ──────────────────────────────────────────────────────

/**
 * 把旧 `kv_store.remote_servers` 迁移到表里。
 * 旧 key 先复制到 `remote_servers_legacy` 作为备份，再删除原 key，避免重复迁移。
 *
 * @param {(s: object) => object} encryptedToRow 远端传入的行转换（需要加密密码）
 * @returns {Promise<number>} 迁移条数
 */
export async function migrateLegacyKvServers(encryptedToRow) {
  const legacy = getKv('remote_servers');
  if (!Array.isArray(legacy) || legacy.length === 0) return 0;
  const existing = await countServerRows();
  if (existing > 0) return 0; // 表里已有数据，不动

  const rows = legacy.map(s => encryptedToRow(s));
  await replaceAllServerRows(rows);
  try {
    setKv('remote_servers_legacy', legacy);
    setKv('remote_servers', []);
  } catch { /* 备份失败不影响迁移结果 */ }
  console.log(`[RemoteStore] 已把 ${rows.length} 台服务器从 kv 迁移到 ${SERVERS_TABLE} 表`);
  return rows.length;
}

export default {
  SERVERS_TABLE, ensureServersTable, serverToRow, rowToServer,
  listServerRows, countServerRows, replaceAllServerRows,
  queueServerWrite, queueServerDelete, flushServerWrites,
  migrateLegacyKvServers,
};
