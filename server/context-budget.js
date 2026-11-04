/**
 * context-budget.js — 统一的「上下文预算」计算与裁剪（运维助手 + AI Shell 共用）。
 *
 * 背景（用户反馈）：「模型上下文太长，一些只有 16k 的小模型就会抽风，
 * AI Shell 和运维助手都有出现」。
 *
 * 原因很具体：
 *   - 两个功能原来都只按「配置的预算」裁剪，而预算是给人看的 48k/65k 默认值；
 *     换成 16k 窗口的小模型后，请求体远超窗口。很多引擎（vLLM/ollama/strata）
 *     遇到超长 prompt **不报错，直接静默截断**——模型看到被砍掉一半的对话，
 *     于是开始胡言乱语（重复、断句、忘掉任务、乱造命令）。
 *   - AI Shell 之前完全没有预算概念：system + 5 轮历史 + 每步最多 6k 字符的
 *     命令输出，跑 3~4 步就超 16k。
 *
 * 这个模块只做纯计算，方便单测：
 *   1. planBudget：窗口 → 可用于 prompt 的预算 / 给输出的预留 / 历史预算；
 *   2. fitMessagesToBudget：把消息数组压进预算（**不拆散 assistant.tool_calls 与
 *      tool 消息的配对**，否则上游 400）；
 *   3. fitAgentMessages：AI Shell 的文本协议消息（RUN/命令输出）压缩 + 丢老步骤。
 */

import { estimateTokens, messagesTokens, compactMessages } from './routes/chat-context.js';

/** 预留给「模板/tokenizer 误差」的安全比例（窗口的 6%） */
export const SAFETY_RATIO = 0.06;
/** 输出 token 最多占窗口的 30%（小窗口模型不能贪输出） */
export const MAX_OUTPUT_RATIO = 0.3;
/** 16k 及以下的小窗口：输出硬上限（小模型长生成质量崩得快，也挤占对话空间） */
export const SMALL_WINDOW = 16_384;
export const SMALL_WINDOW_MAX_OUTPUT = 2048;
/** 历史消息最多占 prompt 预算的 85% */
export const MAX_HISTORY_RATIO = 0.85;

function toInt(v, fallback = 0) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 计算一份「安全」的上下文预算。
 *
 * @param {object} opts
 * @param {number} opts.windowTokens 模型上下文窗口（token）
 * @param {number} [opts.maxOutputTokens] 期望的单次输出上限
 * @param {number} [opts.fixedTokens] 已知的固定开销（system + 工具定义）
 * @param {number} [opts.safetyRatio]
 * @returns {{
 *   windowTokens:number, outputTokens:number, safetyTokens:number,
 *   promptBudget:number, historyBudget:number, fixedTokens:number,
 *   warnings:string[]
 * }}
 */
export function planBudget({ windowTokens, maxOutputTokens = 4096, fixedTokens = 0, safetyRatio = SAFETY_RATIO } = {}) {
  const warnings = [];
  const win = Math.max(2048, toInt(windowTokens, 8192));
  const safetyTokens = Math.ceil(win * Math.max(0.01, Math.min(0.2, safetyRatio)));
  // 小窗口（≤16k）额外压输出：16k 的 30% 是 4.9k，小模型生成长文质量崩得快，
  // 而且会把对话空间挤没。这里给 2k 硬上限。
  const ratioCap = Math.floor(win * MAX_OUTPUT_RATIO);
  const outputCap = win <= SMALL_WINDOW ? Math.min(ratioCap, SMALL_WINDOW_MAX_OUTPUT) : ratioCap;
  let outputTokens = Math.max(256, Math.min(toInt(maxOutputTokens, 2048), outputCap));
  if (outputTokens !== toInt(maxOutputTokens, outputCap)) {
    warnings.push(`输出上限 ${toInt(maxOutputTokens)} 超过窗口 ${win} 允许值，已压到 ${outputTokens}`);
  }

  let promptBudget = Math.max(512, win - safetyTokens - outputTokens);
  const fixed = Math.max(0, toInt(fixedTokens, 0));

  // 固定开销太大：先压输出，保证至少 1/4 窗口给对话（否则历史全被丢光也没用）
  const minHistory = Math.max(256, Math.floor(win * 0.25));
  if (fixed > promptBudget - minHistory) {
    const needed = fixed + minHistory + safetyTokens;
    const shrunk = Math.max(256, win - needed);
    if (shrunk < outputTokens) {
      outputTokens = shrunk;
      promptBudget = Math.max(512, win - safetyTokens - outputTokens);
      warnings.push(`系统提示 + 工具定义约 ${fixed} tokens，已把输出上限压到 ${outputTokens} 以保住对话空间`);
    }
  }

  const historyBudget = Math.min(
    Math.max(256, Math.floor(promptBudget * MAX_HISTORY_RATIO)),
    Math.max(256, promptBudget - fixed),
  );

  if (fixed > promptBudget * 0.9) {
    warnings.push(
      `系统提示 + 工具定义约 ${fixed} tokens，已占窗口 ${win} 的 ${Math.round((fixed / win) * 100)}%，`
      + '对话空间非常紧张；建议换窗口更大的模型，或精简技能内容/工具。',
    );
  }

  return {
    windowTokens: win,
    outputTokens,
    safetyTokens,
    promptBudget,
    historyBudget,
    fixedTokens: fixed,
    warnings,
  };
}

