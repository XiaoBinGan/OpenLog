import { NodeSSH } from 'node-ssh';
import { errorMessage } from './errors.js';
import { guardSshConnection } from './ssh-guard.js';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getKv, setKv, getDb } from './db/index.js';

// AES-256-GCM 加密密钥（32 字节）
// 优先从 OPENLOG_SECRET_KEY 派生；未设置时回退到源码内置种子（兼容旧数据）
const LEGACY_ENC_KEY = crypto.scryptSync('openlog-remote-secret-salt-v2', 'openlog', 32);
const ALGORITHM = 'aes-256-gcm';

// 密钥按需解析（不要在模块初始化时固化）：
// ESM 的 import 求值早于入口模块体里的 dotenv 加载，remote.js 初始化时
// process.env.OPENLOG_SECRET_KEY 往往还是空值。若在这里固化密钥，就会
// 永久回退到源码内置 legacy key，导致 .env 的 OPENLOG_SECRET_KEY 形同虚设。
// 改成「调用时读取 + 值变化时重算」，同时仍然缓存 scrypt 结果避免重复开销。
let cachedKeySource = null;
let cachedEncKey = LEGACY_ENC_KEY;

function getEncKey() {
  const source = process.env.OPENLOG_SECRET_KEY || '';
  if (source !== cachedKeySource) {
    cachedKeySource = source;
    cachedEncKey = source
      ? crypto.scryptSync(source, 'openlog-remote-secret-salt-v2', 32)
      : LEGACY_ENC_KEY;
  }
  return cachedEncKey;
}

/** 当前生效的密钥来源：'env'（OPENLOG_SECRET_KEY）或 'legacy'（源码内置种子） */
export function getEncryptionKeySource() {
  return (process.env.OPENLOG_SECRET_KEY || '') ? 'env' : 'legacy';
}

// 旧密钥解密成功后需要立即用新密钥重新加密并落盘
let needsReencrypt = false;

/**
 * 远程服务器日志管理模块
 * 支持通过 SSH 连接远程服务器，获取日志内容
 */

// 远程服务器配置存储路径（保留作回退）
// 同样按需读取：模块初始化时 .env 可能尚未加载
function getConfigPath() {
  return process.env.REMOTE_CONFIG_PATH || path.join(process.cwd(), 'remote-servers.json');
}

// 内存中的服务器配置
let servers = [];

// SSH 连接池
const sshConnections = new Map();

/**
 * 加载服务器配置（优先从 SQLite，失败则回退到文件）
 */
export function loadServers() {
  // 检查数据库是否已初始化
  let db;
  try { db = getDb(); } catch {}

  if (db) {
    try {
      const stored = getKv('remote_servers');
      if (stored && Array.isArray(stored)) {
        servers = stored.map(s => ({
          ...s,
          password: s.password ? decryptPassword(s.password) : undefined,
        }));
        persistKeyMigration();
        console.log('[Remote] 从 SQLite 加载了', servers.length, '台服务器');
        return servers;
      }
    } catch (err) {
      console.warn('[Remote] 从 DB 加载失败，回退到文件:', errorMessage(err));
    }
  }

  // 回退到文件
  try {
    if (fs.existsSync(getConfigPath())) {
      const data = fs.readFileSync(getConfigPath(), 'utf-8');
      servers = JSON.parse(data);
      servers = servers.map(s => ({
        ...s,
        password: s.password ? decryptPassword(s.password) : undefined,
      }));
    }
  } catch (err) {
    console.error('Failed to load remote servers config:', errorMessage(err));
    servers = [];
  }
  persistKeyMigration();
  return servers;
}

/**
 * 保存服务器配置（优先 SQLite，失败则回退到文件）
 */
function saveServers() {
  // 加密密码后保存
  const dataToSave = servers.map(s => ({
    ...s,
    password: s.password ? encryptPassword(s.password) : undefined,
  }));

  // 检查数据库是否已初始化
  let db;
  try { db = getDb(); } catch {}

  if (db) {
    try {
      setKv('remote_servers', dataToSave);
      return;
    } catch (err) {
      console.warn('[Remote] 保存到 DB 失败，回退到文件:', errorMessage(err));
    }
  }

  // 回退到文件
  try {
    fs.writeFileSync(getConfigPath(), JSON.stringify(dataToSave, null, 2));
  } catch (err) {
    console.error('Failed to save remote servers config:', errorMessage(err));
  }
}

/**
 * 简单的密码加密（生产环境应使用更安全的方案）
 */
function encryptPassword(password) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, getEncKey(), iv);
  const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // 格式: iv:authTag:ciphertext (均为 hex)
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted.toString('hex');
}

