// .env 必须在其它 import 之前加载：ESM 会先求值所有 import，
// remote.js / docker.js 等在模块初始化阶段就会读 process.env
// （例如 OPENLOG_SECRET_KEY 决定 SSH 密码的加密密钥）。
// 旧写法在 import 之后才 dotenv.config()，那些模块拿到的是空值，
// 于是回退到源码内置密钥 —— .env 里的 OPENLOG_SECRET_KEY 形同虚设。
import 'dotenv/config';
import express from 'express';
import { errorMessage, isTransientNetworkError } from './errors.js';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';
import * as si from 'systeminformation';
import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as remote from './remote.js';
import * as docker from './docker.js';
import { warnIfUnconfigured as warnIfHostGpuUnconfigured } from './gpu-host-ssh.js';
import gpuRouter from './routes/gpu.js';
import skillsRouter from './routes/skills.js';
import createMonitorRouter from './routes/monitor.js';
import createLogsRouter from './routes/logs.js';
import createAnalysisRouter from './routes/analysis.js';
import assistantMemoryRouter from './routes/assistant-memory.js';
import createModelsRouter from './routes/models.js';
import createRemoteRouter from './routes/remote.js';
import createSettingsRouter, { SENSITIVE_KEYS } from './routes/settings.js';
import createDockerRouter from './routes/docker.js';
import createChatRouter from './routes/chat.js';
import createAuthRouter from './routes/auth.js';
import { isLoopbackAddress } from './security/loopback.js';
import { migrateWatchSourceFields } from './settings-migrations.js';
import { initDb, getDb, getKv, setKv, insertLogRecord, getAlertConfig, closeDb } from './db/index.js';
import { resolveDockerTransport } from './docker-transport.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── 鉴权 ──────────────────────────────────────────────────
const TOKEN_FILE = path.join(__dirname, '..', 'data', '.auth_token');
const AUTH_TOKEN = loadOrCreateToken();

function loadOrCreateToken() {
  if (process.env.OPENLOG_TOKEN) return process.env.OPENLOG_TOKEN;
  try {
    if (fs.existsSync(TOKEN_FILE)) return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {}
  const token = crypto.randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  } catch {}
  return token;
}

// 生产模式鉴权提示：只提示令牌位置，不打印令牌本身。
// 远端浏览器访问时，前端会自动弹出「需要访问令牌」入口，输入这里的令牌即可。
if (process.env.NODE_ENV === 'production' && !process.env.OPENLOG_TOKEN) {
  console.log(`[Auth] 生产模式已启用鉴权；访问令牌在 ${TOKEN_FILE}（浏览器首次访问需输入）`);
}

// 判断是否为回环地址（仅开发模式下用于免鉴权）

// 时间安全比较 token：先用 SHA-256 对齐长度，再 timingSafeEqual
function tokenMatches(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  if (!candidate || !expected) return false;
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function authMiddleware(req, res, next) {
  // 仅非生产环境允许回环地址免鉴权；生产环境始终要求有效 token
  const ip = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress;
  if (process.env.NODE_ENV !== 'production' && isLoopbackAddress(ip)) return next();
  const auth = req.headers.authorization;
  // 只接受 Authorization 头。不接受 ?token= —— query string 会进入浏览器历史、
  // Referer、代理与访问日志，等于把长期凭据写进各处日志。
  // WebSocket 升级请求无法自定义头，其 query token 在 upgrade 处理里单独校验。
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
  if (tokenMatches(token, AUTH_TOKEN)) return next();
  res.status(401).json({ error: 'Unauthorized — 需要有效的访问令牌' });
}

// ─── Settings 敏感字段加密（文件落盘用）────────────────────
// 生产环境应从 OPENLOG_SECRET_KEY 读取；未设置时回退到源码内置派生（并给出唯一告警）
const SETTINGS_LEGACY_ENC_KEY = crypto.scryptSync('openlog-settings-salt-v2', 'openlog-settings', 32);
const SETTINGS_ENC_KEY = process.env.OPENLOG_SECRET_KEY
  ? crypto.scryptSync(process.env.OPENLOG_SECRET_KEY, 'openlog-settings-salt-v2', 32)
  : SETTINGS_LEGACY_ENC_KEY;
if (!process.env.OPENLOG_SECRET_KEY) {
  console.warn('⚠️  [安全] 未设置 OPENLOG_SECRET_KEY，正在使用源码内置的默认密钥加密存储的凭据（SSH 密码 / API Key）。请设置 OPENLOG_SECRET_KEY 环境变量。');
}

function encryptField(value) {
  if (!value) return value;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', SETTINGS_ENC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted.toString('hex');
}

function decryptField(value) {
  if (!value) return value;
  // 非加密格式直接返回（兼容旧数据）
  if (!value.includes(':')) return value;
  try {
    const [ivHex, authTagHex, cipherHex] = value.split(':');
    if (!ivHex || !authTagHex || !cipherHex) return value;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', SETTINGS_ENC_KEY, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(Buffer.from(cipherHex, 'hex')), decipher.final()]);
    return decrypted.toString('utf8');
  } catch { return value; }
}

// Settings 持久化文件（在项目根目录，可用 OPENLOG_SETTINGS_PATH 覆盖以便测试隔离）
const SETTINGS_FILE = process.env.OPENLOG_SETTINGS_PATH
  || path.join(__dirname, '..', 'settings.json');

// 从 SQLite 加载 settings（数据库未初始化时回退到文件）
function loadSettings() {
  let db;
  try { db = getDb(); } catch {}

  // 优先从 DB 加载
  if (db) {
    try {
      const stored = getKv('app_settings');
      if (stored) {
        const migrated = migrateWatchSourceFields(stored);
        if (migrated !== stored) {
          // 只有确实改动了才写回，避免每次启动都无谓地写库
          try {
            setKv('app_settings', migrated);
            console.log('[Settings] 已迁移 watchSources 旧字段名（logPath→path, watchFiles→pattern）');
          } catch (e) {
            console.warn('[Settings] watchSources 迁移写回失败（不影响本次运行）:', errorMessage(e));
          }
        }
        return migrated;
      }
    } catch (e) {
      console.warn('[Settings] 从 DB 加载失败:', errorMessage(e));
    }
  }

  // 回退到文件
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
      const fileSettings = migrateWatchSourceFields(JSON.parse(raw));
      // 解密敏感字段
      for (const key of SENSITIVE_KEYS) {
        if (fileSettings[key]) fileSettings[key] = decryptField(fileSettings[key]);
      }
      // 自动迁移到 DB
      if (db) {
        try {
          setKv('app_settings', fileSettings);
          console.log('[Settings] 已迁移到 SQLite');
        } catch (e) {}
      }
      return fileSettings;
    }
  } catch (e2) {}
  return null;
}

// 保存 settings 到 SQLite
function saveSettings(data) {
  let db;
  try { db = getDb(); } catch {}

  if (db) {
    try {
      setKv('app_settings', data);
      // 刷新内存缓存，确保后续 ensureSettings() 返回最新值
      settings = { ...defaultSettings, ...data };
      return true;
    } catch (e) {
      console.warn('[Settings] 保存到 DB 失败:', errorMessage(e));
    }
  }

  // 回退到文件
  try {
    const fileData = { ...data };
    // 加密敏感字段
    for (const key of SENSITIVE_KEYS) {
      if (fileData[key]) fileData[key] = encryptField(fileData[key]);
    }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(fileData, null, 2), 'utf8');
    // 刷新内存缓存
    settings = { ...defaultSettings, ...data };
    return true;
  } catch (e2) {
    console.error('[Settings] 保存到文件失败:', errorMessage(e2));
    return false;
  }
}

// 初始化数据库（启动时调用）
async function initDatabase() {
  try {
    await initDb();
    console.log('[DB] 数据库初始化完成');
    ensureSettings();
    remote.loadServers();
  } catch (err) {
    console.error('[DB] 初始化失败:', errorMessage(err));
  }
}

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true }); // 关键：使用 noServer: true，避免自动处理升级

