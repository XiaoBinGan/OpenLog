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
  normalizeBaseUrl, guessEngine, getCachedToolSupport, setCachedToolSupport,
  isToolUnsupportedError, looksLikeUncalledToolUse, TOOL_PROTOCOL_PROMPT, renderToolsAsText,
  parseToolProtocol, renderToolResultForTextProtocol, extractDelta,
} from '../llm-provider.js';
import { compactMessages, isContextOverflowError, stripToolCallBlocks, isOnlyToolCallText } from './chat-context.js';

const CONFIRM_TIMEOUT_MS = 3 * 60 * 1000;

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
export const DEFAULT_MAX_ROUNDS = Number(process.env.OPENLOG_ASSISTANT_MAX_ROUNDS) || 30;
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
  async function runToolWithGuard(tc, args, res) {
    const risk = classifyToolRisk(tc.name, args);

    if (risk.risk !== 'read') {
      const confirmId = `cf-${Date.now().toString(36)}-${nextConfirmId()}`;
      const preview = tc.name === 'remote_edit_file'
        ? buildEditPreview(args.oldString, args.newString, args.replaceAll)
        : undefined;
      res.write(`data: ${JSON.stringify({
        type: 'tool_confirm', confirmId, tool: tc.name, args,
        risk: risk.risk, reason: risk.reason, preview,
      })}\n\n`);

      const approved = await waitForApproval(confirmId);
      res.write(`data: ${JSON.stringify({ type: 'tool_confirm_result', confirmId, approved })}\n\n`);

      if (!approved) {
        const denied = { error: '用户拒绝执行该操作', skipped: true };
        recordAgentAction({
          tool: tc.name, action: 'denied',
          serverId: args.serverId, serverName: serverNameById(args.serverId),
          filePath: args.filePath || args.path, command: args.command, summary: risk.reason,
        });
        res.write(`data: ${JSON.stringify({ type: 'tool_result', tool: tc.name, result: denied })}\n\n`);
        return { result: denied };
      }
    }

    res.write(`data: ${JSON.stringify({ type: 'tool_start', tool: tc.name, args })}\n\n`);
    const result = await executeAssistantTool(tc.name, args);

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

    res.write(`data: ${JSON.stringify({ type: 'tool_result', tool: tc.name, result })}\n\n`);
    return { result };
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
   * @param {number} [opts.contextBudget] 上下文 token 预算
   * @param {number} [opts.maxTokens]
   */
  async function run({
    openai, baseUrl, model, messages, tools, systemPrompt, isLocalModel, res,
    maxRounds = DEFAULT_MAX_ROUNDS,
    maxWallMs = DEFAULT_MAX_WALL_MS,
    contextBudget = DEFAULT_CONTEXT_BUDGET,
    roundTimeoutMs = DEFAULT_ROUND_TIMEOUT_MS,
    maxTokens = 4096,
    toolResultChars = DEFAULT_TOOL_RESULT_CHARS,
  }) {
    const settings = ensureSettings();
    const engine = guessEngine(baseUrl, model);
    const startedAt = Date.now();

    // 已知不支持原生 tools（上次探测结论）就直接走文本协议
    let mode = getCachedToolSupport(baseUrl, model) === false ? 'text' : 'native';
    let textModeNotified = false;

    /** 文本协议模式下追加到 system prompt 的工具清单 */
    const textProtocolSuffix = `\n\n## 工具调用协议（当前引擎不支持原生 function calling，请严格按此格式）\n${renderToolsAsText(tools)}\n\n${TOOL_PROTOCOL_PROMPT}`;
    const baseSystemPrompt = systemPrompt;

    const sse = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

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
        rounds: { text: '已达到步数上限（可用 OPENLOG_ASSISTANT_MAX_ROUNDS 调整），先给你一份阶段性结论。', type: 'rounds' },
        time: { text: '已达到单次任务时长上限，先给你一份阶段性结论。', type: 'time' },
        context: { text: '会话上下文接近模型上限，已压缩历史后给你阶段性结论。', type: 'context' },
      }[reason] || { text: '任务提前结束，这里是当前进展。', type: 'unknown' };

      try {
        const compacted = compactMessages(messages, { maxTokens: Math.floor(contextBudget * 0.6), keepRecentTurns: 6 });
        const summaryPrompt = `${baseSystemPrompt}\n\n【系统提示】${notice.text}请立刻基于**已经拿到的工具结果**写一份阶段性总结：已经确认了什么、还差什么没查、接下来建议怎么做（不要再调用工具，直接输出回答）。`;
        const stream = await openai.chat.completions.create({
          model,
          messages: [{ role: 'system', content: summaryPrompt }, ...compacted.messages],
          stream: true,
          max_tokens: maxTokens,
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
          return { rounds: round, mode, exhausted: true, reason };
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
      return { rounds: round, mode, exhausted: true, reason };
    }

    let round = 0;
    /** 上下文超限只做一次深度压缩，避免死循环 */
    let contextRetried = false;
    /** 单轮模型超时次数：连续两次就收尾（模型明显顶不住了） */
    let roundTimeouts = 0;
    while (round < maxRounds) {
      // 时长预算
      if (Date.now() - startedAt > maxWallMs) {
        return summarizeAndFinish('time');
      }
      round++;

      const useNative = mode === 'native';
      const systemContent = useNative ? baseSystemPrompt : `${baseSystemPrompt}${textProtocolSuffix}`;

      // 每次请求前做上下文压缩：超出预算就压缩旧工具结果（长任务的根因之一）
      const systemTokens = Math.ceil(systemContent.length / 2);
      const compacted = compactMessages(messages, {
        maxTokens: Math.max(4_000, contextBudget - systemTokens - maxTokens),
      });
      if (compacted.compressed) {
        messages = compacted.messages;
        sse({
          type: 'context_compacted',
          tokens: compacted.tokens,
          dropped: compacted.dropped,
          message: `上下文接近上限，已压缩早期工具结果（约 ${Math.round(compacted.tokens / 1000)}k tokens）`,
        });
      }

      // 每次重建消息头，保证 system prompt 与当前模式一致
      const roundMessages = [{ role: 'system', content: systemContent }, ...messages];

      const params = {
        model,
        messages: roundMessages,
        stream: true,
        max_tokens: maxTokens,
      };
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
        // 上下文超限（模型侧硬限制）→ 压缩到 60% 预算后重试一次，别直接失败
        if (isContextOverflowError(err) && !contextRetried) {
          contextRetried = true;
          const harder = compactMessages(messages, {
            maxTokens: Math.max(2_000, Math.floor(contextBudget * 0.5)),
            keepRecentTurns: 4,
            keepChars: 600,
          });
          messages = harder.messages;
          round--;
          sse({
            type: 'context_compacted',
            tokens: harder.tokens,
            dropped: harder.dropped,
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

      try {
        for await (const chunk of stream) {
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;
          const { content, reasoning } = extractDelta(delta);
          if (content) contentAcc += content;
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
        throw err;
      } finally {
        clearTimeout(roundTimer);
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
        if (contentAcc.trim()) {
          const f = new ThinkingStreamFilter(ensureSettings);
          const filtered = f.feed(contentAcc) + f.flush();
          if (filtered) sse({ content: filtered });
        }
        messages.push({
          role: 'assistant',
          content: contentAcc || null,
          tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } })),
        });
        for (const tc of toolCalls) {
          let args = {};
          try { args = JSON.parse(tc.arguments); } catch { args = {}; }
          const toolStartedAt = Date.now();
          const { result } = await runToolWithGuard(tc, args, res);
          const toolMs = Date.now() - toolStartedAt;
          if (toolMs > 10_000) console.warn(`[Chat] 工具 ${tc.name} 耗时 ${toolMs}ms`);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result).slice(0, toolResultChars) });
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
          const { result } = await runToolWithGuard({ name: parsed.tool, arguments: JSON.stringify(parsed.args) }, parsed.args, res);
          messages.push({ role: 'user', content: renderToolResultForTextProtocol(parsed.tool, result) });
          continue;
        }

        const finalText = parsed.kind === 'final' ? parsed.content : (parsed.content || contentAcc);
        if (finalText) sse({ content: finalText });
        finish();
        return { rounds: round, mode };
      }

      // ── 原生模式但没 tool_calls：正常回答 ──
      const f = new ThinkingStreamFilter(ensureSettings);
      const filtered = f.feed(contentAcc) + f.flush();
      // 模型有时把「打算调用什么」写成 XML 正文，剥掉再展示
      const visible = stripToolCallBlocks(filtered);
      if (visible) {
        sse({ content: visible });
      } else if (isOnlyToolCallText(filtered)) {
        console.warn('[Chat] 模型只输出工具调用 XML，无有效正文');
        sse({ type: 'provider_notice', message: '模型返回了无法执行的工具调用格式，已忽略。可以再问一次或换个模型。' });
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
