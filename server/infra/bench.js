/**
 * server/infra/bench.js
 *
 * 推理服务基准引擎（派工单 A6）。
 *
 * 目标：给一个**已经跑起来的**推理服务做「并发 × 上下文长度」矩阵基准，产出
 * TTFT（首 token 延迟）、吞吐（tokens/s、req/s）与显存峰值，并据实测结果反推
 * 一套可以直接填进 ModelService.resources 的推荐配额。
 *
 * 设计约束（和 /tmp/infra-contract.md 一致，违反即返工）：
 *
 *   1. **控制面不做数据面的事**：本模块只发 HTTP 请求、只读指标，不起进程、不碰 k8s。
 *   2. **一律不直连生产**：所有网络访问都必须通过注入的 `fetchImpl`。没注入就直接
 *      返回 `ok:false`，绝不给「顺手打一下真机」的默认路径。测试里的 fetch 全是假实现。
 *   3. **安全阀先于吞吐**：矩阵是串行跑的（一个组合跑完再跑下一个），每个组合内部
 *      才放并发；错误率 / p95 TTFT / 总时长 / 吞吐 任一越界立即中止，并把已经拿到
 *      的结果原样返回 —— 宁可少测一组，也不把线上服务打满。
 *   4. 时间来源全部可注入（`now` / `sleep`），保证单测可确定性复现，不依赖真实时钟。
 *
 * 术语：
 *   - **cell（组合）**：矩阵里的一个 (concurrency, inputTokens) 点。
 *   - **wave（波）**：一个 cell 内部按 concurrency 分批时的一批请求。
 *   - **sample**：一次成功请求，只有成功请求才进 TTFT 统计。
 */

/** 默认推理端点路径（OpenAI 兼容） */
const DEFAULT_PATH = '/v1/chat/completions';

/** 默认矩阵：并发 3 档 × 上下文 2 档 = 6 个组合，串行跑 */
export const DEFAULT_MATRIX = Object.freeze({
  concurrencies: Object.freeze([1, 4, 8]),
  inputTokens: Object.freeze([512, 4096]),
});

/**
 * 默认安全阀。取值保守，理由逐条写在字段注释里 —— 这些数字会直接决定
 * 「会不会把线上服务测挂」，所以宁可小不可大。
 */
export const DEFAULT_LIMITS = Object.freeze({
  /** 单 cell 最大并发；矩阵里写更大的值会被夹到这一档 */
  maxConcurrency: 8,
  /** 单 cell 最大请求数（含失败），防止一档组合跑成压力测试 */
  maxRequestsPerCell: 20,
  /** 整轮基准的墙钟上限：超过就收手，剩下的组合不跑 */
  maxTotalMs: 120000,
  /** 错误率上限（0-1），超过立即中止 —— 超过说明服务已经不在正常状态 */
  maxErrorRate: 0.2,
  /** p95 TTFT 上限（ms）：超过说明排队已经很严重，继续加压只会更糟 */
  maxP95TtftMs: 30000,
  /** 吞吐上限（tokens/s）：防跑飞（统计错、服务被打满、返回体异常大） */
  maxTokensPerSec: 100000,
});

/** 每个 worker 默认跑几轮；实际请求数 = min(maxRequestsPerCell, 并发 × 轮数) */
const DEFAULT_ROUNDS = 4;
/** 单请求默认超时；再长就没意义了（p95 阈值本身才 30s） */
const DEFAULT_REQUEST_TIMEOUT_MS = 60000;
/** 显存建议余量：KV cache 增长 + 碎片 + 引擎自身开销 */
const DEFAULT_MEMORY_HEADROOM = 1.25;
/** 显存建议对齐粒度（MiB） */
const DEFAULT_MEMORY_GRANULARITY_MIB = 512;
/** 算力配额对齐粒度（百分点） */
const DEFAULT_CORES_GRANULARITY = 5;
/**
 * 「每 10% 算力稳定承载 1 路并发」——这是从 100% 算力 ≈ 10 路稳定并发的经验
 * 基线换算来的线性假设，见 recommendQuota 里的详细说明。
 */
const DEFAULT_CORES_PER_CONCURRENCY = 10;
/** 目标吞吐取实测峰值的 90%：留 10% 给抖动，不必压到极限 */
const DEFAULT_TARGET_THROUGHPUT_RATIO = 0.9;

/** 构造输入用的固定填充句（固定 = 可复现 = 不同机器上的 TTFT 可比） */
export const FILLER_SENTENCE =
  '这是一段用于构造基准输入的固定填充文本，重复拼接后按 token 近似裁剪。'
  + 'The quick brown fox jumps over the lazy dog, and the model should describe the sky in one short sentence. ';

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
const TIMEOUT_MARK = Symbol('bench.timeout');

/* ────────────────────────────── 小工具 ────────────────────────────── */

