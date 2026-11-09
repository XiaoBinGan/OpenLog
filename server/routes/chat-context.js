/**
 * chat-context.js — 运维助手会话的上下文预算管理。
 *
 * 为什么需要：长任务会不断把 tool_result 塞进 messages，每条最多 20KB。
 * 十几轮之后 prompt 就会撞模型的上下文窗口 —— 实测 Strata 在 65k tokens 时直接返回
 *   `request exceeds the context window: prompt (65609 tokens) leaves no room to answer`
 * 整个任务就此中断，前面辛苦查到的结果全丢。
 *
 * 这里做两件事：
 *   1. **估算 token**：不引 tokenizer，按字符类型粗略估（中文≈1 token/字，ASCII≈1 token/3.5 字符），
 *      结果用于预算判断，不需要精确；
 *   2. **压缩历史**：保留最近几轮的完整工具结果，更早的替换成一行摘要（工具名 + 关键字段 + 截断标志），
 *      并在超出预算时逐级加严（先截断旧的，再截断近的，最后连 assistant 正文也截断）。
 *
 * 关键约束：**不能拆散 tool_calls 与 tool 消息的配对**（OpenAI 协议要求
 * 带 tool_calls 的 assistant 消息后面必须紧跟对应的 tool 消息，否则上游 400）。
 * 所以压缩只改内容，不改消息结构。
 */

import { contentTokens } from '../vision-content.js';

/** 中文/日文/韩文等宽字符按 1 token 估；其余按 3.5 字符 1 token 估 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  let wide = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code > 0x2e80) wide += 1; // CJK、全角标点
  }
  const narrow = s.length - wide;
  return Math.ceil(wide + narrow / 3.5);
}

/**
 * 一条消息的 token 估算。
 *
 * 多模态注意：图片按固定常量算（`IMAGE_TOKEN_ESTIMATE`），**绝不**对 base64 正文做
 * `estimateTokens(JSON.stringify(content))` —— 那样一张 300KB 的图会被估成 8.5 万 token，
 * 预算当场爆掉，历史会被整段丢弃。
 */
export function messageTokens(msg) {
  if (!msg) return 0;
  let total = 0;
  if (typeof msg.content === 'string') total += estimateTokens(msg.content);
  else if (Array.isArray(msg.content)) total += contentTokens(msg.content, estimateTokens);
  if (msg.tool_calls) total += estimateTokens(JSON.stringify(msg.tool_calls));
  return total + 4; // 角色/分隔符的固定开销
}

/** 整个消息数组的 token 估算 */
export function messagesTokens(messages) {
  return (messages || []).reduce((sum, m) => sum + messageTokens(m), 0);
}

/** 单条工具结果保留的最大字符数（压缩时用） */
export const TOOL_RESULT_KEEP_CHARS = 1200;
/** 更早的工具结果压缩后的字符数 */
export const TOOL_RESULT_SUMMARY_CHARS = 240;

/**
 * 把一条前端展示过的工具结果压成一行摘要。
 *
 * 保留「哪个工具、看了什么、有没有报错」，丢掉大段内容 ——
 * 模型需要细节时会重新调用工具（比背着一堆过期输出更准）。
 */
export function summarizeToolResult(toolName, content) {
  const text = String(content ?? '');
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }

  const parts = [toolName || 'tool'];
  if (parsed && typeof parsed === 'object') {
    if (parsed.error) parts.push(`错误: ${String(parsed.error).slice(0, 120)}`);
    for (const key of ['filePath', 'path', 'command', 'pattern', 'service', 'containerId', 'serverId']) {
      if (parsed[key]) { parts.push(`${key}=${String(parsed[key]).slice(0, 80)}`); break; }
    }
    if (typeof parsed.matchCount === 'number') parts.push(`命中 ${parsed.matchCount} 行`);
    if (typeof parsed.bytes === 'number') parts.push(`${parsed.bytes} 字节`);
    if (typeof parsed.success === 'boolean') parts.push(parsed.success ? '成功' : '失败');
    if (parsed.truncated) parts.push('（已截断）');
    if (parsed.replacements) parts.push(`替换 ${parsed.replacements} 处`);
  }
  const head = text.replace(/\s+/g, ' ').slice(0, TOOL_RESULT_SUMMARY_CHARS);
  if (parts.length > 1) return `[历史结果已压缩] ${parts.join(' ')} | ${head}…`;
  // 非 JSON / 没有可提取字段：也要带上工具名，模型才知道这一步做了什么
  return `[历史结果已压缩] ${parts[0]} | ${head}…`;
}

