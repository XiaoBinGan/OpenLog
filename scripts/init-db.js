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

// ─── 种子内置技能（仅首次）────────────────────────────────────────────
const existingSkills = db.prepare('SELECT COUNT(*) as cnt FROM skills WHERE is_default = 1').get();
if (existingSkills.cnt === 0) {
  const skills = [
    { id: 'b6da56e1-c0f7-49d6-9677-ca9d4e55b7ee', name: 'Docker 容器异常退出', command: 'docker ps -a --filter status=exited', description: '列出异常退出的容器及退出码', content: '# Purpose\n检查 Docker 容器异常退出情况\n\n# Workflow\n1. 列出所有异常退出的容器\n2. 检查退出码和退出原因\n3. 查看容器日志最后 50 行\n\n# Constraints\n- 只读操作，不修改容器状态\n- 如发现 OOMKilled，建议检查内存限制\n\n# Output\n- 容器名、退出码、退出时间\n- 异常原因分析', category: 'Docker', is_default: 1 },
    { id: 'c1a7b8d2-e3f4-5678-9abc-def012345678', name: '磁盘空间检查', command: 'df -h && du -sh /var/log/* 2>/dev/null | sort -rh | head -10', description: '检查磁盘使用率和最大目录', content: '# Purpose\n检查服务器磁盘使用情况\n\n# Workflow\n1. 查看所有挂载点使用率\n2. 列出 /var/log 下最大的目录/文件\n3. 识别占用超过 80% 的分区\n\n# Constraints\n- 只读操作\n\n# Output\n- 各分区使用率\n- Top 10 大目录', category: '系统', is_default: 1 },
    { id: 'd2b8c9e3-f4a5-6789-abcd-ef0123456789', name: 'CPU 飙高排查', command: 'top -bn1 | head -20 && ps aux --sort=-%cpu | head -10', description: '排查 CPU 占用高的进程', content: '# Purpose\n排查 CPU 使用率异常\n\n# Workflow\n1. top 查看系统负载概览\n2. ps 按 CPU 排序列出 Top 10 进程\n3. 检查 load average 与 CPU 核心数比例\n\n# Constraints\n- 只读操作\n\n# Output\n- 系统负载\n- Top 10 CPU 进程', category: '系统', is_default: 1 },
    { id: 'e3c9d0f4-a5b6-7890-bcde-f01234567890', name: '内存泄漏排查', command: 'free -h && ps aux --sort=-%mem | head -10', description: '排查内存占用异常', content: '# Purpose\n排查内存使用异常\n\n# Workflow\n1. free 查看内存总览\n2. ps 按内存排序列出 Top 10 进程\n3. 检查 swap 使用情况\n\n# Constraints\n- 只读操作\n\n# Output\n- 内存使用率\n- Top 10 内存进程', category: '系统', is_default: 1 },
    { id: 'f4d0e1a5-b6c7-8901-cdef-012345678901', name: '日志巡检', command: 'grep -rn "ERROR\|FATAL\|Exception" /var/log/*.log 2>/dev/null | tail -50', description: '扫描日志中的错误和异常', content: '# Purpose\n扫描日志中的错误信息\n\n# Workflow\n1. 搜索 ERROR/FATAL/Exception 关键词\n2. 返回最近 50 条匹配\n3. 统计各类错误频率\n\n# Constraints\n- 只读操作，不修改日志\n\n# Output\n- 错误日志条目\n- 错误类型分布', category: '日志', is_default: 1 },
    { id: 'a5e1f2b6-c7d8-9012-defa-123456789012', name: 'Nginx 访问分析', command: 'tail -1000 /var/log/nginx/access.log 2>/dev/null | awk \'{print $9}\' | sort | uniq -c | sort -rn', description: '分析 Nginx 访问日志状态码分布', content: '# Purpose\n分析 Nginx 访问状态\n\n# Workflow\n1. 统计最近 1000 条请求的状态码分布\n2. 检查 4xx/5xx 比例\n3. 如有大量 5xx，检查 error.log\n\n# Constraints\n- 只读操作\n\n# Output\n- 状态码分布\n- 异常比例分析', category: '服务', is_default: 1 },
    { id: 'b6f2a3c7-d8e9-0123-efab-234567890123', name: 'MySQL 慢查询', command: 'mysql -e "SHOW FULL PROCESSLIST;" 2>/dev/null || echo "MySQL 未连接"', description: '检查 MySQL 慢查询和锁等待', content: '# Purpose\n检查 MySQL 运行状态\n\n# Workflow\n1. SHOW PROCESSLIST 查看当前查询\n2. 检查长时间运行的查询\n3. 检查锁等待\n\n# Constraints\n- 只读操作\n\n# Output\n- 运行中的查询列表\n- 慢查询分析', category: '数据库', is_default: 1 },
    { id: 'c7a3b4d8-e9f0-1234-fabc-345678901234', name: '网络连通性', command: 'ping -c 4 8.8.8.8 && ss -tlnp | head -20', description: '检查网络连通性和监听端口', content: '# Purpose\n检查网络连通性\n\n# Workflow\n1. ping 外网测试连通性\n2. 列出所有监听端口\n3. 检查 DNS 解析\n\n# Constraints\n- 只读操作\n\n# Output\n- 网络连通状态\n- 端口监听列表', category: '网络', is_default: 1 },
  ];
  const insertSkill = db.prepare(
    'INSERT OR IGNORE INTO skills (id, name, command, description, content, category, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const now = Math.floor(Date.now() / 1000);
  for (const s of skills) {
    insertSkill.run(s.id, s.name, s.command, s.description, s.content, s.category, 1, now, now);
  }
  console.log(`📝 种子 ${skills.length} 个内置技能`);
} else {
  console.log('⏭️  内置技能已存在，跳过');
}

db.close();
console.log('🎉 数据库初始化完成\n');