function decryptWithKey(encrypted, key) {
  const [ivHex, authTagHex, cipherHex] = encrypted.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(Buffer.from(cipherHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

function decryptPassword(encrypted) {
  // 兼容旧 Base64 格式（无冒号分隔）
  if (!encrypted.includes(':')) {
    return Buffer.from(encrypted, 'base64').toString('utf-8');
  }
  const key = getEncKey();
  // 优先使用当前密钥（OPENLOG_SECRET_KEY 派生）
  try {
    return decryptWithKey(encrypted, key);
  } catch {}
  // 当前密钥失败则回退旧密钥；成功后标记迁移，加载完成后用新密钥重新加密并落盘
  if (key !== LEGACY_ENC_KEY) {
    try {
      const decrypted = decryptWithKey(encrypted, LEGACY_ENC_KEY);
      needsReencrypt = true;
      return decrypted;
    } catch {}
  }
  // 解密失败，返回原值（可能已是明文）
  return encrypted;
}

// 旧密钥数据迁移：加载完成后用新密钥重新加密并持久化
function persistKeyMigration() {
  if (!needsReencrypt) return;
  needsReencrypt = false;
  saveServers();
  console.log('[Remote] 已使用新密钥重新加密存储的 SSH 密码');
}

/** 仅供测试：加解密内部实现（生产代码不要引用） */
export const _cryptoInternals = { encryptPassword, decryptPassword, decryptWithKey, getEncryptionKeySource };

/**
 * 获取所有服务器配置（不返回密码）
 */
export function getServers() {
  return servers.map(s => ({
    id: s.id,
    name: s.name,
    host: s.host,
    port: s.port,
    username: s.username,
    logPath: s.logPath,
    watchFiles: s.watchFiles,
    lastConnected: s.lastConnected,
    status: s.status,
  }));
}

/** 获取所有服务器配置（含明文密码，用于导出备份） */
export function getServersWithEncryptedPasswords() {
  return servers.map(s => ({
    id: s.id, name: s.name, host: s.host, port: s.port,
    username: s.username,
    password: s.password, // 直接返回内存中的明文
    logPath: s.logPath, watchFiles: s.watchFiles,
    lastConnected: s.lastConnected, status: s.status,
  }));
}

/**
 * 添加服务器
 */
export function addServer(config) {
  const server = {
    id: uuidv4(),
    name: config.name || config.host,
    host: config.host,
    port: config.port || 22,
    username: config.username,
    password: config.password,
    privateKey: config.privateKey,
    privateKeyPath: config.privateKeyPath,
    logPath: config.logPath || '/var/log',
    watchFiles: config.watchFiles || '*.log',
    lastConnected: null,
    status: 'disconnected',
  };
  
  servers.push(server);
  saveServers();
  return server;
}

/**
 * 更新服务器配置
 */
export function updateServer(id, updates) {
  const index = servers.findIndex(s => s.id === id);
  if (index === -1) return null;
  
  // 密码为空时不覆盖已有密码（编辑弹窗安全约定）
  const clean = { ...updates };
  if (!clean.password && !clean.privateKey && !clean.privateKeyPath) {
    delete clean.password;
  }
  
  servers[index] = {
    ...servers[index],
    ...clean,
    id, // 保持 id 不变
  };
  
  saveServers();
  return servers[index];
}

/**
 * 删除服务器
 */
export function deleteServer(id) {
  const index = servers.findIndex(s => s.id === id);
  if (index === -1) return false;
  
  // 关闭连接
  disconnectServer(id);
  
  servers.splice(index, 1);
  saveServers();
  return true;
}

/**
 * 测试服务器连接
 * config 可带 serverId：编辑时密码为空则用已存密码
 */
export async function testConnection(config) {
  const ssh = new NodeSSH();
  
  // 编辑模式下密码为空时，从已存配置补全密码/私钥
  let resolvedConfig = { ...config };
  if (config.serverId && !config.password && !config.privateKey && !config.privateKeyPath) {
    const existing = servers.find(s => s.id === config.serverId);
    if (existing) {
      resolvedConfig.password = existing.password || resolvedConfig.password;
      resolvedConfig.privateKey = existing.privateKey || resolvedConfig.privateKey;
      resolvedConfig.privateKeyPath = existing.privateKeyPath || resolvedConfig.privateKeyPath;
    }
  }
  
  try {
    const sshConfig = {
      host: resolvedConfig.host,
      port: resolvedConfig.port || 22,
      username: resolvedConfig.username,
    };
    
    if (resolvedConfig.privateKey) {
      sshConfig.privateKey = resolvedConfig.privateKey;
    } else if (resolvedConfig.privateKeyPath) {
      sshConfig.privateKeyPath = resolvedConfig.privateKeyPath;
    } else if (resolvedConfig.password) {
      sshConfig.password = resolvedConfig.password;
    } else {
      throw new Error('需要密码或私钥');
    }
    
    await ssh.connect(sshConfig);
    // 短连接同样要挂：connect 返回后到 dispose 之间 socket 仍可能出错
    guardSshConnection(ssh, `测试连接 ${config.host}`);
    
    // 获取系统信息
    const result = await ssh.execCommand('uname -a && echo "---SEPARATOR---" && df -h / | tail -1 && echo "---SEPARATOR---" && free -m | grep Mem');
    await ssh.dispose();
    
    const parts = result.stdout.split('---SEPARATOR---');
    const info = {
      connected: true,
      system: parts[0]?.trim() || 'Unknown',
      disk: parts[1]?.trim() || '',
      memory: parts[2]?.trim() || '',
    };
    
    return { success: true, info };
  } catch (err) {
    return { success: false, error: errorMessage(err) };
  }
}

/**
 * 连接到服务器
 */
export async function connectServer(id) {
  const server = servers.find(s => s.id === id);
  if (!server) {
    throw new Error('服务器不存在');
  }
  
  // 如果已连接，先断开
  if (sshConnections.has(id)) {
    await disconnectServer(id);
  }
  
  const ssh = new NodeSSH();
  
  try {
    const sshConfig = {
      host: server.host,
      port: server.port,
      username: server.username,
      // 半开连接防护：网络变化后 TCP 层可能已断但 SSH 层无感知，
      // 连接会静默变成僵尸（此前没有这项，P0-12 的 read ETIMEDOUT 崩溃
      // 正是这一类问题）。keepalive 每 15s 探测一次，3 次无响应即判定断开。
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
    };
    
    if (server.privateKey) {
      sshConfig.privateKey = server.privateKey;
    } else if (server.privateKeyPath) {
      sshConfig.privateKeyPath = server.privateKeyPath;
    } else if (server.password) {
      sshConfig.password = server.password;
    } else {
      throw new Error('服务器未配置密码或私钥，请在编辑中填写认证信息');
    }
    
    await ssh.connect(sshConfig);
    
    // 必须挂：node-ssh 在 'ready' 之后移除了它唯一的 error 监听者，
    // 不挂的话这个连接后续任何 socket 错误都会升级成 uncaughtException 并终止进程。
    guardSshConnection(ssh, `服务器 ${server.name || id}`, () => {
      // 连接已不可用：从连接表摘除，让上层按「未连接」处理（UI 会提示重连）
      if (sshConnections.get(id) === ssh) {
        sshConnections.delete(id);
        const srv = servers.find(x => x.id === id);
        if (srv) { srv.status = 'disconnected'; saveServers(); }
      }
    });
    
    sshConnections.set(id, ssh);
    server.status = 'connected';
    server.lastConnected = new Date().toISOString();
    saveServers();
    
    return { success: true };
  } catch (err) {
    server.status = 'error';
    saveServers();
    throw err;
  }
}

/**
 * 断开服务器连接
 */
/**
 * 取得一台服务器的**活跃** SSH 连接，没有就按需建立。
 *
 * Docker-over-SSH 桥接层依赖它：桥不自己管理连接生命周期，而是复用这个池，
 * 于是「按需连接、断连守卫、自动重连」在整个进程里只有一份实现。
 */
export async function ensureSshConnection(id) {
  const existing = sshConnections.get(id);
  if (existing && existing.isConnected()) return existing;

  await connectServer(id);

  const ssh = sshConnections.get(id);
  if (!ssh || !ssh.isConnected()) {
    throw new Error(`服务器 ${id} 的 SSH 连接未能建立`);
  }
  return ssh;
}

export async function disconnectServer(id) {
  const ssh = sshConnections.get(id);
  if (ssh) {
    await ssh.dispose();
    sshConnections.delete(id);
  }
  
  const server = servers.find(s => s.id === id);
  if (server) {
    server.status = 'disconnected';
    saveServers();
  }
}

/**
 * 关闭全部 SSH 连接（进程退出时调用）。
 * 不逐个走 disconnectServer()，避免退出路径上反复 saveServers() 写库。
 */
export async function disconnectAll() {
  const entries = [...sshConnections.entries()];
  sshConnections.clear();
  await Promise.allSettled(entries.map(([, ssh]) => ssh.dispose()));
  for (const s of servers) s.status = 'disconnected';
  return entries.length;
}

/**
 * 执行 Shell 命令（用于 Web Terminal）
 * 返回一个 Promise，resolve 时返回命令输出
 */
export async function execShellCommand(id, command, timeout = 30000) {
  const ssh = sshConnections.get(id);
  if (!ssh) {
    throw new Error('服务器未连接');
  }
  
  try {
    const result = await ssh.execCommand(command, { execOptions: { timeout } });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
      signal: result.signal,
    };
  } catch (err) {
    throw new Error(`命令执行失败: ${errorMessage(err)}`);
  }
}

/**
 * 创建交互式 Shell 会话（用于 WebSocket）
 * 使用 PTY 模式，支持交互式命令
 */
export async function createShellSession(id, ws) {
  const ssh = sshConnections.get(id);
  if (!ssh) {
    throw new Error('服务器未连接');
  }
  
  const server = servers.find(s => s.id === id);
  if (!server) {
    throw new Error('服务器不存在');
  }
  
  try {
    // 使用 PTY 模式创建交互式 Shell
    const shellStream = await ssh.requestShell({
      term: 'xterm-256color',
      cols: 120,
      rows: 30,
    });
    
    // 服务器输出 → WebSocket 客户端
    shellStream.on('data', (data) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'shell_output', data: data.toString('utf-8') }));
      }
    });
    
    shellStream.stderr.on('data', (data) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'shell_output', data: data.toString('utf-8') }));
      }
    });
    
    shellStream.on('close', () => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'shell_closed' }));
      }
    });
    
    shellStream.on('error', (err) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'shell_error', error: errorMessage(err) }));
      }
    });
    
    return {
      send: (data) => shellStream.write(data),
      resize: (cols, rows) => shellStream.setWindow(rows, cols),
      close: () => shellStream.end(),
    };
  } catch (err) {
    throw new Error(`创建 Shell 会话失败: ${errorMessage(err)}`);
  }
}