const PORT = process.env.PORT || 3011;
const HOST = process.env.HOST || '127.0.0.1';

// CORS 白名单：OPENLOG_ALLOWED_ORIGINS（逗号分隔）优先；未设置时仅允许 localhost/127.0.0.1 任意端口，
// 以及不带 Origin 头的请求（同源 / 非浏览器客户端）。
const ALLOWED_ORIGINS = (process.env.OPENLOG_ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin) return true; // 无 Origin 头
  if (ALLOWED_ORIGINS.length > 0) return ALLOWED_ORIGINS.includes(origin);
  try {
    // 注意：new URL('http://[::1]:3011').hostname 返回带方括号的 '[::1]'，
    // 只比较 '::1' 会让 IPv6 回环来源被误拒。
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1'
      || hostname === '::1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

/**
 * 判断一个路径是否属于「必须返回 JSON」的后端命名空间（/api 与 /ws）。
 *
 * 两个用途：SPA 兜底放行，以及最后的 JSON 404。
 *
 * 必须写成 `p === '/api' || p.startsWith('/api/')` —— 只写 startsWith('/api/')
 * 会漏掉不带尾斜杠的 `/api` 与 `/ws`：它们匹配失败后掉进 SPA 兜底，
 * 返回一份 HTML 首页而不是 JSON。（实测确认过。）
 */
function isApiPath(p) {
  return p === '/api' || p.startsWith('/api/')
      || p === '/ws'  || p.startsWith('/ws/');
}

// Middleware
app.use(cors({
  origin(origin, callback) {
    callback(null, isAllowedOrigin(origin));
  },
}));
app.use(express.json({ limit: '10mb' }));

// 生产模式：托管前端静态文件
if (process.env.NODE_ENV === 'production') {
  const clientDist = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(clientDist));
  // SPA fallback — 所有非 API 路由返回 index.html
  app.get('*', (req, res, next) => {
    if (isApiPath(req.path)) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// 简易 Rate Limiter（每 IP 每分钟 120 次）
const rateLimitMap = new Map();
app.use((req, res, next) => {
  const ip = (req.ip || req.connection?.remoteAddress || 'unknown').replace('::ffff:', '');
  // localhost 不限速（回环判定与鉴权旁路、发放令牌共用同一份）
  if (isLoopbackAddress(ip)) return next();
  const now = Date.now();
  const record = rateLimitMap.get(ip) || { count: 0, resetAt: now + 60000 };
  if (now > record.resetAt) { record.count = 0; record.resetAt = now + 60000; }
  record.count++;
  rateLimitMap.set(ip, record);
  if (record.count > 120) return res.status(429).json({ error: 'Too Many Requests' });
  next();
});

// 鉴权中间件（排除公开端点）
const PUBLIC_PATHS = ['/api/auth/token'];
app.use((req, res, next) => {
  if (PUBLIC_PATHS.some(p => req.path.startsWith(p))) return next();
  authMiddleware(req, res, next);
});

// Token 获取端点（仅 localhost）
// Token 获取端点（仅 localhost）—— 已抽到 server/routes/auth.js
app.use(createAuthRouter({ authToken: AUTH_TOKEN }));

// 默认 settings
// 环境变量只作为「首次启动、数据库尚无配置」时的默认值：ensureSettings() 用
// { ...defaultSettings, ...saved } 合并，已有配置不会被覆盖 —— 这正是
// docker-compose / .env.example 所承诺的语义（此前这些变量写了但服务端从不读取）。
const DEFAULT_LOG_PATH = process.env.LOG_PATH || path.join(os.homedir(), 'logs');
const defaultSettings = {
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiBaseUrl: process.env.OPENAI_BASE_URL || 'http://localhost:11434/v1',
  model: process.env.MODEL || 'qwen3.5:9b',
  logPath: DEFAULT_LOG_PATH,
  watchFiles: '*.log',
  refreshInterval: '5000',
  autoAnalysis: true,
  thinkingEnabled: false,
  // 日志持久化配置
  logPersistence: false,                          // 是否持久化到数据库
  logPersistenceLevels: ['ERROR', 'FATAL', 'WARN'], // 持久化的日志等级
  logPersistenceMaxAge: 7,                        // 持久化日志保留天数
  watchSources: [
    {
      id: 'default',
      name: '默认服务',
      path: DEFAULT_LOG_PATH,
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
  // 容器异常退出通知
  dockerEventNotify: true,
  // 容器日志定时巡检
  containerPatrolEnabled: false,
  containerPatrolInterval: '300000',  // ms，默认 5 分钟
  containerPatrolLevels: ['ERROR', 'FATAL', 'WARN']
};

// Settings - 懒加载，数据库初始化完成后加载
let settings = null;

function ensureSettings() {
  if (!settings) {
    const saved = loadSettings();
    if (saved) {
      // 合并默认值：新字段用默认值，已有字段保持不变
      settings = { ...defaultSettings, ...saved };
    } else {
      settings = defaultSettings;
    }
  }
  return settings;
}

// 🧠 过滤 <think/> 标签：非流式响应直接替换
function stripThinking(text) {
  if (ensureSettings().thinkingEnabled) return text;
  // 匹配 <think&gt;...</think&gt;（支持多行、贪婪匹配最外层）
  return text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/g, '').trim();
}


// WebSocket connections
const wsClients = new Set();

// Logs storage
const logs = [];

// WebSocket 连接处理 - 仅处理来自 upgrade 的连接
// 注意：不要使用 wss.on('connection')，因为我们在 server.on('upgrade') 中处理

// Broadcast to all clients
function broadcast(data) {
  const message = JSON.stringify(data);
  wsClients.forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

// ============================================================
// 多源日志监控
// ============================================================
const watchers = new Map(); // sourceId -> chokidar watcher

// 文件偏移量记录（每个文件的已读字节位置）
const fileOffsets = new Map(); // filePath -> lastReadBytes

function readLastLine(filePath, sourceId) {
  try {
    const stat = fs.statSync(filePath);
    const size = stat.size;
    const lastPos = fileOffsets.get(filePath) ?? 0;

    // 文件被轮转（变小了），从头开始读
    if (size < lastPos) {
      fileOffsets.set(filePath, 0);
    }

    if (size === lastPos) return null; // 无新内容

    // 读取新增内容（从上次位置到文件末尾）
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(Math.min(size - lastPos, 512 * 1024)); // 最多 512KB
    fs.readSync(fd, buf, 0, buf.length, lastPos);
    fs.closeSync(fd);
    fileOffsets.set(filePath, size);

    const content = buf.toString('utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length === 0) return null;

    // 返回最后一行（以及所有新行用于记录）
    const lastLine = lines[lines.length - 1];
    return { lastLine, sourceId };
  } catch (err) {
    console.error(`[${sourceId}] Read error: ${errorMessage(err)}`);
    return null;
  }
}

function startLogWatcher() {
  // 关闭所有旧 watcher
  watchers.forEach(w => w.close());
  watchers.clear();
  fileOffsets.clear();

  const sources = ensureSettings().watchSources || [];

  if (sources.length === 0) {
    // 兼容旧配置
    const single = {
      id: 'default',
      name: '默认服务',
      path: ensureSettings().logPath || path.join(os.homedir(), 'logs'),
      pattern: ensureSettings().watchFiles || '*.log',
      enabled: true,
      autoAnalysis: ensureSettings().autoAnalysis ?? true
    };
    startSourceWatcher(single);
    return;
  }

  sources.forEach(source => {
    if (!source.enabled) {
      console.log(`[${source.id}] 跳过（已禁用）`);
      return;
    }
    startSourceWatcher(source);
  });
}

function startSourceWatcher(source) {
  const logDir = source.path;
  const pattern = source.pattern || '*.log';

  // 目录没配置时直接跳过，并说清楚原因。
  // 原实现不校验就往下走：existsSync(undefined) 返回 false，于是
  // mkdirSync(undefined) 抛出 "The path argument must be of type string"，
  // 用户看到的是一句和配置毫无关系的底层报错。（触发原因见 migrateWatchSourceFields）
  if (typeof logDir !== 'string' || logDir.trim() === '') {
    console.error(`[${source.id}] 跳过日志源「${source.name || source.id}」：未配置日志目录（path / logPath 均为空）`);
    return;
  }

  if (!fs.existsSync(logDir)) {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      console.log(`[${source.id}] Created directory: ${logDir}`);
    } catch (err) {
      console.error(`[${source.id}] Failed to create directory: ${errorMessage(err)}`);
      return;
    }
  }

  try {
    const watcher = chokidar.watch(path.join(logDir, pattern), {
      persistent: true,
      ignoreInitial: false  // 初始也扫描（用于记录偏移量）
    });

    watcher.on('add', (filePath) => {
      console.log(`[${source.id}] 📄 监听: ${path.basename(filePath)}`);
      fileOffsets.set(filePath, 0);
    });

    watcher.on('change', (filePath) => {
      const result = readLastLine(filePath, source.id);
      if (!result || !result.lastLine) return;

      const logEntry = parseLogLine(result.lastLine, `${source.name}/${path.basename(filePath)}`);
      logEntry.sourceId = source.id;
      saveLog(logEntry, source);
      broadcast({ type: 'log', data: logEntry });
    });

    watcher.on('error', (err) => {
      console.error(`[${source.id}] Watcher error: ${errorMessage(err)}`);
    });

    watchers.set(source.id, watcher);
    console.log(`[${source.id}] 🚀 开始监听: ${logDir} (${pattern})`);
  } catch (err) {
    console.error(`[${source.id}] Failed to start watcher: ${errorMessage(err)}`);
  }
}

// 停止指定服务监控
function stopSourceWatcher(sourceId) {
  const w = watchers.get(sourceId);
  if (w) {
    w.close();
    watchers.delete(sourceId);
    console.log(`[${sourceId}] 已停止`);
  }
}

function parseLogLine(line, source) {
  const timestampMatch = line.match(/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})/);
  const levelMatch = line.match(/\b(INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL)\b/i);
  
  return {
    id: uuidv4(),
    timestamp: timestampMatch ? timestampMatch[1] : new Date().toISOString(),
    level: levelMatch ? levelMatch[1].toUpperCase() : 'INFO',
    message: line,
    source: source,
    metadata: JSON.stringify({ raw: line })
  };
}

// 多任务分析队列：每个服务（sourceId）独立队列
const analysisQueues = new Map(); // sourceId -> { running: bool, pending: [] }
const analysisDebounce = new Map(); // key -> timestamp
const DEBOUNCE_MS = 30_000;

// 分析历史记录（内存存储，最多 500 条）
const analysisHistory = [];
const MAX_ANALYSIS_HISTORY = 500;

/** 添加分析记录（自动去重相同类型+名称 5 秒内的重复条目） */
function addAnalysisRecord(record) {
  const existing = analysisHistory.find(r =>
    r.type === record.type &&
    r.sourceName === record.sourceName &&
    r.status === record.status &&
    Math.abs(new Date(r.timestamp).getTime() - new Date(record.timestamp || Date.now()).getTime()) < 5000
  );
  if (existing) return; // 跳过重复
  analysisHistory.unshift(record);
  if (analysisHistory.length > MAX_ANALYSIS_HISTORY) analysisHistory.pop();
}

function getQueue(sourceId) {
  if (!analysisQueues.has(sourceId)) {
    analysisQueues.set(sourceId, { running: false, pending: [] });
  }
  return analysisQueues.get(sourceId);
}

function processQueue(sourceId) {
  const q = getQueue(sourceId);
  if (q.running || q.pending.length === 0) return;
  q.running = true;

  const { log, source } = q.pending.shift();
  runAnalysis(log, source).finally(() => {
    q.running = false;
    processQueue(sourceId); // 继续处理下一个
  });
}

function saveLog(log, source = null) {
  logs.unshift(log);

  // Keep only last 10000 logs
  if (logs.length > 10000) {
    logs.pop();
  }

  // 🚀 日志持久化到数据库（可选）
  const settings = ensureSettings();
  if (settings.logPersistence) {
    const levels = settings.logPersistenceLevels || ['ERROR', 'FATAL', 'WARN'];
    if (levels.includes(log.level)) {
      try {
        insertLogRecord({
          id: log.id || uuidv4(),
          machine_id: source?.id || 'default',
          source_type: 'file',
          source_name: source?.name || log.source || 'unknown',
          content: log.message || log.raw || '',
          severity: (log.level || 'info').toLowerCase(),
          timestamp: log.timestamp ? Math.floor(new Date(log.timestamp).getTime() / 1000) : Math.floor(Date.now() / 1000),
          parsed: log,
        });
      } catch (err) {
        console.warn('[DB] 日志持久化失败:', errorMessage(err));
      }
    }
  }

  // 🚀 主动分析：ERROR/FATAL 日志出现时加入分析队列
  const autoAnalysisEnabled = settings.autoAnalysis && (source?.autoAnalysis ?? true);
  if ((log.level === 'ERROR' || log.level === 'FATAL') && autoAnalysisEnabled) {
    enqueueAnalysis(log, source);
  }
}

function enqueueAnalysis(log, source) {
  const sourceId = source?.id || 'default';
  const q = getQueue(sourceId);

  // 防抖：同类错误 30s 内不重复
  const key = `${sourceId}:${log.message.slice(0, 120)}`;
  const now = Date.now();
  if (analysisDebounce.has(key)) {
    const last = analysisDebounce.get(key);
    if (now - last < DEBOUNCE_MS) {
      console.log(`[${sourceId}] ⏭️ 防抖跳过: ${log.message.slice(0, 60)}`);
      return;
    }
  }
  analysisDebounce.set(key, now);

  q.pending.push({ log, source });
  console.log(`[${sourceId}] 📋 加入分析队列 (待处理: ${q.pending.length})`);
  processQueue(sourceId);
}

async function runAnalysis(errorLog, source) {
  const sourceId = source?.id || 'default';
  console.log(`[${sourceId}] 🤖 开始分析: ${errorLog.message.slice(0, 80)}`);

  const apiKey = ensureSettings().openaiApiKey;
  const baseUrl = ensureSettings().openaiBaseUrl || 'http://localhost:11434/v1';
  const model = ensureSettings().model;
  const isLocalModel = baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1') || baseUrl.includes('0.0.0.0');

  if (!apiKey && !isLocalModel) {
    broadcast({
      type: 'ai_analysis',
      status: 'skipped',
      message: '未配置 LLM，无法自动分析。请在设置页面配置 API Key。',
      log: errorLog,
      sourceId
    });
    return;
  }
  if (!model) {
    broadcast({
      type: 'ai_analysis',
      status: 'skipped',
      message: '未配置 LLM 模型，无法自动分析。',
      log: errorLog,
      sourceId
    });
    return;
  }

  // 通知前端：分析开始
  console.log(`[${sourceId}] 📡 调用 LLM: ${model}`);
  broadcast({ type: 'ai_analysis', status: 'pending', log: errorLog, sourceId });

  try {
    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({ apiKey: apiKey || 'ollama', baseURL: baseUrl });

    const prompt = `你是一个专业的运维工程师。请分析以下错误日志，找出根因并给出简洁的修复建议。

错误日志：
[${errorLog.timestamp}] [${errorLog.level}] ${errorLog.message}
来源: ${errorLog.source}

请用以下格式回复（Markdown）：
## 🔍 根因分析
[一句话说明最可能的根因]

## 💡 修复建议
1. [具体可操作的修复步骤]
2. [...]

回复语言与日志一致（中文日志用中文）。`;

    const response = await openai.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      timeout: 60_000
    });

    const analysis = stripThinking(response.choices[0].message.content);
    console.log(`[${sourceId}] ✅ 分析完成`);

    // 存入历史
    const record = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      sourceId,
      sourceName: source?.name || sourceId,
      log: errorLog,
      analysis,
      status: 'done',
      model
    };
    addAnalysisRecord(record);

    broadcast({
      type: 'ai_analysis',
      status: 'done',
      log: errorLog,
      sourceId,
      analysis,
      recordId: record.id
    });
  } catch (err) {
    console.error(`[${sourceId}] 分析失败: ${errorMessage(err)}`);

    // 存入历史
    const record = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      sourceId,
      sourceName: source?.name || sourceId,
      log: errorLog,
      analysis: null,
      status: 'error',
      error: errorMessage(err),
      model
    };
    addAnalysisRecord(record);

    broadcast({
      type: 'ai_analysis',
      status: 'error',
      message: `分析失败: ${errorMessage(err)}`,
      log: errorLog,
      sourceId,
      recordId: record.id
    });
  }
}

