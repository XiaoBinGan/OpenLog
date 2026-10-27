/**
 * llm-provider.js — 通用 OpenAI 兼容推理服务适配层。
 *
 * 背景：OpenLog 要对接的不只是 OpenAI，还有 vLLM / SGLang / Strata / Ollama / LM Studio。
 * 它们都喊「OpenAI 兼容」，但**能力集并不一样**，直接按 OpenAI 的用法发请求会踩：
 *
 * | 能力 | vLLM | SGLang | Strata | Ollama | OpenAI |
 * |---|---|---|---|---|---|
 * | `/v1/chat/completions` | ✅ | ✅ | ✅ | ✅ | ✅ |
 * | 原生 `tools`（function calling） | 需 `--enable-auto-tool-choice` | 需 `--tool-call-parser` | ✅ | 部分模型 | ✅ |
 * | `reasoning_content` 流式字段 | 视模型 | 视模型 | ✅ | ❌ | ❌ |
 * | `/v1/models` | ✅ | ✅ | ✅ | ✅ | ✅ |
 * | `stream_options.include_usage` | ✅ | 部分 | 部分 | ❌ | ✅ |
 * | `max_tokens` | ✅ | ✅ | ✅ | ✅ | 新版改名 max_completion_tokens |
 *
 * 所以这个模块负责三件事：
 *   1. **发现**：列出模型、探测原生 tool calling 是否可用（结果缓存）；
 *   2. **降级**：不支持原生 tools 时，自动改走「文本协议」（TOOL_CALL: {...}），
 *      让 agent 能力在 vLLM/SGLang 上也能用；
 *   3. **归一**：把 `reasoning_content` 流式增量统一交给调用方，不污染正文。
 *
 * 纯逻辑（协议解析 / 能力判断 / URL 归一）都是可单测的纯函数。
 */

/** 各引擎的典型特征，用于给出提示与默认值 */
export const ENGINE_HINTS = {
  vllm: {
    name: 'vLLM',
    toolHint: '原生 function calling 需要启动时加 --enable-auto-tool-choice --tool-call-parser hermes（或对应模型的 parser）',
  },
  sglang: {
    name: 'SGLang',
    toolHint: '原生 function calling 需要启动时加 --tool-call-parser（如 qwen25 / llama3）',
  },
  strata: {
    name: 'Strata',
    toolHint: '原生 function calling 可用',
  },
  ollama: {
    name: 'Ollama',
    toolHint: '需模型本身支持 tools（qwen2.5 / qwen3 / llama3.1+ 等）',
  },
  openai: {
    name: 'OpenAI 兼容',
    toolHint: '',
  },
};

/** 把 baseUrl 归一成「不带尾部 /、带 /v1」的形式 */
export function normalizeBaseUrl(baseUrl) {
  let url = String(baseUrl || '').trim();
  if (!url) return '';
  url = url.replace(/\/+$/, '');
  if (/\/v\d+$/.test(url)) return url;
  return `${url}/v1`;
}

/** 拼接 API 路径（baseUrl 可能已带 /v1） */
export function apiUrl(baseUrl, path) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) return '';
  return `${base}/${String(path || '').replace(/^\/+/, '')}`;
}

/** 从 baseUrl / 模型名猜引擎类型（仅用于提示文案，不影响功能） */
export function guessEngine(baseUrl, model) {
  const url = String(baseUrl || '').toLowerCase();
  const name = String(model || '').toLowerCase();
  if (/8899|strata/.test(url) || /strata/.test(name)) return 'strata';
  if (/sglang/.test(url) || /sglang/.test(name)) return 'sglang';
  if (/vllm/.test(url) || /vllm/.test(name)) return 'vllm';
  if (/11434/.test(url) || /ollama/.test(name)) return 'ollama';
  return 'openai';
}

// ─── 模型列表 ──────────────────────────────────────────────────────────────

/**
 * 拉取模型列表。
 *
 * 优先标准 `/v1/models`（vLLM / SGLang / Strata / Ollama / LM Studio / OpenAI 都支持），
 * 失败再退到 Ollama 的 `/api/tags`。返回：
 *   { ok, models: string[], engine, error? }
 *
 * @param {string} baseUrl
 * @param {string} [apiKey]
 * @param {typeof fetch} [fetchImpl] 测试注入
 */