function round1(n) {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

function round2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/** 向上取整到 step 的整数倍（step <= 0 时退化为普通向上取整） */
function ceilToMultiple(value, step) {
  const v = Number(value);
  const s = Number(step);
  if (!Number.isFinite(v) || v <= 0) return 0;
  if (!Number.isFinite(s) || s <= 0) return Math.ceil(v);
  return Math.ceil(v / s) * s;
}

function fmtNum(n) {
  if (!Number.isFinite(n)) return '—';
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

const defaultNow = () => (
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
);

/**
 * 默认 sleep。刻意 unref：基准里的「请求超时」计时器不该拖住进程退出。
 * @param {number} ms 毫秒
 * @returns {Promise<void>}
 */
const defaultSleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, Math.max(0, ms));
  if (timer && typeof timer.unref === 'function') timer.unref();
});

/* ────────────────────────── token 近似与输入构造 ────────────────────────── */

/**
 * 粗略 token 估算（不引 tokenizer，避免基准跑之前先加载几十 MB 词表）。
 *
 * 规则（可复现、跨机器一致）：
 *   - CJK 字符 1 字 ≈ 1 token（Qwen / Llama 系中文词表基本如此）；
 *   - 其余字符按「4 个字符 ≈ 1 token」折算，空白先折叠。
 *
 * @param {string} text 文本
 * @returns {number} 估算 token 数（整数，非负）
 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  if (s.length === 0) return 0;
  const cjkMatches = s.match(CJK_RE);
  const cjk = cjkMatches ? cjkMatches.length : 0;
  const rest = s.replace(CJK_RE, '').replace(/\s+/g, ' ').trim();
  const latin = rest.length === 0 ? 0 : Math.ceil(rest.length / 4);
  return cjk + latin;
}

/**
 * 构造「约 inputTokens 个 token」的填充文本。
 *
 * 算法：整句重复到超过目标，再按比例裁尾，循环到估算值不再超标。
 * 全程无随机数 —— 同样的 inputTokens 一定得到同样的字符串，这样不同批次、
 * 不同机器上的基准结果才可比。
 *
 * @param {number} inputTokens 目标 token 数
 * @param {string} [sentence] 填充句
 * @returns {string} 估算 token 数 <= inputTokens 且尽量接近的文本
 */
export function makePaddingText(inputTokens, sentence = FILLER_SENTENCE) {
  const target = Math.max(0, Math.floor(Number(inputTokens) || 0));
  if (target === 0) return '';
  const perRepeat = estimateTokens(sentence);
  if (perRepeat <= 0) return '';
  let text = sentence.repeat(Math.max(1, Math.ceil(target / perRepeat)));
  // 收敛式裁剪：每轮按当前比例缩一刀，正常 2 刀内到位；guard 防死循环
  for (let guard = 0; guard < 64; guard += 1) {
    const est = estimateTokens(text);
    if (est <= target || text.length === 0) break;
    const keep = Math.max(0, Math.floor(text.length * (target / est)) - 1);
    text = text.slice(0, keep);
  }
  return text;
}

/* ────────────────────────────── 百分位 ────────────────────────────── */

/**
 * 百分位（nearest-rank 法，不做插值）。
 *
 *   idx = ceil(p × n) - 1，越界夹到 [0, n-1]
 *
 * 选 nearest-rank 而不是线性插值：延迟分布要「真实存在过的那一次请求」，
 * 插出来的 42.7ms 这种数在 UI 上没人能对上日志。
 *
 * @param {number[]} values 样本
 * @param {number} p 0-1
 * @returns {number|null} 百分位值（1 位小数）；无有效样本返回 null
 */
