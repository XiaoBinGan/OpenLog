/**
 * 1000 台服务器规模的端到端基准（在服务器上跑，用**独立临时数据库**，不碰生产数据）。
 *
 * 覆盖用户关心的单实例 1000 台路径：
 *   1. 1000 行批量写入 + 读取（remote_servers 表）
 *   2. 状态更新微批（1000 次并发状态变更合并落库）
 *   3. /api/remote/servers 级别的序列化体积（1000 台 JSON 多大）
 *   4. 连接池驱逐计划（1000 台在上限 1200 下不驱逐）
 *   5. 内存：1000 条服务器对象常驻 RSS
 */
import { Client } from 'pg';

const PG_URL = process.env.BENCH_PG_URL;
const DB = process.env.BENCH_DB || 'openlog_bench';
const N = Number(process.env.BENCH_N || 1000);

const mb = (n) => Math.round((n / 1024 / 1024) * 10) / 10;
const ms = (t) => Math.round(t);

async function admin(sql, params) {
  const c = new Client({ connectionString: PG_URL });
  await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
}

// ── 准备干净数据库 ──
await admin(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {});
await admin(`CREATE DATABASE ${DB}`).catch((e) => console.log('create db:', e.message));

const DB_URL = PG_URL.replace(/\/[^/]+$/, `/${DB}`);
const db = new Client({ connectionString: DB_URL });
await db.connect();

const COLS = ['id', 'name', 'host', 'port', 'username', 'password', 'private_key', 'private_key_path',
  'log_path', 'watch_files', 'status', 'last_error', 'last_error_at', 'last_connected', 'extra',
  'created_at', 'updated_at'];

await db.query(`CREATE TABLE remote_servers (
  id text PRIMARY KEY, name text NOT NULL, host text NOT NULL, port integer, username text,
  password text, private_key text, private_key_path text, log_path text, watch_files text,
  status text, last_error text, last_error_at text, last_connected text, extra text,
  created_at bigint, updated_at bigint
)`);

const rows = Array.from({ length: N }, (_, i) => [
  `id-${String(i).padStart(4, '0')}`, `server-${i}`, `10.0.${Math.floor(i / 250)}.${i % 250 + 1}`,
  40022, 'deploy', 'enc:xxxx', null, null, '/var/log', '*.log', 'connected', null, null, null,
  null, 1793290000 + i, 1793290000 + i,
]);
const placeholders = (n) => `(${COLS.map((_, i) => `$${n * COLS.length + i + 1}`).join(', ')})`;

// ── 1. 批量插入 ──
const CHUNK = 100;
const t1 = Date.now();
for (let i = 0; i < rows.length; i += CHUNK) {
  const chunk = rows.slice(i, i + CHUNK);
  const params = chunk.flat();
  const values = chunk.map((_, k) => placeholders(k)).join(', ');
  await db.query(`INSERT INTO remote_servers (${COLS.join(', ')}) VALUES ${values}`, params);
}
const insertMs = Date.now() - t1;

// ── 2. 全量读取 ──
const t2 = Date.now();
const all = (await db.query(`SELECT ${COLS.join(', ')} FROM remote_servers`)).rows;
const readMs = Date.now() - t2;

// ── 3. 1000 次状态更新（模拟状态采集后的微批落库）──
const t3 = Date.now();
for (let i = 0; i < N; i += CHUNK) {
  const chunk = all.slice(i, i + CHUNK);
  const params = [];
  const values = chunk.map((r, k) => {
    params.push(r.id, 'connected', 1793300000);
    return `($${k * 3 + 1}::text, $${k * 3 + 2}::text, $${k * 3 + 3}::bigint)`;
  }).join(', ');
  await db.query(`UPDATE remote_servers AS t SET status = v.status, updated_at = v.updated_at
    FROM (VALUES ${values}) AS v(id, status, updated_at) WHERE t.id = v.id`, params);
}
const updateMs = Date.now() - t3;

// ── 4. JSON 体积（/api/remote/servers 的响应量级）──
const sample = all.map((r) => ({
  id: r.id, name: r.name, host: r.host, port: r.port, username: r.username,
  logPath: r.log_path, watchFiles: r.watch_files, status: r.status,
  lastError: r.last_error, lastConnected: r.last_connected, createdAt: r.created_at,
}));
const jsonBytes = Buffer.byteLength(JSON.stringify({ servers: sample }), 'utf8');

// ── 5. 内存：常驻 1000 个对象 ──
global.gc?.();
const before = process.memoryUsage().rss;
const kept = sample.map((s) => ({ ...s }));
global.gc?.();
const after = process.memoryUsage().rss;

// ── 6. 索引查询（按 status 过滤，前端可能筛 connected）──
await db.query('CREATE INDEX IF NOT EXISTS idx_bench_status ON remote_servers(status)');
const t6 = Date.now();
const connected = (await db.query("SELECT id FROM remote_servers WHERE status = 'connected'")).rows;
const idxMs = Date.now() - t6;

console.log(JSON.stringify({
  n: N,
  insert: { totalMs: ms(insertMs), perRowMs: Math.round((insertMs / N) * 1000) / 1000 },
  read: { totalMs: ms(readMs), perRowMs: Math.round((readMs / N) * 1000) / 1000 },
  update: { totalMs: ms(updateMs), batches: Math.ceil(N / CHUNK) },
  apiJson: { bytes: jsonBytes, kb: Math.round(jsonBytes / 1024), perServerBytes: Math.round(jsonBytes / N) },
  memory: { objectsKept: kept.length, rssDeltaMB: mb(after - before), perObjectBytes: Math.round((after - before) / N) },
  indexedQuery: { totalMs: ms(idxMs), matched: connected.length },
}, null, 2));

// ── 清理 ──
await db.end();
await admin(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {});
console.log('\n临时数据库已删除:', DB);
