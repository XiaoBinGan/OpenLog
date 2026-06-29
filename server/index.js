import express from 'express';
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
import dotenv from 'dotenv';
import * as remote from './remote.js';
import * as docker from './docker.js';
import * as gpu from './gpu.js';
import { initDb, getDb, getKv, setKv, insertLogRecord, listLogRecords, listSkills, getSkill, createSkill, updateSkill, deleteSkill, getAlertConfig, upsertAlertConfig, listAlertConfigs, listMachines } from './db/index.js';

dotenv.config();

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

function authMiddleware(req, res, next) {
  if (process.env.NODE_ENV === 'production') return next();
  const ip = (req.ip || req.connection?.remoteAddress || '').replace('::ffff:', '');
  // localhost / Vite proxy 免鉴权
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return next();
  const auth = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : req.query.token;
  if (token === AUTH_TOKEN) return next();
  res.status(401).json({ error: 'Unauthorized — 需要有效的访问令牌' });
}

// ─── Settings 敏感字段加密（文件落盘用）────────────────────
const SETTINGS_ENC_KEY = crypto.scryptSync('openlog-settings-salt-v2', 'openlog-settings', 32);
const SENSITIVE_KEYS = ['openaiApiKey'];

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

// Settings 持久化文件（在项目根目录）
const SETTINGS_FILE = path.join(__dirname, '..', 'settings.json');

// 从 SQLite 加载 settings（数据库未初始化时回退到文件）
function loadSettings() {
  let db;
  try { db = getDb(); } catch {}

  // 优先从 DB 加载
  if (db) {
    try {
      const stored = getKv('app_settings');
      if (stored) return stored;
    } catch (e) {
      console.warn('[Settings] 从 DB 加载失败:', e.message);
    }
  }

  // 回退到文件
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
      const fileSettings = JSON.parse(raw);
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
      return true;
    } catch (e) {
      console.warn('[Settings] 保存到 DB 失败:', e.message);
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
    return true;
  } catch (e2) {
    console.error('[Settings] 保存到文件失败:', e2.message);
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
    console.error('[DB] 初始化失败:', err.message);
  }
}

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true }); // 关键：使用 noServer: true，避免自动处理升级

const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: '*',
}));
app.use(express.json({ limit: '10mb' }));

