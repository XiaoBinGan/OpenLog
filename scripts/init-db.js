/**
 * 数据库初始化脚本
 * 首次 clone 后自动创建 SQLite 数据库和表结构，写入默认配置
 * 
 * 安全策略：
 *   1. 所有表使用 CREATE TABLE IF NOT EXISTS（已有数据不受影响）
 *   2. app_settings 只在 kv_store 为空时写入默认值（不覆盖已有配置）
 *   3. 可重复执行，幂等操作
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const DB_PATH = join(DATA_DIR, 'openlog.db');

// ─── 检查 better-sqlite3 兼容性 ──────────────────────────────────────────
try {
  const testDb = new Database(':memory:');
  testDb.close();
} catch (err) {
  console.error('\n❌ better-sqlite3 原生模块加载失败！');
  console.error('   错误详情:', err.message);
  if (err.code === 'ERR_DLOPEN_FAILED' || err.message.includes('NODE_MODULE_VERSION') || err.message.includes('node')) {
    console.error('\n🔧 Node.js 版本与 better-sqlite3 编译版本不匹配。');
    console.error('   项目要求 Node v20（详见项目根目录 .nvmrc 文件）。');
    console.error('');
    console.error('   📋 请按以下步骤修复：');
    console.error('');
    console.error('      1. 切换 Node 版本:      nvm use 20');
    console.error('      2. 重建 native 模块:    npm rebuild better-sqlite3');
    console.error('      3. 重新运行:            npm run init-db');
    console.error('');
  } else {
    console.error('\n🔧 请尝试运行以下命令修复：');
    console.error('   npm rebuild better-sqlite3');
  }
  process.exit(1);
}

// ─── 确保目录存在 ───────────────────────────────────────────────────
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
  console.log('📁 创建数据目录:', DATA_DIR);
}

const isNew = !existsSync(DB_PATH);

// ─── 打开 / 创建数据库 ──────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

if (isNew) {
  console.log('🆕 创建新数据库:', DB_PATH);
} else {
  console.log('🗄️  连接已有数据库:', DB_PATH);
}

// ─── 创建表（IF NOT EXISTS，已有表不重复创建）───────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS machines (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'local',
    name TEXT NOT NULL,
    host TEXT,
    port INTEGER,
    ssh_user TEXT,
    log_path TEXT,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
  );

  CREATE TABLE IF NOT EXISTS log_records (
    id TEXT PRIMARY KEY,
    machine_id TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_name TEXT NOT NULL,
    content TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'error',
    timestamp INTEGER,
    parsed JSON,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
  );

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
  );

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
  );

  CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_log_records_machine ON log_records(machine_id);
  CREATE INDEX IF NOT EXISTS idx_log_records_timestamp ON log_records(timestamp);
  CREATE INDEX IF NOT EXISTS idx_analysis_records_log ON analysis_records(log_record_id);
`);

console.log('✅ 表结构就绪');

// ─── 写入默认配置（仅首次，不覆盖已有配置）─────────────────────────
const existing = db.prepare('SELECT value FROM kv_store WHERE key = ?').get('app_settings');

if (!existing) {
  const defaultSettings = {
    openaiApiKey: '',
    openaiBaseUrl: 'http://localhost:11434/v1',
    model: 'qwen3.5:9b',
    logPath: join(os.homedir(), 'logs'),
    watchFiles: '*.log',
    refreshInterval: '5000',
    autoAnalysis: true,
    thinkingEnabled: false,
    logPersistence: false,
    logPersistenceLevels: ['ERROR', 'FATAL', 'WARN'],
    logPersistenceMaxAge: 7,
    watchSources: [
      {
        id: 'default',
        name: '默认服务',
        path: join(os.homedir(), 'logs'),
        pattern: '*.log',
        enabled: true,
        autoAnalysis: true
      }
    ],
    dockerSources: [
      {
        id: 'local',
        name: '本地 Docker',
        socketPath: '/var/run/docker.sock',
        host: 'localhost',
        port: 2375,
        tls: false,
        enabled: false,
        autoAnalysis: true,
        projects: []
      }
    ],
    dockerEventNotify: true,
    containerPatrolEnabled: false,
    containerPatrolInterval: '300000',
    containerPatrolLevels: ['ERROR', 'FATAL', 'WARN']
  };

  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    'INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)'
  ).run('app_settings', JSON.stringify(defaultSettings, null, 2), now);

  console.log('📝 写入默认配置到 kv_store');
} else {
  console.log('⏭️  配置已存在，跳过');
}

db.close();
console.log('🎉 数据库初始化完成\n');
