#!/usr/bin/env node
/**
 * scripts/migrate-sqlite-to-pg.mjs — 把现有 SQLite 数据迁到 PostgreSQL（或 MySQL）。
 *
 * 什么时候用：默认是 SQLite；服务器规模上到几百上千台、或者要多实例共享一个库时换 PG。
 *
 * 用法（在仓库根目录）：
 *   OPENLOG_DB_TYPE=postgres \
 *   OPENLOG_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/openlog \
 *   node scripts/migrate-sqlite-to-pg.mjs
 *
 * 可选：
 *   OPENLOG_DATA_DIR=/path/to/data       SQLite 所在目录（默认 <repo>/data）
 *   OPENLOG_SQLITE_PATH=/path/openlog.db  直接指定 SQLite 文件
 *   --dry-run                            只统计不写入
 *
 * 说明：
 *  - 目标库会自动建表（建表语句与运行时一致，按方言生成）
 *  - 主键冲突时**跳过**（ON CONFLICT DO NOTHING），可重复执行
 *  - kv_store 里的加密数据（SSH 密码）依赖 OPENLOG_SECRET_KEY：
 *    迁移与运行时必须用同一个密钥，否则迁移过去的密码解不开
 *  - 只复制数据，不删除 SQLite 文件（留作回滚）
 */

import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');

const sqlitePath = process.env.OPENLOG_SQLITE_PATH
  || join(process.env.OPENLOG_DATA_DIR || join(ROOT, 'data'), 'openlog.db');

/** 要迁移的表（顺序即依赖顺序：machines 先于 log_records） */
const TABLES = [
  'machines',
  'log_records',
  'analysis_records',
  'alert_configs',
  'kv_store',
  'skills',
  'remote_servers',
];

function tableColumns(sqlite, table) {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all();
  return rows.map(r => r.name);
}

async function main() {
  if (!existsSync(sqlitePath)) {
    console.error(`[migrate] 找不到 SQLite 文件: ${sqlitePath}`);
    console.error('[migrate] 用 OPENLOG_DATA_DIR 或 OPENLOG_SQLITE_PATH 指定位置');
    process.exit(1);
  }
  if (!process.env.OPENLOG_DATABASE_URL && !process.env.OPENLOG_DB_TYPE) {
    console.error('[migrate] 请先设置 OPENLOG_DB_TYPE（postgres/mysql）与连接信息');
    process.exit(1);
  }

  const sqlite = new Database(sqlitePath, { readonly: true });
  console.log(`[migrate] 源 SQLite: ${sqlitePath}`);

  // 目标库：用运行时同一套 DB 层，保证建表/类型与线上完全一致
  const dbm = await import('../server/db/index.js');
  const store = await import('../server/remote-store.js');
  const targetDb = await dbm.initDb();
  console.log(`[migrate] 目标库: ${dbm.getDbType()}`);

  // remote_servers 是运行时单独建的表，这里确保存在
  await store.ensureServersTable();

  const summary = [];

  for (const table of TABLES) {
    // 旧库可能还没有某些表（例如 remote_servers 是新版才拆出来的），跳过而不是报错
    const exists = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(table);
    if (!exists) {
      summary.push({ table, total: 0, copied: 0, skipped: 0, note: '源库无此表' });
      continue;
    }
    const countRow = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    const total = Number(countRow?.n || 0);
    if (total === 0) {
      summary.push({ table, total: 0, copied: 0, skipped: 0 });
      continue;
    }
    const columns = tableColumns(sqlite, table);
    if (columns.length === 0) {
      summary.push({ table, total, copied: 0, skipped: total, note: '表结构不存在' });
      continue;
    }

    if (DRY_RUN) {
      summary.push({ table, total, copied: 0, skipped: 0, note: 'dry-run' });
      continue;
    }

    // 分批读 + 分批写，避免一次把所有数据读进内存
    const CHUNK = 500;
    let copied = 0;
    let skipped = 0;
    for (let offset = 0; offset < total; offset += CHUNK) {
      const rows = sqlite.prepare(`SELECT ${columns.join(', ')} FROM ${table} LIMIT ? OFFSET ?`).all(CHUNK, offset);
      for (const row of rows) {
        const params = columns.map(c => row[c] ?? null);
        const placeholders = columns.map(() => '?').join(', ');
        try {
          // ON CONFLICT DO NOTHING：可重复执行，已存在的主键跳过
          await targetDb.run(
            `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
            params,
          );
          copied += 1;
        } catch (err) {
          skipped += 1;
          console.warn(`[migrate] ${table} 跳过一行: ${err.message}`);
        }
      }
    }
    summary.push({ table, total, copied, skipped });
    console.log(`[migrate] ${table}: ${copied}/${total} 行${skipped ? `（跳过 ${skipped}）` : ''}`);
  }

  // kv 缓存要刷新，否则后续 getKv 读到的还是旧内存（脚本进程内无所谓，提示一下）
  console.log('\n[migrate] 结果汇总:');
  for (const s of summary) {
    console.log(`  ${s.table.padEnd(18)} 源 ${String(s.total).padStart(6)} 行 → 写入 ${String(s.copied).padStart(6)} 行${s.note ? ` (${s.note})` : ''}`);
  }

  sqlite.close();
  await dbm.closeDb();
  console.log(`\n[migrate] ${DRY_RUN ? '（dry-run，未写入）' : '完成'}。SQLite 文件保留未动，可作回滚。`);
}

main().catch((err) => {
  console.error('[migrate] 失败:', err);
  process.exit(1);
});
