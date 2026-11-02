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
 * 会话主循环在 chat-runner.js（要同时兼容原生 tool_calls 与文本协议降级）。
 * remote 模块直接 import（无状态函数集合）。
 */
import express from 'express';
import { errorMessage } from '../errors.js';
import * as remote from '../remote.js';
import { AGENT_TOOLS } from '../agent-tools.js';
import { listAgentActions } from '../agent-audit.js';
import {
  normalizeBaseUrl, guessEngine, ENGINE_HINTS, isToolUnsupportedError, setCachedToolSupport,
} from '../llm-provider.js';
import { createChatRunner } from './chat-runner.js';
import { resolveContextConfig, CONTEXT_DEFAULTS, CONTEXT_BOUNDS, pickPersistableConfig } from './context-config.js';

// ─── 运维助手 Tool Calling ──────────────────────────────────────────

const ASSISTANT_TOOLS = [
  // ── Docker 工具 ──
  { type: 'function', function: { name: 'docker_list', description: '列出所有Docker容器（运行状态、镜像名、端口映射、退出码等）', parameters: { type: 'object', properties: { sourceId: { type: 'string', description: 'Docker源ID（可选，不传则列出所有源）' } } } } },
  { type: 'function', function: { name: 'docker_logs', description: '读取指定容器的日志（最近N行）', parameters: { type: 'object', properties: { containerId: { type: 'string', description: '容器ID（12位短ID）或名称' }, sourceId: { type: 'string', description: 'Docker源ID（可选）' }, tail: { type: 'number', description: '读取最后N行，默认200' } }, required: ['containerId'] } } },
  { type: 'function', function: { name: 'docker_inspect', description: '查看容器详细信息（状态、端口、环境变量、挂载卷、网络）', parameters: { type: 'object', properties: { containerId: { type: 'string', description: '容器ID或名称' }, sourceId: { type: 'string', description: 'Docker源ID（可选）' } }, required: ['containerId'] } } },
  { type: 'function', function: { name: 'docker_start', description: '⚠️ 启动一个已停止的容器。需要用户确认后才能调用。', parameters: { type: 'object', properties: { containerId: { type: 'string' }, sourceId: { type: 'string' } }, required: ['containerId'] } } },
  { type: 'function', function: { name: 'docker_stop', description: '⚠️ 停止一个运行中的容器。需要用户确认后才能调用。', parameters: { type: 'object', properties: { containerId: { type: 'string' }, sourceId: { type: 'string' } }, required: ['containerId'] } } },
  { type: 'function', function: { name: 'docker_restart', description: '⚠️ 重启容器。需要用户确认后才能调用。', parameters: { type: 'object', properties: { containerId: { type: 'string' }, sourceId: { type: 'string' } }, required: ['containerId'] } } },
  { type: 'function', function: { name: 'docker_exec', description: '在容器内执行命令。只读命令（cat/ls/grep/ps/nginx -T 等）会直接执行、无需确认；会修改容器状态的命令需要用户确认。', parameters: { type: 'object', properties: { containerId: { type: 'string' }, command: { type: 'string', description: '要执行的命令' }, sourceId: { type: 'string' } }, required: ['containerId', 'command'] } } },
  { type: 'function', function: { name: 'docker_health_check', description: '执行所有容器健康诊断（检查退出状态、OOM、异常退出等）', parameters: { type: 'object', properties: {} } } },
  // ── 远程服务器工具 ──
  { type: 'function', function: { name: 'remote_servers', description: '列出已配置的远程服务器及其连接状态', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'remote_exec', description: '在远程服务器执行 Shell 命令。只读命令（ls/cat/grep/ps/df/ss/docker ps/日志查看等）会直接执行、无需确认；写文件、改配置、启停服务等命令需要用户确认。', parameters: { type: 'object', properties: { serverId: { type: 'string', description: '服务器ID' }, command: { type: 'string', description: 'Shell命令' } }, required: ['serverId', 'command'] } } },
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

/** 测试用：当前挂起数量 */
export function _pendingApprovalCount() {
  return pendingApprovals.size;
}

/**
 * 流式思维过滤器：把模型输出的思维块（`<think>…</think>`）从展示内容里剔除。
 *
 * 有两个历史上踩过的坑，这里一并修掉：
 *
 * 1. **不输出 think 标记的模型会被吞光回复。** 旧实现「没看到 <think 就把内容全缓存」，
 *    于是 Strata/Qwen 这类把思考放 reasoning_content、正文直接输出的模型，
 *    feed() 永远返回 ''，最终只靠 flush() 里「最后一行且 <100 字」的兜底挤出半句。
 *    实测：67 字的三行回答，输出 0 字。
 *
 * 2. **缓冲区只增不减导致大回答被丢。** 现在只要确认「没进入思维块」，正文立刻透传。
 *
 * 同时做流式安全：只有「可能是不完整标记的前缀」才留在缓冲里等下一个 chunk，
 * 其余一律立即输出（否则跨 chunk 的 `<thi` + `nk>` 会漏判）。
 */
const THINK_OPEN = '<think';
const THINK_CLOSE = '</think>';
const THINK_OPEN_ENTITY = '&lt;think';
const THINK_CLOSE_ENTITY = '&lt;/think&gt;';
const THINK_OPEN_TEXT = "Here's a thinking";
/** 这些前缀若出现在缓冲末尾，说明标记可能被 chunk 切开了，要等下一块 */
const PARTIAL_PREFIXES = [THINK_OPEN, THINK_CLOSE, THINK_OPEN_ENTITY, THINK_CLOSE_ENTITY, THINK_OPEN_TEXT];

class ThinkingStreamFilter {
  constructor(ensureSettings) {
    this.ensureSettings = ensureSettings;
    this.inThinkingBlock = false;
    this.buffer = '';
  }

  /** 末尾是否可能是被切断的标记前缀（是则返回该前缀长度） */
  _partialTailLength(text) {
    let maxLen = 0;
    for (const prefix of PARTIAL_PREFIXES) {
      const max = Math.min(prefix.length - 1, text.length);
      for (let len = max; len > 0; len--) {
        if (text.endsWith(prefix.slice(0, len))) { maxLen = Math.max(maxLen, len); break; }
      }
    }
    return maxLen;
  }

  /** 在一段文本里找最早的开始标记 */
  _findOpen(text) {
    let idx = -1;
    let len = 0;
    for (const [marker, l] of [[THINK_OPEN, THINK_OPEN.length], [THINK_OPEN_ENTITY, THINK_OPEN_ENTITY.length], [THINK_OPEN_TEXT, THINK_OPEN_TEXT.length]]) {
      const i = text.indexOf(marker);
      if (i !== -1 && (idx === -1 || i < idx)) { idx = i; len = l; }
    }
    return { idx, len };
  }

  /** 在一段文本里找最早的结束标记 */
  _findClose(text) {
    let idx = -1;
    let len = 0;
    for (const [marker, l] of [[THINK_CLOSE, THINK_CLOSE.length], [THINK_CLOSE_ENTITY, THINK_CLOSE_ENTITY.length]]) {
      const i = text.indexOf(marker);
      if (i !== -1 && (idx === -1 || i < idx)) { idx = i; len = l; }
    }
    return { idx, len };
  }

  feed(content) {
    if (this.ensureSettings().thinkingEnabled) return content;
    if (!content) return '';

    this.buffer += content;
    let output = '';

    // 循环处理：可能一次 chunk 里包含「正文 + 思维块 + 正文」
    for (;;) {
      if (this.inThinkingBlock) {
        const { idx, len } = this._findClose(this.buffer);
        if (idx === -1) {
          // 思维块还没结束：整段丢掉，但要保留可能的结束标记前缀
          const keep = this._partialTailLength(this.buffer);
          this.buffer = keep > 0 ? this.buffer.slice(this.buffer.length - keep) : '';
          return output;
        }
        this.buffer = this.buffer.slice(idx + len);
        this.inThinkingBlock = false;
        continue;
      }

      const { idx, len } = this._findOpen(this.buffer);
      if (idx === -1) {
        const keep = this._partialTailLength(this.buffer);
        const emit = keep > 0 ? this.buffer.slice(0, this.buffer.length - keep) : this.buffer;
        this.buffer = keep > 0 ? this.buffer.slice(this.buffer.length - keep) : '';
        return output + emit;
      }
      output += this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + len);
      this.inThinkingBlock = true;
    }
  }

  flush() {
    if (this.ensureSettings().thinkingEnabled) return '';
    if (this.inThinkingBlock) {
      this.buffer = '';
      this.inThinkingBlock = false;
      return '';
    }
    const rest = this.buffer;
    this.buffer = '';
    return rest;
  }
}

