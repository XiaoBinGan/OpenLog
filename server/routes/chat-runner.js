/**
 * 运维助手会话执行器（从 routes/chat.js 抽出的核心循环）。
 *
 * 为什么要单独抽出来：现在要同时兼容
 *   - 支持原生 function calling 的引擎（OpenAI、Strata、加了 tool-call-parser 的 vLLM/SGLang）
 *   - 只支持 chat/completions 的引擎（没开 parser 的 vLLM/SGLang、多数本地小模型）
 * 两套协议混在一个 400 行的路由里已经没法看了，所以在这里用「模式」收敛：
 *
 *   mode='native'  → 用 OpenAI tools/tool_calls（首选）
 *   mode='text'    → 用 TOOL_CALL:/FINAL: 文本协议（降级），工具结果以文本回灌
 *
 * 切换是自动的：native 请求若报「不支持 tools」，缓存结论并就地切 text 重试，
 * 用户无感。两条路径共用同一套「确认闸门 + 审计 + 执行器」。
 */

import { errorMessage } from '../errors.js';
import * as remote from '../remote.js';
import { classifyToolRisk, buildEditPreview } from '../agent-tools.js';
import { recordAgentAction } from '../agent-audit.js';
import {
  guessEngine, getCachedToolSupport, setCachedToolSupport,
  isToolUnsupportedError, looksLikeUncalledToolUse, looksLikeFakeExecution,
  looksLikeEnglishProse, stripEnglishReasoningPreamble,
  TOOL_PROTOCOL_PROMPT, renderToolsAsText,
  parseToolProtocol, renderToolResultForTextProtocol, extractDelta,
} from '../llm-provider.js';
import { compactMessages, isContextOverflowError, isStreamOptionsUnsupported, stripToolCallBlocks, isOnlyToolCallText, estimateTokens, messagesTokens } from './chat-context.js';
import { fitMessagesToBudget } from '../context-budget.js';
import { CONTEXT_DEFAULTS, STREAM_USAGE_ENGINES } from './context-config.js';

const CONFIRM_TIMEOUT_MS = Number(process.env.OPENLOG_ASSISTANT_CONFIRM_TIMEOUT_MS) || 90_000;

/**
 * 长任务预算（可用环境变量调）。
 *
 * 背景（真实 bug）：原来硬编码 `maxRounds = 10`，且每轮把最多 20KB 的 tool_result
 * 原样塞进上下文。长任务因此有两种「突然退出」：
 *   1. 第 10 轮被硬停 —— 已有成果全丢，只剩一句「请简化问题重试」；
 *   2. 十几轮后 prompt 撑爆模型上下文窗口（实测 Strata 65k tokens 直接 400），
 *      整个任务报错中断。
 *
 * 现在：轮数/时长可配 + 每轮做上下文压缩 + 超预算时**先做一次收尾总结**再结束，
 * 而不是把用户已经查到的信息一起扔掉。
 */
export const DEFAULT_MAX_ROUNDS = Number(process.env.OPENLOG_ASSISTANT_MAX_ROUNDS) || 8;
export const DEFAULT_MAX_WALL_MS = Number(process.env.OPENLOG_ASSISTANT_MAX_WALL_MS) || 10 * 60 * 1000;
/** 上下文预算（tokens）：给模型输出和工具定义留余量，默认 48k（Strata 窗口 65536） */
export const DEFAULT_CONTEXT_BUDGET = Number(process.env.OPENLOG_ASSISTANT_CONTEXT_TOKENS) || 48_000;
/** 单条工具结果进上下文的最大字符数（20KB≈6k tokens，太贵了） */
export const DEFAULT_TOOL_RESULT_CHARS = Number(process.env.OPENLOG_ASSISTANT_TOOL_RESULT_CHARS) || 6_000;
/** SSE 心跳间隔：长时间等模型/工具时保住连接（代理/浏览器都可能掐空闲连接） */
const SSE_HEARTBEAT_MS = 15_000;
/**
 * 单轮模型调用超时。实测长任务里出现过单轮静默 180s（大 prompt 时模型排队/变慢），
 * 没有超时的话整条 SSE 就干等，用户以为卡死。超时后本轮按空响应处理并继续/收尾。
 */
export const DEFAULT_ROUND_TIMEOUT_MS = Number(process.env.OPENLOG_ASSISTANT_ROUND_TIMEOUT_MS) || 180_000;

function serverNameById(serverId) {
  if (!serverId) return undefined;
  try {
    return remote.getServers().find(s => s.id === serverId)?.name;
  } catch {
    return undefined;
  }
}

/**
 * 创建会话执行器。
 * @param {object} deps
 * @param {() => object} deps.ensureSettings
 * @param {(name:string, args:object) => Promise<object>} deps.executeAssistantTool
 * @param {Map<string, {resolve:Function, timer:any}>} deps.pendingApprovals
 * @param {() => number} deps.nextConfirmId
 * @param {any} deps.ThinkingStreamFilter 过滤 <think> 的类
 */
export function createChatRunner({ ensureSettings, executeAssistantTool, pendingApprovals, nextConfirmId, ThinkingStreamFilter }) {
  /** 等前端确认一次写操作；超时视为拒绝 */
  const waitForApproval = (confirmId, timeoutMs = CONFIRM_TIMEOUT_MS) => new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(confirmId);
      resolve(false);
    }, timeoutMs);
    if (timer.unref) timer.unref();
    pendingApprovals.set(confirmId, { resolve, timer });
  });

  /**
   * 走一次确认闸门 + 执行 + 审计。
   * @returns {Promise<{result: object}>} result.error 表示被拒或执行失败
   */
/**
 * 归一化工具参数，让"语义相同"的调用落到同一个缓存键上。
 * 只去掉空值（undefined / null / '' / 空对象），不动真实取值。
 */