// System monitoring
let monitorInterval = null;
const monitorHistory = [];

function startMonitor() {
  const interval = parseInt(ensureSettings().refreshInterval || '5000');
  
  if (monitorInterval) {
    clearInterval(monitorInterval);
  }
  
  monitorInterval = setInterval(async () => {
    try {
      const [cpu, mem, disks, network] = await Promise.all([
        si.currentLoad(),
        si.mem(),
        si.fsSize(),
        si.networkStats()
      ]);
      
      const stats = {
        timestamp: new Date().toISOString(),
        cpu: cpu.currentLoad || 0,
        memory: mem.total > 0 ? (mem.used / mem.total) * 100 : 0,
        disk: disks.map(d => ({
          name: d.mount,
          used: d.used,
          total: d.size,
          usePercent: d.use
        })),
        network: network[0] ? network[0].rx_sec + network[0].tx_sec : 0,
        gpuUtil: 0, // populated separately if nvidia-smi available
      };
      
      monitorHistory.unshift(stats);
      
      // Keep only last 1000 entries
      if (monitorHistory.length > 1000) {
        monitorHistory.pop();
      }
      
      broadcast({ type: 'monitor', data: stats });
    } catch (err) {
      console.error('Monitor error:', err);
    }
  }, interval);
}

// ─── Docker 事件监听（容器异常退出推送）─────────────────
let dockerEventStarted = false;

