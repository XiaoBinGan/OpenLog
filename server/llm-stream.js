/**
 * server/llm-stream.js —— 把「模型流式输出」转发成 SSE，统一处理思考态与降级
 *
 * 背景（2026-11-06 用户报「AI 智能诊断好像被改出问题来了」）：
 *   本机的 Qwen 类模型默认会先输出 `reasoning_content` 思考几秒到二十秒，
 *   正文 `content` 才开始。而各个诊断路由都是
 *
 *     for await (const chunk of stream) {
 *       const content = chunk.choices[0]?.delta?.content || '';
 *       if (content) res.write(...)
 *     }
 *
 *   —— 思考期间**一个字节都不发**，前端面板因此空白 7~21 秒，用户以为点坏了。
 *
 * 这里做四件事：
 *   1. 思考阶段定期发 `{status:'模型思考中…'}` 心跳，面板一直有反馈；
 *   2. 正文一到就照常转发 `{content}`；
 *   3. settings.thinkingEnabled 关闭时，直接请求引擎**别思考**
 *      （实测：正文首字 17s → ~0.7s），引擎不认这个参数则自动降级重试；
 *   4. 统一 [DONE] / 错误写法，调用方只管拼 prompt。
 *
 * 纯逻辑（该发什么事件）与 IO 分离，便于单测：见 buildThinkingParams / nextStreamEvent。
 */

/** 引擎不认思考开关时会报这些 */
const UNSUPPORTED_PARAM_RE = /unknown|unsupported|unexpected|invalid.*(param|argument|field)|unrecognized/i;

/**
 * 关闭思考的请求参数（Qwen3 / vLLM / SGLang 通用写法）。
 *
 * 实测（本机 8899 端口，qwen3.8-flash-next-q2_0）：
 *   - 默认：reasoning 722ms 开始，正文 5149ms 才出
 *   - chat_template_kwargs.enable_thinking=false：无 reasoning，正文 690ms
 *   - reasoning_effort='none'：无 reasoning，正文 137ms
 *
 * @param {boolean} thinkingEnabled 设置里的开关（true = 保留思考）
 * @returns {object} 需要合并进请求体的额外参数
 */
export function buildThinkingParams(thinkingEnabled) {
  if (thinkingEnabled) return {};
  return {
    chat_template_kwargs: { enable_thinking: false },
    reasoning_effort: 'none',
  };
}

/**
 * 判断一个错误是不是「引擎不认我们发的思考开关参数」。
 * @param {unknown} err
 */
export function isUnsupportedParamError(err) {
  const msg = String(err?.message || err || '');
  if (!msg) return false;
  return UNSUPPORTED_PARAM_RE.test(msg);
}

/**
 * 从模型 chunk 里取出「该发什么」。
 * @param {object} chunk openai SDK 的 chunk
 * @returns {{content:string, reasoning:string}}
 */
export function readChunk(chunk) {
  const delta = chunk?.choices?.[0]?.delta || {};
  return {
    content: typeof delta.content === 'string' ? delta.content : '',
    reasoning: typeof delta.reasoning_content === 'string' ? delta.reasoning_content
      : typeof delta.reasoning === 'string' ? delta.reasoning
        : '',
  };
}

/**
 * 请求模型（带思考开关，遇到不支持的引擎自动降级重试一次）。
 *
 * @param {object} opts
 * @param {{chat:{completions:{create:Function}}}} opts.openai
 * @param {string} opts.model
 * @param {string} opts.prompt
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.temperature]
 * @param {boolean} [opts.thinkingEnabled]
 * @returns {Promise<any>} 流对象
 */
export async function createChatStream({ openai, model, prompt, maxTokens = 2048, temperature = 0.3, thinkingEnabled = false }) {
  const base = {
    model,
    messages: [{ role: 'user', content: prompt }],
    stream: true,
    max_tokens: maxTokens,
    temperature,
  };
  const extra = buildThinkingParams(thinkingEnabled);
  try {
    return await openai.chat.completions.create({ ...base, ...extra });
  } catch (err) {
    if (Object.keys(extra).length === 0 || !isUnsupportedParamError(err)) throw err;
    // 引擎不认思考开关：去掉参数重试（宁可慢，不能失败）
    console.warn('[llm-stream] 引擎不支持思考开关参数，降级重试:', String(err?.message || err).slice(0, 160));
    return await openai.chat.completions.create(base);
  }
}

/**
 * 把模型流写进 SSE 响应。
 *
 * 事件约定（前端 readSSEStream / 各面板已支持）：
 *   {status: '…'}  —— 进度（会在有正文后被清掉）
 *   {content: '…'} —— 正文增量
 *   {error: '…'}   —— 错误
 *   data: [DONE]   —— 结束
 *
 * @param {object} opts
 * @param {import('node:http').ServerResponse} opts.res
 * @param {AsyncIterable} opts.stream
 * @param {(text:string)=>void} [opts.onContent] 累计正文（调用方存历史用）
 * @param {number} [opts.heartbeatMs] 心跳间隔
 * @returns {Promise<string>} 完整正文
 */
export async function pipeChatStreamToSSE({ res, stream, onContent, heartbeatMs = 800 }) {
  let full = '';
  let sawContent = false;
  let reasoningChars = 0;
  let lastPingAt = Date.now();

  for await (const chunk of stream) {
    const { content, reasoning } = readChunk(chunk);
    if (reasoning) {
      reasoningChars += reasoning.length;
      // 思考期间给心跳，避免前端长时间空白
      if (!sawContent && Date.now() - lastPingAt >= heartbeatMs) {
        lastPingAt = Date.now();
        res.write(`data: ${JSON.stringify({ status: `模型思考中…（已推理 ${reasoningChars} 字）` })}\n\n`);
      }
    }
    if (content) {
      if (!sawContent) {
        sawContent = true;
        // 清掉「思考中」提示，正文开始
        res.write(`data: ${JSON.stringify({ status: '' })}\n\n`);
      }
      full += content;
      onContent?.(content);
      res.write(`data: ${JSON.stringify({ content })}\n\n`);
    }
  }

  res.write('data: [DONE]\n\n');
  res.end();
  return full;
}