function normalizeToolArgs(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (Array.isArray(value)) {
    const arr = value.map(normalizeToolArgs).filter((v) => v !== undefined);
    return arr.length === 0 ? undefined : arr;
  }
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const nv = normalizeToolArgs(v);
    if (nv !== undefined) out[k] = nv;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** 稳定序列化：键排序，避免 {a,b} 与 {b,a} 被当成不同调用 */
function stableStringify(value) {
  try {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  } catch {
    return String(value);
  }
}

  async function runToolWithGuard(tc, args, res, approvedOps, resultCache) {
    const risk = classifyToolRisk(tc.name, args);
    // 只读命令（ls/cat/grep/ps 等）直接执行，不弹确认；
    // 同一次任务里「完全相同的写操作」确认过一次就不再问（避免反复点批准）。
    const opKey = `${tc.name}:${JSON.stringify(args)}`;
    const alreadyApproved = risk.risk !== 'read' && approvedOps?.has(opKey);

    if (risk.risk !== 'read' && !alreadyApproved) {
      const confirmId = `cf-${Date.now().toString(36)}-${nextConfirmId()}`;
      const preview = tc.name === 'remote_edit_file'
        ? buildEditPreview(args.oldString, args.newString, args.replaceAll)
        : undefined;
      res.write(`data: ${JSON.stringify({
        type: 'tool_confirm', confirmId, tool: tc.name, args,
        risk: risk.risk, reason: risk.reason, preview,
      })}\n\n`);

      // 等人工确认期间也给反馈：否则用户看到的是「界面静止 1.5 分钟然后弹出拒绝」
      const deadlineAt = Date.now() + CONFIRM_TIMEOUT_MS;
      const confirmTicker = setInterval(() => {
        const left = Math.max(0, Math.round((deadlineAt - Date.now()) / 1000));
        try { res.write(`data: ${JSON.stringify({ type: 'provider_notice', message: `等待你确认「${tc.name}」（剩余 ${left}s，超时将自动拒绝）` })}\n\n`); } catch { /* 连接已断 */ }
      }, 10000);
      if (confirmTicker.unref) confirmTicker.unref();
      let approved;
      try {
        approved = await waitForApproval(confirmId);
      } finally {
        clearInterval(confirmTicker);
      }
      res.write(`data: ${JSON.stringify({ type: 'tool_confirm_result', confirmId, approved })}\n\n`);

      if (!approved) {
        const denied = { error: '用户拒绝执行该操作', skipped: true };
        recordAgentAction({
          tool: tc.name, action: 'denied',
          serverId: args.serverId, serverName: serverNameById(args.serverId),
          filePath: args.filePath || args.path, command: args.command, summary: risk.reason,
        });
        res.write(`data: ${JSON.stringify({ type: 'tool_result', tool: tc.name, result: denied, durationMs: 0 })}\n\n`);
        return { result: denied };
      }
      approvedOps?.add(opKey);
    }

    const startedAt = Date.now();
    res.write(`data: ${JSON.stringify({ type: 'tool_start', tool: tc.name, args, startedAt })}\n\n`);

    // 相同调用去重：真机上模型把「集群有几个节点」拆成 19 次调用（k8s_pods×4、remote_exec×9），
    // 白白多花 100 秒。只读工具结果在一次任务内稳定，直接复用并告知模型「这是缓存」。
    // 参数归一化再算 key：模型常把同一件事写成 {} / {clusterId:undefined} / {clusterId:'',limit:0}，
    // 语义相同却算出不同 key，去重就白做了（真机实测 k8s_overview 被调 3 次就是这原因）。
    const dedupeKey = `${tc.name}:${stableStringify(normalizeToolArgs(args))}`;
    if (risk.risk === 'read' && resultCache && resultCache.has(dedupeKey)) {
      const cached = resultCache.get(dedupeKey);
      res.write(`data: ${JSON.stringify({ type: 'tool_result', tool: tc.name, result: cached.result, durationMs: 0, cached: true })}\n\n`);
      return { result: { ...cached.result, _cached: '本次任务内已用相同参数调用过，直接复用；不要重复调用' } };
    }


    /**
     * 流式输出钩子：exec/read 类工具把 stdout/stderr 边跑边推给前端，
     * 让用户像看终端一样看到「正在执行什么、输出了什么」。
     * 模型侧仍然只拿最终结果（截断后），不影响上下文预算。
     */
    const hooks = {
      onOutput: (stream, chunk) => {
        const text = String(chunk || '');
        if (!text) return;
        // 单块限长，避免一行几万字符把 SSE 撑爆
        res.write(`data: ${JSON.stringify({
          type: 'tool_progress', tool: tc.name, stream,
          chunk: text.length > 4000 ? `${text.slice(0, 4000)}…(截断)` : text,
        })}\n\n`);
      },
    };

    let result;
    try {
      // 工具必须有独立的超时：之前 list_metrics / remote_exec 卡住时会一直等到**单轮 180s 上限**，
      // 模型那边再重试一轮，用户体感就是「等了 8 分钟然后突然结束」。
      // 超时后返回结构化错误，让模型能自己换个办法（换工具 / 缩小范围 / 告诉用户原因）。
      result = await withToolTimeout(tc.name, () => executeAssistantTool(tc.name, args, hooks));
    } catch (err) {
      result = { error: errorMessage(err) };
    }
    const durationMs = Date.now() - startedAt;
    // 只缓存"只读且成功"的结果：失败允许重试，写操作必须真的执行
    if (risk.risk === 'read' && resultCache && result && !result.error) resultCache.set(dedupeKey, { result });

    if (risk.risk !== 'read') {
      recordAgentAction({
        tool: tc.name,
        action: result?.error ? 'failed' : 'executed',
        serverId: args.serverId, serverName: serverNameById(args.serverId),
        filePath: args.filePath || args.path, command: args.command,
        summary: result?.error ? String(result.error).slice(0, 200) : (result?.preview || risk.reason),
        success: !result?.error,
      });
    }

    // durationMs 给前端展示「这一步花了多久」；result 可能很大，
    // 这里再兜一层大小上限，避免单个 SSE 事件过大把页面卡住。
    res.write(`data: ${JSON.stringify({ type: 'tool_result', tool: tc.name, result: guardUiResult(result), durationMs })}\n\n`);
    return { result };
  }

  /** 单个工具结果进 SSE 事件的大小保护（模型侧另有一套上下文截断） */
  const UI_RESULT_CHARS = 60_000;
  function guardUiResult(result) {
    try {
      const json = JSON.stringify(result ?? null);
      if (json.length <= UI_RESULT_CHARS) return result;
      return {
        truncated: true,
        _note: `输出过大（${json.length} 字符），已截断到 ${UI_RESULT_CHARS}`,
        preview: json.slice(0, UI_RESULT_CHARS),
      };
    } catch {
      return { error: '结果无法序列化' };
    }
  }

  /**
   * 跑一轮会话。
   * @param {object} opts
   * @param {any} opts.openai OpenAI SDK 客户端
   * @param {string} opts.baseUrl
   * @param {string} opts.model
   * @param {Array} opts.allMessages 会被就地追加
   * @param {Array} opts.tools 工具定义
   * @param {Array} opts.toolNames
   * @param {string} opts.systemPrompt
   * @param {boolean} opts.isLocalModel
   * @param {any} opts.res express 响应（SSE）
   * @param {number} [opts.maxRounds]
   * @param {number} [opts.maxWallMs] 总时长预算
   * @param {number} [opts.contextBudget] 上下文 token 预算（旧参数，保留兼容）
   * @param {number} [opts.maxTokens]
   * @param {object} [opts.contextConfig] 已解析的上下文配置（优先于上面两个旧参数）
   */
  async function run({
    openai, baseUrl, model, messages, tools, systemPrompt, isLocalModel, res,
    maxRounds = DEFAULT_MAX_ROUNDS,
    maxWallMs = DEFAULT_MAX_WALL_MS,
    contextBudget = DEFAULT_CONTEXT_BUDGET,
    roundTimeoutMs = DEFAULT_ROUND_TIMEOUT_MS,
    maxTokens = 4096,
    toolResultChars = DEFAULT_TOOL_RESULT_CHARS,
    contextConfig = null,
    contextWarnings = [],
  }) {
    const settings = ensureSettings();
    const engine = guessEngine(baseUrl, model);
    const startedAt = Date.now();

    // 上下文配置：优先用调用方解析好的（三级优先级已合并 + 夹紧），
    // 否则退回旧参数构造一份，保证单独调用 run() 的老路径行为不变。
    const cfg = {
      windowTokens: contextConfig?.windowTokens ?? CONTEXT_DEFAULTS.windowTokens,
      budgetTokens: contextConfig?.budgetTokens ?? contextBudget,
      maxOutputTokens: contextConfig?.maxOutputTokens ?? maxTokens,
      autoCompact: contextConfig?.autoCompact ?? true,
      compactAt: contextConfig?.compactAt ?? CONTEXT_DEFAULTS.compactAt,
      warnAt: contextConfig?.warnAt ?? CONTEXT_DEFAULTS.warnAt,
      maxRounds: contextConfig?.maxRounds ?? maxRounds,
      maxWallMs: contextConfig?.maxWallMs ?? maxWallMs,
      toolResultChars: contextConfig?.toolResultChars ?? toolResultChars,
    };
    const budgetTokens = cfg.budgetTokens;
    const outputTokens = cfg.maxOutputTokens;
    const toolChars = cfg.toolResultChars;
    maxRounds = cfg.maxRounds;
    maxWallMs = cfg.maxWallMs;

    /** 工具定义本身也占上下文（原生 tools 模式要算进去，否则前端数字偏小） */
    let toolsTokensCache = -1;
    const toolsTokens = () => {
      if (toolsTokensCache >= 0) return toolsTokensCache;
      try {
        toolsTokensCache = estimateTokens(JSON.stringify(tools || []));
      } catch {
        toolsTokensCache = 0;
      }
      return toolsTokensCache;
    };

    // 已知不支持原生 tools（上次探测结论）就直接走文本协议
    let mode = getCachedToolSupport(baseUrl, model) === false ? 'text' : 'native';
    let textModeNotified = false;

    /** 文本协议模式下追加到 system prompt 的工具清单 */
    const textProtocolSuffix = `\n\n## 工具调用协议（当前引擎不支持原生 function calling，请严格按此格式）\n${renderToolsAsText(tools)}\n\n${TOOL_PROTOCOL_PROMPT}`;
    const baseSystemPrompt = systemPrompt;

    /** 用户最近一条消息：用来判断「该不该清理英文思维链前缀」 */
    const lastUserText = (() => {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'user') return String(messages[i].content || '');
      }
      return '';
    })();
    const userIsChinese = /[\u4e00-\u9fa5]/.test(lastUserText);

    const sse = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    // ── 上下文用量上报 ────────────────────────────────────────────────
    // 每次请求模型前推一条 context_usage：前端据此画用量条。
    // 为什么在请求前而不是响应后：这一轮真正发给模型的量才是「会不会被截断」的依据。
    let compactedCount = 0;
    /** 固定开销（system+工具）已超预算的提示只发一次 */
    let fixedOverheadWarned = false;
    /** 连续「压缩了但没省下来」的次数：防止无限压缩死循环 */
    let ineffectiveCompactions = 0;
    let warnedAtPercent = 0;      // 已经提示过的档位（避免每轮重复弹）
    let providerUsage = null;     // 引擎返回的真实 usage（有就用它校准）
    let lastUsage = null;

    const buildUsage = ({ systemContent, useNative, roundNo, estimated = true }) => {
      const sysTokens = estimateTokens(systemContent);
      const toolsTok = useNative ? toolsTokens() : 0;
      const msgTok = messagesTokens(messages);
      // 有引擎实测的 prompt_tokens 就**以它为准**（这才是模型真正看到的量，
      // 也是会不会被截断的唯一可靠依据）；没有才退回本地估算。
      const estimateTotal = sysTokens + toolsTok + msgTok;
      const used = providerUsage?.promptTokens > 0 ? providerUsage.promptTokens : estimateTotal;
      const percent = budgetTokens > 0 ? Math.round((used / budgetTokens) * 1000) / 10 : 0;
      return {
        type: 'context_usage',
        used,
        budget: budgetTokens,
        window: cfg.windowTokens,
        percent,
        breakdown: { system: sysTokens, tools: toolsTok, messages: msgTok },
        compactAt: cfg.compactAtTokens ?? Math.floor(budgetTokens * cfg.compactAt),
        warnAt: cfg.warnAtTokens ?? Math.floor(budgetTokens * cfg.warnAt),
        rounds: roundNo,
        compacted: compactedCount,
        estimated: estimated && !providerUsage,
        providerUsage: providerUsage || null,
      };
    };

    const emitUsage = (ctx) => {
      const usage = buildUsage(ctx);
      lastUsage = usage;
      sse(usage);
      // 预警：只发**当前最高档**。
      // 真实踩到的坑：阈值调低后同一时刻 warn 和 critical 都满足，前端会同时弹两条
      // 提示（一条说"偏高"、一条说"即将压缩"），看起来像重复告警。
      const pct = usage.percent / 100;
      const level = pct >= cfg.compactAt ? 2 : (pct >= cfg.warnAt ? 1 : 0);
      if (level > warnedAtPercent) {
        warnedAtPercent = level;
        sse({
          type: 'context_warning',
          level: level === 2 ? 'critical' : 'warn',
          percent: usage.percent,
          used: usage.used,
          budget: usage.budget,
          window: usage.window,
          suggestion: level === 2 ? 'compact' : 'new_session',
          message: level === 2
            ? `上下文已用 ${usage.percent}%，即将自动压缩历史（较早的细节会丢失）。建议开启新会话继续。`
            : `上下文已用 ${usage.percent}%，建议开启新会话；若长期需要更大上下文，可切换到窗口更大的模型。`,
        });
      }
      return usage;
    };


    // SSE 心跳：等模型/工具时可能几十秒没有事件，代理或浏览器会掐掉空闲连接。
    // 用注释帧（`:` 开头）保活，客户端解析时会忽略。
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* 连接已断，由外层收尾 */ }
    }, SSE_HEARTBEAT_MS);
    if (heartbeat.unref) heartbeat.unref();

    const finish = (payload) => {
      clearInterval(heartbeat);
      if (payload) sse(payload);
      sse({ type: 'done' });
      res.write('data: [DONE]\n\n');
      res.end();
    };

    /** 预算/异常收尾：先让模型总结已有成果，别让用户白等一场 */
    async function summarizeAndFinish(reason) {
      // 键必须和调用方传的 reason 完全一致（曾因 rounds/round 不一致，
      // 用户看到的是「任务提前结束」这种没信息量的兜底文案）
      const notice = {
        rounds: { text: `已达到步数上限（可在助手齿轮面板或设置页调整，当前 ${maxRounds} 轮），先给你一份阶段性结论。`, type: 'rounds' },
        time: { text: `已达到单次任务时长上限（当前 ${Math.round(maxWallMs / 60000)} 分钟），先给你一份阶段性结论。`, type: 'time' },
        context: { text: '会话上下文接近模型上限，已压缩历史后给你阶段性结论。', type: 'context' },
      }[reason] || { text: '任务提前结束，这里是当前进展。', type: 'unknown' };

      try {
        const compacted = compactMessages(messages, {
          maxTokens: Math.max(2_000, Math.floor(budgetTokens * 0.6)),
          keepRecentTurns: 6,
        });
        const summaryPrompt = `${baseSystemPrompt}\n\n【系统提示】${notice.text}请立刻基于**已经拿到的工具结果**写一份阶段性总结：已经确认了什么、还差什么没查、接下来建议怎么做（不要再调用工具，直接输出回答）。`;
        const stream = await openai.chat.completions.create({
          model,
          messages: [{ role: 'system', content: summaryPrompt }, ...compacted.messages],
          stream: true,
          max_tokens: outputTokens,
        });
        let acc = '';
        // 聚合后再剥离工具调用 XML：流式逐段剥会把跨 chunk 的标签切坏
        for await (const chunk of stream) {
          const { content } = extractDelta(chunk.choices?.[0]?.delta);
          if (content) acc += content;
        }
        const f = new ThinkingStreamFilter(ensureSettings);
        const cleaned = stripToolCallBlocks(f.feed(acc) + f.flush());
        if (cleaned) {
          sse({ type: 'budget_exhausted', reason, message: notice.text });
          sse({ content: cleaned });
          finish();
          return { rounds: round, mode, exhausted: true, reason, usage: lastUsage };
        }
        // 模型只吐了工具调用 XML，没有总结 —— 不算成功，走下面的兜底提示
        console.warn('[Chat] 收尾总结只返回了工具调用 XML，已丢弃');
      } catch (err) {
        console.warn('[Chat] 收尾总结失败:', errorMessage(err));
      }
      // 总结也失败：至少把原因说清楚，别静默结束
      sse({ type: 'budget_exhausted', reason, message: notice.text });
      sse({ content: `\n\n⚠️ ${notice.text}\n（阶段总结生成失败，请回复「继续」让我接着做，或缩小任务范围。）` });
      finish();
      return { rounds: round, mode, exhausted: true, reason, usage: lastUsage };
    }

    /** 本次任务内已批准过的写操作（完全相同才跳过确认） */
    const approvedOps = new Set();
    // 只读工具结果缓存：同一任务内相同参数不重复执行（真机实测能省 100 秒）
    const toolResultCache = new Map();

    // 先把生效配置推给前端：齿轮面板/用量条要立刻知道窗口与预算，
    // 不能等第一轮模型返回（大 prompt 时可能几十秒）。
    sse({
      type: 'context_config',
      config: {
        windowTokens: cfg.windowTokens,
        budgetTokens: cfg.budgetTokens,
        maxOutputTokens: cfg.maxOutputTokens,
        autoCompact: cfg.autoCompact,
        compactAt: cfg.compactAt,
        warnAt: cfg.warnAt,
        maxRounds: cfg.maxRounds,
        maxWallMs: cfg.maxWallMs,
        compactAtTokens: cfg.compactAtTokens ?? Math.floor(budgetTokens * cfg.compactAt),
        warnAtTokens: cfg.warnAtTokens ?? Math.floor(budgetTokens * cfg.warnAt),
      },
      engine,
      model,
      warnings: Array.isArray(contextWarnings) ? contextWarnings : [],
    });

    let round = 0;
    /** 上下文超限只做一次深度压缩，避免死循环 */
    let contextRetried = false;
    /** 单轮模型超时次数：连续两次就收尾（模型明显顶不住了） */
    let roundTimeouts = 0;
  let retriedUpstream = false;
    /** 本次任务里是否真正执行过工具（识别「没调工具却声称已执行」用） */
    let anyToolExecuted = false;
    /** 假执行纠正只做一次，避免模型较劲时死循环 */
    let fakeExecCorrected = false;

    /**
     * 抓「没调工具就报完成」的假执行。
     *
     * 真实表现：文本协议降级后，模型回「收到，工具连接正常」——本轮没有
     * TOOL_CALL，也没有任何工具结果，用户却以为它查过了。这里在收尾前拦一次：
     * 把这句话塞回上下文 + 一条纠正指令，让它要么真调工具、要么承认没执行。
     *
     * @returns {boolean} true = 已拦截并要求重试（调用方应 continue，不要 finish）
     */
    const maybeCorrectFakeExecution = (text) => {
      if (anyToolExecuted || fakeExecCorrected) return false;
      if (!looksLikeFakeExecution(text)) return false;
      fakeExecCorrected = true;
      sse({
        type: 'provider_notice',
        message: '模型声称已执行操作，但本轮没有真正调用任何工具 —— 已要求它重新执行',
        engine,
      });
      messages.push({ role: 'assistant', content: text });
      messages.push({
        role: 'user',
        content: '你刚才的回答声称已经执行/连接/修复，但这一轮你并没有真正调用任何工具（既没有 tool_calls，也没有 TOOL_CALL）。'
          + '要么立刻真正调用工具再回答，要么明确告诉用户「我没有执行任何操作」。禁止编造执行结果。',
      });
      return true;
    };

    while (round < maxRounds) {
      // 时长预算
      if (Date.now() - startedAt > maxWallMs) {
        return summarizeAndFinish('time');
      }
      round++;

      const useNative = mode === 'native';
      const systemContent = useNative ? baseSystemPrompt : `${baseSystemPrompt}${textProtocolSuffix}`;

      // 每次请求前做上下文压缩：超出预算就压缩旧工具结果（长任务的根因之一）
      // 阈值来自配置：默认在预算的 85% 触发，给「压缩后还能继续干活」留余量。
      const systemTokens = estimateTokens(systemContent);
      const toolsTok = useNative ? toolsTokens() : 0;
      /** system + 工具定义是压不掉的固定开销；它俩超预算时压缩再多次也没用 */
      const fixedOverhead = systemTokens + toolsTok;
      const beforeTokens = fixedOverhead + messagesTokens(messages);

      // 固定开销已经吃掉预算的大半 → 说明配置本身不合理（预算太小或工具太多），
      // 直接告诉用户怎么改，而不是每轮徒劳压缩。
      if (fixedOverhead >= budgetTokens * 0.9) {
        if (!fixedOverheadWarned) {
          fixedOverheadWarned = true;
          sse({
            type: 'context_warning',
            level: 'critical',
            percent: Math.round((beforeTokens / Math.max(1, budgetTokens)) * 1000) / 10,
            used: beforeTokens,
            budget: budgetTokens,
            window: cfg.windowTokens,
            suggestion: 'raise_budget',
            message: `系统提示 + 工具定义已占约 ${Math.round(fixedOverhead / 100) / 10}k tokens，接近当前预算 ${Math.round(budgetTokens / 1000)}k，压缩历史无法腾出空间。`
              + `请在设置页或齿轮面板把「上下文预算」调大到至少 ${Math.ceil((fixedOverhead * 2) / 1000)}k（模型窗口允许的话）。`,
          });
        }
      } else {
        // 只在**真正越过阈值**时压缩，而不是每轮都压。
        // 之前每轮都拿「阈值对应的目标」去压，导致一越过 85% 就每轮压缩一次
        // （实测 30 轮出现 30 次压缩，每次都截断历史，长任务体验很差）。
        // 现在：越过 compactAt 才触发，且一次压到 60% 左右留出余量。
        const triggerTokens = Math.floor(budgetTokens * (cfg.autoCompact ? cfg.compactAt : 0.99));
        const targetMessagesTokens = Math.max(
          500,
          Math.min(
            Math.floor(budgetTokens * 0.6) - fixedOverhead,
            budgetTokens - fixedOverhead - outputTokens,
          ),
        );
        const compacted = beforeTokens > triggerTokens
          ? compactMessages(messages, { maxTokens: targetMessagesTokens })
          : { messages, tokens: messagesTokens(messages), compressed: false, dropped: 0 };
        if (compacted.compressed) {
          messages = compacted.messages;
          compactedCount += 1;
          const afterTokens = fixedOverhead + messagesTokens(messages);
          const saved = beforeTokens - afterTokens;
          // 压缩无效（几乎没省）也算一次：连续两次说明压不动了，别无限循环
          if (saved < 200) ineffectiveCompactions += 1;
          else ineffectiveCompactions = 0;
          sse({
            type: 'context_compacted',
            before: beforeTokens,
            after: afterTokens,
            tokens: compacted.tokens,
            dropped: compacted.dropped,
            count: compactedCount,
            trigger: 'budget',
            message: saved >= 200
              ? `上下文接近上限，已压缩早期工具结果（${compacted.dropped} 条，约省 ${Math.round(saved / 1000)}k tokens）`
              : '上下文已压缩，但可压缩内容有限（早期消息已很精简）',
          });
          if (ineffectiveCompactions >= 2) return summarizeAndFinish('context');
        }
      }

      // 最后一道保险：把消息硬压进「窗口安全线」内。
      //
      // 为什么压缩完还要再压：`budgetTokens` 是用户可见的预算（默认 48k），
      // 而小窗口模型（16k）很多引擎对超长 prompt **不报错、直接静默截断** ——
      // 模型看到半截对话就会「抽风」（重复、忘任务、编命令）。这里按
      // window - system - tools - output - 安全余量 再兜一次，宁丢老消息也不超窗。
      {
        const hardPromptBudget = Math.max(512, budgetTokens - fixedOverhead);
        const curTokens = messagesTokens(messages);
        if (curTokens > hardPromptBudget) {
          const fit = fitMessagesToBudget(messages, hardPromptBudget);
          if (fit.messages !== messages) {
            messages = fit.messages;
            sse({
              type: 'context_compacted',
              before: fixedOverhead + curTokens,
              after: fixedOverhead + fit.tokens,
              tokens: fit.tokens,
              dropped: fit.dropped,
              count: ++compactedCount,
              trigger: 'window',
              message: `当前模型窗口约 ${cfg.windowTokens} tokens，已丢弃最早的 ${fit.dropped} 条历史以腾出空间（否则小模型会因超长被静默截断而答非所问）`,
            });
          }
        }
      }

      // 每次重建消息头，保证 system prompt 与当前模式一致
      const roundMessages = [{ role: 'system', content: systemContent }, ...messages];

      // 请求前上报用量（前端用量条/预警依赖它）
      emitUsage({ systemContent, useNative, roundNo: round });

      const params = {
        model,
        messages: roundMessages,
        stream: true,
        max_tokens: outputTokens,
      };
      // 让引擎顺带返回真实 token 用量（部分引擎不支持，失败会自动降级重试）
      let requestStreamUsage = STREAM_USAGE_ENGINES.has(engine);
      if (requestStreamUsage) params.stream_options = { include_usage: true };
      if (isLocalModel) params.temperature = 0.7;
      if (useNative) {
        params.tools = tools;
        params.tool_choice = 'auto';
      }

      const llmStartedAt = Date.now();
      let stream;
      const abortCtl = new AbortController();
      const roundTimer = setTimeout(() => {
        try { abortCtl.abort(new Error('模型响应超时')); } catch { /* 忽略 */ }
      }, roundTimeoutMs);
      if (roundTimer.unref) roundTimer.unref();
      try {
        stream = await openai.chat.completions.create(params, { signal: abortCtl.signal });
      } catch (err) {
        clearTimeout(roundTimer);
        // 引擎不认 stream_options（部分 vLLM/SGLang 老版本会 400）→ 去掉重试本轮
        if (requestStreamUsage && isStreamOptionsUnsupported(err)) {
          requestStreamUsage = false;
          sse({ type: 'provider_notice', message: '当前推理服务不支持返回 token 用量，已改用本地估算（不影响使用）', engine });
          round--;
          continue;
        }
        // 引擎不支持 tools → 缓存结论，切文本协议重试本轮（不消耗轮次预算）
        if (useNative && isToolUnsupportedError(err)) {
          setCachedToolSupport(baseUrl, model, false);
          mode = 'text';
          round--;
          if (!textModeNotified) {
            textModeNotified = true;
            sse({ type: 'provider_notice', message: '当前推理服务不支持原生工具调用，已自动切换为文本协议（功能不变）', engine });
          }
          continue;
        }
        // 上下文超限（模型侧硬限制）→ 深度压缩后重试一次，别直接失败
        if (isContextOverflowError(err) && !contextRetried) {
          contextRetried = true;
          const beforeTokens = messagesTokens(messages);
          const harder = compactMessages(messages, {
            maxTokens: Math.max(2_000, Math.floor(budgetTokens * 0.5)),
            keepRecentTurns: 4,
            keepChars: 600,
          });
          messages = harder.messages;
          round--;
          compactedCount += 1;
          sse({
            type: 'context_compacted',
            before: beforeTokens,
            after: harder.tokens,
            tokens: harder.tokens,
            dropped: harder.dropped,
            count: compactedCount,
            trigger: 'overflow',
            message: `模型上下文超限，已深度压缩历史（约 ${Math.round(harder.tokens / 1000)}k tokens）后重试`,
          });
          continue;
        }
        if (isContextOverflowError(err)) return summarizeAndFinish('context');
        // 单轮超时：不把整个任务打死，记一笔重试一次，连续超时则收尾
        if (abortCtl.signal.aborted) {
          roundTimeouts += 1;
          sse({ type: 'provider_notice', message: `模型本轮响应超时（${Math.round(roundTimeoutMs / 1000)}s），已重试`, engine });
          if (roundTimeouts >= 2) return summarizeAndFinish('time');
          round--;
          continue;
        }
        throw err;
      }

      let contentAcc = '';
      let reasoningAcc = '';
      const toolCallAcc = new Map();
      /**
       * 原生模式下边收边推正文：长回答不再「憋到最后一次性吐出来」。
       *
       * 什么时候开始流：
       *   - 本次任务已经真执行过工具（anyToolExecuted）→ 直接流，模型确实在干活；
       *   - 还没执行过任何工具 → 要防「假执行」话术（「收到，工具连接正常」这类
       *     短句提前推出去就没法收回，用户会先看到假话再看到纠正提示）：
       *     攒到 16 字且开头 60 字不像假执行时才开流；攒到 60 字也强制开流
       *     （正常长回答里偶尔出现「已修复」不该把整段回答憋住）。
       */
      const liveFilter = useNative ? new ThinkingStreamFilter(ensureSettings) : null;
      let streamedContent = '';
      let streamingStarted = false;
      const shouldStartStreaming = () => {
        // 中文提问却先吐英文散文：很可能是模型把 reasoning 写进了正文 —— 先等中文出现，
        // 否则用户先看到一大段英文思维链（等太久宁可整段最后一次性发）
        if (userIsChinese && !anyToolExecuted && contentAcc.length < 400 && looksLikeEnglishProse(contentAcc)) {
          return false;
        }
        return anyToolExecuted
          || contentAcc.length >= 60
          || (contentAcc.length >= 16 && !looksLikeFakeExecution(contentAcc.slice(0, 60)));
      };

    // 首字可能等十几秒（T4 上加载/排队都慢）。这期间如果一声不吭，用户会以为卡死 ——
    // 所以每 3 秒推一条 status，界面上的「思考中」会带着已等待秒数动起来。
    let firstChunkAt = 0;
    const waitTicker = setInterval(() => {
      const waited = Math.round((Date.now() - llmStartedAt) / 1000);
      if (waited >= 3) {
        try { sse({ status: `模型思考中…（已等待 ${waited}s）` }); } catch { /* 连接已断 */ }
      }
    }, 3000);
    if (waitTicker.unref) waitTicker.unref();
    try {
        for await (const chunk of stream) {
          // 引擎返回的真实用量（stream_options.include_usage）：这类 chunk 通常没有 choices，
          // 必须在 `continue` 之前捕获，否则永远拿不到。
          if (chunk?.usage) {
            const u = chunk.usage;
            providerUsage = {
              promptTokens: Number(u.prompt_tokens) || 0,
              completionTokens: Number(u.completion_tokens) || 0,
              totalTokens: Number(u.total_tokens) || 0,
            };
          }
      // 注意：不能在这里清计时器 —— OpenAI 兼容流的第一帧通常是 role 空 delta，
      // 在这里清会导致「等待首字」的提示永远不出现（线上实测 10s 等待、0 条进度帧）。
      // 真正的首字判定放到 content / reasoning / tool_calls 分支里。

          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;
          const { content, reasoning } = extractDelta(delta);
          if (content) {
        if (!firstChunkAt) { firstChunkAt = Date.now(); clearInterval(waitTicker); }
            contentAcc += content;
            if (liveFilter) {
              if (!streamingStarted && shouldStartStreaming()) {
                // 开始流式：把之前攒下的整段一次性喂进去
                streamingStarted = true;
                // 中文提问时，剥掉模型漏在开头的英文思维链（真实用户反馈过「返回都是英文」）
                const startText = userIsChinese
                  ? stripEnglishReasoningPreamble(contentAcc, lastUserText)
                  : contentAcc;
                const out = liveFilter.feed(startText);
                if (out) { streamedContent += out; sse({ content: out }); }
              } else if (streamingStarted) {
                const out = liveFilter.feed(content);
                if (out) { streamedContent += out; sse({ content: out }); }
              }
            }
          }
        if (!firstChunkAt) { firstChunkAt = Date.now(); clearInterval(waitTicker); }
          if (reasoning) reasoningAcc += reasoning;
          if (useNative && delta.tool_calls) {
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
      } catch (err) {
        // 流式过程中被超时中断（已收到部分输出时保留，继续下一轮）
        if (abortCtl.signal.aborted) {
          roundTimeouts += 1;
          if (contentAcc.trim()) sse({ content: `\n\n（本轮输出被中断：模型 ${Math.round(roundTimeoutMs / 1000)}s 未响应完）` });
          if (roundTimeouts >= 2) return summarizeAndFinish('time');
          continue;
        }
        // 上游断连（Connection error / ECONNRESET / 早停）：一次自动重试，别让用户对着半截流发呆。
        // 已收到正文时不再重试（避免重复输出），只补一句说明。
        if (isUpstreamConnectionError(err)) {
          const hint = upstreamConnectionHint(err, baseUrl);
          if (!contentAcc.trim() && !retriedUpstream) {
            retriedUpstream = true;
            sse({ type: 'provider_notice', message: `${hint}，正在自动重试一次`, engine });
            round--;
            continue;
          }
          sse({ type: 'provider_notice', message: hint, engine });
          return summarizeAndFinish('error');
        }
        throw err;
      } finally {
        clearInterval(waitTicker);
        clearTimeout(roundTimer);
      }

      // 收尾：把思维过滤器里还没吐出的尾巴推出去（正文已经边收边推过了）
      if (liveFilter) {
        const tail = liveFilter.flush();
        if (tail) { streamedContent += tail; sse({ content: tail }); }
      }

      // 引擎返回了真实 prompt_tokens 时补发一条校准后的用量：
      // 否则前端一直显示估算值（首轮是在请求**前**上报的，那时还没有 usage）。
      if (providerUsage && providerUsage.promptTokens > 0) {
        emitUsage({ systemContent, useNative, roundNo: round, estimated: false });
      }

      const llmMs = Date.now() - llmStartedAt;
      if (llmMs > 30_000) console.warn(`[Chat] 第 ${round} 轮模型响应慢: ${llmMs}ms`);
      else console.log(`[Chat] 第 ${round} 轮模型 ${llmMs}ms`);

      // 引擎确实支持原生 tools（这次成功拿到 tool_calls）→ 缓存结论
      if (useNative && toolCallAcc.size > 0) setCachedToolSupport(baseUrl, model, true);

      // ── 静默忽略 tools 的引擎（vLLM/SGLang 未开 parser）──
      // 现象：传了 tools 不报错，但返回的是「我需要调用 xxx 工具」这类文字，没有任何 action。
      // 处理：判为不支持原生 tools，丢弃这段废话，切文本协议重试本轮。
      if (useNative && toolCallAcc.size === 0 && round === 1 && contentAcc.trim()
        && looksLikeUncalledToolUse(contentAcc, tools.map(t => t.function?.name).filter(Boolean))) {
        setCachedToolSupport(baseUrl, model, false);
        mode = 'text';
        round--;
        if (!textModeNotified) {
          textModeNotified = true;
          sse({ type: 'provider_notice', message: '当前推理服务未真正启用原生工具调用（请求被静默忽略），已自动切换为文本协议', engine });
        }
        continue;
      }

      // 思维过程：仅在设置允许时推给前端
      if (reasoningAcc && settings.thinkingEnabled) {
        sse({ reasoning_content: reasoningAcc });
      }

      // ── 原生模式：有 tool_calls 就走工具 ──
      if (useNative && toolCallAcc.size > 0) {
        const toolCalls = [...toolCallAcc.values()];
        // 正文在流式阶段已经推给前端了，这里不要再补发一遍（否则内容重复）
        messages.push({
          role: 'assistant',
          content: contentAcc || null,
          tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } })),
        });
        for (const tc of toolCalls) {
          let args = {};
          try { args = JSON.parse(tc.arguments); } catch { args = {}; }
          const toolStartedAt = Date.now();
          const { result } = await runToolWithGuard(tc, args, res, approvedOps, toolResultCache);
          anyToolExecuted = true;
          const toolMs = Date.now() - toolStartedAt;
          if (toolMs > 10_000) console.warn(`[Chat] 工具 ${tc.name} 耗时 ${toolMs}ms`);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result).slice(0, toolChars) });
        }
        continue;
      }

      // ── 文本协议模式：从正文里解析 TOOL_CALL / FINAL ──
      if (!useNative) {
        // 过滤思维块后再解析（有的模型会把 <think> 混在正文里）
        const f = new ThinkingStreamFilter(ensureSettings);
        const cleaned = (f.feed(contentAcc) + f.flush()).trim();
        const parsed = parseToolProtocol(cleaned);

        if (parsed.kind === 'tool') {
          messages.push({ role: 'assistant', content: contentAcc || null });
          const { result } = await runToolWithGuard({ name: parsed.tool, arguments: JSON.stringify(parsed.args) }, parsed.args, res, approvedOps, toolResultCache);
          anyToolExecuted = true;
          messages.push({ role: 'user', content: renderToolResultForTextProtocol(parsed.tool, result) });
          continue;
        }

        const finalText = parsed.kind === 'final' ? parsed.content : (parsed.content || contentAcc);
        // 没调过任何工具却声称「已执行/已连接」→ 纠正一次再让它继续
        if (maybeCorrectFakeExecution(finalText)) continue;
        if (finalText) sse({ content: finalText });
        finish();
        return { rounds: round, mode };
      }

      // ── 原生模式但没 tool_calls：正常回答 ──
      // 正文在流式阶段已经推过了；这里只处理「没流出去的部分」和假执行拦截。
      const f = new ThinkingStreamFilter(ensureSettings);
      const filtered = f.feed(contentAcc) + f.flush();
      // 模型有时把「打算调用什么」写成 XML 正文，剥掉再展示
      const visible = stripToolCallBlocks(filtered);
      // 同样的假执行拦截（原生模式下模型也可能直接编答案）
      if (maybeCorrectFakeExecution(visible || filtered)) continue;
      if (!streamedContent) {
        // 一句正文都没流出去（例如思维块被整段过滤）才补发；
        // 顺手剥掉模型漏进正文的英文思维链前缀（中文提问时）
        const cleaned = userIsChinese
          ? stripEnglishReasoningPreamble(visible)
          : visible;
        if (cleaned) sse({ content: cleaned });
        else if (isOnlyToolCallText(filtered)) {
          console.warn('[Chat] 模型只输出工具调用 XML，无有效正文');
          sse({ type: 'provider_notice', message: '模型返回了无法执行的工具调用格式，已忽略。可以再问一次或换个模型。' });
        }
      }
      finish();
      return { rounds: round, mode };
    }

    // 轮数预算用尽：先给阶段性总结，而不是一句「请简化问题重试」把成果丢掉
    return summarizeAndFinish('rounds');
  }

  return { run, waitForApproval };
}