function startDockerEventWatch() {
  const enabled = ensureSettings().dockerEventNotify !== false;
  const sources = ensureSettings().dockerSources || [];

  if (!enabled || dockerEventStarted) return;
  dockerEventStarted = true;

  for (const src of sources) {
    docker.startEventWatcher(src.id, src, (event) => {
      broadcast(event);
    });
  }
}

function restartDockerEventWatch() {
  docker.stopAllEventWatchers();
  dockerEventStarted = false;
  startDockerEventWatch();
}

// ─── 容器日志定时巡检 ────────────────────────────────────
let patrolTimer = null;
let lastPatrolResults = [];
// routes/docker.js 与本文件的巡检定时器共同读写这一份结果，故以访问器暴露
function getLastPatrolResults() { return lastPatrolResults; }
function setLastPatrolResults(v) { lastPatrolResults = v; }

// ─── 告警 Webhook 冷却状态 ───────────────────────────────
const alertCooldowns = new Map(); // key: "machineId_containerName_errorSig", value: timestamp

function startContainerPatrol() {
  if (patrolTimer) clearInterval(patrolTimer);

  const enabled = ensureSettings().containerPatrolEnabled;
  if (!enabled) return;

  const interval = parseInt(ensureSettings().containerPatrolInterval || '300000');
  const levels = ensureSettings().containerPatrolLevels || ['ERROR', 'FATAL'];
  const sources = ensureSettings().dockerSources || [];

  // 立即执行一次
  runPatrol(sources, levels);

  patrolTimer = setInterval(() => {
    runPatrol(sources, levels);
  }, interval);

  console.log(`[Patrol] 容器日志巡检已启动 (间隔: ${interval / 1000}s, 等级: ${levels.join(',')})`);
}

// 为远程 Docker 源构建 hostExec 回调
function buildHostExecMap() {
  const remoteServers = remote.getServers();
  const map = new Map();
  for (const rs of remoteServers) {
    if (rs.status === 'connected' || rs.status === 'online') { // 'online' 是历史值，实际状态为 'connected'
      map.set(rs.host, async (cmd) => {
        try {
          return await remote.execShellCommand(rs.id, cmd, 10000);
        } catch { return { stdout: '', stderr: 'ssh failed' }; }
      });
    }
  }
  return map;
}

async function runPatrol(sources, levels) {
  try {
    const hostExecMap = buildHostExecMap();
    const hostExecForSource = (src) => hostExecMap.get(src.host) || null;

    const results = await docker.patrolContainerLogs(sources, levels, hostExecForSource);
    // 只在有新结果时覆盖，避免空巡检冲掉上一次有效数据
    if (results.length > 0) {
      lastPatrolResults = results;
      // 处理告警通知
      for (const result of results) {
        processAlertForResult(result);
      }
    }
    if (results.length > 0) {
      broadcast({ type: 'container_patrol', data: { results, timestamp: new Date().toISOString() } });
    }
  } catch (err) {
    console.error('[Patrol] 巡检异常:', errorMessage(err));
  }
}

// ─── 告警 Webhook 发送逻辑 ─────────────────────────────────

/** 规范化错误签名用于冷却键 */
export function normalizeAlertSig(line) {
  return (line || '')
    .replace(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\w+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\w+\s+\d{4}\s*-\s*/i, '')
    .replace(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^\s]*\s*-?\s*/i, '')
    .replace(/req_[a-f0-9]+/gi, 'req_XXX')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, 'UUID')
    .trim()
    .slice(0, 120);
}

/** 匹配关键词 patterns（逗号分隔，如 "ERROR,FATAL,Exception"）*/
export function matchAlertPatterns(content, patterns) {
  if (!patterns) return true;
  const keywords = patterns.split(',').map(k => k.trim().toUpperCase()).filter(Boolean);
  if (keywords.length === 0) return true;
  const upperContent = (content || '').toUpperCase();
  return keywords.some(kw => upperContent.includes(kw));
}

/** 匹配 severity_filter（逗号分隔，如 "ERROR,FATAL"）*/
export function matchesSeverityFilter(lineLevel, severityFilter) {
  if (!severityFilter) return true;
  const levels = severityFilter.split(',').map(l => l.trim().toUpperCase()).filter(Boolean);
  if (levels.length === 0) return true;
  const lvl = (lineLevel || 'INFO').toUpperCase();
  return levels.includes(lvl);
}

/** 处理单个巡检结果的告警通知 */
async function processAlertForResult(result) {
  try {
    const config = getAlertConfig(result.sourceId);
    if (!config || !config.enabled) return;

    if (!config.webhook_url) {
      return; // 未配置 webhook，静默跳过
    }

    const patterns = config.patterns || '';
    const severityFilter = config.severity_filter || '';
    const cooldownMinutes = config.cooldown_minutes || 5;

    // 按 patterns 和 severity_filter 过滤日志行
    const matchedLines = result.lines.filter(line => {
      const content = line.content || line.line || '';
      if (!matchAlertPatterns(content, patterns)) return false;
      if (!matchesSeverityFilter(line.level, severityFilter)) return false;
      return true;
    });

    if (matchedLines.length === 0) return;

    // 冷却时间控制
    const now = Date.now();
    const cooldownMs = cooldownMinutes * 60 * 1000;
    const newErrors = [];

    for (const line of matchedLines) {
      const errorSig = normalizeAlertSig(line.content || line.line || '');
      const cooldownKey = `${result.sourceId}_${result.containerName}_${errorSig}`;
      const lastSent = alertCooldowns.get(cooldownKey);
      if (lastSent && (now - lastSent) < cooldownMs) continue;
      alertCooldowns.set(cooldownKey, now);
      newErrors.push(line);
    }

    if (newErrors.length === 0) return;

    // 构建 webhook payload
    const payload = {
      text: `🔴 容器日志告警 — ${result.sourceName}/${result.containerName}`,
      server: result.sourceName,
      container: result.containerName,
      image: result.image,
      errors: newErrors.map(l => ({
        level: l.level,
        content: l.content || l.line,
        timestamp: l.timestamp,
      })),
      time: new Date().toISOString(),
    };

    // 发送 POST 到 webhook_url
    console.log(`[Alert] 发送 Webhook 到 ${config.webhook_url} (${newErrors.length}/${matchedLines.length} 条异常)`);
    const response = await fetch(config.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000), // 10s 超时
    });

    if (!response.ok) {
      console.error(`[Alert] Webhook 发送失败: HTTP ${response.status} ${response.statusText}`);
    } else {
      console.log(`[Alert] ✅ Webhook 发送成功 (${newErrors.length} 条通知到 ${result.sourceName}/${result.containerName})`);
    }
  } catch (err) {
    console.error(`[Alert] 处理告警异常 (${result.sourceName}/${result.containerName}):`, errorMessage(err));
  }
}

