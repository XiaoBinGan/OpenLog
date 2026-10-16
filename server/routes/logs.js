/**
 * routes/logs.js — 日志查询、持久化历史与 AI 分析/修复
 *
 * 从 server/index.js 抽出。需要 index.js 的模块级状态，通过工厂函数注入：
 *   logs           —— 内存中的实时日志环形缓冲（index.js 的 saveLog() 写入）
 *   ensureSettings —— 读取当前生效配置（AI 分析的 apiKey/baseUrl/model）
 *   saveLog        —— 写入环形缓冲并持久化、推送（/api/logs/generate-sample 用）
 *   broadcast      —— 向所有 WS 客户端推送（同一路由用）
 *
 * 数据库访问直接 import db 层；不引用 index.js 的其它内部符号。
 */
import express from 'express';
import { errorMessage } from '../errors.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getDb, listLogRecords } from '../db/index.js';

export default function createLogsRouter({ logs, ensureSettings, saveLog, broadcast }) {
  const router = express.Router();

// Get logs
router.get('/api/logs', (req, res) => {
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
router.get('/api/logs/history', async (req, res) => {
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
    res.status(500).json({ error: errorMessage(err) });
  }
});

// 清理过期持久化日志
router.delete('/api/logs/history', async (req, res) => {
  try {
    const { maxAgeDays } = req.query;
    const days = parseInt(maxAgeDays) || ensureSettings().logPersistenceMaxAge || 7;
    const cutoffTs = Math.floor(Date.now() / 1000) - days * 86400;
    
    const db = getDb();
    const result = db.run(`DELETE FROM log_records WHERE timestamp < ?`, cutoffTs);
    
    res.json({ deleted: result.changes, cutoffDate: new Date(cutoffTs * 1000).toISOString() });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// Analyze logs with AI
router.post('/api/logs/analyze', async (req, res) => {
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
    let errorMsg = errorMessage(err);
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
router.post('/api/logs/fix', async (req, res) => {
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
    res.status(500).json({ error: errorMessage(err) });
  }
});

// Clear logs
router.delete('/api/logs', (req, res) => {
  logs.length = 0;
  res.json({ success: true });
});
// Get available log files
router.get('/api/logs/files', (req, res) => {
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
router.post('/api/logs/generate-sample', (req, res) => {
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

  return router;
}
