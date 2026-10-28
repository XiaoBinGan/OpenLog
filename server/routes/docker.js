/**
 * routes/docker.js — Docker 容器查询、日志分析、巡检与操作
 *
 * 从 server/index.js 抽出（24 个路由）。这是依赖面最宽的一个路由组，
 * 因为它同时横跨「读配置」「跑 LLM」「写分析历史」「推 WebSocket」「驱动巡检定时器」。
 *
 * 注入（index.js 的模块级状态与函数）：
 *   ensureSettings       —— 读取当前生效配置
 *   broadcast            —— 向所有 WS 客户端推送
 *   addAnalysisRecord    —— 写入分析历史
 *   buildHostExecMap     —— 构建宿主机执行映射（需 docker + remote 两侧信息）
 *   stripThinking        —— 依赖 ensureSettings 的 LLM 文本过滤器
 *   getLastPatrolResults —— 巡检结果由 index.js 的定时器和本文件共同读写，
 *   setLastPatrolResults    因此注入取值/设值访问器而不是值本身
 *
 * 直接 import：docker 模块、uuid、命令安全策略（与 routes/remote.js 共用同一份）。
 */
import express from 'express';
import { errorMessage } from '../errors.js';
import { v4 as uuidv4 } from 'uuid';
import * as docker from '../docker.js';
import {
  hasShellMetaChars, rejectUnlessContainerExecEnabled,
  READONLY_COMMANDS, commandBaseName,
} from '../security/shell-command-policy.js';
import { getServers } from '../remote.js';
import { resolveDockerTransport } from '../docker-transport.js';