function restartContainerPatrol() {
  if (patrolTimer) clearInterval(patrolTimer);
  docker.resetPatrolCheckpoints();
  startContainerPatrol();
}

// API Routes

// ─── 日志路由（已抽到 server/routes/logs.js）──────────────────────────────
// logs 是下方的实时日志缓冲，ensureSettings 是配置读取，均通过工厂注入
app.use(createLogsRouter({ logs, ensureSettings, saveLog, broadcast }));



// ─── 系统监控路由（已抽到 server/routes/monitor.js）────────────────────────
// monitorHistory 由下方 startMonitor() 的定时器写入，这里通过工厂注入
app.use(createMonitorRouter({ monitorHistory }));

// ============================================================
// 配置读写 —— 已抽到 server/routes/settings.js
// ============================================================
app.use(createSettingsRouter({
  ensureSettings, saveSettings, startLogWatcher,
  restartDockerEventWatch, restartContainerPatrol, startMonitor,
}));

// ============================================================
// 自定义技能 (Skills) / 机器列表 / 告警配置 —— 已抽到 server/routes/skills.js
// ============================================================
app.use(skillsRouter);

// ============================================================
// 日志分析状态 API —— 已抽到 server/routes/analysis.js
// ============================================================
app.use(createAnalysisRouter({ analysisQueues, analysisHistory, enqueueAnalysis }));

// ============================================================
// 运维助手知识库 —— 已抽到 server/routes/assistant-memory.js
// ============================================================
app.use(assistantMemoryRouter);

// ============================================================
// 可用模型列表 —— 已抽到 server/routes/models.js
// ============================================================
app.use(createModelsRouter({ ensureSettings }));

// ============================================================
// LLM 助手聊天 API（流式 SSE）
// ============================================================

function buildAssistantContext() {
  if (lastPatrolResults.length > 0) {
    const lines = lastPatrolResults.slice(0, 3).map(r => `${r.containerName}: ${r.uniqueCount || r.matchCount}种异常`).join(', ');
    return `巡检: ${lines}`;
  }
  return '暂无。';
}


const DANGEROUS_TOOLS = new Set(['docker_start', 'docker_stop', 'docker_restart', 'docker_exec', 'remote_exec']);