export async function listModels(baseUrl, apiKey, fetchImpl = fetch) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) return { ok: false, models: [], engine: 'unknown', error: '未配置 Base URL' };

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  // 1) 标准 /models
  try {
    const res = await fetchImpl(`${base}/models`, { method: 'GET', headers, signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      const models = (Array.isArray(data?.data) ? data.data : [])
        .map(m => m?.id || m?.name || m?.model)
        .filter(Boolean);
      if (models.length > 0) {
        return { ok: true, models, engine: guessEngine(baseUrl) };
      }
    }
  } catch { /* 继续尝试 Ollama 专有接口 */ }

  // 2) Ollama /api/tags
  try {
    const root = base.replace(/\/v1$/, '');
    const res = await fetchImpl(`${root}/api/tags`, { method: 'GET', headers, signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      const models = (data?.models || []).map(m => m?.name).filter(Boolean);
      return { ok: models.length > 0, models, engine: 'ollama' };
    }
  } catch { /* 两种都不行 */ }

  return { ok: false, models: [], engine: 'unknown', error: '该服务未提供 /v1/models 或 /api/tags' };
}

// ─── 能力探测 ──────────────────────────────────────────────────────────────

/** tool calling 探测缓存：baseUrl|model → { supported, ts } */
const toolCapabilityCache = new Map();
const TOOL_CAP_TTL_MS = 30 * 60 * 1000;

export function _resetToolCapabilityCache() {
  toolCapabilityCache.clear();
}

/**
 * 判断某引擎是否真的支持原生 function calling。
 *
 * 判据：`/v1/models` 是否返回、以及上一次真实请求是否报过 tool 相关错误。
 * 探测成本高（要真发一次请求），所以只在拿不准时让调用方按「先试原生、失败降级」处理，
 * 这里只负责缓存结论。
 */
export function getCachedToolSupport(baseUrl, model) {
  const key = `${normalizeBaseUrl(baseUrl)}|${model || ''}`;
  const hit = toolCapabilityCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > TOOL_CAP_TTL_MS) {
    toolCapabilityCache.delete(key);
    return null;
  }
  return hit.supported;
}

export function setCachedToolSupport(baseUrl, model, supported) {
  toolCapabilityCache.set(`${normalizeBaseUrl(baseUrl)}|${model || ''}`, {
    supported: Boolean(supported),
    ts: Date.now(),
  });
}

/** 判断一个错误是不是「该引擎不支持 tools」 */
export function isToolUnsupportedError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  const status = Number(err?.status || err?.response?.status || 0);
  if (status && status !== 400 && status !== 404 && status !== 422 && status !== 500) return false;
  return /tool|function[_\s-]?call|tool_choice|tools.*not|unsupported.*tool|not support.*tool|unknown parameter|invalid parameter.*tool/.test(msg);
}

// ─── 文本工具协议 ──────────────────────────────────────────────────────────

/**
 * 文本协议：不支持原生 tools 的引擎，用它来「假装」function calling。
 *
 * 模型被要求输出：
 *   TOOL_CALL: {"tool":"remote_grep","args":{"serverId":"...","pattern":"..."}}
 * 或者
 *   FINAL: 给用户的回答
 *
 * 为什么不用 XML/JSON mode：这套协议对 7B 级模型最稳，且不会因为 JSON 里带换行就崩。
 */
export const TOOL_PROTOCOL_PROMPT = `你可以调用工具来完成任务。需要工具时，**只输出一行**：

TOOL_CALL: {"tool":"工具名","args":{参数对象}}

一次只调用一个工具。拿到工具结果后继续判断；任务完成或无需工具时，用：

FINAL: 给用户的最终回答

规则：
- 不要输出 TOOL_CALL 以外的任何内容（除了 FINAL）
- args 必须是合法 JSON
- 不要在 TOOL_CALL 里编造结果，等系统返回`;

