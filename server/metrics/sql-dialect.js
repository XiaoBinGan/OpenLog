/**
 * 监控三张表（api_metrics_minute / db_metric_sample / slow_query_log）的 SQL 方言集中层。
 * 负责人：#7 store。契约见 docs/monitoring-contract.md 第 3 节。
 *
 * 为什么要把方言单独抽一个文件：
 *  建表/写入/淘汰分散在 store、sampler、router 三处，只要有一处漏写冲突子句，
 *  PG 上就会变成「重复插入 → 主键冲突报错 → 监控数据静默丢失」。
 *  集中以后这里只有纯字符串生成，没有任何 IO，可以单独断言生成结果。
 *
 * 方言差异只有四类：
 *  1) 毫秒时间戳：SQLite 只有 INTEGER，PG/MySQL 用 BIGINT；
 *  2) 自增主键：PG 用 BIGSERIAL，MySQL 用 AUTO_INCREMENT，SQLite 用 INTEGER PRIMARY KEY AUTOINCREMENT；
 *  3) 占位符：PG 是 $1..$n，SQLite/MySQL 是 ?；
 *  4) 冲突子句：PG/SQLite 是 ON CONFLICT ... DO UPDATE，MySQL 是 ON DUPLICATE KEY UPDATE。
 */

/** 归一化数据库类型：环境变量里 pg/postgresql/sqlite3 这些写法都得认 */
export function normalizeDbType(dbType) {
  const t = String(dbType || '').trim().toLowerCase();
  if (t === 'pg' || t === 'postgresql' || t === 'postgres') return 'postgres';
  if (t === 'mysql' || t === 'mariadb') return 'mysql';
  return 'sqlite';
}

/**
 * 生成占位符。
 * api-store 的 DELETE/查询也要拼 SQL，让它复用这里而不是自己写 `dbType === 'postgres' ? '$' : '?'`。
 * @param {string} dbType
 * @param {number} [index=1] 第几个参数（PG 从 1 开始）
 * @returns {string}
 */
export function placeholder(dbType, index = 1) {
  return normalizeDbType(dbType) === 'postgres' ? `$${index}` : '?';
}

/** SQLite 只有 INTEGER（BIGINT 会被亲和成 INTEGER，不如直接写对） */
function tsType(t) {
  return t === 'sqlite' ? 'INTEGER' : 'BIGINT';
}

/** 自增主键：SQLite 必须显式 AUTOINCREMENT，否则删掉的 id 会被复用（指纹比对会串行） */
function serialPk(t) {
  if (t === 'postgres') return 'BIGSERIAL PRIMARY KEY';
  if (t === 'mysql') return 'BIGINT AUTO_INCREMENT PRIMARY KEY';
  return 'INTEGER PRIMARY KEY AUTOINCREMENT';
}

/** 可能进主键/唯一索引的文本列：MySQL 的 TEXT 不能做主键，必须收窄成 VARCHAR */
function keyText(t, len = 191) {
  return t === 'mysql' ? `VARCHAR(${len})` : 'TEXT';
}

/** 大文本（JSON 采样 / SQL 样本） */
function longText(t) {
  return t === 'mysql' ? 'LONGTEXT' : 'TEXT';
}

/**
 * 建表 + 建索引语句（3 张表）。
 * 建表一律 IF NOT EXISTS，所以重复执行幂等；索引在 MySQL 上不支持 IF NOT EXISTS，
 * 由 api-store 的 ensureSchema 容忍「已存在」这类错误。
 * @param {'postgres'|'sqlite'|'mysql'|string} dbType
 * @returns {string[]} 依次执行的 DDL 语句
 */
