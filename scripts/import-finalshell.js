import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DB_PATH = join(__dirname, '../data/openlog.db');

// FinalShell 密码解密（简单的 XOR 加密）
function decryptFinalShellPassword(encrypted) {
  try {
    const key = 'FinalShell';
    let result = '';
    for (let i = 0; i < encrypted.length; i++) {
      result += String.fromCharCode(encrypted.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return result;
  } catch {
    return encrypted;
  }
}

// 解析 FinalShell JSON
function parseFinalShellConfig(json) {
  const config = JSON.parse(json);
  return {
    name: config.name || config.host,
    host: config.host,
    port: config.port || 22,
    username: config.user_name || 'root',
    password: config.password || '',
    authType: config.authentication_type, // 1=密码，2=密钥
    privateKey: config.private_key || '',
    privateKeyPath: config.private_key_path || '',
  };
}

// 加密密码（与 remote.js 保持一致）
function encryptPassword(password) {
  return Buffer.from(password).toString('base64');
}

// 导入单个服务器到数据库
function importToDatabase(server) {
  const db = await import('better-sqlite3').then(m => m.default(DB_PATH));
  
  // 检查是否已存在
  const existing = db.prepare("SELECT key FROM kv_store WHERE key = 'remote_servers'").get();
  let servers = existing ? JSON.parse(existing.value) : [];
  
  // 检查是否重复（按 host:port 判断）
  const isDuplicate = servers.some(s => s.host === server.host && s.port === server.port);
  if (isDuplicate) {
    console.log(`[跳过] ${server.name} (${server.host}:${server.port}) - 已存在`);
    return false;
  }
  
  // 添加新服务器
  servers.push({
    id: uuidv4(),
    name: server.name,
    host: server.host,
    port: server.port,
    username: server.username,
    password: encryptPassword(server.password),
    privateKey: server.privateKey || null,
    privateKeyPath: server.privateKeyPath || null,
    logPath: '/var/log',
    watchFiles: '*.log',
    lastConnected: null,
    status: 'disconnected',
  });
  
  // 保存到数据库
  db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES ('remote_servers', ?)").run(
    JSON.stringify(servers)
  );
  
  console.log(`[导入] ${server.name} (${server.host}:${server.port}) - 用户: ${server.username}`);
  return true;
}

// 主函数
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log(`
FinalShell 配置导入工具
用法:
  node import-finalshell.js <file.json>        # 导入单个文件
  node import-finalshell.js <directory/>        # 导入目录下所有 JSON 文件
  node import-finalshell.js <file1.json> <file2.json> ...  # 导入多个文件
`);
    process.exit(1);
  }
  
  let files = [];
  
  for (const arg of args) {
    const stat = fs.statSync(arg);
    if (stat.isDirectory()) {
      // 目录：读取所有 JSON 文件
      const dirFiles = fs.readdirSync(arg)
        .filter(f => f.endsWith('.json'))
        .map(f => path.join(arg, f));
      files.push(...dirFiles);
    } else if (arg.endsWith('.json')) {
      files.push(arg);
    }
  }
  
  if (files.length === 0) {
    console.error('未找到 JSON 文件');
    process.exit(1);
  }
  
  console.log(`\n找到 ${files.length} 个文件\n`);
  
  let imported = 0;
  let skipped = 0;
  
  for (const file of files) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const server = parseFinalShellConfig(content);
      
      // 如果密码看起来是加密的，尝试解密
      if (server.password && server.password.length > 0) {
        const decrypted = decryptFinalShellPassword(server.password);
        if (decrypted && decrypted.length > 0) {
          server.password = decrypted;
        }
      }
      
      const success = await importToDatabase(server);
      if (success) imported++;
      else skipped++;
    } catch (err) {
      console.error(`[错误] ${file}: ${err.message}`);
    }
  }
  
  console.log(`\n导入完成: ${imported} 成功, ${skipped} 跳过`);
}

// 使用 better-sqlite3 直接执行
async function importToDatabaseDirect(server) {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(DB_PATH);
  
  try {
    // 检查是否已存在
    const existing = db.prepare("SELECT value FROM kv_store WHERE key = 'remote_servers'").get();
    let servers = existing ? JSON.parse(existing.value) : [];
    
    // 检查是否重复
    const isDuplicate = servers.some(s => s.host === server.host && s.port === server.port);
    if (isDuplicate) {
      console.log(`[跳过] ${server.name} (${server.host}:${server.port}) - 已存在`);
      return false;
    }
    
    // 添加新服务器
    servers.push({
      id: uuidv4(),
      name: server.name,
      host: server.host,
      port: server.port,
      username: server.username,
      password: encryptPassword(server.password),
      privateKey: server.privateKey || null,
      privateKeyPath: server.privateKeyPath || null,
      logPath: '/var/log',
      watchFiles: '*.log',
      lastConnected: null,
      status: 'disconnected',
    });
    
    db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES ('remote_servers', ?)").run(
      JSON.stringify(servers)
    );
    
    console.log(`[导入] ${server.name} (${server.host}:${server.port}) - 用户: ${server.username}`);
    return true;
  } finally {
    db.close();
  }
}

main().catch(console.error);