/** 执行工具调用，返回结果对象 */
async function executeAssistantTool(name, args) {
  const settings = ensureSettings();
  const dockerSources = settings.dockerSources || [];

  // 辅助：根据 sourceId 获取 Docker 配置
  const getDockerConfig = async (sourceId) => {
    const src = sourceId ? dockerSources.find(s => s.id === sourceId) : dockerSources.find(s => s.enabled);
    if (!src) throw new Error('未找到可用的 Docker 源');
    return { sourceId: src.id, config: await resolveDockerTransport(src) };
  };

  try {
    switch (name) {
      // ── Docker ──
      case 'docker_list': {
        if (args.sourceId) {
          const { sourceId, config } = await getDockerConfig(args.sourceId);
          const containers = await docker.listContainers(sourceId, config);
          return { containers, sourceId, total: containers.length };
        }
        const all = [];
        for (const src of dockerSources.filter(s => s.enabled)) {
          try {
            const config = await resolveDockerTransport(src);
            const containers = await docker.listContainers(src.id, config);
            all.push({ sourceId: src.id, sourceName: src.name, containers });
          } catch (e) { all.push({ sourceId: src.id, sourceName: src.name, error: errorMessage(e), containers: [] }); }
        }
        return { sources: all, totalSources: all.length };
      }
      case 'docker_logs': {
        const dc = await getDockerConfig(args.sourceId);
        const logs = await docker.getContainerLogs(dc.sourceId, args.containerId, dc.config, { tail: args.tail || 200 });
        const logLines = (logs || []).slice(-(args.tail || 200));
        return { containerId: args.containerId, totalLines: logLines.length, logs: logLines };
      }
      case 'docker_inspect': {
        const dc = await getDockerConfig(args.sourceId);
        const containers = await docker.listContainers(dc.sourceId, dc.config);
        const c = containers.find(x => x.id === args.containerId || x.shortId === args.containerId || (x.names || []).some(n => n.includes(args.containerId)));
        if (!c) return { error: `容器 ${args.containerId} 未找到` };
        return { container: c };
      }
      case 'docker_start': {
        const dc = await getDockerConfig(args.sourceId);
        const r = await docker.startContainer(dc.sourceId, args.containerId, dc.config);
        return r;
      }
      case 'docker_stop': {
        const dc = await getDockerConfig(args.sourceId);
        const r = await docker.stopContainer(dc.sourceId, args.containerId, dc.config);
        return r;
      }
      case 'docker_restart': {
        const dc = await getDockerConfig(args.sourceId);
        const r = await docker.restartContainer(dc.sourceId, args.containerId, dc.config);
        return r;
      }
      case 'docker_exec': {
        const dc = await getDockerConfig(args.sourceId);
        const r = await docker.execInContainer(dc.sourceId, args.containerId, args.command, dc.config);
        return { output: r.output, exitCode: r.exitCode };
      }
      case 'docker_health_check': {
        const r = await docker.healthCheck(dockerSources);
        return r;
      }
      // ── 远程服务器 ──
      case 'remote_servers': {
        const servers = remote.getServers();
        return { servers, total: servers.length };
      }
      case 'remote_exec': {
        // 确保已连接
        const servers = remote.getServers();
        const s = servers.find(x => x.id === args.serverId);
        if (!s) return { error: `服务器 ${args.serverId} 未找到` };
        if (s.status !== 'connected') {
          try { await remote.connectServer(args.serverId); } catch (e) { return { error: `连接失败: ${errorMessage(e)}` }; }
        }
        const r = await remote.execRemoteCommand(args.serverId, args.command);
        return r;
      }
      case 'remote_system_stats': {
        const servers = remote.getServers();
        const s = servers.find(x => x.id === args.serverId);
        if (!s) return { error: `服务器 ${args.serverId} 未找到` };
        if (s.status !== 'connected') {
          try { await remote.connectServer(args.serverId); } catch (e) { return { error: `连接失败: ${errorMessage(e)}` }; }
        }
        const r = await remote.getRemoteSystemStats(args.serverId);
        return r;
      }
      case 'remote_list_files': {
        const servers = remote.getServers();
        const s = servers.find(x => x.id === args.serverId);
        if (!s) return { error: `服务器 ${args.serverId} 未找到` };
        if (s.status !== 'connected') {
          try { await remote.connectServer(args.serverId); } catch (e) { return { error: `连接失败: ${errorMessage(e)}` }; }
        }
        const r = await remote.listRemoteFiles(args.serverId, args.path || '');
        return r;
      }
      case 'remote_read_file': {
        const servers = remote.getServers();
        const s = servers.find(x => x.id === args.serverId);
        if (!s) return { error: `服务器 ${args.serverId} 未找到` };
        if (s.status !== 'connected') {
          try { await remote.connectServer(args.serverId); } catch (e) { return { error: `连接失败: ${errorMessage(e)}` }; }
        }
        const r = await remote.readRemoteFile(args.serverId, args.filePath, { lines: args.lines || 200 });
        return r;
      }
      case 'remote_search_logs': {
        const servers = remote.getServers();
        const s = servers.find(x => x.id === args.serverId);
        if (!s) return { error: `服务器 ${args.serverId} 未找到` };
        if (s.status !== 'connected') {
          try { await remote.connectServer(args.serverId); } catch (e) { return { error: `连接失败: ${errorMessage(e)}` }; }
        }
        const r = await remote.searchRemoteLogs(args.serverId, args.search);
        return r;
      }
      // ── 本地 ──
      case 'local_system_stats': {
        const [cpu, mem, disksData, network, processes] = await Promise.all([
          si.currentLoad(), si.mem(), si.fsSize(), si.networkStats(), si.processes()
        ]);
        let gpus = [];
        try {
          const { execSync } = await import('child_process');
          const out = execSync('nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>/dev/null', { timeout: 3000 });
          gpus = out.toString().trim().split('\n').filter(Boolean).map(line => {
            const [idx, name, util, memUsed, memTotal, temp] = line.split(',').map(s => s.trim());
            return { index: parseInt(idx) || 0, name: name || '', util: parseFloat(util) || 0, memUsed: parseFloat(memUsed) || 0, memTotal: parseFloat(memTotal) || 1, temp: parseFloat(temp) || 0 };
          });
        } catch {}
        return {
          cpu: { load: cpu.currentLoad || 0 },
          memory: { used: mem.used || 0, total: mem.total || 1, free: mem.free || 0, usePercent: mem.total > 0 ? ((mem.used / mem.total) * 100).toFixed(1) : 0 },
          disk: disksData.map(d => ({ name: d.fs, used: d.used, total: d.size, usePercent: d.use })),
          network: (network || []).slice(0, 3).map(n => ({ iface: n.iface, rx: n.rx_sec, tx: n.tx_sec })),
          processes: (processes?.list || []).slice(0, 10).map(p => ({ pid: p.pid, name: p.name, cpu: p.cpu, mem: p.mem })),
          gpus,
        };
      }
      case 'local_log_files': {
        const logPath = settings.logPath || path.join(os.homedir(), 'logs');
        let files = [];
        try {
          if (fs.existsSync(logPath)) {
            files = fs.readdirSync(logPath).filter(f => f.endsWith('.log')).map(f => ({
              name: f, path: path.join(logPath, f), size: fs.statSync(path.join(logPath, f)).size
            }));
          }
        } catch {}
        return { logPath, files, total: files.length };
      }
      case 'local_read_log': {
        const content = fs.readFileSync(args.filePath, 'utf8');
        const allLines = content.split('\n').filter(Boolean);
        const lines = allLines.slice(-(args.lines || 200));
        return { filePath: args.filePath, totalLines: allLines.length, returnedLines: lines.length, lines };
      }
      default:
        return { error: `未知工具: ${name}` };
    }
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

// ============================================================
// 运维助手对话 —— 已抽到 server/routes/chat.js
// ============================================================
app.use(createChatRouter({ ensureSettings, buildAssistantContext, executeAssistantTool }));

// ========================================
// ============================================================
// Docker API Routes —— 已抽到 server/routes/docker.js
// ============================================================
app.use(createDockerRouter({
  ensureSettings, broadcast, addAnalysisRecord, buildHostExecMap, stripThinking,
  getLastPatrolResults, setLastPatrolResults,
}));

// ========================================
// Remote Server API Routes
// ========================================
// Remote Server API Routes —— 已抽到 server/routes/remote.js
// 命令安全策略与 docker /exec 共用 server/security/shell-command-policy.js
// ========================================
app.use(createRemoteRouter({ ensureSettings, stripThinking }));

// Shell 会话存储
const shellSessions = new Map();

// WebSocket 升级处理 - 为 Shell 终端
// 升级请求不经过 Express 中间件，必须在此处完成 token 鉴权
function isUpgradeAuthorized(request) {
  if (process.env.NODE_ENV !== 'production' && isLoopbackAddress(request.socket?.remoteAddress)) return true;
  let token = null;
  try {
    token = new URL(request.url, 'http://localhost').searchParams.get('token');
  } catch {}
  return tokenMatches(token, AUTH_TOKEN);
}

server.on('upgrade', (request, socket, head) => {
  const pathname = request.url.split('?')[0];

  // 所有 WebSocket 端点升级前必须校验 token，失败直接 401 并断开，绝不升级
  if (!isUpgradeAuthorized(request)) {
    try {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    } catch {}
    socket.destroy();
    return;
  }

  // Shell WebSocket 端点: /ws/shell/:serverId
  if (pathname.startsWith('/ws/shell/')) {
    const serverId = pathname.split('/')[3];

    wss.handleUpgrade(request, socket, head, (ws) => {
      handleShellWebSocket(ws, serverId);
    });
  } else if (pathname.startsWith('/ws/aishell/')) {
    // AI Shell WebSocket 端点: /ws/aishell/:serverId
    const serverId = pathname.split('/')[3];

    wss.handleUpgrade(request, socket, head, (ws) => {
      handleAIShellWebSocket(ws, serverId);
    });
  } else if (pathname.startsWith('/ws/docker/logs/')) {
    // Docker 实时日志流端点: /ws/docker/logs/:sourceId/:containerId
    const parts = pathname.split('/');
    const sourceId = parts[4];
    const containerId = parts[5];
    if (!sourceId || !containerId) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      handleDockerLogStream(ws, sourceId, containerId);
    });
  } else if (pathname === '/ws') {
    // 原有的主 WebSocket 连接
    wss.handleUpgrade(request, socket, head, (ws) => {
      wsClients.add(ws);
      console.log('Client connected to WebSocket');

      ws.on('close', () => {
        wsClients.delete(ws);
        console.log('Client disconnected from WebSocket');
      });
    });
  } else {
    // 其他路径则关闭 socket
    socket.destroy();
  }
});

// 处理 Shell WebSocket 连接
async function handleShellWebSocket(ws, serverId) {
  console.log(`Shell WebSocket connected for server: ${serverId}`);
  
  let shellSession = null;
  
  try {
    // 创建交互式 Shell 会话
    shellSession = await remote.createShellSession(serverId, ws);
    shellSessions.set(serverId, shellSession);
    
    ws.send(JSON.stringify({ 
      type: 'shell_ready', 
      message: 'Shell session started' 
    }));
    
    // 接收客户端输入
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        if (msg.type === 'input' && shellSession) {
          // 发送按键到远程 Shell
          shellSession.send(msg.data);
        } else if (msg.type === 'resize' && shellSession) {
          // 调整终端大小
          shellSession.resize(msg.cols, msg.rows);
        }
      } catch (err) {
        console.error('Shell message error:', err);
      }
    });
    
    ws.on('close', () => {
      console.log(`Shell WebSocket closed for server: ${serverId}`);
      if (shellSession) {
        shellSession.close();
        shellSessions.delete(serverId);
      }
    });
    
  } catch (err) {
    console.error('Failed to create shell session:', err);
    ws.send(JSON.stringify({ 
      type: 'shell_error', 
      error: errorMessage(err) 
    }));
    ws.close();
  }
}