/**
 * 列出远程日志文件
 */
export async function listRemoteFiles(id, subPath = '') {
  const ssh = sshConnections.get(id);
  if (!ssh) {
    throw new Error('服务器未连接');
  }

  const server = servers.find(s => s.id === id);
  const basePath = subPath || server.logPath;

  try {
    // 用 stat 方式列出，避免 ls -lAh 的月份/日期歧义问题
    const result = await ssh.execCommand(
      `find "${basePath}" -maxdepth 1 -printf "%f\\n%Y\\n%s\\n" 2>&1 | paste -d'\\n' - - -`
    );

    if (result.code !== 0) {
      return { files: [], dirs: [], currentPath: basePath, error: result.stderr || result.stdout };
    }

    const lines = result.stdout.split('\n').filter(l => l.trim());
    const files = [];
    const dirs = [];

    for (let i = 0; i < lines.length; i += 3) {
      const name = lines[i]?.trim();
      const type = lines[i + 1]?.trim(); // 'd' = dir, 'f' = file, 'l' = link
      const size = parseInt(lines[i + 2]?.trim() || '0');

      if (!name || name === '.' || name === '..') continue;

      const isDir = type === 'd';
      const isLog = name.endsWith('.log') || name.includes('.log.');

      if (isDir) {
        dirs.push({ name, path: path.posix.join(basePath, name) });
      } else {
        files.push({
          name,
          path: path.posix.join(basePath, name),
          size,
          isLog,
        });
      }
    }

    // 日志文件排前面
    files.sort((a, b) => {
      if (a.isLog && !b.isLog) return -1;
      if (!a.isLog && b.isLog) return 1;
      return b.name.localeCompare(a.name);
    });

    return { files, dirs, currentPath: basePath };
  } catch (err) {
    return { files: [], dirs: [], error: errorMessage(err) };
  }
}

