/**
 * routes/chat.js — 运维助手对话（SSE 流式 + 工具调用）
 *
 * 从 server/index.js 抽出。这是最后一条从 index.js 搬走的路由。
 *
 * 注入：
 *   ensureSettings         —— 读取当前生效配置（apiKey / baseUrl / model / dockerSources）
 *   buildAssistantContext  —— 汇总可用资源上下文（docker 源 + 远程机器）
 *   executeAssistantTool   —— 执行模型请求的工具调用；内部会走 docker / remote / 本机三条路径
 *
 * remote 模块直接 import（无状态函数集合）。
 */
import express from 'express';
import { errorMessage } from '../errors.js';
import * as remote from '../remote.js';
import { AGENT_TOOLS, classifyToolRisk, buildEditPreview } from '../agent-tools.js';
import { recordAgentAction, listAgentActions } from '../agent-audit.js';

/** serverId → 服务器名（审计里记名字比记 uuid 好认） */
function serverNameById(serverId) {
  if (!serverId) return undefined;
  try {
    return remote.getServers().find(s => s.id === serverId)?.name;
  } catch {
    return undefined;
  }
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
  // ── 远程代码/配置读写（错误定位 + 修复）──
  ...AGENT_TOOLS,
];

/**
 * 待确认的写操作：confirmId → { resolve, timer }
 * 前端收到 tool_confirm 事件后弹确认框，再 POST /api/chat/confirm 放行/拒绝。
 *
 * 为什么确认要放在服务端：只靠提示词说「先问用户」是不可靠的 ——
 * 模型漏问一次就会直接改线上文件。这里在代码层面拦一道。
 */
const pendingApprovals = new Map();
let confirmSeq = 0;

/** 测试用：清理挂起的确认 */
export function _clearPendingApprovals() {
  for (const [, entry] of pendingApprovals) {
    clearTimeout(entry.timer);
    entry.resolve(false);
  }
  pendingApprovals.clear();
}

// 🧠 流式思维过滤器：过滤 Qwen3 等模型的思维过程
/**
 * 流式思维过滤器：过滤 Qwen3 等模型的思维过程。
 *
 * 原本是 index.js 的模块级 class，直接闭包引用 ensureSettings。
 * 搬到本文件后改为构造器注入 —— 它每次 feed/flush 都要读 thinkingEnabled。
 */
class ThinkingStreamFilter {
  constructor(ensureSettings) {
    this.ensureSettings = ensureSettings;
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
    if (this.ensureSettings().thinkingEnabled) return content;
    if (!content) return '';

    const { output } = this._extract(this.buffer + content);
    return output;
  }

  flush() {
    if (this.ensureSettings().thinkingEnabled) return '';
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

export default function createChatRouter({
  ensureSettings, buildAssistantContext, executeAssistantTool,
}) {
  const router = express.Router();

/** 等待前端确认一次写操作；超时视为拒绝 */
const CONFIRM_TIMEOUT_MS = 3 * 60 * 1000;

function waitForApproval(confirmId, timeoutMs = CONFIRM_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(confirmId);
      resolve(false);
    }, timeoutMs);
    if (timer.unref) timer.unref();
    pendingApprovals.set(confirmId, { resolve, timer });
  });
}

// 前端确认/拒绝一次写操作
router.post('/api/chat/confirm', (req, res) => {
  const { confirmId, approved } = req.body || {};
  const entry = pendingApprovals.get(confirmId);
  if (!entry) return res.status(404).json({ error: '确认请求不存在或已超时' });
  clearTimeout(entry.timer);
  pendingApprovals.delete(confirmId);
  entry.resolve(Boolean(approved));
  res.json({ ok: true, approved: Boolean(approved) });
});

// 运维助手写操作审计流水（用真实 SSH 账号时，这是事后复查/回滚的入口）
router.get('/api/chat/audit', (req, res) => {
  const limit = Number(req.query.limit) || 50;
  const serverId = req.query.serverId ? String(req.query.serverId) : undefined;
  res.json({ actions: listAgentActions(limit, serverId) });
});

