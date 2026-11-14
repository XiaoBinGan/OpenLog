/**
 * TSDB 表结构 —— 时序数据的持久化骨架。
 *
 * 为什么不能用现有的 `db_metric_sample` 表：那张表是「一行一整个 JSON 快照」，
 * 查询要全表扫、无法按标签过滤、无法做时间窗口聚合。它的定位是自身可观测性
 * （把一次采样整体存下来给人看），不是时序库。
 *
 * 两张表的设计：
 *   ts_series  一条时间序列一行（指标名 + 标签集合），指纹唯一
 *   ts_sample  (series_id, ts_ms) 主键，一行一个采样点
 *
 * 为什么不把标签平铺成列：标签集合是动态的（不同指标标签完全不同），
 * 平铺会变成几百列、每行大量 NULL，SQLite 的存储和索引都会崩。
 * 用 JSON 存 + 内存索引过滤，是 Prometheus 之外多数轻量实现的共同选择。
 */

import { normalizeDbType } from '../metrics/sql-dialect.js';

/** SQLite 只有 INTEGER；PG/MySQL 用 BIGINT */
function tsType(t) {
  return t === 'sqlite' ? 'INTEGER' : 'BIGINT';
}

/** MySQL 的 TEXT 不能进主键/唯一索引，必须收窄 */
function keyText(t, len = 191) {
  return t === 'mysql' ? `VARCHAR(${len})` : 'TEXT';
}

/** 自增主键：三方言写法不同 */
function serialPk(t) {
  if (t === 'postgres') return 'BIGSERIAL PRIMARY KEY';
  if (t === 'mysql') return 'BIGINT AUTO_INCREMENT PRIMARY KEY';
  return 'INTEGER PRIMARY KEY AUTOINCREMENT';
}

/** 索引语句：MySQL 不支持 IF NOT EXISTS，由 ensureSchema 容忍「已存在」错误 */
function idxStmt(t, name, table, cols) {
  const head = t === 'mysql' ? 'CREATE INDEX' : 'CREATE INDEX IF NOT EXISTS';
  return `${head} ${name} ON ${table}(${cols})`;
}

/**
 * TSDB 建表语句。
 *
 * @param {'postgres'|'sqlite'|'mysql'|string} dbType
 * @returns {string[]}
 */
export function tsdbDdl(dbType) {
  const t = normalizeDbType(dbType);
  const ts = tsType(t);

  return [
    // 序列表：fingerprint 唯一，name/labels 冗余存着便于排查（不必每次反解指纹）
    `CREATE TABLE IF NOT EXISTS ts_series (
  id ${serialPk(t)},
  fingerprint ${keyText(t, 64)} NOT NULL,
  name ${keyText(t)} NOT NULL,
  labels ${t === 'mysql' ? 'LONGTEXT' : 'TEXT'} NOT NULL
)`,
    // 指纹唯一索引单独建：MySQL 的 TEXT 列建唯一索引必须指定前缀长度，
    // 而 fingerprint 固定 ≤64 字符，收窄成 VARCHAR 后可以直接建
    `CREATE UNIQUE INDEX ${t === 'mysql' ? '' : 'IF NOT EXISTS '}uq_ts_series_fp ON ts_series(fingerprint${t === 'mysql' ? '(64)' : ''})`,
    `${t === 'mysql' ? 'CREATE INDEX' : 'CREATE INDEX IF NOT EXISTS'} idx_ts_series_name ON ts_series(name${t === 'mysql' ? '(191)' : ''})`,

    // 采样表：(series_id, ts_ms) 主键 —— 同一序列同一毫秒只保留一个值，
    // 抓取重叠时用 upsert 覆盖而不是插入重复点
    `CREATE TABLE IF NOT EXISTS ts_sample (
  series_id BIGINT NOT NULL,
  ts_ms ${ts} NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (series_id, ts_ms)
)`,
    // 按时间清理时要走这个索引，否则 retain 会全表扫
    idxStmt(t, 'idx_ts_sample_ts', 'ts_sample', 'ts_ms'),

    // 抓取目标的运行状态（up / scrape_duration / last_error）
    // 单独建表而不是塞进 ts_series：Prometheus 的 up 指标属于目标元数据，
    // 混进用户指标会让「列出所有指标名」被内部指标污染
    `CREATE TABLE IF NOT EXISTS ts_target (
  id ${keyText(t, 200)} NOT NULL PRIMARY KEY,
  job ${keyText(t, 100)} NOT NULL,
  url ${keyText(t, 500)} NOT NULL,
  health ${keyText(t, 16)} NOT NULL DEFAULT 'unknown',
  last_scrape_ms ${ts},
  last_duration_ms REAL,
  last_error ${keyText(t, 500)}
)`,
  ];
}

/** 采样表列顺序 —— 写入与查询必须严格一致 */
export const SAMPLE_COLUMNS = ['series_id', 'ts_ms', 'value'];

/**
 * 生成多值 INSERT ... ON CONFLICT DO NOTHING。
 *
 * 为什么是 DO NOTHING 而不是 DO UPDATE：采样点的主键是 (series_id, ts_ms)，
 * 冲突意味着「同一毫秒已经有一个值」。抓取延迟造成的重复不如保留先到的那个，
 * 更新会让历史点在补抓时被改写，破坏按时间单调的假设。
 *
 * @param {string} dbType
 * @param {number} rows 一行语句塞几个点
 * @returns {string}
 */
export function sampleInsertSql(dbType, rows) {
  const t = normalizeDbType(dbType);
  const n = Math.max(1, Math.floor(Number(rows) || 1));
  const tuples = [];
  let i = 1;
  for (let r = 0; r < n; r += 1) {
    const cells = SAMPLE_COLUMNS.map(() => {
      const ph = t === 'postgres' ? `$${i}` : '?';
      i += 1;
      return ph;
    });
    tuples.push(`(${cells.join(', ')})`);
  }
  const head = `INSERT INTO ts_sample (${SAMPLE_COLUMNS.join(', ')}) VALUES ${tuples.join(', ')}`;
  if (t === 'mysql') return `${head} ON DUPLICATE KEY UPDATE value = value`;
  // SQLite / PG 都支持 DO NOTHING；PG 不需要指名冲突列
  if (t === 'postgres') return `${head} ON CONFLICT DO NOTHING`;
  return `${head} ON CONFLICT (series_id, ts_ms) DO NOTHING`;
}

/** 序列 upsert（拿到 id）。PG/SQLite 用 RETURNING id，MySQL 用 LAST_INSERT_ID 技巧 */
export function seriesInsertSql(dbType) {
  const t = normalizeDbType(dbType);
  if (t === 'postgres') {
    return `INSERT INTO ts_series (fingerprint, name, labels) VALUES ($1, $2, $3)
ON CONFLICT (fingerprint) DO UPDATE SET name = EXCLUDED.name
RETURNING id`;
  }
  if (t === 'mysql') {
    // ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id) 让 LAST_INSERT_ID 返回已存在的行
    return `INSERT INTO ts_series (fingerprint, name, labels) VALUES (?, ?, ?)
ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`;
  }
  return `INSERT INTO ts_series (fingerprint, name, labels) VALUES (?, ?, ?)
ON CONFLICT (fingerprint) DO UPDATE SET name = excluded.name
RETURNING id`;
}