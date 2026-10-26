/**
 * routes/remote.js — 远程服务器管理与操作（SSH）
 *
 * 从 server/index.js 抽出。全部 23 个路由都是 ./remote.js 的薄封装，
 * 注入两项：
 *   ensureSettings —— settings 在 index.js 中可被重新赋值，注入取值函数而非值本身
 *   stripThinking  —— 依赖 ensureSettings 的文本过滤器，无法做成无依赖工具函数
 *
 * 命令执行相关端点（/:id/exec、/:id/shell、/:id/aishell）的安全策略
 * 来自 ../security/shell-command-policy.js，与 docker 的 /exec 路由共用同一份。
 */
import express from 'express';
import { errorMessage } from '../errors.js';
import * as remote from '../remote.js';
import { getRemoteMfu } from '../gpu-mfu.js';
import {
  hasShellMetaChars, rejectUnlessRemoteExecEnabled,
  READONLY_COMMANDS, commandBaseName,
} from '../security/shell-command-policy.js';

export default function createRemoteRouter({ ensureSettings, stripThinking }) {
  const router = express.Router();

// ========================================

// Get all remote servers
router.get('/api/remote/servers', (req, res) => {
  try {
    const servers = remote.getServers();
    res.json({ servers });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// Add a new remote server
router.post('/api/remote/servers', async (req, res) => {
  try {
    const server = remote.addServer(req.body);
    res.json({ success: true, server });
  } catch (err) {
    res.status(400).json({ error: errorMessage(err) });
  }
});

// Update remote server
router.put('/api/remote/servers/:id', (req, res) => {
  try {
    const server = remote.updateServer(req.params.id, req.body);
    if (!server) {
      return res.status(404).json({ error: '服务器不存在' });
    }
    res.json({ success: true, server });
  } catch (err) {
    res.status(400).json({ error: errorMessage(err) });
  }
});

// Delete remote server
router.delete('/api/remote/servers/:id', (req, res) => {
  try {
    const deleted = remote.deleteServer(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: '服务器不存在' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// Test connection to a remote server
router.post('/api/remote/test', async (req, res) => {
  const b = req.body || {};
  try {
    // 诊断日志：把「浏览器实际发来了什么」记下来。
    // 只记**有没有**、**长度**、以及**首尾是否有空白**，绝不记密码/私钥的值 ——
    // 认证失败时最常见的歧义就是「密码到底发出去了没有、是不是被前端丢了」，
    // 之前没有任何地方能回答这个问题，只能靠猜。
    //
    // 首尾空白单独标出来是因为复制粘贴时最常带上尾随空格，
    // 而且这一点不会泄露密码内容。（刻意不记 hash：弱密码的 hash 前缀可被爆破。）
    const pw = typeof b.password === 'string' ? b.password : '';
    const pwNote = !pw ? '无'
      : pw !== pw.trim() ? `有(${pw.length}字符, ⚠️ 首尾有空白)`
      : `有(${pw.length}字符)`;
    console.log(
      '[Remote/test] ' +
      `host=${b.host}:${b.port || 22} user=${b.username} ` +
      `password=${pwNote} ` +
      `privateKey=${b.privateKey ? '有' : '无'} privateKeyPath=${b.privateKeyPath || '无'} ` +
      `serverId=${b.serverId || '无'}`
    );

    const result = await remote.testConnection(b);
    if (!result?.success) console.warn('[Remote/test] 失败:', result?.error);
    res.json(result);
  } catch (err) {
    console.warn('[Remote/test] 异常:', errorMessage(err));
    res.status(400).json({ success: false, error: errorMessage(err) });
  }
});

// Connect to a remote server
router.post('/api/remote/servers/:id/connect', async (req, res) => {
  try {
    const result = await remote.connectServer(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: errorMessage(err) });
  }
});

// Disconnect from a remote server
router.post('/api/remote/servers/:id/disconnect', async (req, res) => {
  try {
    await remote.disconnectServer(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
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
router.post('/api/remote/import', async (req, res) => {
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
          username: config.user_name || config.username || 'root',
          password: config.password || '',
        };

        // 尝试解密密码（FinalShell 格式）
        if (serverData.password && serverData.password.length > 0) {
          // 如果不是 OpenLog 格式 (iv:authTag:cipher)，尝试 FinalShell 解密
          if (!serverData.password.includes(':')) {
            const decrypted = decryptFinalShellPassword(serverData.password);
            if (decrypted && decrypted.length > 0 && /^[\x20-\x7E]+$/.test(decrypted)) {
              serverData.password = decrypted;
            }
          }
          // OpenLog 加密格式密码直接传给 addServer（会再次加密存储，解出明文使用）
        }

        // 添加服务器（自动去重）
        const result = remote.addServer(serverData);
        if (result) {
          imported++;
        } else {
          skipped++;
        }
      } catch (err) {
        errors.push({ config: config.name || config.host, error: errorMessage(err) });
      }
    }

    res.json({ success: true, imported, skipped, errors });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// 已移除 GET /api/remote/servers/:id/password
// 该端点曾以明文返回已存储的 SSH 密码。编辑弹窗现在留空即表示不修改，
// 由 remote.updateServer() 保留原有密码；后端连接仍可正常使用已存密码。

// 导出服务器配置（不含凭据，仅配置）
router.get('/api/remote/export', async (req, res) => {
  try {
    const servers = remote.getServersWithEncryptedPasswords().map(({ password, ...rest }) => rest);
    res.json({ servers });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// List remote files
router.get('/api/remote/servers/:id/files', async (req, res) => {
  try {
    const { path: subPath } = req.query;
    const result = await remote.listRemoteFiles(req.params.id, subPath);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// Read remote log file
router.get('/api/remote/servers/:id/logs', async (req, res) => {
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
    res.status(500).json({ error: errorMessage(err) });
  }
});

// Search remote logs
router.get('/api/remote/servers/:id/search', async (req, res) => {
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
    res.status(500).json({ error: errorMessage(err) });
  }
});

// 读取远程文件原始内容（编辑器用）
router.get('/api/remote/servers/:id/file/read', async (req, res) => {
  try {
    const { path: filePath } = req.query;
    if (!filePath) return res.status(400).json({ error: '缺少文件路径' });
    const result = await remote.readRemoteFileRaw(req.params.id, filePath);
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// 写入远程文件内容（编辑器用）
router.post('/api/remote/servers/:id/file/write', async (req, res) => {
  try {
    const { path: filePath, content } = req.body;
    if (!filePath || content === undefined) return res.status(400).json({ error: '缺少参数' });
    const result = await remote.writeRemoteFile(req.params.id, filePath, content);
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// 上传文件到远程服务器
router.post('/api/remote/servers/:id/file/upload', async (req, res) => {
  try {
    const { path: remotePath, content: base64Content, name } = req.body;
    if (!remotePath || !base64Content) return res.status(400).json({ error: '缺少参数' });
    const buffer = Buffer.from(base64Content, 'base64');
    const result = await remote.uploadRemoteFile(req.params.id, buffer, remotePath, name);
    if (result.error) return res.status(500).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// ─── 分片上传 API ──────────────────────────────────────

// 初始化分片上传
router.post('/api/remote/servers/:id/file/upload/init', async (req, res) => {
  try {
    const { path: remotePath, fileSize } = req.body;
    if (!remotePath || !fileSize) return res.status(400).json({ error: '缺少参数' });
    const result = await remote.initChunkedUpload(req.params.id, remotePath, fileSize);
    if (result.error) return res.status(500).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// 上传单个分片
router.post('/api/remote/servers/:id/file/upload/chunk', async (req, res) => {
  try {
    const { uploadId, chunkIndex, data: base64Data } = req.body;
    if (!uploadId || chunkIndex === undefined || !base64Data) return res.status(400).json({ error: '缺少参数' });
    const result = await remote.uploadChunk(req.params.id, uploadId, chunkIndex, base64Data);
    if (result.error) return res.status(500).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// 完成分片上传
router.post('/api/remote/servers/:id/file/upload/complete', async (req, res) => {
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
    console.error('[upload/complete] uncaught:', errorMessage(err));
    res.status(500).json({ error: errorMessage(err) });
  }
});

// 取消分片上传
router.post('/api/remote/servers/:id/file/upload/cancel', async (req, res) => {
  try {
    const { uploadId } = req.body;
    await remote.cancelChunkedUpload(req.params.id, uploadId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// Get remote system stats
router.get('/api/remote/servers/:id/stats', async (req, res) => {
  try {
    const stats = await remote.getRemoteSystemStats(req.params.id);
    res.json(stats);
  } catch (err) {
    // 未连接不算错误，前端静默处理
    if (err.message === '服务器未连接') {
      res.json({ offline: true });
    } else {
      res.status(500).json({ error: errorMessage(err) });
    }
  }
});

/**
 * MFU（模型算力利用率）—— 独立端点，避免拖慢 /stats。
 *
 * /stats 是 30 秒轮询的热路径，而 MFU 需要读 vLLM /metrics 并做两次差分采样
 * （冷启动要 sleep 2s）。放同一个接口会让监控页每次都变慢，所以拆开：
 * 前端单独请求、失败不影响显卡状态展示。
 */
router.get('/api/remote/servers/:id/mfu', async (req, res) => {
  try {
    const result = await getRemoteMfu(req.params.id);
    res.json(result);
  } catch (err) {
    res.json({ available: false, reason: errorMessage(err) });
  }
});


// Execute command on remote server (with caution!)
router.post('/api/remote/servers/:id/exec', async (req, res) => {
  try {
    if (rejectUnlessRemoteExecEnabled(res)) return;
    const { command } = req.body;
    if (!command) {
      return res.status(400).json({ error: '缺少命令' });
    }
    // 安全限制：先拒绝元字符/命令链接，再校验命令白名单
    if (hasShellMetaChars(command)) {
      return res.status(403).json({ error: '命令被安全策略阻止: 不允许 shell 元字符或命令链接' });
    }
    const cmdBase = commandBaseName(command);
    if (!READONLY_COMMANDS.includes(cmdBase)) {
      return res.status(403).json({ error: '命令不允许执行' });
    }
    const result = await remote.execRemoteCommand(req.params.id, command);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// Execute shell command on remote server
router.post('/api/remote/servers/:id/shell', async (req, res) => {
  try {
    if (rejectUnlessRemoteExecEnabled(res)) return;
    const { command, timeout } = req.body;
    if (!command) {
      return res.status(400).json({ error: '缺少命令' });
    }
    // 安全限制：先拒绝元字符/命令链接，再校验命令白名单
    if (hasShellMetaChars(command)) {
      return res.status(403).json({ error: '命令被安全策略阻止: 不允许 shell 元字符或命令链接' });
    }
    const cmdBase = commandBaseName(command);
    if (!READONLY_COMMANDS.includes(cmdBase)) {
      return res.status(403).json({ error: `命令被安全策略阻止: ${cmdBase}` });
    }
    const result = await remote.execShellCommand(req.params.id, command, timeout);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: errorMessage(err) });
  }
});

// AI Shell: 自然语言转 Shell 命令并执行
router.post('/api/remote/:id/aishell', async (req, res) => {
  try {
    if (rejectUnlessRemoteExecEnabled(res)) return;
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

    // 安全校验：先拒绝元字符/命令链接，再检查命令白名单
    if (hasShellMetaChars(command)) {
      return res.status(403).json({ error: 'AI 生成的命令被安全策略阻止: 不允许 shell 元字符或命令链接', command, explanation });
    }
    const cmdBase = commandBaseName(command);
    if (!READONLY_COMMANDS.includes(cmdBase)) {
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
    res.status(500).json({ error: errorMessage(err) });
  }
});
  return router;
}