export function percentile(values, p) {
  const arr = (Array.isArray(values) ? values : [])
    .filter((v) => typeof v === 'number' && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (arr.length === 0) return null;
  const q = clamp(Number.isFinite(p) ? p : 0.5, 0, 1);
  const idx = clamp(Math.ceil(q * arr.length) - 1, 0, arr.length - 1);
  return round1(arr[idx]);
}

/* ─────────────────────────── 目标 / 矩阵 / 安全阀归一 ─────────────────────────── */

/**
 * 把 target.url 与 target.path 拼成真正的请求地址。
 * 已经是完整端点（含 /chat/completions 或 /completions）就不再追加，避免
 * `/v1/chat/completions/v1/chat/completions` 这种 404。
 *
 * @param {{url?: string, path?: string}} target 目标
 * @returns {string} 端点 URL
 */
export function buildEndpoint(target) {
  const raw = String(target?.url ?? '').trim();
  const path = String(target?.path || DEFAULT_PATH).trim() || DEFAULT_PATH;
  if (!raw) return path;
  const base = raw.replace(/\/+$/, '');
  if (/\/completions$/i.test(base) || base.endsWith(path)) return base;
  return base + (path.startsWith('/') ? path : `/${path}`);
}

function validateTarget(target) {
  if (!target || typeof target !== 'object') {
    return { ok: false, reason: '缺少 target：需要 { url, model } 才能构造 OpenAI 兼容请求' };
  }
  if (!String(target.url ?? '').trim()) {
    return { ok: false, reason: 'target.url 为空：基准必须指向具体的推理服务地址' };
  }
  if (!String(target.model ?? '').trim()) {
    return { ok: false, reason: 'target.model 为空：推理引擎按模型名路由，缺了就一定 404' };
  }
  return { ok: true };
}

/**
 * 归一安全阀：缺省用默认值，非法值回落到默认值，范围做夹取。
 * 单独导出是为了 A7 表单能拿同一套规则做前端校验（前后端不要两套数字）。
 *
 * @param {object} [input] 用户给的 limits
 * @returns {typeof DEFAULT_LIMITS} 归一后的安全阀
 */
export function normalizeLimits(input) {
  const src = input && typeof input === 'object' ? input : {};
  // 下限 >= 1 的字段（并发数、请求数、时长、吞吐）语义上「0 或负数」是无意义的，
  // 直接回落到默认值；maxErrorRate 是比例，0 有意义，按夹取处理。
  const pick = (key, lo, hi) => {
    const v = Number(src[key]);
    if (!Number.isFinite(v)) return DEFAULT_LIMITS[key];
    if (lo >= 1 && v <= 0) return DEFAULT_LIMITS[key];
    return clamp(v, lo, hi);
  };
  return {
    maxConcurrency: Math.floor(pick('maxConcurrency', 1, 256)),
    maxRequestsPerCell: Math.floor(pick('maxRequestsPerCell', 1, 1000)),
    maxTotalMs: Math.floor(pick('maxTotalMs', 1000, 3600000)),
    maxErrorRate: clamp(pick('maxErrorRate', 0, 1), 0, 1),
    maxP95TtftMs: Math.floor(pick('maxP95TtftMs', 100, 600000)),
    maxTokensPerSec: Math.floor(pick('maxTokensPerSec', 1, 10000000)),
  };
}

/**
 * 归一矩阵：保留用户给定顺序（UI 上是逐行展开的，顺序变了用户会以为丢组合），
 * 去重、丢非法值。空矩阵返回 cells: []，由调用方判 ok:false。
 *
 * @param {{concurrencies?: number[], inputTokens?: number[]}} [matrix] 矩阵
 * @returns {{concurrencies: number[], inputTokens: number[], cells: Array<{concurrency: number, inputTokens: number}>}}
 */
export function normalizeMatrix(matrix) {
  const src = matrix && typeof matrix === 'object' ? matrix : {};
  const uniqPositiveInts = (list) => {
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
      const v = Math.floor(Number(raw));
      if (!Number.isFinite(v) || v <= 0) continue;
      if (!out.includes(v)) out.push(v);
    }
    return out;
  };
  const concurrencies = uniqPositiveInts(src.concurrencies ?? DEFAULT_MATRIX.concurrencies);
  const inputTokens = uniqPositiveInts(src.inputTokens ?? DEFAULT_MATRIX.inputTokens);
  const cells = [];
  for (const concurrency of concurrencies) {
    for (const tokens of inputTokens) {
      cells.push({ concurrency, inputTokens: tokens });
    }
  }
  return { concurrencies, inputTokens, cells };
}

/* ───────────────────────────── 响应读取 ───────────────────────────── */

/**
 * 把各种「响应体」统一成异步可迭代的 chunk 流。
 * 支持：ReadableStream(getReader) / 异步可迭代 / 数组 / 字符串 / text()/json()。
 * 基准要能对接真引擎（SSE 流）也要能对接假实现（几行字符串），所以这里放宽到最泛。
 *
 * @param {any} res fetch 的响应
 * @returns {AsyncGenerator<any>} chunk 流
 */
async function* iterateBody(res) {
  const body = res?.body ?? null;
  if (body == null) {
    if (typeof res?.text === 'function') {
      const text = await res.text();
      if (text != null && String(text).length > 0) yield String(text);
      return;
    }
    if (typeof res?.json === 'function') {
      yield JSON.stringify(await res.json());
      return;
    }
    return;
  }
  if (typeof body === 'string') {
    if (body.length > 0) yield body;
    return;
  }
  if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        if (value != null) yield value;
      }
    } finally {
      if (typeof reader.releaseLock === 'function') {
        try { reader.releaseLock(); } catch { /* 已释放，忽略 */ }
      }
    }
  }
  if (typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) {
      if (chunk != null) yield chunk;
    }
    return;
  }
  if (typeof body[Symbol.iterator] === 'function') {
    for (const chunk of body) {
      if (chunk != null) yield chunk;
    }
  }
}

/**
 * 从整段响应文本里取「生成 token 数」。
 * 优先用引擎回报的 usage.completion_tokens（真机 vLLM/SGLang/llama.cpp 都有）；
 * 没有就按 delta 内容估算，保证假实现也能算出吞吐。
 *
 * @param {string} text 完整响应文本
 * @returns {number} token 数
 */
