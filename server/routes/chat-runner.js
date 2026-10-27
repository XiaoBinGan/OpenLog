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
  isToolUnsupportedError, TOOL_PROTOCOL_PROMPT, renderToolsAsText,
  parseToolProtocol, renderToolResultForTextProtocol, extractDelta,
} from '../llm-provider.js';

const CONFIRM_TIMEOUT_MS = 3 * 60 * 1000;

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
   * @param {number} [opts.maxTokens]
   */
  async function run({ openai, baseUrl, model, messages, tools, systemPrompt, isLocalModel, res, maxRounds = 10, maxTokens = 4096 }) {
    const settings = ensureSettings();
    const engine = guessEngine(baseUrl, model);

    // 已知不支持原生 tools（上次探测结论）就直接走文本协议
    let mode = getCachedToolSupport(baseUrl, model) === false ? 'text' : 'native';
    let textModeNotified = false;

    /** 文本协议模式下追加到 system prompt 的工具清单 */
    const textProtocolSuffix = `\n\n## 工具调用协议（当前引擎不支持原生 function calling，请严格按此格式）\n${renderToolsAsText(tools)}\n\n${TOOL_PROTOCOL_PROMPT}`;
    let baseSystemPrompt = systemPrompt;

    const sse = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    let round = 0;
    while (round < maxRounds) {
      round++;

      const useNative = mode === 'native';
      const systemContent = useNative ? baseSystemPrompt : `${baseSystemPrompt}${textProtocolSuffix}`;

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

      let stream;
      try {
        stream = await openai.chat.completions.create(params);
      } catch (err) {
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
        throw err;
      }

      let contentAcc = '';
      let reasoningAcc = '';
      const toolCallAcc = new Map();

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

      // 引擎确实支持原生 tools（这次成功拿到 tool_calls）→ 缓存结论
      if (useNative && toolCallAcc.size > 0) setCachedToolSupport(baseUrl, model, true);

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
          const { result } = await runToolWithGuard(tc, args, res);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 20000) });
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
        sse({ type: 'done' });
        res.write('data: [DONE]\n\n');
        res.end();
        return { rounds: round, mode };
      }

      // ── 原生模式但没 tool_calls：正常回答 ──
      const f = new ThinkingStreamFilter(ensureSettings);
      const filtered = f.feed(contentAcc) + f.flush();
      if (filtered) sse({ content: filtered });
      sse({ type: 'done' });
      res.write('data: [DONE]\n\n');
      res.end();
      return { rounds: round, mode };
    }

    sse({ content: '\n\n⚠️ 工具调用轮数已达上限，请简化问题重试。' });
    sse({ type: 'done' });
    res.write('data: [DONE]\n\n');
    res.end();
    return { rounds: round, mode, exhausted: true };
  }

  return { run, waitForApproval };
}

export default createChatRunner;
