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

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true }); // 关键：使用 noServer: true，避免自动处理升级

const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Settings - 默认使用 Ollama 本地模型
const settings = {
  openaiApiKey: '',
  openaiBaseUrl: 'http://localhost:11434/v1',
  model: 'qwen3.5:9b',
  logPath: path.join(os.homedir(), 'logs'),
  watchFiles: '*.log',
  refreshInterval: '5000'
};

// Default settings
const defaultSettings = { ...settings };

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

// Log watcher
let watcher = null;

function startLogWatcher() {
  const logPath = settings.logPath || path.join(os.homedir(), 'logs');
  const watchFiles = settings.watchFiles || '*.log';
  
  if (watcher) {
    watcher.close();
  }
  
  // Ensure directory exists
  if (!fs.existsSync(logPath)) {
    try {
      fs.mkdirSync(logPath, { recursive: true });
      console.log(`Created log directory: ${logPath}`);
    } catch (err) {
      console.error('Failed to create log directory:', err.message);
      return;
    }
  }
  
  try {
    watcher = chokidar.watch(path.join(logPath, watchFiles), {
      persistent: true,
      ignoreInitial: true
    });
    
    watcher.on('add', (filePath) => {
      console.log(`Watching file: ${filePath}`);
    });
    
    watcher.on('change', (filePath) => {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').filter(line => line.trim());
        const lastLine = lines[lines.length - 1];
        
        if (lastLine) {
          const logEntry = parseLogLine(lastLine, path.basename(filePath));
          saveLog(logEntry);
          broadcast({ type: 'log', data: logEntry });
        }
      } catch (err) {
        console.error('Error reading log file:', err.message);
      }
    });
    
    console.log(`Started watching: ${logPath}/${watchFiles}`);
  } catch (err) {
    console.error('Failed to start log watcher:', err.message);
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

function saveLog(log) {
  logs.unshift(log);
  
  // Keep only last 10000 logs
  if (logs.length > 10000) {
    logs.pop();
  }
}

// System monitoring
let monitorInterval = null;
const monitorHistory = [];

function startMonitor() {
  const interval = parseInt(settings.refreshInterval || '5000');
  
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
        network: network[0] ? network[0].rx_sec + network[0].tx_sec : 0
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
    const baseUrl = settings.openaiBaseUrl || 'http://localhost:11434/v1';
    
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
  
  const apiKey = settings.openaiApiKey;
  const baseUrl = settings.openaiBaseUrl || 'http://localhost:11434/v1';
  const model = settings.model || 'qwen3.5:9b';
  
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
  
  const apiKey = settings.openaiApiKey;
  const baseUrl = settings.openaiBaseUrl || 'http://localhost:11434/v1';
  const model = settings.model || 'qwen3.5:9b';
  
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
  try {
    const [cpu, mem, disks, network, processes] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.networkStats(),
      si.processes()
    ]);
    
    res.json({
      cpu: { load: cpu.currentLoad || 0, cores: cpu.cpus.map(c => c.load) },
      memory: { used: mem.used || 0, total: mem.total || 1, free: mem.free || 0 },
      disk: disks.map(d => ({ name: d.fs, used: d.used, total: d.size, usePercent: d.use })),
      network: network.map(n => ({ iface: n.iface, rx: n.rx_sec, tx: n.tx_sec })),
      processes: processes.list.slice(0, 10).map(p => ({ pid: p.pid, name: p.name, cpu: p.cpu, mem: p.mem }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Monitor history
app.get('/api/monitor/history', (req, res) => {
  const { limit = 100 } = req.query;
  const result = monitorHistory.slice(0, parseInt(limit));
  res.json(result);
});

// Settings
app.get('/api/settings', (req, res) => {
  res.json(settings);
});

app.put('/api/settings', (req, res) => {
  const updates = req.body;
  
  for (const [key, value] of Object.entries(updates)) {
    settings[key] = value;
  }
  
  // Restart services if needed
  if (updates.logPath || updates.watchFiles) {
    startLogWatcher();
  }
  
  if (updates.refreshInterval) {
    startMonitor();
  }
  
  res.json({ success: true });
});

// Get available log files
app.get('/api/logs/files', (req, res) => {
  const logPath = settings.logPath || path.join(os.homedir(), 'logs');
  
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
server.listen(PORT, () => {
  console.log(`🚀 Give Me The Log server running on http://localhost:${PORT}`);
  startLogWatcher();
  startMonitor();
});