function extractCompletionTokens(text) {
  const m = /"completion_tokens"\s*:\s*(\d+)/.exec(text);
  if (m) return Number(m[1]);
  const parts = [];
  const re = /"content"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let hit;
  while ((hit = re.exec(text)) !== null) parts.push(hit[1]);
  if (parts.length > 0) return estimateTokens(parts.join(''));
  return estimateTokens(text);
}

/**
 * 发一次请求并测出 TTFT / 总耗时 / 生成 token 数。
 *
 * TTFT 定义：请求发出 → 第一个**非空**响应 chunk 到达。
 * 真机上是第一条 SSE data 行；非流式 JSON 响应会被算成「整体延迟」，
 * 这一点在 UI 上要标注（见 docs 里的说明）。
 *
 * @param {object} args 参数
 * @param {Function} args.fetchImpl 注入的 fetch
 * @param {string} args.endpoint 端点
 * @param {Record<string, string>} args.headers 请求头
 * @param {string} args.body 请求体（已序列化的 JSON 字符串）
 * @param {Function} args.now 时钟
 * @param {Function} args.sleep 睡眠
 * @param {number} args.timeoutMs 单请求超时
 * @returns {Promise<{kind: 'ok'|'timeout'|'http'|'network'|'empty', ttftMs?: number, latencyMs?: number, tokens?: number, status?: number, message?: string}>}
 */
async function measureOnce({ fetchImpl, endpoint, headers, body, now, sleep, timeoutMs }) {
  const startedAt = now();
  const call = (async () => {
    try {
      const res = await fetchImpl(endpoint, { method: 'POST', headers, body });
      return { ok: true, res };
    } catch (err) {
      return { ok: false, error: err };
    }
  })();

  let settled;
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    settled = await Promise.race([
      call,
      Promise.resolve(sleep(timeoutMs)).then(() => TIMEOUT_MARK),
    ]);
  } else {
    settled = await call;
  }

  if (settled === TIMEOUT_MARK) {
    // 超时不取消在途请求（fetch 已发出去了），只是不再等它 —— 结果丢弃
    call.catch(() => {});
    return { kind: 'timeout', latencyMs: round1(now() - startedAt), message: `请求超过 ${timeoutMs}ms 未返回` };
  }

  if (!settled.ok) {
    const msg = settled.error && settled.error.message ? String(settled.error.message) : '未知网络错误';
    return { kind: 'network', latencyMs: round1(now() - startedAt), message: msg };
  }

  const res = settled.res;
  const status = Number(res?.status ?? 200);
  if (Number.isFinite(status) && (status < 200 || status >= 300)) {
    return { kind: 'http', status, latencyMs: round1(now() - startedAt), message: `HTTP ${status}` };
  }

  let firstChunkAt = null;
  let text = '';
  const decoder = typeof TextDecoder === 'function' ? new TextDecoder() : null;
  for await (const chunk of iterateBody(res)) {
    const piece = typeof chunk === 'string'
      ? chunk
      : (decoder && (chunk instanceof Uint8Array || ArrayBuffer.isView(chunk))
        ? decoder.decode(chunk, { stream: true })
        : String(chunk ?? ''));
    if (!piece) continue;
    text += piece;
    if (firstChunkAt === null && piece.trim().length > 0) firstChunkAt = now();
  }
  if (decoder) {
    const tail = decoder.decode();
    if (tail) text += tail;
  }

  const latencyMs = round1(now() - startedAt);
  if (firstChunkAt === null || text.trim().length === 0) {
    return { kind: 'empty', latencyMs, message: '响应体为空，无法测 TTFT' };
  }
  return {
    kind: 'ok',
    ttftMs: round1(firstChunkAt - startedAt),
    latencyMs,
    tokens: extractCompletionTokens(text),
    status,
  };
}

/* ───────────────────────────── 单个 cell ───────────────────────────── */

/**
 * 跑一个矩阵组合（内部按 concurrency 分批放并发）。
 *
 * 中止检查点：每一波**之前**看总时长，每一波**之后**看错误率 / p95 TTFT / 吞吐。
 * 之所以按波检查而不是按请求检查：单次请求的抖动不该判定服务状态，一波样本才有意义。
 *
 * @param {object} args 参数
 * @returns {Promise<{result: object, abort: {reason: string, kind: string}|null}>}
 */