const TOOL_MSG_CHARS = 1200;
const TOOL_MSG_SUMMARY_CHARS = 240;

/**
 * 把消息数组压进 `budget`（token），返回新数组。
 *
 * 策略（从轻到重）：
 *   1. 调 compactMessages 压缩旧工具结果；
 *   2. 仍然超 → **按组丢弃最老的消息**。一个「组」= 带 tool_calls 的 assistant +
 *      紧跟着的那几条 tool 消息（必须整组丢，否则 OpenAI 协议不合法）；
 *   3. 保证最后 2 组和最后一条 user 消息一定保留。
 *
 * @param {Array} messages 不含 system
 * @param {number} budget
 * @returns {{ messages:Array, tokens:number, dropped:number, compressed:boolean }}
 */
export function fitMessagesToBudget(messages, budget) {
  const list = Array.isArray(messages) ? messages : [];
  const target = Math.max(256, toInt(budget, 4096));
  const before = messagesTokens(list);
  if (before <= target) return { messages: list, tokens: before, dropped: 0, compressed: false };

  // 第一级：压缩工具结果
  const compacted = compactMessages(list, {
    maxTokens: target,
    keepRecentTurns: 6,
    keepChars: TOOL_MSG_CHARS,
  });
  let next = compacted.messages;
  let tokens = messagesTokens(next);
  if (tokens <= target) {
    return { messages: next, tokens, dropped: 0, compressed: true };
  }

  // 第二级：按组丢最老的
  const groups = [];
  for (let i = 0; i < next.length; i++) {
    const m = next[i];
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const ids = new Set(m.tool_calls.map(tc => tc.id));
      const group = [m];
      let j = i + 1;
      while (j < next.length && next[j]?.role === 'tool' && ids.has(next[j].tool_call_id)) {
        group.push(next[j]);
        j++;
      }
      groups.push(group);
      i = j - 1;
    } else if (m?.role === 'tool') {
      // 孤立的 tool 消息（理论上不会出现）：单独成组，丢的时候一起丢
      groups.push([m]);
    } else {
      groups.push([m]);
    }
  }

  // 从最老的组开始丢，但保留最后 2 组和最后一个 user 组
  let lastUserGroup = -1;
  groups.forEach((g, idx) => { if (g.some(x => x?.role === 'user')) lastUserGroup = idx; });
  const protectedFrom = Math.max(0, groups.length - 2);
  let dropped = 0;
  while (tokens > target && groups.length > 1) {
    const idx = groups.findIndex((g, i) => i < protectedFrom && i !== lastUserGroup);
    if (idx < 0) break;
    const removed = groups.splice(idx, 1)[0];
    dropped += removed.length;
    tokens -= messagesTokens(removed);
  }
  next = groups.flat();
  return { messages: next, tokens, dropped, compressed: true };
}

const OBS_SUMMARY_CHARS = 400;

/**
 * 把一段文本截到不超过 maxTokens（保留开头 + 结尾，中间省略）。
 * 用于「技能内容 / 环境信息 太大，把 system prompt 撑爆」的情况 ——
 * 直接扔掉一部分技能总比让引擎静默截断整段对话好。
 *
 * @param {string} text
 * @param {number} maxTokens
 * @returns {{ text:string, truncated:boolean, tokens:number }}
 */