export function ddlFor(dbType) {
  const t = normalizeDbType(dbType);
  const ts = tsType(t);
  const idx = t === 'mysql' ? 'CREATE INDEX' : 'CREATE INDEX IF NOT EXISTS';

  return [
    `CREATE TABLE IF NOT EXISTS api_metrics_minute (
  bucket_ms ${ts} NOT NULL,
  route ${keyText(t)} NOT NULL,
  method ${keyText(t, 16)} NOT NULL,
  calls INTEGER NOT NULL,
  err4xx INTEGER NOT NULL DEFAULT 0,
  err5xx INTEGER NOT NULL DEFAULT 0,
  p50_ms REAL,
  p95_ms REAL,
  p99_ms REAL,
  max_ms REAL,
  PRIMARY KEY (bucket_ms, method, route)
)`,
    `CREATE TABLE IF NOT EXISTS db_metric_sample (
  ts_ms ${ts} NOT NULL PRIMARY KEY,
  kind ${keyText(t, 16)} NOT NULL,
  payload ${longText(t)} NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS slow_query_log (
  id ${serialPk(t)},
  ts_ms ${ts} NOT NULL,
  fingerprint ${keyText(t)} NOT NULL,
  ms REAL NOT NULL,
  source ${keyText(t, 120)},
  sample ${longText(t)}
)`,
    `${idx} idx_api_metrics_minute_bucket ON api_metrics_minute(bucket_ms)`,
    `${idx} idx_slow_query_log_ts ON slow_query_log(ts_ms)`,
  ];
}

/** 写入列顺序：api-store 的 toRowValues() 必须严格按这个顺序排参数 */
export const UPSERT_COLUMNS = [
  'bucket_ms', 'route', 'method', 'calls',
  'err4xx', 'err5xx', 'p50_ms', 'p95_ms', 'p99_ms', 'max_ms',
];

/** 冲突时要覆盖的列：bucket_ms/route/method 是主键，不动；其余全部用新值盖掉 */
const UPSERT_OVERWRITE = ['calls', 'err4xx', 'err5xx', 'p50_ms', 'p95_ms', 'p99_ms', 'max_ms'];

/**
 * 生成多值 upsert 语句。
 *
 * 为什么是多值：一次写一整分钟的全部路由聚合（几十到几百行）。
 * 逐行 INSERT 在 SQLite 上是 N 次语句 + N 次 fsync 排队，写锁被拉长，
 * 主服务的读请求全堵在后面；合成一条语句后写放大只有一次。
 *
 * @param {'postgres'|'sqlite'|'mysql'|string} dbType
 * @param {number} [rowCount=1] 这一条语句里塞几行
 * @returns {string} 带占位符的 SQL
 */
export function upsertSql(dbType, rowCount = 1) {
  const t = normalizeDbType(dbType);
  const rows = Math.max(1, Math.floor(Number(rowCount) || 1));
  const per = UPSERT_COLUMNS.length;
  const tuples = [];
  let n = 1;
  for (let r = 0; r < rows; r += 1) {
    const cells = [];
    for (let c = 0; c < per; c += 1) {
      cells.push(t === 'postgres' ? `$${n}` : '?');
      n += 1;
    }
    tuples.push(`(${cells.join(', ')})`);
  }

  const head = `INSERT INTO api_metrics_minute (${UPSERT_COLUMNS.join(', ')}) VALUES ${tuples.join(', ')}`;
  if (t === 'mysql') {
    return `${head} ON DUPLICATE KEY UPDATE ${UPSERT_OVERWRITE.map((c) => `${c} = VALUES(${c})`).join(', ')}`;
  }
  // PG 用 EXCLUDED，SQLite 关键字大小写不敏感但统一写小写更符合社区习惯
  const ref = t === 'postgres' ? 'EXCLUDED' : 'excluded';
  return `${head} ON CONFLICT (bucket_ms, method, route) DO UPDATE SET ${UPSERT_OVERWRITE.map((c) => `${c} = ${ref}.${c}`).join(', ')}`;
}

/**
 * 慢查询单行插入语句（id 交给自增）。
 * @param {'postgres'|'sqlite'|'mysql'|string} dbType
 * @returns {string}
 */
export function insertSlowQuerySql(dbType) {
  const t = normalizeDbType(dbType);
  const cols = ['ts_ms', 'fingerprint', 'ms', 'source', 'sample'];
  const cells = cols.map((_, i) => (t === 'postgres' ? `$${i + 1}` : '?'));
  return `INSERT INTO slow_query_log (${cols.join(', ')}) VALUES (${cells.join(', ')})`;
}