// AI Shell WebSocket 处理器 — 自然语言 → AI 生成命令 → 远程执行
async function handleAIShellWebSocket(ws, serverId) {
  console.log(`AI Shell WebSocket connected for server: ${serverId}`);

  const SYSTEM_PROMPT = `You are an AI assistant on a remote Linux server (${serverId}). You have TWO modes:

## Mode 1: Command (when the request involves checking system state, files, processes, logs, etc.)
Output ONLY the shell command on a single line — no explanation, no markdown, no backticks.
Rules for commands:
- Use POSIX-compatible syntax
- Never generate destructive commands (rm -rf, dd, mkfs, etc.) unless explicitly requested
- For monitoring queries, prefer concise output (use head/tail/grep)
- Multi-step operations should be joined with && or ;
- Assume tools: grep, awk, sed, find, curl, ps, top, df, free, du, systemctl, journalctl, docker, kubectl, python3, nvidia-smi

## Mode 2: Answer (when the request is a general question, explanation, or cannot be converted to a command)
Prefix your response with "ANSWER:" followed by a helpful, concise answer in Chinese.
Example: "ANSWER: Docker 是一种容器化平台，用于打包和运行应用。"

Choose Mode 2 if the user is asking "是什么", "怎么做", "为什么", "能做什么" or any knowledge question.
Choose Mode 1 for operational requests like "查看", "列出", "检查", "找出".`;

  ws.send(JSON.stringify({
    type: 'aishell_ready',
    message: 'AI Shell session ready'
  }));

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // 自然语言指令 → 生成命令
      if (msg.type === 'natural_language' || msg.type === 'regenerate') {
        const requestId = msg.id;
        const text = msg.text;
        const skillContent = msg.skillContent || '';
        const skillName = msg.skillName || '';
        const history = msg.history || [];

        // 如果有技能上下文，构建增强 system prompt
        let systemPrompt = SYSTEM_PROMPT;
        if (skillContent) {
          systemPrompt = `${SYSTEM_PROMPT}

## 🎯 用户当前使用的技能: ${skillName}

以下是该技能的标准操作流程，请严格遵循它来生成命令：

${skillContent}

重要：你的任务是根据上述技能规程，将用户的自然语言请求转换为 shell 命令。技能规程的 Workflow 章节提供了命令顺序，优先使用其中指定的命令和参数。`;
        }

        console.log(`[AIShell] 收到自然语言: "${text.slice(0, 80)}"${skillName ? ` (技能: ${skillName})` : ''}`);

        try {
          const apiKey = ensureSettings().openaiApiKey;
          const baseUrl = ensureSettings().openaiBaseUrl || 'http://localhost:11434/v1';
          const model = ensureSettings().model || 'qwen3.5:9b';
          const isLocalModel = baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1') || baseUrl.includes('0.0.0.0');

          if (!apiKey && !isLocalModel) {
            ws.send(JSON.stringify({
              type: 'error',
              id: requestId,
              error: '未配置 LLM API Key。请在设置页面配置。'
            }));
            return;
          }

          const OpenAI = (await import('openai')).default;
          const openai = new OpenAI({
            apiKey: apiKey || 'ollama',
            baseURL: baseUrl
          });

          const response = await openai.chat.completions.create({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              ...history.filter(h => h.role && h.content).map(h => ({ role: h.role, content: h.content })),
              { role: 'user', content: text }
            ],
            temperature: 0.2,
            max_tokens: 800,
            timeout: 30_000
          });

          const rawOutput = (response.choices[0].message.content || '').trim();

          // Check if it's a text answer (not a command)
          if (rawOutput.startsWith('ANSWER:')) {
            const answer = rawOutput.slice(7).trim();
            ws.send(JSON.stringify({
              type: 'assistant_answer',
              id: requestId,
              content: answer
            }));
            return;
          }

          let command = rawOutput;

          // 清理可能的 markdown 代码块标记
          command = command
            .replace(/^```(?:bash|sh|shell|cmd|powershell)?\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();

          console.log(`[AIShell] 生成命令: "${command}"`);

          if (!command || command === 'NO_COMMAND') {
            ws.send(JSON.stringify({
              type: 'error',
              id: requestId,
              error: 'AI 无法将你的请求转换为命令。请尝试更具体的描述，或切换到命令模式手动输入。'
            }));
            return;
          }

          ws.send(JSON.stringify({
            type: 'command_generated',
            id: requestId,
            command
          }));

        } catch (err) {
          console.error('[AIShell] AI 生成命令失败:', errorMessage(err));
          ws.send(JSON.stringify({
            type: 'error',
            id: requestId,
            error: `AI 生成命令失败: ${errorMessage(err)}`
          }));
        }
      }

      // 执行命令
      else if (msg.type === 'execute') {
        const requestId = msg.id;
        const command = msg.command;

        console.log(`[AIShell] 执行命令: "${command}"`);

        try {
          const result = await remote.execRemoteCommand(serverId, command);

          if (result.error) {
            ws.send(JSON.stringify({
              type: 'command_error',
              id: requestId,
              error: result.error
            }));
            ws.send(JSON.stringify({
              type: 'command_done',
              id: requestId,
              exitCode: -1
            }));
            return;
          }

          // 发送 stdout
          if (result.stdout) {
            ws.send(JSON.stringify({
              type: 'command_output',
              id: requestId,
              data: result.stdout
            }));
          }

          // 发送 stderr
          if (result.stderr) {
            ws.send(JSON.stringify({
              type: 'command_output',
              id: requestId,
              data: `\x1b[33m${result.stderr}\x1b[0m`
            }));
          }

          ws.send(JSON.stringify({
            type: 'command_done',
            id: requestId,
            exitCode: result.exitCode ?? 0
          }));

        } catch (err) {
          console.error('[AIShell] 命令执行失败:', errorMessage(err));
          ws.send(JSON.stringify({
            type: 'command_error',
            id: requestId,
            error: errorMessage(err)
          }));
        }
      }
    } catch (err) {
      console.error('[AIShell] 消息处理错误:', err);
    }
  });

  ws.on('close', () => {
    console.log(`AI Shell WebSocket closed for server: ${serverId}`);
  });

  ws.on('error', (err) => {
    console.error(`AI Shell WebSocket error for server ${serverId}:`, errorMessage(err));
  });
}

// Docker 实时日志流 WebSocket 处理器
async function handleDockerLogStream(ws, sourceId, containerId) {
  console.log(`Docker log stream WebSocket connected for source: ${sourceId}, container: ${containerId}`);

  let logStream = null;

  try {
    const source = (ensureSettings().dockerSources || []).find(s => s.id === sourceId);
    const config = source ? await resolveDockerTransport(source) : {};

    const dockerInstance = docker.getDocker(sourceId, config);
    const container = dockerInstance.getContainer(containerId);

    // 获取实时日志流
    logStream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail: 100,
      timestamps: true,
    });

    // 通知客户端流已就绪
    ws.send(JSON.stringify({ type: 'stream_ready', sourceId, containerId }));

    // 解析 Docker 多路复用流格式：[8字节头][数据]...
    // 字节 0: stream type (1=stdout, 2=stderr)
    // 字节 4-7: 数据长度 (大端序)
    let buffer = Buffer.alloc(0);

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= 8) {
        // 读取 8 字节头：stream type (1 byte) + 3 字节填充 + size (4 bytes)
        const size = buffer.readUInt32BE(4);
        if (size <= 0 || buffer.length < 8 + size) break;

        const data = buffer.slice(8, 8 + size).toString('utf8');
        buffer = buffer.slice(8 + size);

        // 解析时间戳
        const parts = data.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s*(.*)/);
        let timestamp, line;
        if (parts) {
          timestamp = parts[1];
          line = parts[2];
        } else {
          timestamp = new Date().toISOString();
          line = data.trim();
        }

        // 解析日志等级
        let level = 'INFO';
        let content = line;
        const levelMatch = line.match(/^\s*\[(FATAL|ERROR|WARN|WARNING|INFO|DEBUG|TRACE)\]\s*/i);
        if (levelMatch) {
          level = levelMatch[1].toUpperCase() === 'WARNING' ? 'WARN' : levelMatch[1].toUpperCase();
          content = line.substring(levelMatch[0].length);
        }

        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({
            type: 'log',
            timestamp,
            line,
            level,
            content,
          }));
        }
      }
    };

    const onError = (err) => {
      console.error(`Docker log stream error for ${containerId}:`, errorMessage(err));
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'stream_error', error: errorMessage(err) }));
        ws.close();
      }
    };

    const onEnd = () => {
      console.log(`Docker log stream ended for ${containerId}`);
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'stream_end' }));
        ws.close();
      }
    };

    logStream.on('data', onData);
    logStream.on('error', onError);
    logStream.on('end', onEnd);

    // 客户端断开时停止 stream
    ws.on('close', () => {
      console.log(`Docker log stream WebSocket closed for ${containerId}`);
      if (logStream) {
        logStream.removeListener('data', onData);
        logStream.removeListener('error', onError);
        logStream.removeListener('end', onEnd);
        logStream.destroy();
        logStream = null;
      }
    });

    ws.on('error', (err) => {
      console.error(`Docker log stream WS error for ${containerId}:`, errorMessage(err));
      if (logStream) {
        logStream.destroy();
        logStream = null;
      }
    });

    // 处理客户端消息（暂停/继续）
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'pause' && logStream) {
          logStream.pause();
        } else if (msg.type === 'resume' && logStream) {
          logStream.resume();
        }
      } catch {}
    });

  } catch (err) {
    console.error(`Failed to create Docker log stream for ${containerId}:`, errorMessage(err));
    ws.send(JSON.stringify({ type: 'stream_error', error: errorMessage(err) }));
    ws.close();
  }
}

// Start server
// 先初始化数据库
await initDatabase();

server.listen(PORT, HOST, async () => {
  const boundHost = server.address()?.address || HOST;
  console.log(`🚀 Give Me The Log server running on http://${boundHost}:${PORT}`);
  startLogWatcher();
  startMonitor();
  startDockerEventWatch();
  startContainerPatrol();
  startMaintenance();
  warnIfHostGpuUnconfigured();

  // 启动时自动重连之前在线的服务器
  try {
    const servers = remote.getServers();
    const toReconnect = servers.filter(s => s.status === 'connected');
    if (toReconnect.length > 0) {
      console.log(`🔄 正在重连 ${toReconnect.length} 台之前在线的服务器...`);
      await Promise.allSettled(toReconnect.map(async (s) => {
        try {
          await remote.connectServer(s.id);
          console.log(`  ✅ ${s.name} 重连成功`);
        } catch (err) {
          console.log(`  ❌ ${s.name} 重连失败: ${errorMessage(err)}`);
        }
      }));
    }
  } catch (err) {
    console.error('自动重连出错:', errorMessage(err));
  }
});


// ─── GPU 监控路由（已抽到 server/routes/gpu.js）───────────────────────────
app.use(gpuRouter);

/**
 * API 的 JSON 404 —— 必须注册在**所有**路由之后。
 *
 * 不注册的话，未匹配的 /api/* 会落到 Express 默认的 404 处理器，
 * 返回一份 HTML 错误页（`<title>Error</title>`）。前端的 apiFetch 会去
 * JSON.parse 这段 HTML，把「路径写错了」变成一句莫名其妙的解析错误。
 *
 * ⚠️ 位置很关键，踩过坑：最初把它放在 createRemoteRouter 之后，
 * 结果 /api/gpu/* 全部变成 404 —— 因为 GPU 路由是**单独挂在文件末尾**的
 * （上面这一行，甚至在 server.listen 之后）。教训是「最后一个路由」不能靠猜，
 * api.test.js 里有对应的回归测试。
 */
app.use((req, res, next) => {
  // 非 API 路径交回 Express 默认处理，保持原有行为不变
  if (!isApiPath(req.path)) return next();
  res.status(404).json({ error: `接口不存在: ${req.method} ${req.path}` });
});

// ========================================
// 周期性清理 + 优雅退出
// ========================================

// 以下 Map 的键基数没有上限，不显式清理会随进程运行时间单调增长：
//   analysisDebounce —— 键是 `${sourceId}:${消息前 120 字}`，日志内容天然不重复
//   rateLimitMap     —— 原先只有「同一 IP 在窗口过期后再次访问」才重置，换 IP 即残留
//   alertCooldowns   —— 键是 `${sourceId}_${容器名}_${错误签名}`
// （fileOffsets 在 startLogWatcher 里已有 clear()，watchers/shellSessions 在关闭路径删除，均非泄漏）
let maintenanceTimer = null;

function pruneEphemeralMaps() {
  const now = Date.now();
  let removed = 0;
  for (const [key, ts] of analysisDebounce) {
    if (now - ts > DEBOUNCE_MS) { analysisDebounce.delete(key); removed++; }
  }
  for (const [ip, record] of rateLimitMap) {
    if (now > record.resetAt) { rateLimitMap.delete(ip); removed++; }
  }
  // 冷却窗口由用户按分钟配置，这里用 24h 保守兜底
  for (const [key, ts] of alertCooldowns) {
    if (now - ts > 24 * 60 * 60 * 1000) { alertCooldowns.delete(key); removed++; }
  }
  if (removed > 0) {
    console.log(`[Maintenance] 清理 ${removed} 条过期状态 (debounce=${analysisDebounce.size} rateLimit=${rateLimitMap.size} cooldown=${alertCooldowns.size})`);
  }
}

function startMaintenance() {
  if (maintenanceTimer) clearInterval(maintenanceTimer);
  const configured = Number(process.env.OPENLOG_MAINTENANCE_INTERVAL_MS);
  const interval = Number.isFinite(configured) && configured > 0 ? configured : 60_000;
  maintenanceTimer = setInterval(pruneEphemeralMaps, interval);
  // 不要因为这个定时器而阻止进程退出
  if (maintenanceTimer.unref) maintenanceTimer.unref();
  console.log(`[Maintenance] 过期状态清理已启动，间隔 ${interval}ms`);
}

let shuttingDown = false;

async function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return; // 重复信号（Ctrl-C 连按）不重入
  shuttingDown = true;
  console.log(`\n[Shutdown] 收到 ${reason}，开始优雅退出...`);

  // 兜底：任何一步挂住都不能让进程永远不退
  const force = setTimeout(() => {
    console.error('[Shutdown] 超时未退干净，强制退出');
    process.exit(exitCode || 1);
  }, 10_000);
  if (force.unref) force.unref();

  const step = async (name, fn) => {
    try { await fn(); } catch (err) { console.error(`[Shutdown] ${name} 失败: ${errorMessage(err)}`); }
  };

  await step('停止定时器', () => {
    if (monitorInterval) { clearInterval(monitorInterval); monitorInterval = null; }
    if (patrolTimer) { clearInterval(patrolTimer); patrolTimer = null; }
    if (maintenanceTimer) { clearInterval(maintenanceTimer); maintenanceTimer = null; }
  });

  // 先关连接再关服务：keep-alive 连接会把 server.close() 的 callback 无限拖住
  await step('关闭 HTTP 服务', () => new Promise((resolve) => {
    server.close(() => resolve());
    const finish = setTimeout(resolve, 3000);
    if (finish.unref) finish.unref();
    if (typeof server.closeAllConnections === 'function') {
      const kill = setTimeout(() => server.closeAllConnections(), 2000);
      if (kill.unref) kill.unref();
    }
  }));

  await step('关闭 WebSocket', () => {
    for (const client of wss.clients) {
      try { client.terminate(); } catch { /* 连接可能已断开 */ }
    }
    wss.close();
  });

  await step('关闭文件监听', async () => {
    for (const watcher of watchers.values()) {
      try { await watcher.close(); } catch { /* 已关闭 */ }
    }
    watchers.clear();
  });

  await step('关闭 Shell 会话', () => {
    for (const session of shellSessions.values()) {
      try { session.close(); } catch { /* 会话可能已结束 */ }
    }
    shellSessions.clear();
  });

  await step('断开 SSH 连接', async () => {
    const count = await remote.disconnectAll();
    if (count) console.log(`[Shutdown] 已断开 ${count} 个 SSH 连接`);
  });

  await step('关闭数据库', () => closeDb());

  clearTimeout(force);
  console.log('[Shutdown] 完成');
  process.exit(exitCode);
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });

process.on('uncaughtException', (err) => {
  console.error('[UncaughtException]', err);

  // 权衡：监控面板是常驻进程，网络抖动不该让它下线；但**只有**可判定为
  // socket 层瞬时的错误才继续运行，其余一律退出（Node 的默认建议：
  // 未捕获异常后进程状态未定义）。
  if (isTransientNetworkError(err)) {
    console.warn(`[UncaughtException] ${err.code} 属于瞬时网络错误，继续运行（不退出）`);
    return;
  }

  void shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason) => {
  // 记录但不退出：单次异步失败不应让整个监控面板下线
  console.error('[UnhandledRejection]', reason);
});