/** 把工具定义渲染成文本清单（给不支持原生 tools 的模型看） */
export function renderToolsAsText(tools) {
  return (tools || []).map(t => {
    const fn = t.function || t;
    const required = fn.parameters?.required || [];
    const params = Object.entries(fn.parameters?.properties || {}).map(([name, def]) => {
      const mark = required.includes(name) ? '*' : '';
      return `${name}${mark}:${def.type || 'any'}${def.description ? `(${def.description})` : ''}`;
    }).join(', ');
    return `- ${fn.name}(${params}) — ${fn.description || ''}`;
  }).join('\n');
}

/**
 * 解析模型输出里的文本工具协议。
 * @returns {{ kind:'tool', tool:string, args:object } | { kind:'final', content:string } | { kind:'text', content:string }}
 */
export function parseToolProtocol(raw) {
  const text = String(raw || '').trim();
  if (!text) return { kind: 'text', content: '' };

  // TOOL_CALL: {...}
  const toolMatch = text.match(/TOOL_CALL\s*[:：]\s*([\s\S]*?)(?:\n\s*FINAL\s*[:：]|$)/i);
  if (toolMatch) {
    const jsonText = toolMatch[1].trim();
    try {
      const parsed = JSON.parse(jsonText);
      const tool = parsed.tool || parsed.name;
      const args = parsed.args || parsed.arguments || {};
      if (typeof tool === 'string' && tool) {
        return { kind: 'tool', tool, args: args && typeof args === 'object' ? args : {} };
      }
    } catch {
      // 常见容错：模型输出 ```json ... ``` 包裹
      const fenced = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fenced) {
        try {
          const parsed = JSON.parse(fenced[1].trim());
          const tool = parsed.tool || parsed.name;
          if (typeof tool === 'string' && tool) {
            return { kind: 'tool', tool, args: parsed.args || parsed.arguments || {} };
          }
        } catch { /* 落回 final */ }
      }
    }
    return { kind: 'text', content: text };
  }

  const finalMatch = text.match(/FINAL\s*[:：]\s*([\s\S]*)$/i);
  if (finalMatch) return { kind: 'final', content: finalMatch[1].trim() };

  return { kind: 'text', content: text };
}

/** 把工具结果格式化成文本协议下的一轮观察 */
export function renderToolResultForTextProtocol(tool, result) {
  let body;
  try {
    body = JSON.stringify(result);
  } catch {
    body = String(result);
  }
  if (body.length > 8000) body = `${body.slice(0, 8000)}…（已截断）`;
  return `TOOL_RESULT: ${tool}\n${body}`;
}

// ─── 流式归一 ──────────────────────────────────────────────────────────────

/**
 * 从 OpenAI 兼容的流式 chunk 里取出「正文」与「思维内容」。
 *
 * vLLM / SGLang / Strata 对 reasoning 的处理不一样：
 *  - 有的放 `delta.reasoning_content`
 *  - 有的放 `delta.reasoning`
 *  - 有的把思维直接塞进 `content`（那就交给 ThinkingStreamFilter 处理 <think>）
 */
export function extractDelta(delta) {
  if (!delta) return { content: '', reasoning: '' };
  return {
    content: typeof delta.content === 'string' ? delta.content : '',
    reasoning: typeof delta.reasoning_content === 'string' ? delta.reasoning_content
      : typeof delta.reasoning === 'string' ? delta.reasoning
        : '',
  };
}

/**
 * 给请求体打补丁，规避各引擎已知不兼容参数。
 * @param {object} params 原始请求参数
 * @param {{ engine?: string, allowTools?: boolean }} opts
 */
export function adaptRequestParams(params, opts = {}) {
  const out = { ...params };
  // 不支持 tools 的引擎就别发这个字段，否则 400
  if (opts.allowTools === false) {
    delete out.tools;
    delete out.tool_choice;
  }
  // 部分引擎不接受 include_usage，用流式时去掉更安全
  if (opts.engine === 'vllm' || opts.engine === 'sglang' || opts.engine === 'strata') {
    // 这些引擎都支持，保留；但若上游报错会由调用方降级
  }
  return out;
}

export default {
  ENGINE_HINTS, normalizeBaseUrl, apiUrl, guessEngine, listModels,
  getCachedToolSupport, setCachedToolSupport, isToolUnsupportedError,
  TOOL_PROTOCOL_PROMPT, renderToolsAsText, parseToolProtocol,
  renderToolResultForTextProtocol, extractDelta, adaptRequestParams,
};