export default function createDockerRouter({
  ensureSettings, broadcast, addAnalysisRecord, buildHostExecMap, stripThinking,
  getLastPatrolResults, setLastPatrolResults,
}) {
  const router = express.Router();

/**
 * sourceId 白名单 —— 必须注册在 router 最前面。
 *
 * 原实现里各路由都写 `(ensureSettings().dockerSources || []).find(s => s.id === sourceId)`，
 * 找不到源时得到 undefined，随后被写成 `config = {}`。而 getDocker 对空配置的默认值是
 *     host = 'localhost', port = 2375
 * 于是**任何不存在的 sourceId 都会静默地去连本机 Docker**。
 * 在把 2375 暴露出来的机器上，那是个无鉴权的 Docker API —— 拼错一个 id 就打到它上面。
 *
 * 用 router.param 只写一次：只要路径里带 :sourceId 就先校验，
 * 不存在直接 404，不再往下走。
 *
 * 注意 `/api/docker/ping` 不在此列 —— 它从 body 取 sourceId 且允许传任意 config，
 * 是「保存前先测一下能不能连」用的，必须保留原行为。
 */
router.param('sourceId', (req, res, next, sourceId) => {
  const sources = ensureSettings().dockerSources || [];
  const source = sources.find((s) => s.id === sourceId);
  if (!source) {
    res.status(404).json({ error: `Docker 源不存在: ${sourceId}` });
    return;
  }
  // 顺带把解析结果挂上，省得每条路由再查一遍
  req.dockerSource = source;
  next();
});

// Docker API Routes
// ========================================

// 获取 Docker 连接状态（测试连接）
router.post('/api/docker/ping', async (req, res) => {
  const { sourceId, config } = req.body;
  console.log('[Docker ping] sourceId:', sourceId, 'config:', JSON.stringify(config));
  const result = await docker.pingDocker(sourceId || 'local', config || {});
  res.json(result);
});

// 执行命令（容器内）
// 必须注册在通用路由 POST /api/docker/:sourceId/:containerId/:op **之前**。
// 否则会被它先匹配到，落到 default 分支返回 400「不支持的操作: exec」——
// Docker 页面的「容器内执行命令」面板打的就是这条路由（真实 bug）。
// 安全策略与 REST 远程命令执行共用：默认关闭 + 元字符过滤 + 只读白名单。
router.post('/api/docker/:sourceId/:containerId/exec', async (req, res) => {
  const { sourceId, containerId } = req.params;
  const { command } = req.body;
  if (rejectUnlessContainerExecEnabled(res)) return;
  const config = await getDockerConfig(sourceId);
  if (!config) return res.status(404).json({ error: 'Docker 源未找到' });
  if (!command) return res.status(400).json({ error: '缺少 command 参数' });
  if (hasShellMetaChars(command)) {
    return res.status(403).json({ error: '命令被安全策略阻止: 不允许 shell 元字符或命令链接' });
  }
  const cmdBase = commandBaseName(command);
  if (!READONLY_COMMANDS.includes(cmdBase)) {
    return res.status(403).json({ error: `命令被安全策略阻止: ${cmdBase}` });
  }

  try {
    const { output } = await docker.execInContainer(sourceId, containerId, command, config);
    res.json({ output });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});
// Docker 容器操作（stop/start/restart/remove）
router.post('/api/docker/:sourceId/:containerId/:op', async (req, res) => {
  try {
    const { sourceId, containerId, op } = req.params;
    const source = (ensureSettings().dockerSources || []).find(s => s.id === sourceId);
    const config = await resolveDockerTransport(source);
    let result;
    switch (op) {
      case 'start': result = await docker.startContainer(sourceId, containerId, config); break;
      case 'stop': result = await docker.stopContainer(sourceId, containerId, config); break;
      case 'restart': result = await docker.restartContainer(sourceId, containerId, config); break;
      case 'remove': result = await docker.removeContainer(sourceId, containerId, config); break;
      default: return res.status(400).json({ error: '不支持的操作: ' + op });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// 获取所有 Docker 配置的容器列表
router.get('/api/docker/containers', async (req, res) => {
  try {
    const allContainers = [];
    const sources = ensureSettings().dockerSources || [];
    const enabled = sources.filter(s => s.enabled);

    for (const source of enabled) {
      // via(SSH) 源没有 host 字段，它指向的是某台远程服务器的 docker.sock。
      // 前端「远程设备」模式是按 host 过滤 Docker 源的，不把 host 解析出来
      // 这个源会在设备模式下被整体过滤掉 —— 表现为「所有 Docker 连接均失败」。
      // 同时回传 serverId，供前端按服务器精确匹配（同一 host 可能有多台）。
      const viaHost = source.via?.serverId
        ? (getServers().find(r => r.id === source.via.serverId)?.host || '')
        : '';
      const meta = {
        sourceId: source.id,
        sourceName: source.name,
        host: source.host || viaHost,
        serverId: source.via?.serverId || '',
      };

      try {
        const containers = await docker.listContainers(source.id, await resolveDockerTransport(source));
        allContainers.push({ ...meta, containers });
      } catch (err) {
        allContainers.push({ ...meta, error: errorMessage(err), containers: [] });
      }
    }

    res.json({ sources: allContainers });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// 获取单个容器的详情
router.get('/api/docker/containers/:sourceId/:containerId', async (req, res) => {
  try {
    const { sourceId, containerId } = req.params;
    const source = (ensureSettings().dockerSources || []).find(s => s.id === sourceId);
    const config = await resolveDockerTransport(source);

    // 原实现调用 docker.getContainer(sourceId, containerId, config)，
    // 但 docker.js 从未导出过这个名字 —— 这条路由对任何请求都只会抛
    // "docker.getContainer is not a function"。改为用导出的 getDocker()
    // 取客户端，再按 dockerode 的 API inspect 容器。
    const client = docker.getDocker(sourceId, config);
    const container = await client.getContainer(containerId).inspect();
    res.json(container);
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// 读取容器日志
router.get('/api/docker/containers/:sourceId/:containerId/logs', async (req, res) => {
  try {
    const { sourceId, containerId } = req.params;
    const { tail = 200, since, startTime, filterLevel } = req.query;
    const source = (ensureSettings().dockerSources || []).find(s => s.id === sourceId);
    const config = await resolveDockerTransport(source);

    const logs = await docker.getContainerLogs(sourceId, containerId, config, {
      tail: parseInt(tail),
      since, startTime, filterLevel,
    });
    res.json({ logs, containerId, sourceId });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// 读取多个容器的日志（联合会诊）
router.post('/api/docker/logs/batch', async (req, res) => {
  try {
    const { containers, tail = 200 } = req.body; // containers: [{sourceId, containerId, name}]
    const results = [];

    for (const { sourceId, containerId, name } of containers) {
      try {
        const source = (ensureSettings().dockerSources || []).find(s => s.id === sourceId);
        const config = await resolveDockerTransport(source);
        const logs = await docker.getContainerLogs(sourceId, containerId, config, { tail: parseInt(tail) });
        results.push({ sourceId, containerId, name, logs, ok: true });
      } catch (err) {
        results.push({ sourceId, containerId, name, logs: [], ok: false, error: errorMessage(err) });
      }
    }

    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// 上下游链路追踪
router.get('/api/docker/trace/:sourceId/:containerId', async (req, res) => {
  try {
    const { sourceId, containerId } = req.params;
    const source = (ensureSettings().dockerSources || []).find(s => s.id === sourceId);
    const config = await resolveDockerTransport(source);

    const trace = await docker.traceContainerLinks(sourceId, containerId, config);
    res.json(trace);
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// 批量分析多个容器日志（联合会诊）
router.post('/api/docker/analyze/batch', async (req, res) => {
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
        const config = await resolveDockerTransport(source);
        const logs = await docker.getContainerLogs(sid, containerId, config, { tail: 200 });
        allLogs.push({ sourceId: sid, containerId, name, logs });
      } catch (err) {
        allLogs.push({ sourceId: sid, containerId, name, logs: [], error: errorMessage(err) });
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
          message: errorMessage(err),
          sourceId: 'docker-batch'
        });
      }
    });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// ─── Docker 容器健康诊断 API ────────────────────────────
router.get('/api/docker/health-check', async (req, res) => {
  try {
    const sources = ensureSettings().dockerSources || [];
    const report = await docker.healthCheck(sources);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

router.post('/api/docker/health-check/analyze', async (req, res) => {
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
    console.error('[health-check/analyze]', errorMessage(err));
    if (!res.headersSent) res.status(500).json({ error: errorMessage(err) });
    else { res.write(`data: ${JSON.stringify({ error: errorMessage(err) })}\n\n`); res.end(); }

    addAnalysisRecord({
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      type: 'health',
      sourceName: '健康诊断',
      analysis: null,
      summary: '',
      status: 'error',
      error: errorMessage(err),
      model: ensureSettings().model
    });
  }
});


// ─── 容器日志巡检 API ───────────────────────────────────
// 获取最近一次巡检结果
router.get('/api/docker/patrol', (req, res) => {
  res.json({ results: getLastPatrolResults(), timestamp: new Date().toISOString() });
});

// 立即触发一次巡检
router.post('/api/docker/patrol/now', async (req, res) => {
  try {
    const sources = ensureSettings().dockerSources || [];
    const levels = ensureSettings().containerPatrolLevels || ['ERROR', 'FATAL'];
    const hostExecMap = buildHostExecMap();
    const results = await docker.patrolContainerLogs(sources, levels, (src) => hostExecMap.get(src.host) || null);
    if (results.length > 0) {
      setLastPatrolResults(results);
    }
    broadcast({ type: 'container_patrol', data: { results, timestamp: new Date().toISOString() } });
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// 重置巡检检查点（容器重启后需要调用）
router.post('/api/docker/patrol/reset', async (_req, res) => {
  docker.resetPatrolCheckpoints();
  res.json({ success: true });
});

// 获取最后一次巡检结果
router.get('/api/docker/patrol/last', async (_req, res) => {
  res.json({ results: getLastPatrolResults(), timestamp: getLastPatrolResults().length > 0 ? new Date().toISOString() : null });
});

// AI 分析巡检结果（SSE 流式）
router.post('/api/docker/patrol/analyze', async (req, res) => {
  try {
    // 直接用缓存结果；如果没数据说明还没有异常日志
    let results = getLastPatrolResults();
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
    console.error('[patrol/analyze]', errorMessage(err));
    if (!res.headersSent) res.status(500).json({ error: errorMessage(err) });
    else { res.write(`data: ${JSON.stringify({ error: errorMessage(err) })}\n\n`); res.end(); }

    addAnalysisRecord({
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      type: 'patrol',
      sourceName: '容器巡检',
      analysis: null,
      summary: '',
      status: 'error',
      error: errorMessage(err),
      model: ensureSettings().model
    });
  }
});

// ────────────────────────────────────────
// 单容器异常诊断（SSE 流式）
// ────────────────────────────────────────
router.post('/api/docker/container/:sourceId/:containerId/analyze', async (req, res) => {
  try {
    const { sourceId, containerId } = req.params;
    const { exitCode, exitType, exitLabel, image } = req.body;

    const apiKey = ensureSettings().openaiApiKey;
    const baseUrl = ensureSettings().openaiBaseUrl;
    const model = ensureSettings().model;

    if (!apiKey) return res.status(400).json({ error: '未配置 API Key' });

    const config = await getDockerConfig(sourceId);
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
    console.error('[container/analyze]', errorMessage(err));
    if (!res.headersSent) res.status(500).json({ error: errorMessage(err) });
    else { res.write(`data: ${JSON.stringify({ error: errorMessage(err) })}\n\n`); res.end(); }

    addAnalysisRecord({
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      type: 'health',
      sourceName: '容器诊断',
      analysis: null,
      summary: '',
      status: 'error',
      error: errorMessage(err),
      model: ensureSettings().model
    });
  }
});

// 别名：/diagnose → /analyze（兼容前端 Docker 诊断按钮）
router.post('/api/docker/container/:sourceId/:containerId/diagnose', async (req, res) => {
  req.url = req.url.replace('/diagnose', '/analyze');
  // router 内没有 app 绑定；req.app 就是主应用，语义与原来完全一致
  req.app.handle(req, res);
});

// ────────────────────────────────────────
// Docker 容器操作
// ────────────────────────────────────────
function getDockerConfig(sourceId) {
  const source = (ensureSettings().dockerSources || []).find(s => s.id === sourceId);
  if (!source) return null;
  return resolveDockerTransport(source);
}


async function runDockerOp(req, res, opName, args = []) {
  const { sourceId, containerId } = req.params;
  const config = await getDockerConfig(sourceId);
  if (!config) return res.status(404).json({ error: 'Docker 源未找到' });

  try {
    const op = docker[opName];
    const result = await op(sourceId, containerId, ...args, config);
    res.json({ ok: true, ...result });
  } catch (err) {
    // dockerode 错误通常是 statusCode + message 格式。
    // errorMessage 已保证非空：原写法 `err.message || String(err)` 在
    // AggregateError 下会退化成字符串 "AggregateError"，同样没有诊断价值。
    const msg = errorMessage(err);
    const status = err.statusCode || (msg.toLowerCase().includes('not found') ? 404 : 500);
    res.status(status).json({ error: msg });
  }
}

router.post('/api/docker/:sourceId/:containerId/start',  (req, res) => runDockerOp(req, res, 'startContainer'));
router.post('/api/docker/:sourceId/:containerId/stop',   (req, res) => runDockerOp(req, res, 'stopContainer'));
router.post('/api/docker/:sourceId/:containerId/restart', (req, res) => runDockerOp(req, res, 'restartContainer'));
router.post('/api/docker/:sourceId/:containerId/pause',  (req, res) => runDockerOp(req, res, 'pauseContainer'));
router.post('/api/docker/:sourceId/:containerId/unpause',(req, res) => runDockerOp(req, res, 'unpauseContainer'));
router.delete('/api/docker/:sourceId/:containerId',      (req, res) => runDockerOp(req, res, 'removeContainer'));

  return router;
}