router.post('/api/chat', async (req, res) => {
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
    content: `你是 OpenLog 的运维助手，一名能**亲自动手**排查和修复问题的运维工程师。你不只是给建议——你有工具可以直接读代码、改代码、改配置、跑命令。
风格：简洁有力，像老运维跟同事说话，不啰嗦不念经。用中文。
格式：关键结论加粗，代码用 \`\`\` 包裹，操作步骤编号列出。

## 🔧 你的工具
**查（自动执行）**
- remote_servers — 列出服务器（拿 serverId，**第一步通常先调这个**）
- remote_stat / remote_ls — 看文件/目录属性与列表
- remote_read_file — 读文件（带行号，可指定 startLine/endLine）
- remote_grep — 在目录/文件里搜索（**错误定位的主力**，返回 文件:行号:内容）
- remote_git_status / remote_git_diff — 看仓库改动，确认自己改了什么
- remote_system_stats / remote_search_logs — 系统状态与日志检索
- docker_list / docker_logs / docker_inspect / docker_health_check — 容器排查
- local_system_stats / local_log_files / local_read_log — OpenLog 所在机器

**改（需要用户在界面上点确认）**
- remote_edit_file — 精确替换（改代码/改配置的首选，old_string 必须唯一）
- remote_write_file — 整份写入（新建文件或必须整体替换时用）
- remote_rollback_file — 用自动备份回滚
- remote_restart_service — 重启 systemd 服务（nginx/docker 等）
- remote_exec / docker_exec / docker_start / docker_stop / docker_restart — 执行命令与容器操作

## 🎯 定位并修复问题的标准流程
1. **确认目标**：remote_servers 拿 serverId；不确定服务在哪台机器时先问或看上下文。
2. **定位**：remote_grep 搜报错关键字 → remote_read_file 读相关代码/配置（带行号）。
   看日志优先用 remote_search_logs 或 remote_read_file 读日志尾部。
3. **说明方案**：改之前用一两句话讲清楚「改哪个文件、哪一行、改成什么、为什么」。
4. **动手改**：用 remote_edit_file，old_string 要包含足够上下文保证唯一。
   （写操作会弹确认框给用户，不需要你在文字里再问一遍；但方案要讲清楚）
5. **验证**：改完必须验证——remote_read_file 复核改动、remote_exec 跑语法检查/测试、
   或重启服务后看日志。没验证过不要宣布"已修复"。
6. **兜底**：验证失败就继续排查；改错了用 remote_rollback_file 回滚。

## 📌 原则
- **主动推进**：收到任务立刻调工具，不要等用户推一步走一步。
- **工具失败换方案**：Docker 源不可用就走 SSH 执行 docker 命令；某条路不通就换。
- **不要瞎猜**：没读过的文件不要假设内容；没执行过的命令不要说已执行。
- **最小改动**：只改必要的那几行，不要顺手重构、不要动无关文件。
- **改配置前先备份**：remote_edit_file / remote_write_file 会自动备份，但你要在回答里说明备份存在。
- **危险操作**：删除、格式化、重启生产服务这类，必须先说明影响，让用户在确认框里决定。

## 📋 当前环境
- Docker 源: ${enabledDocker.length > 0 ? enabledDocker.map(s => s.name).join('、') : '无'}
- 远程服务器: ${connectedRemote.length > 0 ? connectedRemote.map(s => `${s.name}(${s.id})`).join('、') : (remoteServers.length > 0 ? `${remoteServers.length}台(均未连接)` : '无')}

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

    // ── Tool Calling 循环 ──
    // 定位+修复一个线上问题常常要 6-8 步（grep → 读文件 → 看日志 → 改 → 验证），
    // 5 轮太少，放宽到 10 轮；每轮都有超时与工具结果截断兜底。
    let toolRound = 0;
    const MAX_TOOL_ROUNDS = 10;

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
          const thinkingFilter = new ThinkingStreamFilter(ensureSettings);
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

          // ── 写操作确认闸门 ──────────────────────────────────────────
          // read 直接跑；write / danger 必须等前端确认（默认 3 分钟超时视为拒绝）
          const risk = classifyToolRisk(tc.name, args);
          if (risk.risk !== 'read') {
            const confirmId = `cf-${Date.now().toString(36)}-${++confirmSeq}`;
            const preview = tc.name === 'remote_edit_file'
              ? buildEditPreview(args.oldString, args.newString, args.replaceAll)
              : undefined;
            res.write(`data: ${JSON.stringify({
              type: 'tool_confirm',
              confirmId,
              tool: tc.name,
              args,
              risk: risk.risk,
              reason: risk.reason,
              preview,
            })}\n\n`);

            const approved = await waitForApproval(confirmId);
            res.write(`data: ${JSON.stringify({ type: 'tool_confirm_result', confirmId, approved })}\n\n`);

            if (!approved) {
              const denied = { error: '用户拒绝执行该操作', skipped: true };
              recordAgentAction({
                tool: tc.name,
                action: 'denied',
                serverId: args.serverId,
                serverName: serverNameById(args.serverId),
                filePath: args.filePath || args.path,
                command: args.command,
                summary: risk.reason,
              });
              res.write(`data: ${JSON.stringify({ type: 'tool_result', tool: tc.name, result: denied })}\n\n`);
              allMessages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: JSON.stringify(denied),
              });
              continue;
            }
          }

          res.write(`data: ${JSON.stringify({ type: 'tool_start', tool: tc.name, args })}\n\n`);

          const result = await executeAssistantTool(tc.name, args);

          // 审计：写/危险操作（已确认执行）留一条可复查的记录
          if (risk.risk !== 'read') {
            recordAgentAction({
              tool: tc.name,
              action: result?.error ? 'failed' : 'executed',
              serverId: args.serverId,
              serverName: serverNameById(args.serverId),
              filePath: args.filePath || args.path,
              command: args.command,
              summary: result?.error ? String(result.error).slice(0, 200) : (result?.preview || risk.reason),
              success: !result?.error,
            });
          }

          res.write(`data: ${JSON.stringify({ type: 'tool_result', tool: tc.name, result })}\n\n`);

          allMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(result).slice(0, 20000),
          });
        }

        // 继续循环，让 LLM 基于工具结果回复
        continue;
      }

      // 无工具调用 → 流式输出最终内容
      const thinkingFilter = new ThinkingStreamFilter(ensureSettings);
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
    console.error('Chat API error:', errorMessage(err));
    if (!res.headersSent) res.status(500).json({ error: errorMessage(err) });
    else { res.write(`data: ${JSON.stringify({ error: errorMessage(err) })}\n\n`); res.end(); }
  }
});
  return router;
}
