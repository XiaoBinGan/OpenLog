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

/** watch_files 字段长度上限：超过就判定为历史膨胀数据，回退默认值 */
export const MAX_WATCH_FILES_CHARS = 4096;
/** watch_files 默认值（与 UI 的日志匹配模式一致） */
export const DEFAULT_WATCH_FILES = '*.log';

/**
 * 归一化 watch_files 字段（读取时用）。
 *
 * ⚠️ 历史大坑：早期 serverToRow 无条件 JSON.stringify(watchFiles)，而 rowToServer 只在
 * 值以 "[" 开头时才 JSON.parse。于是普通字符串 '*.log' 存成 '"*.log"'，读回来还是
 * '"*.log"'（带引号），下次保存又 stringify 一遍 —— 每保存一次多一层转义，
 * 因为每层转义都把上一层的内层引号再转义一次，长度按 2^n 膨胀。
 * 而 saveServer() 在每次状态变化（每 30s 的状态采集）都会调用，几十分钟就能把一行
 * 撑到 32MB：/api/remote/servers 返回上百 MB JSON，浏览器直接卡死，
 * 表现为「服务器连接全没了」，同时写库超时报 Connection terminated。
 *
 * 现在：字符串原样存、读取时最多解 8 层历史嵌套，并限制长度。
 */
function unwrapLayers(value, maxDepth) {
  let v = value;
  for (let depth = 0; depth < maxDepth && typeof v === 'string'; depth++) {
    // 长度已超限就不再解析：32MB 的 JSON.parse 很贵，而列表请求每次都会走这里
    if (v.length > MAX_WATCH_FILES_CHARS) break;
    const t = v.trim();
    // 只有形如 '"..."' 或 '["..."]' 才可能是 JSON 编码过的历史值
    if (!(t.startsWith('"') || t.startsWith('['))) break;
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string' || Array.isArray(parsed)) { v = parsed; continue; }
    } catch { /* 不是合法 JSON，当普通字符串 */ }
    break;
  }
  if (v == null) return DEFAULT_WATCH_FILES;
  // 数组是历史写法（旧版按数组存），保留数组语义，别悄悄改成字符串
  if (Array.isArray(v)) {
    const arr = v.map(x => String(x));
    return arr.join(',').length > MAX_WATCH_FILES_CHARS ? DEFAULT_WATCH_FILES : arr;
  }
  const str = String(v);
  if (!str || str.length > MAX_WATCH_FILES_CHARS) return DEFAULT_WATCH_FILES;
  return str;
}

/**
 * 读取时归一化（轻量，列表请求里会用）：最多解 8 层历史嵌套，
 * 超长脏值直接回退默认值，不做昂贵的深度解析。
 */
export function normalizeWatchFiles(value) {
  return unwrapLayers(value, 8);
}

/**
 * 深度归一化：最多解 64 层嵌套。**只给一次性修复用**（启动时 repairServerRows），
 * 因为膨胀值每层转义长度翻倍，需要多轮才能剥干净，代价较大。
 */
export function deepNormalizeWatchFiles(value) {
  return unwrapLayers(value, 64);
}

/**
 * 序列化 watch_files（写入时用）。
 *
 * **关键：字符串原样存**，不要再 JSON.stringify —— 那正是膨胀 bug 的来源
 * （存进去 '"*.log"'，读的时候只认 '[' 开头所以原样返回带引号的字符串，
 * 下次保存再 stringify 一层，长度按 2^n 涨）。数组是历史写法，仍按 JSON 存。
 */
export function serializeWatchFiles(value) {
  if (Array.isArray(value)) {
    const arr = value.map(x => String(x));
    return arr.join(',').length > MAX_WATCH_FILES_CHARS ? DEFAULT_WATCH_FILES : JSON.stringify(arr);
  }
  return normalizeWatchFiles(value);
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
    watch_files: server.watchFiles != null ? serializeWatchFiles(server.watchFiles) : null,
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
  const watchFiles = normalizeWatchFiles(row.watch_files);
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

/**
 * 修复历史膨胀行（启动时跑一次，幂等）。
 *
 * 只修 watch_files：它被双重编码过，可能已经涨到几十 MB。修复后写库恢复正常大小。
 * @returns {Promise<{scanned:number, fixed:number, bytesFreed:number}>}
 */
export async function repairServerRows() {
  await ensureServersTable();
  const db = getDb();
  let rows = [];
  try {
    rows = await db.all(`SELECT id, watch_files FROM ${SERVERS_TABLE}`);
  } catch {
    return { scanned: 0, fixed: 0, bytesFreed: 0 };
  }
  let fixed = 0;
  let bytesFreed = 0;
  for (const row of (rows || [])) {
    const rawValue = row.watch_files;
    if (rawValue == null) continue;
    const normalized = deepNormalizeWatchFiles(rawValue);
    if (String(rawValue) !== normalized) {
      bytesFreed += Math.max(0, String(rawValue).length - normalized.length);
      try {
        await db.run(`UPDATE ${SERVERS_TABLE} SET watch_files = ? WHERE id = ?`, [normalized, row.id]);
        fixed++;
      } catch { /* 单行失败不影响其它行 */ }
    }
  }
  return { scanned: (rows || []).length, fixed, bytesFreed };
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
  listServerRows, countServerRows, replaceAllServerRows, repairServerRows,
  normalizeWatchFiles, deepNormalizeWatchFiles, serializeWatchFiles,
  queueServerWrite, queueServerDelete, flushServerWrites,
  migrateLegacyKvServers,
};