/** 取 tool 消息对应的工具名（从前面最近的 assistant.tool_calls 里找） */
function toolNameForToolMessage(messages, index) {
  for (let i = index - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
      const call = m.tool_calls.find(tc => tc.id === messages[index].tool_call_id);
      if (call) return call.function?.name || 'tool';
    }
    if (m?.role === 'user') return 'tool';
  }
  return 'tool';
}

/**
 * 按预算压缩消息（返回**新数组**，不修改入参）。
 *
 * @param {Array} messages 原始会话消息（不含 system）
 * @param {object} [opts]
 * @param {number} [opts.maxTokens] 目标上限（含 system 之外的预算）
 * @param {number} [opts.keepRecentTurns] 最近多少条消息保持完整（默认 8）
 * @param {number} [opts.keepChars] 完整保留时单条工具结果的最大字符数
 * @returns {{ messages:Array, tokens:number, compressed:boolean, dropped:number }}
 */
export function compactMessages(messages, opts = {}) {
  const {
    maxTokens = 48_000,
    keepRecentTurns = 8,
    keepChars = TOOL_RESULT_KEEP_CHARS,
  } = opts;

  const list = Array.isArray(messages) ? messages : [];
  const before = messagesTokens(list);
  if (before <= maxTokens) {
    return { messages: list, tokens: before, compressed: false, dropped: 0 };
  }

  // 第一级：最近 keepRecentTurns 之外的工具结果 → 一行摘要
  const cutoff = Math.max(0, list.length - keepRecentTurns);
  let compressedCount = 0;
  let out = list.map((m, i) => {
    if (m?.role !== 'tool' || i >= cutoff) return m;
    const toolName = toolNameForToolMessage(list, i);
    const next = summarizeToolResult(toolName, m.content);
    if (next !== m.content) compressedCount += 1;
    return { ...m, content: next };
  });

  // 第二级：仍超预算 → 最近几轮的工具结果也截断到 keepChars
  let tokens = messagesTokens(out);
  if (tokens > maxTokens) {
    out = out.map((m, i) => {
      if (m?.role !== 'tool' || i < cutoff) return m;
      const text = String(m.content ?? '');
      if (text.length <= keepChars) return m;
      return { ...m, content: `${text.slice(0, keepChars)}\n…[输出过长已截断]` };
    });
    tokens = messagesTokens(out);
  }

  // 第三级：还超 → 从最早的消息开始丢，但**保留 tool_calls 配对**
  // （丢 assistant.tool_calls 时必须连着它的 tool 消息一起丢）
  let dropped = 0;
  while (tokens > maxTokens && out.length > 4) {
    // 找最早的一段「assistant(tool_calls) + 紧随的 tool 消息」
    let dropStart = -1;
    let dropEnd = -1;
    for (let i = 0; i < out.length - 4; i++) {
      if (out[i]?.role === 'assistant' && Array.isArray(out[i].tool_calls) && out[i].tool_calls.length > 0) {
        // 注意：压缩后工具结果可能已不是 tool 角色（不），这里安全地跳过
        dropStart = i;
        let j = i + 1;
        while (j < out.length && out[j]?.role === 'tool') j += 1;
        dropEnd = j;
        break;
      }
    }
    if (dropStart === -1) {
      // 纯文本对话（没有 tool_calls）也要能压缩。
      // 真实 bug：原实现找不到 assistant(tool_calls) 就直接 break，于是
      // 「一问一答」型长会话（最常见的情况）永远不会被压缩 —— 用量一路涨到
      // 超预算，最后只能靠模型报上下文超限来兜底。
      // 这里退化成「按整轮（user+assistant）从最早开始丢」，同样保住最后 4 条。
      const keepTail = 4;
      let removable = 0;
      while (removable < out.length - keepTail) {
        const m = out[removable];
        // 从头开始，一直删到遇到第一条 user 消息为止（保证不留下无主的回答）
        if (m?.role === 'user') break;
        removable += 1;
      }
      if (removable === 0) {
        // 第一条就是 user：把它和紧随的 assistant 一起丢掉（成对丢，不拆散问答）
        removable = Math.min(
          out.length - keepTail,
          out[0]?.role === 'user' && out[1]?.role === 'assistant' ? 2 : 1,
        );
      }
      if (removable <= 0) break;
      out = out.slice(removable);
      dropped += removable;
      tokens = messagesTokens(out);
      continue;
    }
    const removed = out.slice(dropStart, dropEnd);
    out = [...out.slice(0, dropStart), ...out.slice(dropEnd)];
    dropped += removed.length;
    tokens = messagesTokens(out);
  }

  return { messages: out, tokens, compressed: true, dropped };
}