export default createChatRunner;


/**
 * 上游「连不上 / 连接被断」这一类错误。
 *
 * OpenAI SDK 对 fetch 层的失败统一包成 `Connection error.`，真正原因藏在 cause 里；
 * strata/vLLM 在 OOM 或模型卸载时也会直接断流。这些都应该重试或给出可操作提示，
 * 而不是把 `Connection error.; request to http://...` 原样丢给用户（英文、且看不出该做什么）。
 */
export const DEFAULT_TOOL_TIMEOUT_MS = Number(process.env.OPENLOG_ASSISTANT_TOOL_TIMEOUT_MS) || 45_000;

/**
 * 给单次工具调用套一个超时。
 *
 * 为什么必须有：工具里可能连 SSH、查时序库、跑远程命令，任何一处卡住都会把整轮对话拖到
 * 180s 的单轮上限；模型再重试一轮，用户看到的就是「长时间等待 + 突然结束」。
 * 超时返回的是结构化错误（isError），模型可以据此换策略，而不是沉默。
 */
async function withToolTimeout(name, fn, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({
      error: `工具 ${name} 超过 ${Math.round(timeoutMs / 1000)}s 未返回，已中止（可能是远端不可达或数据量过大）`,
      timeout: true,
    }), timeoutMs);
    if (timer.unref) timer.unref();
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function isUpstreamConnectionError(err) {
  const text = `${err?.message || ''} ${err?.cause?.code || ''} ${err?.code || ''}`.toLowerCase();
  return /connection error|econnrefused|econnreset|etimedout|socket hang up|terminated|fetch failed|network/.test(text);
}

/** 把连接错误翻成中文可操作提示（带地址，方便判断是模型没起还是地址配错） */
function upstreamConnectionHint(err, baseUrl) {
  const code = err?.cause?.code || err?.code || '';
  const target = String(baseUrl || '').replace(/\/v1\/?$/, '');
  const detail = code ? `（${code}）` : '';
  return `模型服务不可达${detail}：${target || '未配置地址'} —— 检查推理服务是否在运行、`
    + `地址与端口是否正确、以及它所在的机器是否可达`;
}