// 生产模式：托管前端静态文件
if (process.env.NODE_ENV === 'production') {
  const clientDist = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(clientDist));
  // SPA fallback — 所有非 API 路由返回 index.html
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/ws/')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// 简易 Rate Limiter（每 IP 每分钟 120 次）
const rateLimitMap = new Map();
app.use((req, res, next) => {
  const ip = (req.ip || req.connection?.remoteAddress || 'unknown').replace('::ffff:', '');
  // localhost 不限速
  if (ip === '127.0.0.1' || ip === '::1') return next();
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
app.get('/api/auth/token', (req, res) => {
  const ip = (req.ip || req.connection?.remoteAddress || '').replace('::ffff:', '');
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== 'localhost') {
    return res.status(403).json({ error: '仅允许本地访问' });
  }
  res.json({ token: AUTH_TOKEN });
});

// 默认 settings
const defaultSettings = {
  openaiApiKey: '',
  openaiBaseUrl: 'http://localhost:11434/v1',
  model: 'qwen3.5:9b',
  logPath: path.join(os.homedir(), 'logs'),
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
      path: path.join(os.homedir(), 'logs'),
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

// 🧠 流式思维过滤器：过滤 Qwen3 等模型的思维过程
class ThinkingStreamFilter {
  constructor() {
    this.inThinkingBlock = false;
    this.buffer = '';
  }

  _extract(buffer) {
    // 输出 thinking 之前的所有内容，并返回剩余部分
    const thinkStart = buffer.indexOf('<think');
    const textStart = buffer.indexOf("Here's a thinking");
    const entityStart = buffer.indexOf('&lt;think');

    if (!this.inThinkingBlock) {
      // 找第一个出现的位置
      let first = -1;
      let mode = null;
      if (thinkStart !== -1 && (first === -1 || thinkStart < first)) { first = thinkStart; mode = 'xml'; }
      if (textStart !== -1 && (first === -1 || textStart < first)) { first = textStart; mode = 'text'; }
      if (entityStart !== -1 && (first === -1 || entityStart < first)) { first = entityStart; mode = 'entity'; }

      if (mode === null) {
        // 还没看到开始标签，保留全部内容供下次处理
        this.buffer = buffer;
        return { output: '', remaining: '' };
      }

      // 输出开始标签之前的内容
      const output = buffer.slice(0, first);
      this.buffer = buffer.slice(first);
      this.inThinkingBlock = true;
      return { output, remaining: this.buffer };
    }

    // 已在思维块内，找结束标记
    const thinkEnd = buffer.indexOf('</think>');
    const textEnd = buffer.indexOf('');
    const entityEnd = buffer.indexOf('&lt;/think&gt;');

    let endIdx = -1;
    let endLen = 0;
    if (thinkEnd !== -1 && (endIdx === -1 || thinkEnd < endIdx)) { endIdx = thinkEnd; endLen = 8; }
    if (textEnd !== -1 && (endIdx === -1 || textEnd < endIdx)) { endIdx = textEnd; endLen = 8; }
    if (entityEnd !== -1 && (endIdx === -1 || entityEnd < endIdx)) { endIdx = entityEnd; endLen = 13; }

    if (endIdx === -1) {
      this.buffer = buffer;
      return { output: '', remaining: '' };
    }

    // 结束标记之后的内容才是输出
    const afterEnd = buffer.slice(endIdx + endLen);
    this.buffer = '';
    this.inThinkingBlock = false;
    return { output: afterEnd, remaining: afterEnd };
  }

  feed(content) {
    if (ensureSettings().thinkingEnabled) return content;
    if (!content) return '';

    const { output } = this._extract(this.buffer + content);
    return output;
  }

  flush() {
    if (ensureSettings().thinkingEnabled) return '';
    // 如果还有残留但未到结束标记，尝试提取最后一行有意义内容
    const lastNewline = this.buffer.lastIndexOf('\n');
    const lastPart = this.buffer.slice(lastNewline + 1).trim();
    this.buffer = '';
    this.inThinkingBlock = false;
    if (lastPart && lastPart.length < 100 && /[\u4e00-\u9fa5a-zA-Z0-9]/.test(lastPart)) {
      return lastPart;
    }
    return '';
  }
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
    console.error(`[${sourceId}] Read error: ${err.message}`);
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

  if (!fs.existsSync(logDir)) {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      console.log(`[${source.id}] Created directory: ${logDir}`);
    } catch (err) {
      console.error(`[${source.id}] Failed to create directory: ${err.message}`);
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
      console.error(`[${source.id}] Watcher error: ${err.message}`);
    });

    watchers.set(source.id, watcher);
    console.log(`[${source.id}] 🚀 开始监听: ${logDir} (${pattern})`);
  } catch (err) {
    console.error(`[${source.id}] Failed to start watcher: ${err.message}`);
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
        console.warn('[DB] 日志持久化失败:', err.message);
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
    console.error(`[${sourceId}] 分析失败: ${err.message}`);

    // 存入历史
    const record = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      sourceId,
      sourceName: source?.name || sourceId,
      log: errorLog,
      analysis: null,
      status: 'error',
      error: err.message,
      model
    };
    addAnalysisRecord(record);

    broadcast({
      type: 'ai_analysis',
      status: 'error',
      message: `分析失败: ${err.message}`,
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
    if (rs.status === 'online') {
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
    console.error('[Patrol] 巡检异常:', err.message);
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
    console.error(`[Alert] 处理告警异常 (${result.sourceName}/${result.containerName}):`, err.message);
  }
}

function restartContainerPatrol() {
  if (patrolTimer) clearInterval(patrolTimer);
  docker.resetPatrolCheckpoints();
  startContainerPatrol();
}

// API Routes

// Get logs
app.get('/api/logs', (req, res) => {
  const { level, source, search, limit = 100, offset = 0 } = req.query;
  
  let result = [...logs];
  
  if (level) {
    result = result.filter(log => log.level === level);
  }
  
  if (source) {
    result = result.filter(log => log.source === source);
  }
  
  if (search) {
    const searchLower = search.toLowerCase();
    result = result.filter(log => log.message.toLowerCase().includes(searchLower));
  }
  
  const total = result.length;
  result = result.slice(parseInt(offset), parseInt(offset) + parseInt(limit));
  
  res.json({ logs: result, total });
});

// 获取持久化历史日志（从数据库）
app.get('/api/logs/history', async (req, res) => {
  try {
    const { machine_id, severity, limit = 200, offset = 0, startDate, endDate } = req.query;
    
    const records = listLogRecords({ machine_id, severity, limit: parseInt(limit), offset: parseInt(offset) });
    
    // 可选：按时间范围过滤
    let filtered = records;
    if (startDate) {
      const startTs = Math.floor(new Date(startDate).getTime() / 1000);
      filtered = filtered.filter(r => r.timestamp >= startTs);
    }
    if (endDate) {
      const endTs = Math.floor(new Date(endDate).getTime() / 1000);
      filtered = filtered.filter(r => r.timestamp <= endTs);
    }
    
    res.json({ logs: filtered, total: filtered.length, source: 'database' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 清理过期持久化日志
app.delete('/api/logs/history', async (req, res) => {
  try {
    const { maxAgeDays } = req.query;
    const days = parseInt(maxAgeDays) || ensureSettings().logPersistenceMaxAge || 7;
    const cutoffTs = Math.floor(Date.now() / 1000) - days * 86400;
    
    const db = getDb();
    const result = db.run(`DELETE FROM log_records WHERE timestamp < ?`, cutoffTs);
    
    res.json({ deleted: result.changes, cutoffDate: new Date(cutoffTs * 1000).toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get available Ollama models
app.get('/api/models/ollama', async (req, res) => {
  try {
    const baseUrl = ensureSettings().openaiBaseUrl || 'http://localhost:11434/v1';
    
    // Only work with Ollama local endpoint
    if (!baseUrl.includes('localhost') && !baseUrl.includes('127.0.0.1')) {
      return res.json({ models: [], error: '仅支持本地 Ollama' });
    }
    
    const response = await fetch(`${baseUrl.replace('/v1', '')}/api/tags`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json();
    const models = data.models?.map(m => m.name) || [];
    res.json({ models });
  } catch (err) {
    res.json({ models: [], error: err.message });
  }
});

// Analyze logs with AI
app.post('/api/logs/analyze', async (req, res) => {
  console.log('[AI] 收到分析请求');
  const { logs: analyzeLogs, prompt } = req.body;
  
  const apiKey = ensureSettings().openaiApiKey;
  const baseUrl = ensureSettings().openaiBaseUrl || 'http://localhost:11434/v1';
  const model = ensureSettings().model || 'qwen3.5:9b';
  console.log('[AI] 配置:', { baseUrl, model, apiKey: apiKey ? '[已设置]' : '[未设置]' });
  
  // 本地模型（Ollama/LM Studio）可能不需要 API Key
  const isLocalModel = baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1') || baseUrl.includes('0.0.0.0');
  
  // 如果 baseUrl 已配置，用户可选择是否需要 API Key
  // 只有未配置 baseUrl 且不是本地模型时才强制要求 API Key
  const baseUrlConfigured = baseUrl && baseUrl !== 'http://localhost:11434/v1';
  if (!apiKey && !isLocalModel && !baseUrlConfigured) {
    return res.status(400).json({ error: 'API Key 未配置。请在设置页面配置 API Key，或使用本地模型。' });
  }
  
  if (!model) {
    return res.status(400).json({ error: '模型未配置。请在设置页面选择模型。' });
  }
  
  try {
    console.log('[AI] 开始调用 API...');
    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({ 
      apiKey: apiKey || (isLocalModel ? 'ollama' : 'sk-dummy'),  // 本地模型用 ollama，远程用占位符
      baseURL: baseUrl 
    });
    
    const analysisPrompt = prompt || `你是一个专业的运维工程师和日志分析专家。请分析以下日志，找出可能存在的问题并提供修复建议。

请按以下格式输出分析结果：
## 🔍 分析摘要
[简要说明发现了什么问题]

## ⚠️ 发现的问题
1. [问题1描述]
2. [问题2描述]
...

## 💡 修复建议
1. [建议1]
2. [建议2]
...

## 📊 日志统计
- 总日志数: ${analyzeLogs.length}
- ERROR: ${analyzeLogs.filter(l => l.level === 'ERROR').length}
- WARN: ${analyzeLogs.filter(l => l.level === 'WARN' || l.level === 'WARNING').length}
- INFO: ${analyzeLogs.filter(l => l.level === 'INFO').length}

以下是需要分析的日志：
${analyzeLogs.map(l => `[${l.timestamp}] [${l.level}] ${l.message}`).join('\n')}`;

    const response = await openai.chat.completions.create({
      model,
      messages: [{ role: 'user', content: analysisPrompt }],
      temperature: 0.7
    });
    
    let analysisResult = response.choices[0].message.content || '';
    // 过滤思维过程（支持多种格式）
    // 1. XML 标签格式（部分模型）
    analysisResult = analysisResult
      .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
      .replace(/&lt;think\b[^&]*&gt;[\s\S]*?&lt;\/think&gt;/gi, '');
    
    // 2. "Here's a thinking process" 文本格式（Qwen3 等）
    // 找到思维过程结束标记后的实际分析内容
    const thinkEndPatterns = [
      /\n\*\[Output Generation\][\s\S]*$/,  // Output Generation 标记
      /\n\*\(Done\.\)[\s\S]*$/,            // (Done.) 标记
      /\n\*\*\[Done\]\*\*[\s\S]*$/       // [Done] 标记
    ];
    
    if (analysisResult.includes("Here's a thinking process") || analysisResult.includes("Here's a thinking")) {
      // 找到分析摘要开始的标记
      const analysisStart = analysisResult.indexOf('## 🔍');
      if (analysisStart !== -1) {
        analysisResult = analysisResult.substring(analysisStart).trim();
      } else {
        // 如果没找到摘要标记，尝试从其他结束标记后提取
        for (const pattern of thinkEndPatterns) {
          const match = analysisResult.match(pattern);
          if (match) {
            const endIndex = match.index;
            const remaining = analysisResult.substring(endIndex + match[0].length).trim();
            if (remaining.startsWith('## ')) {
              analysisResult = remaining;
              break;
            }
          }
        }
      }
    }
    
    res.json({ analysis: analysisResult });
  } catch (err) {
    console.error('AI Analysis error:', err);
    
    // 更友好的错误信息
    let errorMsg = err.message;
    if (err.code === 'ECONNREFUSED') {
      errorMsg = '无法连接到 API 服务器。请检查服务是否已启动。';
    } else if (err.status === 401) {
      errorMsg = 'API Key 无效或已过期。请检查配置。';
    } else if (err.status === 404) {
      errorMsg = 'API 端点不存在或模型不可用。请检查 Base URL 和模型名称。';
    } else if (err.status === 429) {
      errorMsg = 'API 请求频率超限。请稍后重试。';
    }
    
    res.status(500).json({ error: errorMsg });
  }
});

// AI 修复代码（需要三次确认）
app.post('/api/logs/fix', async (req, res) => {
  const { errorLog, codeContext, filePath } = req.body;
  
  const apiKey = ensureSettings().openaiApiKey;
  const baseUrl = ensureSettings().openaiBaseUrl || 'http://localhost:11434/v1';
  const model = ensureSettings().model || 'qwen3.5:9b';
  
  const isLocalModel = baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1');
  
  if (!apiKey && !isLocalModel) {
    return res.status(400).json({ error: 'API Key 未配置' });
  }
  
  try {
    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({ 
      apiKey: apiKey || 'sk-dummy',
      baseURL: baseUrl 
    });
    
    const fixPrompt = `你是一个专业的全栈开发工程师。当用户报告错误时，你需要：
1. 分析错误信息，找出问题的根本原因
2. 定位可能出错的代码位置（基于错误类型和堆栈）
3. 提供具体的修复代码

错误信息：
${errorLog}

${codeContext ? `相关代码上下文：\n${codeContext}` : ''}
${filePath ? `可能相关的文件：${filePath}` : ''}

请按以下格式输出：
## 🎯 问题分析
[分析错误原因]

## 📍 可能位置
[基于错误类型推测的可能出错位置]

## 🔧 修复代码
\`\`\`javascript
// 修复后的代码
\`\`\`

## ⚠️ 注意事项
[如果适用，说明为什么这样修复，以及可能的副作用]`;

    const response = await openai.chat.completions.create({
      model,
      messages: [{ role: 'user', content: fixPrompt }],
      temperature: 0.3
    });
    
    res.json({ 
      fix: response.choices[0].message.content,
      warning: '⚠️ 重要：在应用任何修复前，请务必备份原文件并在测试环境验证！'
    });
  } catch (err) {
    console.error('AI Fix error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Clear logs
app.delete('/api/logs', (req, res) => {
  logs.length = 0;
  res.json({ success: true });
});

// Monitor stats
app.get('/api/monitor/stats', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  try {
    const [cpu, mem, disks, network, processes] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.networkStats(),
      si.processes()
    ]);

    // GPU via nvidia-smi
    let gpus = [];
    try {
      const { execSync } = require('child_process');
      const out = execSync(
        'nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>/dev/null',
        { timeout: 3000 }
      );
      gpus = out.toString().trim().split('\n').filter(Boolean).map(line => {
        const [idx, name, util, memUsed, memTotal, temp] = line.split(',').map(s => s.trim());
        return {
          index: parseInt(idx) || 0,
          name: name || '',
          util: parseFloat(util) || 0,
          memUsed: parseFloat(memUsed) || 0,
          memTotal: parseFloat(memTotal) || 1,
          temp: parseFloat(temp) || 0,
        };
      });
    } catch {}

    // 容器内 nvidia-smi 不可用，SSH 到宿主机查询
    if (gpus.length === 0 && process.env.NODE_ENV === 'production') {
      try {
        const { execSync } = await import('child_process');
        const out = execSync(
          'sshpass -p Supremind0717- ssh -o StrictHostKeyChecking=no -o ConnectTimeout=3 -p 40022 smai@127.0.0.1 "nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits" 2>/dev/null',
          { timeout: 5000, encoding: 'utf8' }
        ).trim();
        if (out) {
          gpus = out.split('\n').filter(Boolean).map(line => {
            const [idx, name, util, memUsed, memTotal, temp] = line.split(',').map(s => s.trim());
            return { index: parseInt(idx)||0, name, util: parseFloat(util)||0,
              memUsed: parseInt(memUsed)||0, memTotal: parseInt(memTotal)||0,
              temp: parseFloat(temp)||0, processes: [] };
          });
        }
      } catch {}
    }

    res.json({
      cpu: { load: cpu.currentLoad || 0, cores: cpu.cpus.map(c => c.load) },
      memory: { used: mem.used || 0, total: mem.total || 1, free: mem.free || 0 },
      disk: disks.map(d => ({ name: d.fs, used: d.used, total: d.size, usePercent: d.use })),
      network: network.map(n => ({ iface: n.iface, rx: n.rx_sec, tx: n.tx_sec })),
      processes: processes.list.slice(0, 10).map(p => ({ pid: p.pid, name: p.name, cpu: p.cpu, mem: p.mem })),
      gpus,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Monitor history
app.get('/api/monitor/history', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  const { limit = 100 } = req.query;
  const result = monitorHistory.slice(0, parseInt(limit));
  res.json(result);
});

// Settings
app.get('/api/settings', (req, res) => {
  const settings = ensureSettings();
  // 敏感字段脱敏
  const sanitized = { ...settings };
  if (sanitized.openaiApiKey && sanitized.openaiApiKey.length > 8) {
    sanitized.openaiApiKey = sanitized.openaiApiKey.slice(0, 4) + '***' + sanitized.openaiApiKey.slice(-4);
  }
  res.json(sanitized);
});

app.put('/api/settings', (req, res) => {
  const updates = req.body;

  const currentSettings = ensureSettings();
  for (const [key, value] of Object.entries(updates)) {
    // 拒绝保存脱敏后的敏感字段（含 *** 占位符）
    if (SENSITIVE_KEYS.includes(key) && typeof value === 'string' && value.includes('***') && value.length < 30) {
      continue;
    }
    currentSettings[key] = value;
  }

  // 持久化到文件
  saveSettings(ensureSettings());

  // 重启日志监控（watchSources 变化）
  if (updates.watchSources || updates.logPath || updates.watchFiles) {
    startLogWatcher();
  }

  // 重置 Docker 连接池（dockerSources 变化）
  if (updates.dockerSources) {
    // docker.js 里的 dockerInstances 是导出的 Map
    if (docker.dockerInstances) {
      docker.dockerInstances.forEach((_, k) => docker.dockerInstances.delete(k));
    }
    restartDockerEventWatch();
    restartContainerPatrol();
  }

  if (updates.dockerEventNotify !== undefined) {
    restartDockerEventWatch();
  }

  if (updates.containerPatrolEnabled !== undefined || updates.containerPatrolInterval !== undefined || updates.containerPatrolLevels !== undefined) {
    restartContainerPatrol();
  }

  if (updates.refreshInterval) {
    startMonitor();
  }

  res.json({ success: true, settings });
});

// ============================================================
// 自定义技能 (Skills) API
// ============================================================

// 获取所有技能
app.get('/api/skills', (req, res) => {
  try {
    const skills = listSkills();
    res.json({ skills });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 创建技能
app.post('/api/skills', (req, res) => {
  const { name, command, description, content, category, is_default } = req.body;
  if (!name || !command) return res.status(400).json({ error: 'name and command required' });

  try {
    const skill = { id: uuidv4(), name, command, description, content, category, is_default };
    createSkill(skill);
    res.json({ success: true, skill });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 更新技能
app.put('/api/skills/:id', (req, res) => {
  const { name, command, description, content, category } = req.body;
  if (!name || !command) return res.status(400).json({ error: 'name and command required' });

  try {
    const existing = getSkill(req.params.id);
    if (!existing) return res.status(404).json({ error: '技能不存在' });
    if (existing.is_default) return res.status(403).json({ error: '内置技能不允许修改' });

    updateSkill(req.params.id, { name, command, description, content, category });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 删除技能
app.delete('/api/skills/:id', (req, res) => {
  try {
    const existing = getSkill(req.params.id);
    if (!existing) return res.status(404).json({ error: '技能不存在' });
    if (existing.is_default) return res.status(403).json({ error: '内置技能不允许删除' });

    deleteSkill(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 机器列表 & 告警配置 API
// ============================================================

// 获取所有机器列表
app.get('/api/machines', (req, res) => {
  try {
    const machines = listMachines();
    res.json({ machines });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取所有告警配置
app.get('/api/alerts', (req, res) => {
  try {
    const configs = listAlertConfigs();
    res.json({ configs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 保存/更新告警配置
app.put('/api/alerts', (req, res) => {
  const { machine_id, enabled, patterns, severity_filter, cooldown_minutes, webhook_url } = req.body;
  if (!machine_id) return res.status(400).json({ error: 'machine_id is required' });

  try {
    const existing = getAlertConfig(machine_id);
    const config = {
      id: existing?.id || uuidv4(),
      machine_id,
      enabled: enabled !== undefined ? enabled : true,
      patterns: patterns || '',
      severity_filter: severity_filter || 'ERROR',
      cooldown_minutes: cooldown_minutes !== undefined ? cooldown_minutes : 5,
      webhook_url: webhook_url || '',
    };
    upsertAlertConfig(config);
    res.json({ success: true, config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 日志分析状态 API
// ============================================================

// 查询所有服务分析队列状态
app.get('/api/analysis/status', (req, res) => {
  const result = {};
  analysisQueues.forEach((q, sourceId) => {
    result[sourceId] = {
      pending: q.pending.length,
      running: q.running
    };
  });
  res.json({ queues: result, totalPending: [...analysisQueues.values()].reduce((s, q) => s + q.pending.length, 0) });
});

// 主动触发某服务的分析（POST body: { message, sourceId }）
app.post('/api/analysis/trigger', async (req, res) => {
  const { message, sourceId = 'manual', sourceName = '手动触发' } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  const log = {
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    level: 'ERROR',
    message,
    source: sourceName,
    sourceId,
    metadata: JSON.stringify({ manual: true })
  };

  const source = { id: sourceId, name: sourceName, autoAnalysis: true };
  enqueueAnalysis(log, source);

  res.json({ success: true, message: '已加入分析队列', log });
});

// 获取分析历史记录
app.get('/api/analysis/history', (req, res) => {
  const { sourceId, status, limit = 50, offset = 0 } = req.query;
  let result = [...analysisHistory];
  if (sourceId) result = result.filter(r => r.sourceId === sourceId);
  if (status) result = result.filter(r => r.status === status);
  const total = result.length;
  result = result.slice(parseInt(offset), parseInt(offset) + parseInt(limit));
  res.json({ records: result, total });
});

// 分析历史摘要（供 @ 提及选择）
app.get('/api/analysis/history/brief', (_req, res) => {
  const brief = analysisHistory.slice(0, 30).map(r => ({
    id: r.id,
    timestamp: r.timestamp,
    type: r.type || 'log',
    sourceName: r.sourceName,
    summary: (r.summary || r.log?.message || '').slice(0, 120),
    status: r.status,
    model: r.model,
  }));
  res.json({ records: brief });
});

// 删除单条分析历史
app.delete('/api/analysis/history/:id', (req, res) => {
  const idx = analysisHistory.findIndex(r => r.id === req.params.id);
  if (idx !== -1) { analysisHistory.splice(idx, 1); res.json({ success: true }); }
  else { res.status(404).json({ error: '记录不存在' }); }
});

// 清空分析历史
app.delete('/api/analysis/history', (req, res) => {
  analysisHistory.length = 0;
  res.json({ success: true });
});

// ============================================================
// 运维助手内存文件 API
// ============================================================
const ASSISTANT_MEMORY_DIR = path.join(__dirname, '..', 'assistant_memory');
if (!fs.existsSync(ASSISTANT_MEMORY_DIR)) fs.mkdirSync(ASSISTANT_MEMORY_DIR, { recursive: true });

app.get('/api/assistant/memory', (req, res) => {
  try {
    const files = fs.readdirSync(ASSISTANT_MEMORY_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const filePath = path.join(ASSISTANT_MEMORY_DIR, f);
        const stat = fs.statSync(filePath);
        return {
          name: f.replace(/\.md$/, ''),
          path: filePath,
          content: fs.readFileSync(filePath, 'utf8'),
          updatedAt: stat.mtimeMs,
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/assistant/memory', (req, res) => {
  const { name, content } = req.body;
  if (!name || content === undefined) return res.status(400).json({ error: 'name and content required' });
  const safeName = name.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, '-').replace(/\.md$/, '') + '.md';
  const filePath = path.join(ASSISTANT_MEMORY_DIR, safeName);
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    res.json({ success: true, name: safeName });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/assistant/memory/:name', (req, res) => {
  const filePath = path.join(ASSISTANT_MEMORY_DIR, req.params.name + '.md');
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

// ─── 运维助手 Tool Calling ──────────────────────────────────────────

const ASSISTANT_TOOLS = [
  // ── Docker 工具 ──
  { type: 'function', function: { name: 'docker_list', description: '列出所有Docker容器（运行状态、镜像名、端口映射、退出码等）', parameters: { type: 'object', properties: { sourceId: { type: 'string', description: 'Docker源ID（可选，不传则列出所有源）' } } } } },
  { type: 'function', function: { name: 'docker_logs', description: '读取指定容器的日志（最近N行）', parameters: { type: 'object', properties: { containerId: { type: 'string', description: '容器ID（12位短ID）或名称' }, sourceId: { type: 'string', description: 'Docker源ID（可选）' }, tail: { type: 'number', description: '读取最后N行，默认200' } }, required: ['containerId'] } } },
  { type: 'function', function: { name: 'docker_inspect', description: '查看容器详细信息（状态、端口、环境变量、挂载卷、网络）', parameters: { type: 'object', properties: { containerId: { type: 'string', description: '容器ID或名称' }, sourceId: { type: 'string', description: 'Docker源ID（可选）' } }, required: ['containerId'] } } },
  { type: 'function', function: { name: 'docker_start', description: '⚠️ 启动一个已停止的容器。需要用户确认后才能调用。', parameters: { type: 'object', properties: { containerId: { type: 'string' }, sourceId: { type: 'string' } }, required: ['containerId'] } } },
  { type: 'function', function: { name: 'docker_stop', description: '⚠️ 停止一个运行中的容器。需要用户确认后才能调用。', parameters: { type: 'object', properties: { containerId: { type: 'string' }, sourceId: { type: 'string' } }, required: ['containerId'] } } },
  { type: 'function', function: { name: 'docker_restart', description: '⚠️ 重启容器。需要用户确认后才能调用。', parameters: { type: 'object', properties: { containerId: { type: 'string' }, sourceId: { type: 'string' } }, required: ['containerId'] } } },
  { type: 'function', function: { name: 'docker_exec', description: '⚠️ 在容器内执行命令。需要用户确认后才能调用。', parameters: { type: 'object', properties: { containerId: { type: 'string' }, command: { type: 'string', description: '要执行的命令' }, sourceId: { type: 'string' } }, required: ['containerId', 'command'] } } },
  { type: 'function', function: { name: 'docker_health_check', description: '执行所有容器健康诊断（检查退出状态、OOM、异常退出等）', parameters: { type: 'object', properties: {} } } },
  // ── 远程服务器工具 ──
  { type: 'function', function: { name: 'remote_servers', description: '列出已配置的远程服务器及其连接状态', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'remote_exec', description: '⚠️ 在远程服务器执行Shell命令。需要用户确认后才能调用。', parameters: { type: 'object', properties: { serverId: { type: 'string', description: '服务器ID' }, command: { type: 'string', description: 'Shell命令' } }, required: ['serverId', 'command'] } } },
  { type: 'function', function: { name: 'remote_system_stats', description: '获取远程服务器系统状态（CPU/内存/磁盘/网络/进程/GPU）', parameters: { type: 'object', properties: { serverId: { type: 'string' } }, required: ['serverId'] } } },
  { type: 'function', function: { name: 'remote_list_files', description: '列出远程服务器的日志文件目录', parameters: { type: 'object', properties: { serverId: { type: 'string' }, path: { type: 'string', description: '目录路径（可选，默认服务器配置的日志目录）' } }, required: ['serverId'] } } },
  { type: 'function', function: { name: 'remote_read_file', description: '读取远程服务器上的日志文件内容', parameters: { type: 'object', properties: { serverId: { type: 'string' }, filePath: { type: 'string' }, lines: { type: 'number', description: '读取最后N行，默认200' } }, required: ['serverId', 'filePath'] } } },
  { type: 'function', function: { name: 'remote_search_logs', description: '在远程服务器日志中搜索关键词', parameters: { type: 'object', properties: { serverId: { type: 'string' }, search: { type: 'string', description: '搜索关键词' } }, required: ['serverId', 'search'] } } },
  // ── 本地工具 ──
  { type: 'function', function: { name: 'local_system_stats', description: '获取本机（OpenLog所在服务器）系统状态：CPU/内存/磁盘/网络/进程/GPU', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'local_log_files', description: '列出本地日志文件', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'local_read_log', description: '读取本地日志文件内容', parameters: { type: 'object', properties: { filePath: { type: 'string' }, lines: { type: 'number', description: '读取最后N行，默认200' } }, required: ['filePath'] } } },
];

const DANGEROUS_TOOLS = new Set(['docker_start', 'docker_stop', 'docker_restart', 'docker_exec', 'remote_exec']);

/** 执行工具调用，返回结果对象 */
async function executeAssistantTool(name, args) {
  const settings = ensureSettings();
  const dockerSources = settings.dockerSources || [];

  // 辅助：根据 sourceId 获取 Docker 配置
  const getDockerConfig = (sourceId) => {
    const src = sourceId ? dockerSources.find(s => s.id === sourceId) : dockerSources.find(s => s.enabled);
    if (!src) throw new Error('未找到可用的 Docker 源');
    return { sourceId: src.id, config: { socketPath: src.socketPath || undefined, host: src.socketPath ? undefined : (src.host || 'localhost'), port: src.socketPath ? undefined : (src.port || 2375), tls: src.tls, ca: src.ca, cert: src.cert, key: src.key } };
  };

  try {
    switch (name) {
      // ── Docker ──
      case 'docker_list': {
        if (args.sourceId) {
          const { sourceId, config } = getDockerConfig(args.sourceId);
          const containers = await docker.listContainers(sourceId, config);
          return { containers, sourceId, total: containers.length };
        }
        const all = [];
        for (const src of dockerSources.filter(s => s.enabled)) {
          try {
            const config = { socketPath: src.socketPath || undefined, host: src.socketPath ? undefined : (src.host || 'localhost'), port: src.socketPath ? undefined : (src.port || 2375), tls: src.tls, ca: src.ca, cert: src.cert, key: src.key };
            const containers = await docker.listContainers(src.id, config);
            all.push({ sourceId: src.id, sourceName: src.name, containers });
          } catch (e) { all.push({ sourceId: src.id, sourceName: src.name, error: e.message, containers: [] }); }
        }
        return { sources: all, totalSources: all.length };
      }
      case 'docker_logs': {
        const dc = getDockerConfig(args.sourceId);
        const logs = await docker.getContainerLogs(dc.sourceId, args.containerId, dc.config, { tail: args.tail || 200 });
        const logLines = (logs || []).slice(-(args.tail || 200));
        return { containerId: args.containerId, totalLines: logLines.length, logs: logLines };
      }
      case 'docker_inspect': {
        const dc = getDockerConfig(args.sourceId);
        const containers = await docker.listContainers(dc.sourceId, dc.config);
        const c = containers.find(x => x.id === args.containerId || x.shortId === args.containerId || (x.names || []).some(n => n.includes(args.containerId)));
        if (!c) return { error: `容器 ${args.containerId} 未找到` };
        return { container: c };
      }
      case 'docker_start': {
        const dc = getDockerConfig(args.sourceId);
        const r = await docker.startContainer(dc.sourceId, args.containerId, dc.config);
        return r;
      }
      case 'docker_stop': {
        const dc = getDockerConfig(args.sourceId);
        const r = await docker.stopContainer(dc.sourceId, args.containerId, dc.config);
        return r;
      }
      case 'docker_restart': {
        const dc = getDockerConfig(args.sourceId);
        const r = await docker.restartContainer(dc.sourceId, args.containerId, dc.config);
        return r;
      }
      case 'docker_exec': {
        const dc = getDockerConfig(args.sourceId);
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
          try { await remote.connectServer(args.serverId); } catch (e) { return { error: `连接失败: ${e.message}` }; }
        }
        const r = await remote.execRemoteCommand(args.serverId, args.command);
        return r;
      }
      case 'remote_system_stats': {
        const servers = remote.getServers();
        const s = servers.find(x => x.id === args.serverId);
        if (!s) return { error: `服务器 ${args.serverId} 未找到` };
        if (s.status !== 'connected') {
          try { await remote.connectServer(args.serverId); } catch (e) { return { error: `连接失败: ${e.message}` }; }
        }
        const r = await remote.getRemoteSystemStats(args.serverId);
        return r;
      }
      case 'remote_list_files': {
        const servers = remote.getServers();
        const s = servers.find(x => x.id === args.serverId);
        if (!s) return { error: `服务器 ${args.serverId} 未找到` };
        if (s.status !== 'connected') {
          try { await remote.connectServer(args.serverId); } catch (e) { return { error: `连接失败: ${e.message}` }; }
        }
        const r = await remote.listRemoteFiles(args.serverId, args.path || '');
        return r;
      }
      case 'remote_read_file': {
        const servers = remote.getServers();
        const s = servers.find(x => x.id === args.serverId);
        if (!s) return { error: `服务器 ${args.serverId} 未找到` };
        if (s.status !== 'connected') {
          try { await remote.connectServer(args.serverId); } catch (e) { return { error: `连接失败: ${e.message}` }; }
        }
        const r = await remote.readRemoteFile(args.serverId, args.filePath, { lines: args.lines || 200 });
        return r;
      }
      case 'remote_search_logs': {
        const servers = remote.getServers();
        const s = servers.find(x => x.id === args.serverId);
        if (!s) return { error: `服务器 ${args.serverId} 未找到` };
        if (s.status !== 'connected') {
          try { await remote.connectServer(args.serverId); } catch (e) { return { error: `连接失败: ${e.message}` }; }
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
    return { error: err.message };
  }
}

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages required' });
  }

  const settings = ensureSettings();
  const apiKey = settings.openaiApiKey;
  const baseUrl = settings.openaiBaseUrl || 'http://localhost:11434/v1';
  const model = settings.model;
  const isLocalModel = baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1') || baseUrl.includes('0.0.0.0');
  const baseUrlConfigured = baseUrl && baseUrl !== 'http://localhost:11434/v1';
  
  if (!apiKey && !isLocalModel && !baseUrlConfigured) {
    return res.status(400).json({ error: '未配置 API Key 或 Base URL' });
  }
  if (!model) return res.status(400).json({ error: '未配置模型' });

  // 汇总工具可用的资源上下文
  const dockerSources = settings.dockerSources || [];
  const enabledDocker = dockerSources.filter(s => s.enabled);
  const remoteServers = remote.getServers();
  const connectedRemote = remoteServers.filter(s => s.status === 'connected');

  const systemPrompt = {
    role: 'system',
    content: `你是 OpenLog 的运维助手，帮用户排查服务器、Docker 容器、日志异常、性能问题。
风格：简洁有力，像老运维跟同事说话，不啰嗦不念经。用中文。
格式：关键结论加粗，代码用 \`\`\` 包裹，操作步骤编号列出。

## 🔧 你可以直接调用的工具
- docker_list / docker_logs / docker_inspect / docker_health_check — 查询容器状态
- remote_servers / remote_system_stats / remote_exec / remote_list_files / remote_read_file / remote_search_logs — 远程服务器操作
- local_system_stats / local_log_files / local_read_log — 本机操作

## 📌 任务执行原则
1. **持续追踪**：收到任务后，要主动调用工具获取信息，不要等用户推一步走一步。
2. **工具失败时换方案**：如果一个工具不可用（如 Docker 源断开），立刻尝试替代方案（如通过远程服务器 ssh 执行 docker 命令，或查看本机日志）。
3. **给出结论**：收集足够信息后，给出明确的诊断结论和可操作的建议，不要只说"让我看看"。
4. **记住上下文**：结合对话历史中的巡检报告、分析结果继续深入，不要重复已经做过的事。

## ⚠️ 危险操作安全规则
对**启动/停止/重启/删除容器、在容器或远程服务器执行命令**的操作：
1. 先说清楚你要做什么、为什么
2. 明确说"确认执行吗？"等待用户同意
3. 用户说"确认"/"好的"/"行"/"执行"后才调用工具

## 📋 当前环境
- Docker 源: ${enabledDocker.length > 0 ? enabledDocker.map(s => s.name).join('、') : '无'}
- 远程服务器: ${connectedRemote.length > 0 ? connectedRemote.map(s => `${s.name}(${s.id.slice(0,8)})`).join('、') : (remoteServers.length > 0 ? `${remoteServers.length}台(均未连接)` : '无')}

## 最近的系统状态
${buildAssistantContext()}`
  };

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({ apiKey: apiKey || (isLocalModel ? 'ollama' : 'sk-dummy'), baseURL: baseUrl });

    // 消息历史（会在 tool calling 循环中更新）
    const allMessages = [
      systemPrompt,
      ...messages.filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'tool')
    ];

    // ── Tool Calling 循环（最多 5 轮）──
    let toolRound = 0;
    const MAX_TOOL_ROUNDS = 5;

    while (toolRound < MAX_TOOL_ROUNDS) {
      toolRound++;

      const streamParams = {
        model,
        messages: allMessages,
        stream: true,
        max_tokens: 4096,
        tools: ASSISTANT_TOOLS,
        tool_choice: 'auto',
      };
      if (isLocalModel) streamParams.temperature = 0.7;

      const stream = await openai.chat.completions.create(streamParams);

      // 累积流式输出：content + tool_calls
      let contentAcc = '';
      const toolCallAcc = new Map(); // index → { id, name, arguments }

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        // 文本内容 → 流式发送
        if (delta.content) {
          contentAcc += delta.content;
        }

        // 工具调用增量
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallAcc.has(idx)) toolCallAcc.set(idx, { id: tc.id || '', name: tc.function?.name || '', arguments: '' });
            const entry = toolCallAcc.get(idx);
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name = tc.function.name;
            if (tc.function?.arguments) entry.arguments += tc.function.arguments;
          }
        }
      }

      // 有工具调用 → 执行并回填
      if (toolCallAcc.size > 0) {
        const toolCalls = [...toolCallAcc.values()];

        // 先发送 LLM 说的内容（如果有）
        if (contentAcc.trim()) {
          const thinkingFilter = new ThinkingStreamFilter();
          const filtered = thinkingFilter.feed(contentAcc) + thinkingFilter.flush();
          if (filtered) res.write(`data: ${JSON.stringify({ content: filtered })}\n\n`);
        }

        // 将 assistant 消息加入历史
        const assistantMsg = {
          role: 'assistant',
          content: contentAcc || null,
          tool_calls: toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments }
          }))
        };
        allMessages.push(assistantMsg);

        // 逐个执行工具
        for (const tc of toolCalls) {
          let args = {};
          try { args = JSON.parse(tc.arguments); } catch { args = {}; }

          res.write(`data: ${JSON.stringify({ type: 'tool_start', tool: tc.name, args })}\n\n`);

          const result = await executeAssistantTool(tc.name, args);

          res.write(`data: ${JSON.stringify({ type: 'tool_result', tool: tc.name, result })}\n\n`);

          allMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(result)
          });
        }

        // 继续循环，让 LLM 基于工具结果回复
        continue;
      }

      // 无工具调用 → 流式输出最终内容
      const thinkingFilter = new ThinkingStreamFilter();
      const filtered = thinkingFilter.feed(contentAcc) + thinkingFilter.flush();
      if (filtered) res.write(`data: ${JSON.stringify({ content: filtered })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // 超过最大轮数
    res.write(`data: ${JSON.stringify({ content: '\n\n⚠️ 工具调用轮数已达上限，请简化问题重试。' })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('Chat API error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else { res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`); res.end(); }
  }
});

// Get available log files
app.get('/api/logs/files', (req, res) => {
  const logPath = ensureSettings().logPath || path.join(os.homedir(), 'logs');
  
  try {
    if (!fs.existsSync(logPath)) {
      return res.json([]);
    }
    
    const files = fs.readdirSync(logPath)
      .filter(f => f.endsWith('.log'))
      .map(f => ({
        name: f,
        path: path.join(logPath, f),
        size: fs.statSync(path.join(logPath, f)).size
      }));
    res.json(files);
  } catch (err) {
    res.json([]);
  }
});

// Generate sample logs for testing
app.post('/api/logs/generate-sample', (req, res) => {
  const levels = ['INFO', 'WARN', 'ERROR', 'DEBUG'];
  const messages = [
    'Server started on port 3000',
    'Database connection established',
    'User login successful',
    'Request processed in 145ms',
    'Cache miss for key: user_123',
    'High memory usage detected: 85%',
    'Connection timeout to database',
    'Failed to parse JSON payload',
    'Rate limit exceeded for IP 192.168.1.1',
    'Scheduled task completed successfully',
    'Memory leak detected in worker process',
    'SSL certificate expires in 7 days',
    'Disk usage above threshold: 90%',
    'API response time degraded: 2.5s'
  ];
  
  const count = Math.floor(Math.random() * 10) + 5;
  
  for (let i = 0; i < count; i++) {
    const level = levels[Math.floor(Math.random() * levels.length)];
    const message = messages[Math.floor(Math.random() * messages.length)];
    const source = ['app.log', 'access.log', 'error.log', 'system.log'][Math.floor(Math.random() * 4)];
    
    const log = {
      id: uuidv4(),
      timestamp: new Date(Date.now() - Math.random() * 3600000).toISOString(),
      level,
      message: `${message} [${Math.random().toString(36).substring(7)}]`,
      source,
      metadata: JSON.stringify({ generated: true })
    };
    
    saveLog(log);
    broadcast({ type: 'log', data: log });
  }
  
  res.json({ success: true, count });
});

// ========================================
// Docker API Routes
// ========================================

// 获取 Docker 连接状态（测试连接）
app.post('/api/docker/ping', async (req, res) => {
  const { sourceId, config } = req.body;
  console.log('[Docker ping] sourceId:', sourceId, 'config:', JSON.stringify(config));
  const result = await docker.pingDocker(sourceId || 'local', config || {});
  res.json(result);
});

// 获取所有 Docker 配置的容器列表
app.get('/api/docker/containers', async (req, res) => {
  try {
    const allContainers = [];
    const sources = ensureSettings().dockerSources || [];
    const enabled = sources.filter(s => s.enabled);

    for (const source of enabled) {
      try {
        const containers = await docker.listContainers(source.id, {
          socketPath: source.socketPath || undefined,
          host: source.socketPath ? undefined : (source.host || 'localhost'),
          port: source.socketPath ? undefined : (source.port || 2375),
          tls: source.tls,
          ca: source.ca,
          cert: source.cert,
          key: source.key,
        });
        allContainers.push({
          sourceId: source.id,
          sourceName: source.name,
          host: source.host || '',
          containers,
        });
      } catch (err) {
        allContainers.push({
          sourceId: source.id,
          sourceName: source.name,
          host: source.host || '',
          error: err.message,
          containers: [],
        });
      }
    }

    res.json({ sources: allContainers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取单个容器的详情
app.get('/api/docker/containers/:sourceId/:containerId', async (req, res) => {
  try {
    const { sourceId, containerId } = req.params;
    const source = (ensureSettings().dockerSources || []).find(s => s.id === sourceId);
    const config = source ? {
      socketPath: source.socketPath || undefined,
      host: source.socketPath ? undefined : (source.host || 'localhost'),
      port: source.socketPath ? undefined : (source.port || 2375),
      tls: source.tls,
      ca: source.ca, cert: source.cert, key: source.key,
    } : {};

    const container = await docker.getContainer(sourceId, containerId, config);
    res.json(container);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 读取容器日志
app.get('/api/docker/containers/:sourceId/:containerId/logs', async (req, res) => {
  try {
    const { sourceId, containerId } = req.params;
    const { tail = 200, since, startTime, filterLevel } = req.query;
    const source = (ensureSettings().dockerSources || []).find(s => s.id === sourceId);
    const config = source ? {
      socketPath: source.socketPath || undefined,
      host: source.socketPath ? undefined : (source.host || 'localhost'),
      port: source.socketPath ? undefined : (source.port || 2375),
      tls: source.tls,
      ca: source.ca, cert: source.cert, key: source.key,
    } : {};

    const logs = await docker.getContainerLogs(sourceId, containerId, config, {
      tail: parseInt(tail),
      since, startTime, filterLevel,
    });
    res.json({ logs, containerId, sourceId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 读取多个容器的日志（联合会诊）
app.post('/api/docker/logs/batch', async (req, res) => {
  try {
    const { containers, tail = 200 } = req.body; // containers: [{sourceId, containerId, name}]
    const results = [];

    for (const { sourceId, containerId, name } of containers) {
      try {
        const source = (ensureSettings().dockerSources || []).find(s => s.id === sourceId);
        const config = source ? {
          socketPath: source.socketPath || undefined,
          host: source.socketPath ? undefined : (source.host || "localhost"),
          port: source.socketPath ? undefined : (source.port || 2375),
          tls: source.tls,
          ca: source.ca, cert: source.cert, key: source.key,
        } : {};
        const logs = await docker.getContainerLogs(sourceId, containerId, config, { tail: parseInt(tail) });
        results.push({ sourceId, containerId, name, logs, ok: true });
      } catch (err) {
        results.push({ sourceId, containerId, name, logs: [], ok: false, error: err.message });
      }
    }

    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 上下游链路追踪
app.get('/api/docker/trace/:sourceId/:containerId', async (req, res) => {
  try {
    const { sourceId, containerId } = req.params;
    const source = (ensureSettings().dockerSources || []).find(s => s.id === sourceId);
    const config = source ? {
      socketPath: source.socketPath || undefined,
      host: source.socketPath ? undefined : (source.host || 'localhost'),
      port: source.socketPath ? undefined : (source.port || 2375),
      tls: source.tls,
      ca: source.ca, cert: source.cert, key: source.key,
    } : {};

    const trace = await docker.traceContainerLinks(sourceId, containerId, config);
    res.json(trace);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 批量分析多个容器日志（联合会诊）
app.post('/api/docker/analyze/batch', async (req, res) => {
  try {
    const { containers, prompt: customPrompt, sourceId = 'docker-batch' } = req.body;
    if (!containers || containers.length === 0) {
      return res.status(400).json({ error: '缺少容器列表' });
    }

    // 先读取所有容器的日志
    const allLogs = [];
    for (const { sourceId: sid, containerId, name } of containers) {
      try {
        const source = (ensureSettings().dockerSources || []).find(s => s.id === sid);
        const config = source ? {
          socketPath: source.socketPath || undefined,
          host: source.socketPath ? undefined : (source.host || "localhost"),
          port: source.socketPath ? undefined : (source.port || 2375),
          tls: source.tls,
          ca: source.ca, cert: source.cert, key: source.key,
        } : {};
        const logs = await docker.getContainerLogs(sid, containerId, config, { tail: 200 });
        allLogs.push({ sourceId: sid, containerId, name, logs });
      } catch (err) {
        allLogs.push({ sourceId: sid, containerId, name, logs: [], error: err.message });
      }
    }

    // 构建分析 prompt
    const logsText = allLogs.map(l =>
      `=== ${l.name} (${l.sourceId}) ===\n${l.logs.length > 0 ? l.logs.map(r => `[${r.timestamp || '-'}] [${r.level}] ${r.content}`).join('\n') : l.error || '无日志'}`
    ).join('\n\n');

    const analysisPrompt = customPrompt || `你是专业的运维工程师。以下是多个 Docker 容器的日志，请分析并找出问题根因和上下游链路关系。

${logsText}

请分析：
1. 每个服务的健康状态
2. 哪些服务出现 ERROR/异常
3. 上游服务是否正常（可能是根因）
4. 下游服务是否受影响
5. 给出修复建议，按优先级排序

回复格式（Markdown）：
## 📊 服务状态总览
[各服务状态]

## 🔍 根因分析
[一句话说明根因]

## 💡 修复建议
1. [步骤]
2. [步骤]`;

    // 异步执行分析，HTTP 先返回日志结果
    res.json({
      logs: allLogs,
      message: '日志已获取，分析中...'
    });

    // 后台执行 AI 分析
    setImmediate(async () => {
      try {
        const apiKey = ensureSettings().openaiApiKey;
        const baseUrl = ensureSettings().openaiBaseUrl || 'http://localhost:11434/v1';
        const model = ensureSettings().model;
        const isLocal = baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1');

        if (!apiKey && !isLocal) return;
        if (!model) return;

        const OpenAI = (await import('openai')).default;
        const openai = new OpenAI({ apiKey: apiKey || 'ollama', baseURL: baseUrl });

        const response = await openai.chat.completions.create({
          model,
          messages: [{ role: 'user', content: analysisPrompt }],
          temperature: 0.3,
          timeout: 90_000
        });

        const analysis = stripThinking(response.choices[0].message.content);
        broadcast({
          type: 'docker_batch_analysis',
          status: 'done',
          containers,
          analysis,
          sourceId: 'docker-batch'
        });
      } catch (err) {
        broadcast({
          type: 'docker_batch_analysis',
          status: 'error',
          containers,
          message: err.message,
          sourceId: 'docker-batch'
        });
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Docker 容器健康诊断 API ────────────────────────────
app.get('/api/docker/health-check', async (req, res) => {
  try {
    const sources = ensureSettings().dockerSources || [];
    const report = await docker.healthCheck(sources);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/docker/health-check/analyze', async (req, res) => {
  try {
    const sources = ensureSettings().dockerSources || [];
    const report = await docker.healthCheck(sources);
    const { summary, problems } = report;

    if (problems.length === 0) {
      return res.json({ analysis: '🎉 所有容器运行正常，无需诊断。\n\n' +
        `- ${summary.running} 个运行中\n- ${summary.normalExited} 个正常退出` });
    }

    const apiKey = ensureSettings().openaiApiKey;
    const baseUrl = ensureSettings().openaiBaseUrl;
    const model = ensureSettings().model;

    if (!apiKey) return res.status(400).json({ error: '未配置 API Key' });

    const problemText = problems.map(p =>
      `### ${p.name} (${p.sourceName})\n` +
      `- 镜像: ${p.image}\n` +
      `- 状态: ${p.state}\n` +
      `- 退出码: ${p.exitCode} (` +
      (p.exitType === 'oom' ? 'OOM内存溢出' : p.exitType === 'segfault' ? '段错误' : '异常退出') + `)\n` +
      `- 最近错误日志:\n${p.errors.map(l => '  ' + l).join('\n') || '  无'}`
    ).join('\n\n');

    const prompt = `你是资深运维工程师，正在进行 Docker 容器健康诊断。

## 整体概况
- 总容器: ${summary.total}
- 运行中: ${summary.running}
- OOM被杀: ${summary.oomKilled}
- 异常退出: ${summary.errorExited}
- 正常退出: ${summary.normalExited}

## 问题容器详情
${problemText}

## 诊断要求（用中文回答）：
### 🔴 紧急问题
### 📊 根因分析
### 💡 修复建议
### 🛡️ 预防措施`;

    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({ apiKey, baseURL: baseUrl });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');

    let fullAnalysis = '';

    const stream = await openai.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      max_tokens: 4096,
      temperature: 0.3
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) {
        fullAnalysis += content;
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();

    addAnalysisRecord({
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      type: 'health',
      sourceName: `健康诊断 · ${problems.length} 个问题容器`,
      analysis: fullAnalysis,
      summary: problemText.slice(0, 300),
      status: 'done',
      model
    });
  } catch (err) {
    console.error('[health-check/analyze]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else { res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`); res.end(); }

    addAnalysisRecord({
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      type: 'health',
      sourceName: '健康诊断',
      analysis: null,
      summary: '',
      status: 'error',
      error: err.message,
      model: ensureSettings().model
    });
  }
});


// ─── 容器日志巡检 API ───────────────────────────────────
// 获取最近一次巡检结果
app.get('/api/docker/patrol', (req, res) => {
  res.json({ results: lastPatrolResults, timestamp: new Date().toISOString() });
});

// 立即触发一次巡检
app.post('/api/docker/patrol/now', async (req, res) => {
  try {
    const sources = ensureSettings().dockerSources || [];
    const levels = ensureSettings().containerPatrolLevels || ['ERROR', 'FATAL'];
    const hostExecMap = buildHostExecMap();
    const results = await docker.patrolContainerLogs(sources, levels, (src) => hostExecMap.get(src.host) || null);
    if (results.length > 0) {
      lastPatrolResults = results;
    }
    broadcast({ type: 'container_patrol', data: { results, timestamp: new Date().toISOString() } });
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 重置巡检检查点（容器重启后需要调用）
app.post('/api/docker/patrol/reset', async (_req, res) => {
  docker.resetPatrolCheckpoints();
  res.json({ success: true });
});

// 获取最后一次巡检结果
app.get('/api/docker/patrol/last', async (_req, res) => {
  res.json({ results: lastPatrolResults, timestamp: lastPatrolResults.length > 0 ? new Date().toISOString() : null });
});

// AI 分析巡检结果（SSE 流式）
app.post('/api/docker/patrol/analyze', async (req, res) => {
  try {
    // 直接用缓存结果；如果没数据说明还没有异常日志
    let results = lastPatrolResults;
    if (!results || results.length === 0) {
      return res.status(400).json({ error: '暂无异常日志' });
    }

    const apiKey = ensureSettings().openaiApiKey;
    const baseUrl = ensureSettings().openaiBaseUrl;
    const model = ensureSettings().model;

    if (!apiKey) return res.status(400).json({ error: '未配置 API Key' });

    const containerText = results.map(r =>
      `### ${r.containerName} (${r.sourceName})\n` +
      `- 镜像: ${r.image}\n` +
      `- 异常种类: ${r.uniqueCount || r.matchCount} 种，共 ${r.matchCount} 条匹配\n` +
      `- 最近异常日志:\n${r.lines.map(l => {
        const src = l.source ? ` [${l.source}]` : ' [stdout]';
        const lvl = l.level || 'ERROR';
        return `  [${lvl}]${src} ${l.content || l.line}`;
      }).join('\n')}`
    ).join('\n\n');

    const prompt = `你是资深运维工程师，请分析以下容器日志巡检结果。

## 巡检结果（共 ${results.length} 个容器存在异常日志）
${containerText}

## 分析要求（用中文回答）：
### 📋 问题汇总（按容器分组）
### 🔍 关键错误分析（每个错误类型的影响和严重程度）
### 💡 处理建议（具体的操作步骤或代码修复建议）
### 🛡️ 预防措施`;

    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({ apiKey, baseURL: baseUrl });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');

    let fullAnalysis = '';

    const stream = await openai.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      max_tokens: 4096,
      temperature: 0.3
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) {
        fullAnalysis += content;
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();

    // 保存分析历史
    addAnalysisRecord({
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      type: 'patrol',
      sourceName: `容器巡检 · ${results.length} 个容器`,
      analysis: fullAnalysis,
      summary: containerText.slice(0, 300),
      status: 'done',
      model
    });
  } catch (err) {
    console.error('[patrol/analyze]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else { res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`); res.end(); }

    addAnalysisRecord({
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      type: 'patrol',
      sourceName: '容器巡检',
      analysis: null,
      summary: '',
      status: 'error',
      error: err.message,
      model: ensureSettings().model
    });
  }
});

// ────────────────────────────────────────
// 单容器异常诊断（SSE 流式）
// ────────────────────────────────────────
app.post('/api/docker/container/:sourceId/:containerId/analyze', async (req, res) => {
  try {
    const { sourceId, containerId } = req.params;
    const { exitCode, exitType, exitLabel, image } = req.body;

    const apiKey = ensureSettings().openaiApiKey;
    const baseUrl = ensureSettings().openaiBaseUrl;
    const model = ensureSettings().model;

    if (!apiKey) return res.status(400).json({ error: '未配置 API Key' });

    const config = getDockerConfig(sourceId);
    if (!config) return res.status(404).json({ error: 'Docker 源未找到' });

    // 拉取容器最近日志
    let recentErrorLines = [];
    let containerName = containerId?.slice(0, 12);
    try {
      const logs = await docker.getContainerLogs(sourceId, containerId, config);
      recentErrorLines = (logs || [])
        .filter(l => l.level === 'ERROR' || l.level === 'FATAL')
        .slice(-10);
      // Infer name from latest log or use containerId
    } catch { /* 容器已被删除，日志读不到 */ }

    const containerText = `- 容器 ID: ${containerId}\n- 镜像: ${image || '未知'}\n- 退出码: ${exitCode} (${exitLabel || exitType || '异常退出'})\n` +
      (recentErrorLines.length > 0
        ? `- 退出前最后 ${recentErrorLines.length} 条错误:\n${recentErrorLines.map(l => `  [${l.level}] ${l.content || l.line}`).join('\n')}`
        : '- 未获取到最近错误日志（容器可能已被清理）');

    const prompt = `你是资深运维工程师，正在进行单个容器的异常退出诊断。

## 容器信息
${containerText}

## 诊断要求（用中文回答）：
### 🔴 退出原因（结合退出码和日志综合判断最可能的根因）
### 💡 修复建议（给出 2-3 条具体操作步骤）
### 🛡️ 预防措施（如何避免再次发生）`;

    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({ apiKey, baseURL: baseUrl });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');

    let fullAnalysis = '';
    const stream = await openai.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      max_tokens: 2048,
      temperature: 0.3
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) {
        fullAnalysis += content;
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();

    addAnalysisRecord({
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      type: 'health',
      sourceName: `容器诊断 · ${containerName}`,
      analysis: fullAnalysis,
      summary: containerText.slice(0, 300),
      status: 'done',
      model
    });
  } catch (err) {
    console.error('[container/analyze]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else { res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`); res.end(); }

    addAnalysisRecord({
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      type: 'health',
      sourceName: '容器诊断',
      analysis: null,
      summary: '',
      status: 'error',
      error: err.message,
      model: ensureSettings().model
    });
  }
});

// ────────────────────────────────────────
// Docker 容器操作
// ────────────────────────────────────────
function getDockerConfig(sourceId) {
  const source = (ensureSettings().dockerSources || []).find(s => s.id === sourceId);
  if (!source) return null;
  return {
    socketPath: source.socketPath || undefined,
    host: source.socketPath ? undefined : (source.host || 'localhost'),
    port: source.socketPath ? undefined : (source.port || 2375),
    tls: source.tls,
    ca: source.ca, cert: source.cert, key: source.key,
  };
}

async function runDockerOp(req, res, opName, args = []) {
  const { sourceId, containerId } = req.params;
  const config = getDockerConfig(sourceId);
  if (!config) return res.status(404).json({ error: 'Docker 源未找到' });

  try {
    const op = docker[opName];
    const result = await op(sourceId, containerId, ...args, config);
    res.json({ ok: true, ...result });
  } catch (err) {
    // dockerode 错误通常是 statusCode + message 格式
    const msg = err.message || String(err);
    const status = err.statusCode || (msg.toLowerCase().includes('not found') ? 404 : 500);
    res.status(status).json({ error: msg });
  }
}

app.post('/api/docker/:sourceId/:containerId/start',  (req, res) => runDockerOp(req, res, 'startContainer'));
app.post('/api/docker/:sourceId/:containerId/stop',   (req, res) => runDockerOp(req, res, 'stopContainer'));
app.post('/api/docker/:sourceId/:containerId/restart', (req, res) => runDockerOp(req, res, 'restartContainer'));
app.post('/api/docker/:sourceId/:containerId/pause',  (req, res) => runDockerOp(req, res, 'pauseContainer'));
app.post('/api/docker/:sourceId/:containerId/unpause',(req, res) => runDockerOp(req, res, 'unpauseContainer'));
app.delete('/api/docker/:sourceId/:containerId',      (req, res) => runDockerOp(req, res, 'removeContainer'));

// 执行命令
app.post('/api/docker/:sourceId/:containerId/exec', async (req, res) => {
  const { sourceId, containerId } = req.params;
  const { command } = req.body;
  const config = getDockerConfig(sourceId);
  if (!config) return res.status(404).json({ error: 'Docker 源未找到' });
  if (!command) return res.status(400).json({ error: '缺少 command 参数' });
  // 安全白名单
  const DOCKER_SAFE = ['ls','cat','head','tail','wc','grep','find','du','df','free','ps','top','uptime','date','env','echo','pwd','whoami','id','uname','ss','ip','ping','python','python3','node','npm','npx','nvidia-smi','docker','docker-compose'];
  const cmdBase = command.trim().split(/\s+/)[0].split('/').pop();
  if (!DOCKER_SAFE.includes(cmdBase)) {
    return res.status(403).json({ error: `命令被安全策略阻止: ${cmdBase}` });
  }

  try {
    const { output } = await docker.execInContainer(sourceId, containerId, command, config);
    res.json({ output });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========================================
// Remote Server API Routes
// ========================================

// Get all remote servers
app.get('/api/remote/servers', (req, res) => {
  try {
    const servers = remote.getServers();
    res.json({ servers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a new remote server
app.post('/api/remote/servers', async (req, res) => {
  try {
    const server = remote.addServer(req.body);
    res.json({ success: true, server });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update remote server
app.put('/api/remote/servers/:id', (req, res) => {
  try {
    const server = remote.updateServer(req.params.id, req.body);
    if (!server) {
      return res.status(404).json({ error: '服务器不存在' });
    }
    res.json({ success: true, server });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete remote server
app.delete('/api/remote/servers/:id', (req, res) => {
  try {
    const deleted = remote.deleteServer(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: '服务器不存在' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test connection to a remote server
app.post('/api/remote/test', async (req, res) => {
  try {
    const result = await remote.testConnection(req.body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Connect to a remote server
app.post('/api/remote/servers/:id/connect', async (req, res) => {
  try {
    const result = await remote.connectServer(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Disconnect from a remote server
app.post('/api/remote/servers/:id/disconnect', async (req, res) => {
  try {
    await remote.disconnectServer(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// FinalShell 密码解密
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

// 导入 FinalShell 配置
app.post('/api/remote/import', async (req, res) => {
  try {
    const { configs } = req.body;
    if (!configs || !Array.isArray(configs)) {
      return res.status(400).json({ error: '缺少 configs 数组' });
    }

    let imported = 0;
    let skipped = 0;
    const errors = [];

    for (const config of configs) {
      try {
        // 解析 FinalShell 格式
        const serverData = {
          name: config.name || config.host,
          host: config.host,
          port: config.port || 22,
          username: config.user_name || 'root',
          password: config.password || '',
        };

        // 尝试解密 FinalShell 密码
        if (serverData.password && serverData.password.length > 0) {
          const decrypted = decryptFinalShellPassword(serverData.password);
          if (decrypted && decrypted.length > 0 && /^[\x20-\x7E]+$/.test(decrypted)) {
            serverData.password = decrypted;
          }
        }

        // 添加服务器（自动去重）
        const result = remote.addServer(serverData);
        if (result) {
          imported++;
        } else {
          skipped++;
        }
      } catch (err) {
        errors.push({ config: config.name || config.host, error: err.message });
      }
    }

    res.json({ success: true, imported, skipped, errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get decrypted password (编辑弹窗用)
app.get('/api/remote/servers/:id/password', (req, res) => {
  try {
    const pw = remote.getServerPassword(req.params.id);
    if (pw === null) return res.status(404).json({ error: '服务器不存在' });
    res.json({ password: pw });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List remote files
app.get('/api/remote/servers/:id/files', async (req, res) => {
  try {
    const { path: subPath } = req.query;
    const result = await remote.listRemoteFiles(req.params.id, subPath);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Read remote log file
app.get('/api/remote/servers/:id/logs', async (req, res) => {
  try {
    const { file, lines, search, level } = req.query;
    if (!file) {
      return res.status(400).json({ error: '缺少文件路径' });
    }
    const result = await remote.readRemoteFile(req.params.id, file, {
      lines: parseInt(lines) || 200,
      search,
      level,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search remote logs
app.get('/api/remote/servers/:id/search', async (req, res) => {
  try {
    const { q, path: searchPath, pattern } = req.query;
    if (!q) {
      return res.status(400).json({ error: '缺少搜索关键词' });
    }
    const result = await remote.searchRemoteLogs(req.params.id, q, {
      path: searchPath,
      pattern,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 读取远程文件原始内容（编辑器用）
app.get('/api/remote/servers/:id/file/read', async (req, res) => {
  try {
    const { path: filePath } = req.query;
    if (!filePath) return res.status(400).json({ error: '缺少文件路径' });
    const result = await remote.readRemoteFileRaw(req.params.id, filePath);
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 写入远程文件内容（编辑器用）
app.post('/api/remote/servers/:id/file/write', async (req, res) => {
  try {
    const { path: filePath, content } = req.body;
    if (!filePath || content === undefined) return res.status(400).json({ error: '缺少参数' });
    const result = await remote.writeRemoteFile(req.params.id, filePath, content);
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 上传文件到远程服务器
app.post('/api/remote/servers/:id/file/upload', async (req, res) => {
  try {
    const { path: remotePath, content: base64Content, name } = req.body;
    if (!remotePath || !base64Content) return res.status(400).json({ error: '缺少参数' });
    const buffer = Buffer.from(base64Content, 'base64');
    const result = await remote.uploadRemoteFile(req.params.id, buffer, remotePath, name);
    if (result.error) return res.status(500).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 分片上传 API ──────────────────────────────────────

// 初始化分片上传
app.post('/api/remote/servers/:id/file/upload/init', async (req, res) => {
  try {
    const { path: remotePath, fileSize } = req.body;
    if (!remotePath || !fileSize) return res.status(400).json({ error: '缺少参数' });
    const result = await remote.initChunkedUpload(req.params.id, remotePath, fileSize);
    if (result.error) return res.status(500).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 上传单个分片
app.post('/api/remote/servers/:id/file/upload/chunk', async (req, res) => {
  try {
    const { uploadId, chunkIndex, data: base64Data } = req.body;
    if (!uploadId || chunkIndex === undefined || !base64Data) return res.status(400).json({ error: '缺少参数' });
    const result = await remote.uploadChunk(req.params.id, uploadId, chunkIndex, base64Data);
    if (result.error) return res.status(500).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 完成分片上传
app.post('/api/remote/servers/:id/file/upload/complete', async (req, res) => {
  try {
    const { uploadId, totalChunks } = req.body;
    if (!uploadId || !totalChunks) return res.status(400).json({ error: '缺少参数' });
    const result = await remote.completeChunkedUpload(req.params.id, uploadId, totalChunks);
    if (result.error) {
      console.error('[upload/complete]', result.error);
      return res.status(500).json(result);
    }
    res.json(result);
  } catch (err) {
    console.error('[upload/complete] uncaught:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 取消分片上传
app.post('/api/remote/servers/:id/file/upload/cancel', async (req, res) => {
  try {
    const { uploadId } = req.body;
    await remote.cancelChunkedUpload(req.params.id, uploadId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get remote system stats
app.get('/api/remote/servers/:id/stats', async (req, res) => {
  try {
    const stats = await remote.getRemoteSystemStats(req.params.id);
    res.json(stats);
  } catch (err) {
    // 未连接不算错误，前端静默处理
    if (err.message === '服务器未连接') {
      res.json({ offline: true });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

// Execute command on remote server (with caution!)
app.post('/api/remote/servers/:id/exec', async (req, res) => {
  try {
    const { command } = req.body;
    if (!command) {
      return res.status(400).json({ error: '缺少命令' });
    }
    // 安全限制：只允许特定命令
    const allowedCommands = ['ls', 'cat', 'tail', 'head', 'grep', 'find', 'du', 'df', 'free', 'top', 'ps', 'uptime', 'date'];
    const cmdBase = command.split(' ')[0];
    if (!allowedCommands.includes(cmdBase)) {
      return res.status(403).json({ error: '命令不允许执行' });
    }
    const result = await remote.execRemoteCommand(req.params.id, command);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Execute shell command on remote server (full shell access)
app.post('/api/remote/servers/:id/shell', async (req, res) => {
  try {
    const { command, timeout } = req.body;
    if (!command) {
      return res.status(400).json({ error: '缺少命令' });
    }
    // 安全白名单（比 exec 更宽，但仍限制）
    const SHELL_SAFE = ['ls','cat','head','tail','wc','grep','find','du','df','free','ps','top','htop','uptime','date','env','echo','pwd','whoami','id','uname','hostname','ss','ip','ping','curl','wget','python','python3','node','npm','npx','nvidia-smi','docker','docker-compose','systemctl','journalctl','dmesg','lsof','lscpu','lsblk','mount','df','iostat','vmstat','netstat','ss','iptables','git','make','cmake','tar','zip','unzip','gzip','gunzip','sudo','kill','killall','pgrep','pkill'];
    const cmdBase = command.trim().split(/\s+/)[0].split('/').pop();
    if (!SHELL_SAFE.includes(cmdBase)) {
      return res.status(403).json({ error: `命令被安全策略阻止: ${cmdBase}` });
    }
    const result = await remote.execShellCommand(req.params.id, command, timeout);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// AI Shell: 自然语言转 Shell 命令并执行
app.post('/api/remote/:id/aishell', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: '缺少提示词' });
    }

    const serverId = req.params.id;
    const server = remote.getServers().find(s => s.id === serverId);
    if (!server) {
      return res.status(404).json({ error: '服务器不存在' });
    }

    // 获取 LLM 配置
    const settings = ensureSettings();
    const apiKey = settings.openaiApiKey;
    const baseUrl = settings.openaiBaseUrl || 'http://localhost:11434/v1';
    const model = settings.model;
    const isLocalModel = baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1') || baseUrl.includes('0.0.0.0');

    if (!apiKey && !isLocalModel) {
      return res.status(400).json({ error: '未配置 LLM API Key，请在设置中配置' });
    }
    if (!model) {
      return res.status(400).json({ error: '未配置 LLM 模型，请在设置中配置' });
    }

    // 获取系统信息作为上下文
    let systemContext = '';
    try {
      const stats = await remote.getRemoteSystemStats(serverId);
      if (!stats.error) {
        systemContext = `\n\n当前服务器状态（${server.host}）：\n` +
          `- CPU 使用率: ${stats.cpu?.load?.toFixed(1) || 'N/A'}%\n` +
          `- 内存: ${(stats.memory?.used / 1e9).toFixed(1) || 'N/A'}/${(stats.memory?.total / 1e9).toFixed(1) || 'N/A'} GB\n` +
          `- 磁盘: ${stats.disk?.map(d => `${d.name} ${d.usePercent}%`).join(', ') || 'N/A'}`;
      }
    } catch (_) {}

    // 调用 LLM 翻译为 Shell 命令
    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({ apiKey: apiKey || 'ollama', baseURL: baseUrl });

    const systemPrompt = `你是一个专业的 Linux 运维工程师。用户会用自然语言描述他们想执行的操作。
你需要将用户的请求转换为一个或多个安全的 Shell 命令。

重要规则：
1. 只输出安全的只读命令（ls, cat, head, tail, grep, find, du, df, free, ps, top, uptime, date, netstat, ss, lsof, journalctl, systemctl status, docker ps, docker logs, nvidia-smi, iostat, vmstat, uname, hostname, whoami, id, pwd, env, ip, ping, curl, wget, stat, wc, sort, uniq, awk, sed）
2. 绝对不能执行写入、删除、修改类命令（rm, mv, dd, mkfs, fdisk, shutdown, reboot, systemctl start/stop/restart, docker rm/stop/kill）
3. 如果用户的请求涉及危险操作，回复一个安全的替代方案
4. 尽量用单个命令，必要时用管道组合
5. 限制输出量（使用 head -20 或 tail -50 等）

返回格式为 JSON：
{
  "command": "要执行的 shell 命令",
  "explanation": "简短的中文解释（1-2句话）"
}

只返回 JSON，不要包含其他内容。${systemContext}`;

    const response = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `请将以下请求转换为 Shell 命令：${prompt.trim()}` }
      ],
      temperature: 0.1,
      timeout: 60_000,
      response_format: { type: 'json_object' }
    });

    const llmOutput = stripThinking(response.choices[0].message.content);
    let parsed;
    try {
      parsed = JSON.parse(llmOutput);
    } catch {
      // 尝试从文本中提取 JSON
      const jsonMatch = llmOutput.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        return res.status(500).json({ error: 'AI 返回格式错误，请重试', raw: llmOutput });
      }
    }

    const command = parsed.command || '';
    const explanation = parsed.explanation || '';

    if (!command) {
      return res.status(400).json({ error: 'AI 未能生成有效命令', raw: llmOutput });
    }

    // 安全校验：再次检查命令白名单
    const cmdBase = command.trim().split(/\s+/)[0].split('/').pop();
    const SAFE_CMDS = ['ls','cat','head','tail','wc','grep','find','du','df','free','ps','top','htop','uptime','date','env','echo','pwd','whoami','id','uname','hostname','ss','ip','ping','curl','wget','python','python3','node','npm','npx','nvidia-smi','docker','docker-compose','systemctl','journalctl','dmesg','lsof','lscpu','lsblk','mount','iostat','vmstat','netstat','git','stat','sort','uniq','awk','sed'];
    if (!SAFE_CMDS.includes(cmdBase)) {
      return res.status(403).json({ error: `AI 生成的命令被安全策略阻止: ${cmdBase}`, command, explanation });
    }

    // 执行命令
    const result = await remote.execShellCommand(serverId, command, 30000);

    res.json({
      success: true,
      command,
      explanation,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.code
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Shell 会话存储
const shellSessions = new Map();

// WebSocket 升级处理 - 为 Shell 终端
server.on('upgrade', (request, socket, head) => {
  const pathname = request.url.split('?')[0];

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
      error: err.message 
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
          console.error('[AIShell] AI 生成命令失败:', err.message);
          ws.send(JSON.stringify({
            type: 'error',
            id: requestId,
            error: `AI 生成命令失败: ${err.message}`
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
          console.error('[AIShell] 命令执行失败:', err.message);
          ws.send(JSON.stringify({
            type: 'command_error',
            id: requestId,
            error: err.message
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
    console.error(`AI Shell WebSocket error for server ${serverId}:`, err.message);
  });
}

// Docker 实时日志流 WebSocket 处理器
async function handleDockerLogStream(ws, sourceId, containerId) {
  console.log(`Docker log stream WebSocket connected for source: ${sourceId}, container: ${containerId}`);

  let logStream = null;

  try {
    const source = (ensureSettings().dockerSources || []).find(s => s.id === sourceId);
    const config = source ? {
      socketPath: source.socketPath || undefined,
      host: source.socketPath ? undefined : (source.host || 'localhost'),
      port: source.socketPath ? undefined : (source.port || 2375),
      tls: source.tls,
      ca: source.ca, cert: source.cert, key: source.key,
    } : {};

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
      console.error(`Docker log stream error for ${containerId}:`, err.message);
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'stream_error', error: err.message }));
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
      console.error(`Docker log stream WS error for ${containerId}:`, err.message);
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
    console.error(`Failed to create Docker log stream for ${containerId}:`, err.message);
    ws.send(JSON.stringify({ type: 'stream_error', error: err.message }));
    ws.close();
  }
}

// Start server
// 先初始化数据库
await initDatabase();

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 Give Me The Log server running on http://localhost:${PORT}`);
  startLogWatcher();
  startMonitor();
  startDockerEventWatch();
  startContainerPatrol();

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
          console.log(`  ❌ ${s.name} 重连失败: ${err.message}`);
        }
      }));
    }
  } catch (err) {
    console.error('自动重连出错:', err.message);
  }
});

// ─── GPU 监控路由 ─────────────────────────────────────────────────────────

// 获取 GPU 列表（本地）
app.get('/api/gpu/local', async (req, res) => {
  try {
    let devices = await gpu.getLocalGPUs();
    // Docker容器内 nvidia-smi 不可用，尝试 SSH localhost/
    if (devices.length === 0 && process.env.NODE_ENV === 'production') {
      try {
        const { execSync } = await import('child_process');
        const out = execSync(
          'sshpass -p Supremind0717- ssh -o StrictHostKeyChecking=no -o ConnectTimeout=3 -p 40022 smai@127.0.0.1 "nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits" 2>/dev/null',
          { timeout: 5000, encoding: 'utf8' }
        ).trim();
        if (out) {
          devices = out.split('\n').filter(Boolean).map(line => {
            const [idx, name, util, memUsed, memTotal, temp] = line.split(',').map(s => s.trim());
            return { index: parseInt(idx) || 0, name, util: parseFloat(util) || 0,
              memUsed: parseInt(memUsed) || 0, memTotal: parseInt(memTotal) || 0,
              temp: parseFloat(temp) || 0, processes: [] };
          });
        }
      } catch {}
    }
    const summary = gpu.getGPUSummary(devices);
    res.json({ devices, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取 GPU 列表（远程）— 通过已连接的远程服务器
app.get('/api/gpu/remote-server/:serverId', async (req, res) => {
  try {
    const { serverId } = req.params;
    // 获取 GPU 基本状态
    const result = await remote.execRemoteCommand(serverId, 'nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>&1');
    if (result.error) throw new Error(result.error);
    const lines = (result.stdout || '').trim().split('\n').filter(l => l.trim());

    // 获取进程信息
    const procResult = await remote.execRemoteCommand(serverId, 'nvidia-smi --query-compute-apps=pid,gpu_index,process_name,used_memory --format=csv,noheader,nounits 2>&1');
    const procLines = (procResult.stdout || '').trim().split('\n').filter(l => l.trim());
    const processesByGpu = {};
    for (const pline of procLines) {
      const pparts = pline.split(',').map(s => s.trim());
      const gpuIdx = parseInt(pparts[1]) || 0;
      if (!processesByGpu[gpuIdx]) processesByGpu[gpuIdx] = [];
      processesByGpu[gpuIdx].push({
        pid: parseInt(pparts[0]) || 0,
        name: pparts[2] || 'unknown',
        usedMemory: parseInt(pparts[3]) || 0,
      });
    }

    const devices = lines.map(line => {
      const parts = line.split(',').map(s => s.trim());
      const idx = parseInt(parts[0]) || 0;
      return {
        index: idx,
        name: parts[1] || 'Unknown',
        util: parseFloat(parts[2]) || 0,
        memUsed: parseInt(parts[3]) || 0,
        memTotal: parseInt(parts[4]) || 0,
        temp: parseFloat(parts[5]) || 0,
        processes: processesByGpu[idx] || [],
      };
    });
    const summary = gpu.getGPUSummary(devices);
    res.json({ devices, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get('/api/gpu/remote', async (req, res) => {
  try {
    const { host, sshUser, sshPassword, sshKeyPath, sshPort } = req.query;
    if (!host || !sshUser) return res.status(400).json({ error: 'host and sshUser required' });
    const devices = await gpu.getRemoteGPUs(host, sshUser, sshPassword, sshKeyPath, parseInt(sshPort) || 22);
    const summary = gpu.getGPUSummary(devices);
    res.json({ devices, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 通用 GPU 查询（自动本地/远程）
app.post('/api/gpu/query', async (req, res) => {
  try {
    const { remote: isRemote, host, sshUser, sshPassword, sshKeyPath, sshPort } = req.body;
    const devices = await gpu.getGPUs({ remote: isRemote, host, sshUser, sshPassword, sshKeyPath, sshPort });
    const summary = gpu.getGPUSummary(devices);
    res.json({ devices, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 保存 / 加载 GPU 配置
app.get('/api/gpu/configs', (req, res) => {
  res.json({ configs: gpu.loadGPUConfigs() });
});

app.post('/api/gpu/configs', (req, res) => {
  try {
    const { configs } = req.body;
    gpu.saveGPUConfigs(configs);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
