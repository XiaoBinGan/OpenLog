import { NodeSSH } from 'node-ssh';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { getKv, setKv, getDb } from './db/index.js';

/**
 * 远程服务器日志管理模块
 * 支持通过 SSH 连接远程服务器，获取日志内容
 */

// 远程服务器配置存储路径（保留作回退）
const CONFIG_PATH = process.env.REMOTE_CONFIG_PATH || path.join(process.cwd(), 'remote-servers.json');

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
        console.log('[Remote] 从 SQLite 加载了', servers.length, '台服务器');
        return servers;
      }
    } catch (err) {
      console.warn('[Remote] 从 DB 加载失败，回退到文件:', err.message);
    }
  }

  // 回退到文件
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = fs.readFileSync(CONFIG_PATH, 'utf-8');
      servers = JSON.parse(data);
      servers = servers.map(s => ({
        ...s,
        password: s.password ? decryptPassword(s.password) : undefined,
      }));
    }
  } catch (err) {
    console.error('Failed to load remote servers config:', err.message);
    servers = [];
  }
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
      console.warn('[Remote] 保存到 DB 失败，回退到文件:', err.message);
    }
  }

  // 回退到文件
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(dataToSave, null, 2));
  } catch (err) {
    console.error('Failed to save remote servers config:', err.message);
  }
}

/**
 * 简单的密码加密（生产环境应使用更安全的方案）
 */
function encryptPassword(password) {
  return Buffer.from(password).toString('base64');
}

function decryptPassword(encrypted) {
  return Buffer.from(encrypted, 'base64').toString('utf-8');
}

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
  
  servers[index] = {
    ...servers[index],
    ...updates,
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
 */
export async function testConnection(config) {
  const ssh = new NodeSSH();
  
  try {
    const sshConfig = {
      host: config.host,
      port: config.port || 22,
      username: config.username,
    };
    
    if (config.privateKey) {
      sshConfig.privateKey = config.privateKey;
    } else if (config.privateKeyPath) {
      sshConfig.privateKeyPath = config.privateKeyPath;
    } else if (config.password) {
      sshConfig.password = config.password;
    } else {
      throw new Error('需要密码或私钥');
    }
    
    await ssh.connect(sshConfig);
    
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
    return { success: false, error: err.message };
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
    };
    
    if (server.privateKey) {
      sshConfig.privateKey = server.privateKey;
    } else if (server.privateKeyPath) {
      sshConfig.privateKeyPath = server.privateKeyPath;
    } else if (server.password) {
      sshConfig.password = server.password;
    }
    
    await ssh.connect(sshConfig);
    
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
    throw new Error(`命令执行失败: ${err.message}`);
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
        ws.send(JSON.stringify({ type: 'shell_error', error: err.message }));
      }
    });
    
    return {
      send: (data) => shellStream.write(data),
      resize: (cols, rows) => shellStream.setWindow(rows, cols),
      close: () => shellStream.end(),
    };
  } catch (err) {
    throw new Error(`创建 Shell 会话失败: ${err.message}`);
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
    return { files: [], dirs: [], error: err.message };
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
    return { error: err.message };
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
    return { error: err.message };
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
    return { error: err.message };
  }
}

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
    return { logs: [], error: err.message };
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
    return { success: false, error: err.message };
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
    const gpus = gpuLines.map(l => {
      const parts = l.replace('GPU:', '').split(':');
      return {
        index: parseInt(parts[0]) || 0,
        name: parts[1] || '',
        util: parseFloat(parts[2]) || 0,
        memUsed: parseFloat(parts[3]) || 0,
        memTotal: parseFloat(parts[4]) || 1,
        temp: parseFloat(parts[5]) || 0,
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
    return { error: err.message };
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
    return { results: [], error: err.message };
  }
}

// 懒加载：不在模块导入时加载，等数据库初始化完成后再加载
// export function initRemoteServers() { loadServers(); }

export default {
  loadServers,
  getServers,
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
  tailRemoteFile,
  execRemoteCommand,
  getRemoteSystemStats,
  searchRemoteLogs,
};