/** 测试用：暴露过滤器（chat.js 是工厂函数，类本身不对外） */
export { ThinkingStreamFilter };

export default function createChatRouter({
  ensureSettings, buildAssistantContext, executeAssistantTool,
}) {
  const router = express.Router();

  const runner = createChatRunner({
    ensureSettings,
    executeAssistantTool,
    pendingApprovals,
    nextConfirmId: () => ++confirmSeq,
    ThinkingStreamFilter,
  });

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

  // 当前推理服务能力（前端可用来提示降级状态）
  router.get('/api/chat/provider', (req, res) => {
    const s = ensureSettings();
    const baseUrl = normalizeBaseUrl(s.openaiBaseUrl || '');
    const engine = guessEngine(baseUrl, s.model);
    res.json({
      baseUrl,
      model: s.model || '',
      engine,
      engineName: ENGINE_HINTS[engine]?.name || engine,
      toolHint: ENGINE_HINTS[engine]?.toolHint || '',
    });
  });

  /**
   * 当前生效的上下文配置（齿轮面板 / 设置页初始化用）。
   *
   * 支持把前端「本会话的临时覆盖」带上来算一遍，这样面板显示的就是
   * 「如果现在发消息会用多少」而不是全局默认值。
   * 同时返回边界值，前端可直接用来做输入框范围限制。
   */
  router.get('/api/chat/context-config', (req, res) => {
    const s = ensureSettings();
    let override = {};
    if (req.query.override) {
      try { override = JSON.parse(String(req.query.override)) || {}; } catch { override = {}; }
    }
    const { config, warnings, sources } = resolveContextConfig(s, override);
    res.json({
      config,
      warnings,
      sources,
      persisted: pickPersistableConfig((s && s.assistantContext) || {}),
      defaults: CONTEXT_DEFAULTS,
      bounds: CONTEXT_BOUNDS,
    });
  });

  router.post('/api/chat', async (req, res) => {
    const { messages, contextOverride } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages required' });
    }

    const settings = ensureSettings();
    // 三级优先级：会话覆盖 > 设置页全局 > 环境变量默认；越界会夹紧并给 warnings
    const resolved = resolveContextConfig(settings, contextOverride);
    const apiKey = settings.openaiApiKey;
    // 归一成带 /v1 的地址：vLLM / SGLang / Strata / Ollama 都按这个规则
    const baseUrl = normalizeBaseUrl(settings.openaiBaseUrl || 'http://localhost:11434/v1');
    const model = settings.model;
    const isLocalModel = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(baseUrl);
    const baseUrlConfigured = baseUrl && baseUrl !== 'http://localhost:11434/v1';
    const engine = guessEngine(baseUrl, model);

    if (!apiKey && !isLocalModel && !baseUrlConfigured) {
      return res.status(400).json({ error: '未配置 API Key 或 Base URL' });
    }
    if (!model) return res.status(400).json({ error: '未配置模型' });

    // 汇总工具可用的资源上下文
    const dockerSources = settings.dockerSources || [];
    const enabledDocker = dockerSources.filter(s => s.enabled);
    const remoteServers = remote.getServers();
    const connectedRemote = remoteServers.filter(s => s.status === 'connected');
    // 服务器清单要截断：几千台全塞进 system prompt 会直接炸上下文（十万级 token）。
    // 只给前 30 台 + 总数摘要，完整清单让模型用 remote_servers 工具现查。
    const PROMPT_SERVER_LIMIT = 30;
    const serverListText = connectedRemote.length === 0
      ? (remoteServers.length > 0 ? `${remoteServers.length}台(均未连接)` : '无')
      : [
        connectedRemote.slice(0, PROMPT_SERVER_LIMIT).map(s => `${s.name}(${s.id})`).join('、'),
        connectedRemote.length > PROMPT_SERVER_LIMIT
          ? `…共 ${connectedRemote.length} 台已连接（只列前 ${PROMPT_SERVER_LIMIT} 台，其余用 remote_servers 工具查询）`
          : '',
      ].filter(Boolean).join(' ');

    const systemPrompt = `你是 OpenLog 的运维助手，一名能**亲自动手**排查和修复问题的运维工程师。你不只是给建议——你有工具可以直接读代码、改代码、改配置、跑命令。
风格：简洁有力，像老运维跟同事说话，不啰嗦不念经。用中文。
**语言要求：无论用户用什么语言提问、日志是什么语言，你的正文一律用简体中文回答**（代码、命令、日志原文保持原样）。不要用英文长句解释。
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

**查（命令执行类，只读命令自动放行，不用等确认）**
- remote_exec / docker_exec — 执行查询命令：ls/cat/grep/ps/df/ss/docker ps/systemctl status/nginx -T/journalctl 等，
  以及用管道/分号/&& 拼出来的只读组合（重定向到 /dev/null 也算只读）。
  会弹确认的：写文件重定向、tee、sed -i、find -exec、启停服务、docker run/rm/restart、sudo、命令替换。

**改（需要用户在界面上点确认）**
- remote_edit_file — 精确替换（改代码/改配置的首选，old_string 必须唯一）
- remote_write_file — 整份写入（新建文件或必须整体替换时用）
- remote_rollback_file — 用自动备份回滚
- remote_restart_service — 重启 systemd 服务（nginx/docker 等）
- remote_exec / docker_exec 的非只读命令、docker_start / docker_stop / docker_restart — 容器操作与系统变更

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
- 推理服务: ${ENGINE_HINTS[engine]?.name || engine}（${baseUrl} / ${model}）
- Docker 源: ${enabledDocker.length > 0 ? enabledDocker.map(s => s.name).join('、') : '无'}
- 远程服务器: ${serverListText}

## 最近的系统状态
${buildAssistantContext()}`;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      const OpenAI = (await import('openai')).default;
      const openai = new OpenAI({ apiKey: apiKey || (isLocalModel ? 'ollama' : 'sk-dummy'), baseURL: baseUrl });

      await runner.run({
        openai,
        baseUrl,
        model,
        messages: messages.filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'tool'),
        tools: ASSISTANT_TOOLS,
        systemPrompt,
        isLocalModel,
        res,
        contextConfig: resolved.config,
        contextWarnings: resolved.warnings,
      });
    } catch (err) {
      console.error('Chat API error:', errorMessage(err));
      // 把「不支持 tools」这类可诊断的错误说得更具体
      const hint = isToolUnsupportedError(err)
        ? `当前推理服务（${ENGINE_HINTS[engine]?.name || engine}）不支持原生工具调用：${ENGINE_HINTS[engine]?.toolHint || ''}`
        : errorMessage(err);
      if (!res.headersSent) res.status(500).json({ error: hint });
      else { res.write(`data: ${JSON.stringify({ error: hint })}\n\n`); res.end(); }
    }
  });
  return router;
}