async function runCell(args) {
  const {
    concurrency: requestedConcurrency,
    inputTokens,
    ctx,
  } = args;
  const {
    target, limits, fetchImpl, now, sleep, paddingCache,
    rounds, requestsPerCell, requestTimeoutMs,
  } = ctx;

  const effConcurrency = clamp(
    Math.floor(Number(requestedConcurrency) || 1),
    1,
    limits.maxConcurrency,
  );
  const wantedRequests = Number.isFinite(requestsPerCell) && requestsPerCell > 0
    ? Math.floor(requestsPerCell)
    : Math.max(effConcurrency, effConcurrency * rounds);
  const requests = clamp(Math.floor(wantedRequests), 1, limits.maxRequestsPerCell);

  let padding = paddingCache.get(inputTokens);
  if (padding === undefined) {
    padding = makePaddingText(inputTokens);
    paddingCache.set(inputTokens, padding);
  }

  const endpoint = buildEndpoint(target);
  const headers = { 'Content-Type': 'application/json', ...(target.headers ?? {}) };
  if (target.apiKey) headers.Authorization = `Bearer ${target.apiKey}`;
  const maxTokens = Math.max(16, Math.floor(Number(target.maxTokens) || 256));
  const body = JSON.stringify({
    model: target.model,
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: padding }],
  });

  const ttfts = [];
  const errorKinds = { http: 0, timeout: 0, network: 0, empty: 0 };
  let tokens = 0;
  let done = 0;
  let failed = 0;
  let launched = 0;
  let cellStart = null;
  let cellEnd = null;
  let abort = null;

  const waves = Math.ceil(requests / effConcurrency);
  for (let wave = 0; wave < waves; wave += 1) {
    // ① 进下一波之前先看总时长：已经超了就别再开新请求
    const elapsedBefore = now() - ctx.startedAt;
    if (elapsedBefore >= limits.maxTotalMs) {
      abort = {
        kind: 'totalTime',
        reason: `总耗时已达 ${Math.round(elapsedBefore)}ms（上限 ${limits.maxTotalMs}ms），已中止以免长时间占用线上推理服务`,
      };
      break;
    }

    const need = Math.min(effConcurrency, requests - launched);
    if (need <= 0) break;
    if (cellStart === null) cellStart = now();
    launched += need;

    const outcomes = await Promise.all(Array.from({ length: need }, () => measureOnce({
      fetchImpl, endpoint, headers, body, now, sleep, timeoutMs: requestTimeoutMs,
    })));
    cellEnd = now();

    for (const out of outcomes) {
      done += 1;
      if (out.kind === 'ok') {
        ttfts.push(out.ttftMs);
        tokens += out.tokens;
      } else {
        failed += 1;
        const bucket = out.kind === 'http' || out.kind === 'timeout' || out.kind === 'network' || out.kind === 'empty'
          ? out.kind
          : 'network';
        errorKinds[bucket] += 1;
      }
    }

    // ② 波后判定：错误率 → p95 → 吞吐（严重度从高到低，先报最要命的那个）
    //
    // 错误率用**累计**口径（失败数 / 已完成数），且不设最小样本门槛：这是刻意的保守
    // 选择 —— 1 并发第 1 个请求就 500，说明服务此刻状态就不对，没必要再往下压。
    // 代价是冷启动抖一下也会中止，所以 UI 上必须把 reason 原样展示给用户（见 A7 建议）。
    const errorRate = done > 0 ? failed / done : 0;
    if (errorRate > limits.maxErrorRate) {
      abort = {
        kind: 'errorRate',
        reason: `${effConcurrency} 并发时错误率 ${(errorRate * 100).toFixed(1)}%（${failed}/${done}）超过阈值 ${(limits.maxErrorRate * 100).toFixed(1)}%，已中止以免把无效数据算进推荐配额`,
      };
      break;
    }

    const p95 = percentile(ttfts, 0.95);
    if (p95 !== null && p95 > limits.maxP95TtftMs) {
      abort = {
        kind: 'p95',
        reason: `${effConcurrency} 并发时 p95 TTFT ${fmtNum(p95)}ms 超过阈值 ${limits.maxP95TtftMs}ms，已中止以免影响线上服务`,
      };
      break;
    }

    const wallMs = cellStart === null ? 0 : Math.max(1, (cellEnd ?? now()) - cellStart);
    const tps = tokens / (wallMs / 1000);
    if (tps > limits.maxTokensPerSec) {
      abort = {
        kind: 'tokensPerSec',
        reason: `${effConcurrency} 并发时吞吐 ${fmtNum(Math.round(tps))} tokens/s 超过安全上限 ${limits.maxTokensPerSec}，疑为统计异常或服务已被打满，已中止`,
      };
      break;
    }
  }

  if (cellStart === null) cellStart = now();
  if (cellEnd === null) cellEnd = cellStart;

  const wallMs = Math.max(1, cellEnd - cellStart);
  const qualifiable = failed / Math.max(1, done) <= limits.maxErrorRate;
  const p95 = percentile(ttfts, 0.95);
  const result = {
    concurrency: effConcurrency,
    requestedConcurrency: Math.floor(Number(requestedConcurrency) || 1),
    inputTokens,
    requests,
    samples: ttfts.length,
    ok: ttfts.length > 0 && qualifiable && (p95 === null || p95 <= limits.maxP95TtftMs),
    ttftMs: {
      p50: percentile(ttfts, 0.5),
      p95,
      max: ttfts.length > 0 ? round1(Math.max(...ttfts)) : null,
    },
    tokensPerSec: round2(tokens / (wallMs / 1000)),
    rps: round2(ttfts.length / (wallMs / 1000)),
    errors: failed,
    errorKinds,
    wallMs: round1(wallMs),
    aborted: Boolean(abort),
    /** 相对整轮基准开跑的偏移（ms），用于 UI 上画甘特条 */
    startedAtMs: round1(cellStart - ctx.startedAt),
  };
  return { result, abort };
}

