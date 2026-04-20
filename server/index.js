import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
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
import { initDb, getDb, getKv, setKv } from './db/index.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
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
app.use(cors());
app.use(express.json({ limit: '50mb' }));

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
      host: 'localhost',
      port: 2375,
      tls: false,
      enabled: false,
      autoAnalysis: true,
      projects: []
    }
  ]
};

// Settings - 懒加载，数据库初始化完成后加载
let settings = null;

function ensureSettings() {
  if (!settings) {
    settings = loadSettings() || defaultSettings;
  }
  return settings;
}

// 🧠 过滤 <think/> 标签：非流式响应直接替换
function stripThinking(text) {
  if (ensureSettings().thinkingEnabled) return text;
  // 匹配 <think&gt;...</think&gt;（支持多行、贪婪匹配最外层）
  return text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/g, '').trim();
}

// 🧠 流式思维过滤器：状态机，逐 token 过滤 <think/> 块
class ThinkingStreamFilter {
  constructor() {
    this.inThink = false;       // 当前是否在 <think/> 块内
    this.buffer = '';           // 待判断的 buffer（可能跨 chunk）
  }

  /** 输入一个 chunk 的 content，返回应该输出给客户端的部分 */
  feed(content) {
    if (ensureSettings().thinkingEnabled) return content; // 开启思维 → 全部输出

    let output = '';
    let i = 0;

    // 先处理 buffer 中残留的内容
    if (this.buffer) {
      content = this.buffer + content;
      this.buffer = '';
    }

    while (i < content.length) {
      if (this.inThink) {
        // 在 think 块内，寻找 </think&gt;
        const closeIdx = content.indexOf('</think&gt;', i);
        if (closeIdx !== -1) {
          this.inThink = false;
          i = closeIdx + 8; // 跳过 </think&gt;
          continue;
        }
        // 没找到闭合标签，继续等待
        i = content.length;
        break;
      } else {
        // 不在 think 块内，寻找 <think
        const openIdx = content.indexOf('<think', i);
        if (openIdx === -1) {
          // 没有 <think，安全输出剩余内容
          output += content.slice(i);
          break;
        }
        // 输出 <think 之前的内容
        output += content.slice(i, openIdx);

        // 检查 <think&gt; 是否在当前 content 内完整
        const tagEnd = content.indexOf('>', openIdx);
        if (tagEnd !== -1) {
          this.inThink = true;
          i = tagEnd + 1;
          continue;
        }
        // <think 不完整（跨 chunk），存入 buffer
        this.buffer = content.slice(openIdx);
        break;
      }
    }

    return output;
  }

  /** 流结束，返回 buffer 中残留的可输出内容 */
  flush() {
    if (ensureSettings().thinkingEnabled) return this.buffer;
    // 流结束时如果还在 <think/> 内，丢弃
    if (this.inThink) {
      this.buffer = '';
      return '';
    }
    const remaining = this.buffer;
    this.buffer = '';
    return remaining;
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

  // 🚀 主动分析：ERROR/FATAL 日志出现时加入分析队列
  const autoAnalysisEnabled = ensureSettings().autoAnalysis && (source?.autoAnalysis ?? true);
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
    analysisHistory.unshift(record);
    if (analysisHistory.length > MAX_ANALYSIS_HISTORY) analysisHistory.pop();

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
    analysisHistory.unshift(record);
    if (analysisHistory.length > MAX_ANALYSIS_HISTORY) analysisHistory.pop();

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
        disk: disks[0] && disks[0].size > 0 ? (disks[0].used / disks[0].size) * 100 : 0,
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
  const { logs: analyzeLogs, prompt } = req.body;
  
  const apiKey = ensureSettings().openaiApiKey;
  const baseUrl = ensureSettings().openaiBaseUrl || 'http://localhost:11434/v1';
  const model = ensureSettings().model || 'qwen3.5:9b';
  
  // 本地模型（Ollama/LM Studio）可能不需要 API Key
  const isLocalModel = baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1') || baseUrl.includes('0.0.0.0');
  
  if (!apiKey && !isLocalModel) {
    return res.status(400).json({ error: 'API Key 未配置。请在设置页面配置 API Key，或使用本地模型。' });
  }
  
  if (!model) {
    return res.status(400).json({ error: '模型未配置。请在设置页面选择模型。' });
  }
  
  try {
    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({ 
      apiKey: apiKey || 'ollama',  // Ollama 不需要真实 key，但需要非空字符串
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
    
    res.json({ analysis: response.choices[0].message.content });
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
  res.json(ensureSettings());
});

app.put('/api/settings', (req, res) => {
  const updates = req.body;

  const currentSettings = ensureSettings();
  for (const [key, value] of Object.entries(updates)) {
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
  }

  if (updates.refreshInterval) {
    startMonitor();
  }

  res.json({ success: true, settings });
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
app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages required' });
  }

  const apiKey = ensureSettings().openaiApiKey;
  const baseUrl = ensureSettings().openaiBaseUrl || 'http://localhost:11434/v1';
  const model = ensureSettings().model;
  const isLocalModel = baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1') || baseUrl.includes('0.0.0.0');

  if (!apiKey && !isLocalModel) return res.status(400).json({ error: '未配置 API Key' });
  if (!model) return res.status(400).json({ error: '未配置模型' });

  try {
    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({ apiKey: apiKey || 'ollama', baseURL: baseUrl });

    const systemPrompt = {
      role: 'system',
      content: `你是一个专业的运维工程师和技术支持助手。你的职责是：
- 帮助运维人员排查服务器、网络、数据库、中间件等问题
- 提供清晰、可操作的解决方案
- 支持日志分析、性能调优、故障排查、安全加固等场景
- 回复使用与用户相同的语言（中文提问用中文回答）
- 回复要简洁专业，必要时给出命令示例和配置片段`
    };

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const stream = await openai.chat.completions.create({
      model,
      messages: [systemPrompt, ...messages],
      temperature: 0.7,
      stream: true,
      timeout: 120_000
    });

    const thinkingFilter = new ThinkingStreamFilter();
    for await (const chunk of stream) {
      const raw = chunk.choices[0]?.delta?.content || '';
      if (raw) {
        const content = thinkingFilter.feed(raw);
        if (content) res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }
    const remaining = thinkingFilter.flush();
    if (remaining) res.write(`data: ${JSON.stringify({ content: remaining })}\n\n`);
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
          containers,
        });
      } catch (err) {
        allContainers.push({
          sourceId: source.id,
          sourceName: source.name,
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

// Get remote system stats
app.get('/api/remote/servers/:id/stats', async (req, res) => {
  try {
    const stats = await remote.getRemoteSystemStats(req.params.id);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    const result = await remote.execShellCommand(req.params.id, command, timeout);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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

// Start server
// 先初始化数据库
await initDatabase();

server.listen(PORT, async () => {
  console.log(`🚀 Give Me The Log server running on http://localhost:${PORT}`);
  startLogWatcher();
  startMonitor();

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