/** 从错误信息里识别「上下文超限」 */
export function isContextOverflowError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  const status = Number(err?.status || err?.response?.status || 0);
  if (status && status !== 400 && status !== 413 && status !== 422) return false;
  return /context (window|length|size)|exceeds the context|maximum context|prompt is too long|too many tokens|reduce the length/.test(msg);
}

/**
 * 引擎不认 `stream_options`（想拿真实 token 用量时才会带）。
 *
 * 真实场景：部分老版本 vLLM / SGLang / 自建网关会对未识别的请求参数直接 400，
 * 报 "unknown field stream_options" / "extra fields not permitted"。
 * 命中后应该**去掉该参数重试**，而不是让整轮对话失败。
 */
export function isStreamOptionsUnsupported(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  const status = Number(err?.status || err?.response?.status || 0);
  if (status && status >= 500) return false;
  return /stream_options|include_usage|unknown field|unrecognized|extra fields? not permitted|invalid_request_error.*stream/.test(msg);
}

/**
 * 去掉正文里混进来的「工具调用 XML」。
 *
 * 真实问题：让模型做收尾总结时（已禁用 tools），有些模型仍会把
 *   <tool_call><function=remote_grep><parameter=path>…</parameter></function></tool_call>
 * 当正文吐出来，用户看到的就是一堆 XML。同理，原生模式下模型偶尔也会把
 * 「打算调用什么」写进 content。
 *
 * 这里把成对的 `<tool_call>` 块、以及 `<function=...>` 块一起剥掉；
 * 剥完如果只剩空白，返回空串（调用方据此判断「总结没生成出来」）。
 */
export function stripToolCallBlocks(text) {
  let out = String(text ?? '');
  // 成对的 <tool_call> ... </tool_call>（跨行、贪婪到最近闭合）
  out = out.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '');
  // 没有闭合标签时，从 <tool_call> 删到结尾（常见于被截断的输出）
  out = out.replace(/<tool_call>[\s\S]*$/i, '');
  // 独立的 <function=...>...</function> 段（有些模型不加外层 tool_call）
  out = out.replace(/<function=[\s\S]*?<\/function>/gi, '');
  // 单独残留的 <parameter=...> 段
  out = out.replace(/<parameter=[\s\S]*?<\/parameter>/gi, '');
  // 代码围栏里的 tool_call 片段
  out = out.replace(/```(?:xml|tool_call)?\s*<tool_call>[\s\S]*?```/gi, '');
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 判断一段输出是不是「只有工具调用、没有真正的回答」 */
export function isOnlyToolCallText(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return false;
  if (!/<tool_call>|<function=|<parameter=/i.test(raw)) return false;
  return stripToolCallBlocks(raw).length === 0;
}

export default {
  estimateTokens, messageTokens, messagesTokens,
  summarizeToolResult, compactMessages, isContextOverflowError,
  stripToolCallBlocks, isOnlyToolCallText, TOOL_RESULT_KEEP_CHARS,
};