/**
 * 读取远程文件原始内容（用于编辑器）
 * 通过 execCommand cat 方式，避免 SFTP 兼容性问题
 */
export async function readRemoteFileRaw(id, filePath) {
  const ssh = sshConnections.get(id);
  if (!ssh) return { error: '服务器未连接' };

  try {
    const result = await ssh.execCommand(`cat "${filePath}"`, { encoding: 'utf8' });
    if (result.code !== 0) {
      return { error: result.stderr || '读取失败' };
    }
    return { content: result.stdout };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

/**
 * 写入远程文件内容
 * 通过 base64 编码传输，避免 shell 转义问题
 */
export async function writeRemoteFile(id, filePath, content) {
  const ssh = sshConnections.get(id);
  if (!ssh) return { error: '服务器未连接' };

  try {
    // base64 编码内容，避免 shell 转义
    const b64 = Buffer.from(content, 'utf8').toString('base64');
    // 通过 python 解码写入（支持任意内容）
    const result = await ssh.execCommand(
      `python3 -c "import sys,base64; open('${filePath}','w').write(base64.b64decode(sys.stdin.read()).decode('utf-8'))"`,
      { encoding: 'utf8' }
    );
    if (result.code !== 0) {
      return { error: result.stderr || '写入失败' };
    }
    return { success: true };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

/**
 * 上传本地文件到远程服务器
 * 通过 base64 编码传输
 */
export async function uploadRemoteFile(id, localFileBuffer, remotePath) {
  const ssh = sshConnections.get(id);
  if (!ssh) return { error: '服务器未连接' };

  try {
    const b64 = localFileBuffer.toString('base64');
    const result = await ssh.execCommand(
      `python3 -c "import sys,base64; open('${remotePath}','wb').write(base64.b64decode(sys.stdin.read()))"`,
      { encoding: 'utf8' }
    );
    if (result.code !== 0) {
      return { error: result.stderr || '上传失败' };
    }
    return { success: true, remotePath };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

// ─── 分片上传 ───────────────────────────────────────────
const UPLOAD_SESSIONS = new Map(); // uploadId → { id, remotePath, totalChunks, receivedChunks, fileSize, tempDir }
const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB

// 初始化分片上传会话
export async function initChunkedUpload(id, remotePath, fileSize) {
  const ssh = sshConnections.get(id);
  if (!ssh) return { error: '服务器未连接' };

  const uploadId = `up_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const safePath = remotePath.replace(/'/g, "'\\''");
  const tempDir = `/tmp/openlog_upload_${uploadId}`;

  try {
    await ssh.execCommand(`mkdir -p '${tempDir}'`);
    UPLOAD_SESSIONS.set(uploadId, {
      id: uploadId,
      remotePath,
      totalChunks: 0,
      receivedChunks: new Set(),
      fileSize,
      tempDir,
      safePath,
      createdAt: Date.now()
    });
    return { uploadId, chunkSize: CHUNK_SIZE, totalChunks: Math.ceil(fileSize / CHUNK_SIZE) };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

// 上传单个分片
export async function uploadChunk(id, uploadId, chunkIndex, base64Data) {
  const ssh = sshConnections.get(id);
  if (!ssh) return { error: '服务器未连接' };

  const session = UPLOAD_SESSIONS.get(uploadId);
  if (!session) return { error: '上传会话不存在或已过期' };

  try {
    // base64 通过 stdin 管道解码（避免 shell 命令行长度限制）
    const tempFile = `${session.tempDir}/part_${String(chunkIndex).padStart(5, '0')}`;
    const cleanBase64 = base64Data.replace(/\s/g, '');
    const result = await ssh.execCommand(`base64 -d > '${tempFile}'`, {
      stdin: cleanBase64 + '\n',
      execOptions: { timeout: 30000 }
    });
    if (result.code !== 0) {
      return { error: result.stderr || '分片写入失败' };
    }

    session.receivedChunks.add(chunkIndex);
    return { success: true, chunkIndex, received: session.receivedChunks.size };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

// 完成分片上传：合并分片 + 校验 + 清理
export async function completeChunkedUpload(id, uploadId, totalChunks) {
  const ssh = sshConnections.get(id);
  if (!ssh) return { error: '服务器未连接' };

  const session = UPLOAD_SESSIONS.get(uploadId);
  if (!session) return { error: '上传会话不存在或已过期' };

  try {
    // 合并所有分片（先确保目标目录存在）
    const targetDir = session.safePath.substring(0, session.safePath.lastIndexOf('/'));
    const tmpFile = `${session.tempDir}/merged`;
    const cmd = `mkdir -p '${targetDir}' && cd '${session.tempDir}' && cat part_* > '${tmpFile}' && mv '${tmpFile}' '${session.safePath}' && cd / && rm -rf '${session.tempDir}'`;
    const result = await ssh.execCommand(cmd);
    if (result.code !== 0) {
      console.error(`[complete] merge failed for ${uploadId}:`, result.stderr || result.stdout || '');
      return { error: '文件合并失败: ' + (result.stderr || result.stdout || String(result.code)) };
    }

    // 校验文件大小
    const sizeResult = await ssh.execCommand(`stat -c%s '${session.safePath}' 2>/dev/null || stat -f%z '${session.safePath}' 2>/dev/null`);
    const actualSize = parseInt(sizeResult.stdout?.trim());

    UPLOAD_SESSIONS.delete(uploadId);

    if (actualSize !== session.fileSize) {
      return { 
        success: true, 
        warning: `文件大小不匹配: 期望 ${session.fileSize} bytes, 实际 ${actualSize} bytes`,
        remotePath: session.remotePath 
      };
    }

    return { success: true, remotePath: session.remotePath, size: actualSize };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

// 取消上传（清理远程临时文件）
export async function cancelChunkedUpload(id, uploadId) {
  const ssh = sshConnections.get(id);
  const session = UPLOAD_SESSIONS.get(uploadId);
  if (!session) return;

  try {
    if (ssh) await ssh.execCommand(`rm -rf '${session.tempDir}'`);
  } catch (_) {}
  UPLOAD_SESSIONS.delete(uploadId);
}

// 定期清理过期上传会话（> 30 分钟）
setInterval(() => {
  const now = Date.now();
  for (const [uploadId, session] of UPLOAD_SESSIONS) {
    if (now - session.createdAt > 30 * 60 * 1000) {
      cancelChunkedUpload(session.id, uploadId);
    }
  }
}, 60_000);

/**
 * 读取远程日志文件
 */
export async function readRemoteFile(id, filePath, options = {}) {
  const ssh = sshConnections.get(id);
  if (!ssh) {
    throw new Error('服务器未连接');
  }
  
  const {
    lines = 200,      // 读取最后 N 行
    search = '',      // 搜索关键词
    level = '',       // 过滤级别
  } = options;
  
  try {
    // 使用 tail 读取最后 N 行
    let command = `tail -n ${lines} "${filePath}"`;
    
    // 如果有搜索条件，使用 grep
    if (search) {
      command = `tail -n ${lines * 5} "${filePath}" | grep -i "${search}" | tail -n ${lines}`;
    }
    
    const result = await ssh.execCommand(command);
    
    if (result.stderr && !result.stdout) {
      return { logs: [], error: result.stderr };
    }
    
    // 解析日志行
    const logLines = result.stdout.split('\n').filter(l => l.trim());
    const logs = logLines.map((line, idx) => parseRemoteLogLine(line, filePath, idx));
    
    // 级别过滤
    const filteredLogs = level ? logs.filter(l => l.level === level) : logs;
    
    // 获取文件信息
    const statResult = await ssh.execCommand(`stat -c "%s %y" "${filePath}" 2>/dev/null || stat -f "%z %Sm" "${filePath}"`);
    let fileInfo = null;
    if (statResult.stdout) {
      const [size, ...modifiedParts] = statResult.stdout.split(' ');
      fileInfo = {
        size: parseInt(size),
        modified: modifiedParts.join(' '),
      };
    }
    
    return {
      logs: filteredLogs,
      fileInfo,
      totalLines: logLines.length,
    };
  } catch (err) {
    return { logs: [], error: errorMessage(err) };
  }
}

/**
 * 实时监控远程日志（tail -f）
 */
export async function* tailRemoteFile(id, filePath) {
  const ssh = sshConnections.get(id);
  if (!ssh) {
    throw new Error('服务器未连接');
  }
  
  // 使用 tail -f 获取实时日志
  const stream = await ssh.execCommand(`tail -f "${filePath}"`, { execOptions: { pty: true } });
  
  // 这是一个简化版本，实际实现需要处理流式数据
  // 这里返回一个生成器
  let buffer = '';
  
  for await (const chunk of stream.stdout) {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    
    for (const line of lines) {
      if (line.trim()) {
        yield parseRemoteLogLine(line, filePath);
      }
    }
  }
}

/**
 * 在远程服务器执行命令
 */
export async function execRemoteCommand(id, command) {
  const ssh = sshConnections.get(id);
  if (!ssh) {
    throw new Error('服务器未连接');
  }
  
  try {
    const result = await ssh.execCommand(command);
    return {
      success: true,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.code,
    };
  } catch (err) {
    return { success: false, error: errorMessage(err) };
  }
}

/**
 * 解析远程日志行
 */
function parseRemoteLogLine(line, source, index = 0) {
  const timestampMatch = line.match(/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)/);
  const levelMatch = line.match(/\b(INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL|CRITICAL)\b/i);
  
  return {
    id: `remote-${Date.now()}-${index}`,
    timestamp: timestampMatch ? timestampMatch[1].replace(',', '.') : new Date().toISOString(),
    level: levelMatch ? levelMatch[1].toUpperCase() : 'INFO',
    message: line,
    source: path.basename(source),
    metadata: JSON.stringify({ raw: line, remote: true, path: source }),
  };
}

/**
 * 获取远程服务器系统状态（完整版，含网络流量和进程）
 * 返回与 MonitorStats 接口兼容的结构
 */
export async function getRemoteSystemStats(id) {
  const ssh = sshConnections.get(id);
  if (!ssh) {
    throw new Error('服务器未连接');
  }
  
  try {
    // 一次性获取所有指标
    const result = await ssh.execCommand(`
      # CPU + 内存
      echo "CPU:$(top -bn1 | grep 'Cpu(s)' | awk '{print $2}' || echo '0')"
      echo "MEM:$(free -m | awk '/Mem:/ {printf "%.1f/%.1f MB (%.1f%%)", $3, $2, ($3/$2)*100}')"

      # 磁盘
      df -h | tail -n +2 | grep "^/" | while read line; do echo "DISK:$line"; done

      # 网络流量（取第一个活跃网卡）
      cat /proc/net/dev | awk 'NR>2 {
        split($2,s,":"); rx=$2; ry=$10;
        # 只取内网/公网常见网卡，排除 loopback
        if (s[1] !~ /lo|dummy|docker|br|veth|tun|tap|virbr/) {
          print "NET:" s[1] ":" rx ":" ry
          exit
        }
      }'

      # Top 10 进程（按 CPU 排序）
      ps aux --no-headers | sort -rn -k 3 | head -10 | \
        awk '{print "PROC:" $2 ":" $11 ":" $3 ":" $4}'

      # GPU 信息
      nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>/dev/null | \
        awk -F', ' '{gsub(/%/,"",$3); gsub(/MiB|MB/,"",$4); gsub(/MiB|MB/,"",$5); gsub(/°C/,"",$6); print "GPU:" $1 ":" $2 ":" $3 ":" $4 ":" $5 ":" $6}'

      # GPU 与 PCI Bus 映射（用于将进程准确归属到对应 GPU）
      nvidia-smi --query-gpu=index,gpu_bus_id --format=csv,noheader,nounits 2>/dev/null | \
        awk -F', ' '{print "GPUBUS:" $1 "|" $2}'

      # GPU 占用进程信息：带 gpu_bus_id，避免把所有进程重复显示到每张卡
      nvidia-smi --query-compute-apps=gpu_bus_id,pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null | \
        awk -F', ' '{gsub(/MiB|MB/, "", $4); print "GPUPROC:" $1 "|" $2 "|" $3 "|" $4}'
    `);
    
    if (result.stderr && result.stderr.includes('Permission denied')) {
      // 部分系统 /proc/net/dev 需要权限，降级不返回网络数据
    }
    
    const lines = result.stdout.split('\n').filter(l => l.trim());
    
    // 解析 CPU
    const cpuMatch = lines.find(l => l.startsWith('CPU:'));
    const cpuLoad = cpuMatch ? parseFloat(cpuMatch.replace('CPU:', '')) || 0 : 0;
    
    // 解析内存
    const memMatch = lines.find(l => l.startsWith('MEM:'));
    let memUsed = 0, memTotal = 1, memFree = 0;
    if (memMatch) {
      const m = memMatch.replace('MEM:', '').match(/([\d.]+)\/([\d.]+)\s*MB\s*\(([\d.]+)%\)/);
      if (m) {
        memUsed = parseFloat(m[1]) * 1024 * 1024;
        memTotal = parseFloat(m[2]) * 1024 * 1024;
        memFree  = (parseFloat(m[2]) - parseFloat(m[1])) * 1024 * 1024;
      }
    }
    
    // 解析磁盘
    // 解析磁盘：df -h 输出可能是 6 列（无 inodes）或 7 列（有 inodes）
    // 6列: Filesystem Size Used Avail Use% Mounted-on
    // 7列: Filesystem Size Used Avail Use% Inodes Mounted-on
    const diskLines = lines.filter(l => l.startsWith('DISK:'));
    const SKIP_NAMES = ['/dev', '/dev/shm', '/dev/run', '/sys', '/proc', '/run'];
    const disks = [];
    for (const rawLine of diskLines) {
      const line = rawLine.replace('DISK:', '').trim();
      const parts = line.split(/\s+/);
      if (parts.length < 6) continue;
      // 最后一列是挂载点，倒数第二列是 Use%（带%），倒数第三是 Avail，倒数第四是 Used，倒数第五是 Size
      const n = parts.length;
      const mount = parts[n - 1];
      const pctStr = parts[n - 2]; // e.g. "23%"
      const pct = parseFloat(pctStr.replace('%', '')) || 0;
      const total = parts[n - 5]; // Size
      const used = parts[n - 4];  // Used
      if (SKIP_NAMES.includes(mount)) continue;
      const parseSize = (s) => {
        const m = s.match(/^([\d.]+)([BKMGT])?$/);
        if (!m) return 0;
        const scale = { B: 1, K: 1024, M: 1024**2, G: 1024**3, T: 1024**4 };
        return parseFloat(m[1]) * (scale[m[2]] || 1);
      };
      disks.push({ name: mount, used: parseSize(used), total: parseSize(total), usePercent: pct });
    }
    
    // 解析网络流量
    const netLines = lines.filter(l => l.startsWith('NET:'));
    const network = netLines.map(l => {
      const parts = l.replace('NET:', '').split(':');
      return {
        iface: parts[0] || 'eth0',
        rx: parseInt(parts[1]) || 0,
        tx: parseInt(parts[2]) || 0,
      };
    });
    
    // 解析进程列表
    const procLines = lines.filter(l => l.startsWith('PROC:'));
    const processes = procLines.map(l => {
      const parts = l.replace('PROC:', '').split(':');
      return {
        pid: parseInt(parts[0]) || 0,
        name: (parts[1] || '').split(' ')[0],
        cpu: parseFloat(parts[2]) || 0,
        mem: parseFloat(parts[3]) || 0,
      };
    });

    // 解析 GPU 信息
    const gpuLines = lines.filter(l => l.startsWith('GPU:'));
    const gpuBusLines = lines.filter(l => l.startsWith('GPUBUS:'));
    const gpuProcLines = lines.filter(l => l.startsWith('GPUPROC:'));

    // 将 PCI Bus ID 映射为 GPU index，进程才能准确归属到对应显卡
    const gpuBusToIndex = {};
    gpuBusLines.forEach(l => {
      const [idx, busId] = l.replace('GPUBUS:', '').split('|');
      if (busId) gpuBusToIndex[busId.trim()] = String(parseInt(idx, 10) || 0);
    });

    const gpuProcesses = gpuProcLines.map(l => {
      const parts = l.replace('GPUPROC:', '').split('|');
      const busId = (parts[0] || '').trim();
      return {
        gpuId: gpuBusToIndex[busId] ?? busId,
        pid: parseInt(parts[1]) || 0,
        name: parts[2] || 'unknown',
        usedMemory: parseFloat(parts[3]) || 0,
      };
    });

    const gpus = gpuLines.map(l => {
      const parts = l.replace('GPU:', '').split(':');
      const index = parseInt(parts[0], 10) || 0;
      return {
        index,
        name: parts[1] || '',
        util: parseFloat(parts[2]) || 0,
        memUsed: parseFloat(parts[3]) || 0,
        memTotal: parseFloat(parts[4]) || 1,
        temp: parseFloat(parts[5]) || 0,
        processes: gpuProcesses.filter(p => String(p.gpuId) === String(index)),
      };
    });

    return {
      cpu: { load: cpuLoad, cores: [] },
      memory: { used: memUsed, total: memTotal, free: memFree },
      disk: disks,
      network,
      processes,
      gpus,
    };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

/**
 * 搜索远程日志
 */
export async function searchRemoteLogs(id, search, options = {}) {
  const ssh = sshConnections.get(id);
  if (!ssh) {
    throw new Error('服务器未连接');
  }
  
  const server = servers.find(s => s.id === id);
  const {
    path: searchPath = server.logPath,
    pattern = '*.log',
    maxResults = 500,
  } = options;
  
  try {
    // 使用 find + grep 搜索
    const command = `find "${searchPath}" -name "${pattern}" -type f -exec grep -l "${search}" {} \\; 2>/dev/null | head -20`;
    const result = await ssh.execCommand(command);
    
    const files = result.stdout.split('\n').filter(f => f.trim());
    
    // 对每个文件获取匹配的行
    const results = [];
    for (const file of files.slice(0, 10)) { // 限制搜索文件数
      const grepResult = await ssh.execCommand(`grep -n "${search}" "${file}" | head -50`);
      const lines = grepResult.stdout.split('\n').filter(l => l.trim());
      
      for (const line of lines.slice(0, 50)) {
        const [lineNum, ...contentParts] = line.split(':');
        const content = contentParts.join(':');
        
        results.push({
          file,
          line: parseInt(lineNum),
          content: content.trim(),
          ...parseRemoteLogLine(content, file),
        });
        
        if (results.length >= maxResults) break;
      }
      if (results.length >= maxResults) break;
    }
    
    return { results, files, total: results.length };
  } catch (err) {
    return { results: [], error: errorMessage(err) };
  }
}

// 懒加载：不在模块导入时加载，等数据库初始化完成后再加载
// export function initRemoteServers() { loadServers(); }

export default {
  loadServers,
  getServers,
  getServersWithEncryptedPasswords,
  addServer,
  updateServer,
  deleteServer,
  testConnection,
  connectServer,
  disconnectServer,
  createShellSession,
  listRemoteFiles,
  readRemoteFile,
  readRemoteFileRaw,
  writeRemoteFile,
  uploadRemoteFile,
  initChunkedUpload,
  uploadChunk,
  completeChunkedUpload,
  cancelChunkedUpload,
  tailRemoteFile,
  execRemoteCommand,
  getRemoteSystemStats,
  searchRemoteLogs,
};