/* ───────────────────────── 推荐配额推导 ───────────────────────── */

/**
 * 从显存读数里抠出一个 MiB 数字（支持多种返回形状，真机适配层可能给对象）。
 *
 * @param {any} value readGpuMem() 的返回值
 * @returns {number|null} 显存峰值 MiB
 */
function toPeakMiB(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (Array.isArray(value)) {
    const nums = value.map(toPeakMiB).filter((v) => v !== null);
    return nums.length > 0 ? Math.max(...nums) : null;
  }
  if (typeof value === 'object') {
    for (const key of ['peakMiB', 'memoryMiB', 'gpuMemPeakMiB', 'usedMiB', 'peak']) {
      const hit = toPeakMiB(value[key]);
      if (hit !== null) return hit;
    }
  }
  return null;
}

/**
 * 推荐配额（反推 ModelService.resources）。
 *
 * ## 显存（memoryMiB）
 *   memoryMiB = ceil(显存峰值 × 1.25 / 512) × 512
 *   - 1.25 = 25% 余量：KV cache 随上下文/并发线性长、显存碎片、引擎 workspace；
 *   - 512 MiB 对齐：vGPU 份额（HAMi）本来就按 512 粒度切，不取整会申请到切不出来的数。
 *   - 没有实测显存（没注入 readGpuMem / gpuMemPeakMiB）→ null，confidence 降为 estimated。
 *
 * ## 算力（coresPercent）
 *   1. 取实测最高吞吐 P（tokens/s，只在 ok 且有样本的组合里取）；
 *   2. 目标吞吐 T = P × 0.9（留 10% 抖动余量，不压极限）；
 *   3. 最小并发 C* = 按并发升序找到的第一个「吞吐 >= T」的并发数 —— 再往上加并发
 *      只会抬高 TTFT 而不涨吞吐，那部分并发就是白给的显存和调度压力；
 *   4. coresPercent = ceil(C* × 10 / 5) × 5，夹在 [10, 100]。
 *
 *   假设（真机对拍时重点核这条）：**每 10% 算力可稳定承载 1 路并发**，
 *   即 100% 算力 ≈ 10 路稳定并发。解码阶段是算力瓶颈，batch 内每路摊到的算力
 *   随 batch 增大而下降，所以这里取线性并向下取整到 5 的倍数，是保守估计。
 *   如果真机上 4 路并发就能吃满 100% 算力（小模型 + 大 batch），实测的
 *   tokensPerSec 曲线会在 4 路附近提前见顶，C* 自然变成 4 → coresPercent 40，
 *   这条假设就自洽了。
 *
 * @param {object} input 输入
 * @param {Array<object>} [input.results] runBenchmark 的结果
 * @param {object} [input.best] 最优点
 * @param {number|null} [input.peakGpuMemMiB] 显存峰值 MiB
 * @param {object} [input.limits] 安全阀（只用于说明文字）
 * @returns {{memoryMiB: number|null, coresPercent: number|null, confidence: 'measured'|'estimated', basis: object, notes: string[]}}
 */