export function truncateTextToTokens(text, maxTokens) {
  const raw = String(text ?? '');
  const limit = Math.max(64, toInt(maxTokens, 1024));
  const full = estimateTokens(raw);
  if (full <= limit) return { text: raw, truncated: false, tokens: full };

  const note = '\n\n…（内容过长，已按模型窗口截断）…\n\n';
  const noteTokens = estimateTokens(note);
  const budget = Math.max(32, limit - noteTokens);
  // token 估算近似单调，二分查找可容纳的字符数
  let lo = 0;
  let hi = raw.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(raw.slice(0, mid)) <= budget) lo = mid; else hi = mid - 1;
  }
  const headLen = Math.max(32, Math.floor(lo * 0.7));
  const head = raw.slice(0, headLen);
  const tail = raw.slice(-Math.max(32, lo - headLen));
  const out = `${head}${note}${tail}`;
  return { text: out, truncated: true, tokens: estimateTokens(out) };
}

/**
 * AI Shell（文本协议 RUN / 命令输出）专用的压缩。
 *
 * @param {Array<{role:string, content:string}>} messages messages[0] 是 system
 * @param {object} opts
 * @param {number} opts.promptBudget 可用于「system + 对话」的总预算（不含输出）
 * @param {number} [opts.tailKeep] 尾部至少保留多少条不压缩（默认 4）
 * @returns {{ messages:Array, tokens:number, dropped:number, compressed:number, systemTokens:number, overBudget:boolean }}
 */
export function fitAgentMessages(messages, { promptBudget, tailKeep = 4 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const budget = Math.max(512, toInt(promptBudget, 8192));
  if (list.length === 0) return { messages: list, tokens: 0, dropped: 0, compressed: 0, systemTokens: 0, overBudget: false };

  const system = list[0];
  const systemTokens = estimateTokens(system?.content || '');
  const rest = list.slice(1);
  const allowed = Math.max(256, budget - systemTokens);
  let tokens = messagesTokens(rest);
  if (tokens <= allowed) {
    // system 自己就把预算吃满了：不算「成功压缩」，如实返回 overBudget
    const overBudget = systemTokens + tokens > budget;
    return { messages: list, tokens: systemTokens + tokens, dropped: 0, compressed: 0, systemTokens, overBudget };
  }

  // 第一级：压缩较早的「命令输出」观测
  const protectFrom = Math.max(0, rest.length - tailKeep);
  let compressed = 0;
  let out = rest.map((m, idx) => {
    if (idx >= protectFrom) return m;
    const content = String(m?.content || '');
    if (!content.includes('[命令输出]')) return m;
    if (content.length <= OBS_SUMMARY_CHARS) return m;
    compressed += 1;
    const head = content.slice(0, OBS_SUMMARY_CHARS).replace(/\s+/g, ' ');
    return { ...m, content: `[较早的命令输出已压缩] ${head}…` };
  });

  tokens = messagesTokens(out);
  if (tokens <= allowed) {
    return { messages: [system, ...out], tokens: systemTokens + tokens, dropped: 0, compressed, systemTokens, overBudget: systemTokens + tokens > budget };
  }

  // 第二级：丢最老的对话（AI Shell 是纯文本协议，没有 tool_calls 配对约束）
  // 保护：第一条 user（原始任务）和最后 tailKeep 条
  const tail = out.slice(-tailKeep);
  const headPart = out.slice(0, out.length - tailKeep);
  const firstUserIdx = headPart.findIndex(m => m?.role === 'user');
  const keepFirst = firstUserIdx >= 0 ? headPart[firstUserIdx] : null;

  let dropped = 0;
  let head = headPart;
  // 从最老开始丢；需要保留原始任务时，跳过它
  while (tokens > allowed && head.length > 0) {
    const idx = head.findIndex((m, i) => !(keepFirst && i === firstUserIdx));
    if (idx < 0) break;
    const removed = head.splice(idx, 1)[0]; // eslint-disable-line no-unused-vars
    dropped += 1;
    tokens -= estimateTokens(String(removed?.content || '')) + 4;
  }
  const result = [system, ...head, ...tail];
  const total = systemTokens + messagesTokens(head) + messagesTokens(tail);
  return { messages: result, tokens: total, dropped, compressed, systemTokens, overBudget: total > budget };
}