export function recommendQuota(input = {}) {
  const {
    results = [],
    best = null,
    peakGpuMemMiB = null,
    memoryHeadroom = DEFAULT_MEMORY_HEADROOM,
    memoryGranularityMiB = DEFAULT_MEMORY_GRANULARITY_MIB,
    coresPerConcurrency = DEFAULT_CORES_PER_CONCURRENCY,
    coresGranularity = DEFAULT_CORES_GRANULARITY,
    targetThroughputRatio = DEFAULT_TARGET_THROUGHPUT_RATIO,
  } = input;

  const notes = [];
  const usable = (Array.isArray(results) ? results : [])
    .filter((r) => r && r.ok && r.samples > 0 && Number.isFinite(r.tokensPerSec) && r.tokensPerSec > 0);

  // ── 显存 ──
  const peak = toPeakMiB(peakGpuMemMiB);
  let memoryMiB = null;
  if (peak !== null) {
    memoryMiB = ceilToMultiple(peak * memoryHeadroom, memoryGranularityMiB);
  } else {
    notes.push('没有读到推理引擎的显存峰值（未注入 readGpuMem/gpuMemPeakMiB），显存建议留空：请按模型权重大小 + KV cache（上下文 × 并发 × 2 × 层数 × hidden）手工估算，或接上引擎 /metrics 后重跑。');
  }

  // ── 算力 ──
  let coresPercent = null;
  let minConcurrency = null;
  let peakTps = null;
  let targetTps = null;
  if (usable.length === 0) {
    notes.push('没有成功的样本，无法推导算力配额：至少需要一个 ok 的组合（能拿到 TTFT 与吞吐）才能反推 coresPercent。');
  } else {
    peakTps = Math.max(...usable.map((r) => r.tokensPerSec));
    targetTps = peakTps * targetThroughputRatio;
    const byConcurrency = new Map();
    for (const r of usable) {
      byConcurrency.set(r.concurrency, Math.max(byConcurrency.get(r.concurrency) ?? 0, r.tokensPerSec));
    }
    const ascending = [...byConcurrency.entries()].sort((a, b) => a[0] - b[0]);
    const hit = ascending.find(([, tps]) => tps >= targetTps);
    minConcurrency = hit ? hit[0] : ascending[ascending.length - 1][0];
    coresPercent = clamp(
      ceilToMultiple(minConcurrency * coresPerConcurrency, coresGranularity),
      10,
      100,
    );
    if (!hit) {
      notes.push(`没有任何并发档位达到目标吞吐的 ${(targetThroughputRatio * 100).toFixed(0)}%，说明瓶颈不在并发（引擎侧 max_num_seqs / 显存 / 单请求算力已饱和）：coresPercent 按已测最高并发给出，建议再往上加并发复测一次。`);
    }
    if (best && Number.isFinite(best.tokensPerSec)) {
      notes.push(`最优点是 ${best.concurrency} 并发 / ${best.inputTokens} tokens：${fmtNum(best.tokensPerSec)} tokens/s，p95 TTFT ${fmtNum(best.ttftMs?.p95)}ms。`);
    }
    const maxCtx = Math.max(...usable.map((r) => r.inputTokens));
    if (best && best.inputTokens >= maxCtx) {
      notes.push('最优点出现在最长上下文档：KV cache 按最长上下文计的，显存余量 25% 之外不要再手动下调。');
    }
  }

  if (peak !== null) {
    notes.push(`显存峰值 ${fmtNum(Math.round(peak))}MiB × 1.25 向上取整到 ${memoryGranularityMiB}MiB → ${memoryMiB}MiB。`);
  }

  return {
    memoryMiB,
    coresPercent,
    confidence: peak !== null ? 'measured' : 'estimated',
    basis: {
      peakGpuMemMiB: peak === null ? null : round1(peak),
      memoryHeadroom,
      memoryGranularityMiB,
      peakThroughput: peakTps === null ? null : round2(peakTps),
      targetThroughputRatio,
      targetThroughput: targetTps === null ? null : round2(targetTps),
      minConcurrency,
      coresPerConcurrency,
      coresGranularity,
      bestKey: best ? `${best.concurrency}/${best.inputTokens}` : null,
      samplesUsed: usable.length,
    },
    notes,
  };
}

function pickBest(results) {
  const usable = results.filter((r) => r.ok && r.samples > 0 && Number.isFinite(r.tokensPerSec));
  if (usable.length === 0) return null;
  return usable.reduce((acc, cur) => {
    if (cur.tokensPerSec !== acc.tokensPerSec) return cur.tokensPerSec > acc.tokensPerSec ? cur : acc;
    // 吞吐打平时选更省资源的：并发低 → 上下文短 → p95 低
    if (cur.concurrency !== acc.concurrency) return cur.concurrency < acc.concurrency ? cur : acc;
    if (cur.inputTokens !== acc.inputTokens) return cur.inputTokens < acc.inputTokens ? cur : acc;
    const a = acc.ttftMs?.p95 ?? Infinity;
    const b = cur.ttftMs?.p95 ?? Infinity;
    return b < a ? cur : acc;
  }, usable[0]);
}

function emptySummary(reasonNote) {
  return {
    best: null,
    bestKey: null,
    recommended: {
      memoryMiB: null,
      coresPercent: null,
      confidence: 'estimated',
      basis: null,
      notes: [reasonNote],
    },
  };
}

/* ───────────────────────────── 主入口 ───────────────────────────── */

/**
 * 跑一轮推理服务基准。
 *
 * @param {object} options 参数
 * @param {{url: string, model: string, apiKey?: string, path?: string, headers?: Record<string,string>, maxTokens?: number}} options.target 目标服务（OpenAI 兼容）
 * @param {{concurrencies?: number[], inputTokens?: number[]}} [options.matrix] 矩阵，默认 DEFAULT_MATRIX
 * @param {Partial<typeof DEFAULT_LIMITS>} [options.limits] 安全阀，默认 DEFAULT_LIMITS
 * @param {Function} options.fetchImpl 注入的 fetch（**必填**，禁止直连生产）
 * @param {() => number} [options.now] 时钟（ms）
 * @param {(ms: number) => Promise<void>} [options.sleep] 睡眠
 * @param {() => number|object|Promise<number|object>} [options.readGpuMem] 引擎显存读数（可选）
 * @param {number} [options.gpuMemPeakMiB] 直接给显存峰值（可选，优先于 readGpuMem）
 * @param {number} [options.requestsPerCell] 每组合请求数（默认 min(maxRequestsPerCell, 并发 × 4)）
 * @param {number} [options.rounds] 每个 worker 跑几轮（默认 4）
 * @param {number} [options.requestTimeoutMs] 单请求超时（默认 60000）
 * @returns {Promise<{
 *   ok: boolean,
 *   aborted: boolean,
 *   reason: string|null,
 *   results: Array<object>,
 *   summary: {best: object|null, bestKey: string|null, recommended: object}
 * }>} 基准结果
 */
export async function runBenchmark(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const {
    target,
    matrix,
    limits: limitsIn,
    fetchImpl,
    now,
    sleep,
    readGpuMem,
    gpuMemPeakMiB,
    requestsPerCell,
    rounds: roundsIn,
    requestTimeoutMs,
    memoryHeadroom = DEFAULT_MEMORY_HEADROOM,
    memoryGranularityMiB = DEFAULT_MEMORY_GRANULARITY_MIB,
    coresPerConcurrency = DEFAULT_CORES_PER_CONCURRENCY,
    targetThroughputRatio = DEFAULT_TARGET_THROUGHPUT_RATIO,
  } = opts;

  const limits = normalizeLimits(limitsIn);
  const clockNow = typeof now === 'function' ? now : defaultNow;
  const clockSleep = typeof sleep === 'function' ? sleep : defaultSleep;
  const startedAt = clockNow();

  const targetCheck = validateTarget(target);
  if (!targetCheck.ok) {
    return { ok: false, aborted: false, reason: targetCheck.reason, results: [], summary: emptySummary(targetCheck.reason) };
  }
  if (typeof fetchImpl !== 'function') {
    const reason = '缺少 fetchImpl：基准必须通过注入的 fetch 访问模型服务，不允许直接打线上地址（默认路径必须是安全的）';
    return { ok: false, aborted: false, reason, results: [], summary: emptySummary(reason) };
  }

  const mat = normalizeMatrix(matrix);
  if (mat.cells.length === 0) {
    const reason = '矩阵为空：需要至少一个合法的（并发数, 输入长度）组合才能开跑';
    return { ok: false, aborted: false, reason, results: [], summary: emptySummary(reason) };
  }

  const rounds = Number.isFinite(Number(roundsIn)) && Number(roundsIn) > 0
    ? Math.floor(Number(roundsIn))
    : DEFAULT_ROUNDS;
  const timeoutMs = Number.isFinite(Number(requestTimeoutMs)) && Number(requestTimeoutMs) > 0
    ? Math.floor(Number(requestTimeoutMs))
    : Math.min(DEFAULT_REQUEST_TIMEOUT_MS, limits.maxTotalMs);

  const ctx = {
    target,
    limits,
    fetchImpl,
    now: clockNow,
    sleep: clockSleep,
    paddingCache: new Map(),
    rounds,
    requestsPerCell: Number.isFinite(Number(requestsPerCell)) && Number(requestsPerCell) > 0
      ? Math.floor(Number(requestsPerCell))
      : null,
    requestTimeoutMs: timeoutMs,
    startedAt,
  };

  const results = [];
  let abort = null;
  let peakMiB = toPeakMiB(gpuMemPeakMiB);
  const gpuNotes = [];

  const sampleGpu = async () => {
    if (typeof readGpuMem !== 'function') return;
    try {
      const value = await readGpuMem();
      const mib = toPeakMiB(value);
      if (mib !== null) peakMiB = peakMiB === null ? mib : Math.max(peakMiB, mib);
    } catch (err) {
      gpuNotes.push(`读取显存失败：${err && err.message ? err.message : String(err)}`);
    }
  };

  for (const cell of mat.cells) {
    if (now() - startedAt >= limits.maxTotalMs) {
      abort = {
        kind: 'totalTime',
        reason: `总耗时已达 ${Math.round(now() - startedAt)}ms（上限 ${limits.maxTotalMs}ms），已中止以免长时间占用线上推理服务`,
      };
      break;
    }
    const { result, abort: cellAbort } = await runCell({ ...cell, ctx });
    results.push(result);
    await sampleGpu();
    if (cellAbort) {
      abort = cellAbort;
      break;
    }
  }

  await sampleGpu();

  const best = pickBest(results);
  const recommended = recommendQuota({
    results,
    best,
    peakGpuMemMiB: peakMiB,
    memoryHeadroom,
    memoryGranularityMiB,
    coresPerConcurrency,
    targetThroughputRatio,
  });
  if (gpuNotes.length > 0) recommended.notes.unshift(...gpuNotes);
  if (abort) recommended.notes.unshift(`基准是中止结束的（${abort.kind}），推荐配额只基于已完成的 ${results.length} 个组合，样本不足时请谨慎采信。`);

  const ok = !abort && results.length > 0 && results.every((r) => r.ok);
  if (!ok && !abort) {
    recommended.notes.unshift('所有组合都未产出有效样本（全失败或全部被限流），本次结果不能用来定配额。');
  }

  return {
    ok,
    aborted: Boolean(abort),
    reason: abort ? abort.reason : null,
    results,
    summary: {
      best,
      bestKey: best ? `${best.concurrency}/${best.inputTokens}` : null,
      recommended,
    },
  };
}

export default runBenchmark;
