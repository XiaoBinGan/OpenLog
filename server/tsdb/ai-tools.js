/**
 * AI 的指标查询工具 —— 让运维助手能读时序库。
 *
 * 为什么必须有：AI 助手此前能读日志、能执行命令，但**答不了**这类问题：
 *   「昨天下午 CPU 最高到多少」
 *   「这个服务过去一小时的 P99 延迟趋势」
 *   「磁盘什么时候开始涨的」
 * 而这些恰恰是排查时最需要的事实依据。没有它，AI 只能靠猜或者让用户自己去看图。
 *
 * 设计上的三个约束：
 *
 * 1) **输出必须给模型「能直接读的结论」，不是原始 JSON**。
 *    一小时的 15 秒数据是 240 个点，塞进上下文既浪费又干扰判断。
 *    所以默认做降采样 + 给出 min/max/avg/last/趋势，只在用户明确要求时给原始点。
 *
 * 2) **必须能拒绝不安全的查询**。模型可能写出 `x[1h:1s]` 这种
 *    3 万步的子查询，或者 `{__name__=~".*"}` 全表扫。
 *    这类查询在这里就被挡掉，不要指望模型自己克制。
 *
 * 3) **返回结构里带「数据是否存在」的明确信号**。
 *    查不到数据时要说「没有这个指标，可用的指标有…」，
 *    而不是返回空数组让模型自由发挥 —— 那会变成幻觉的来源。
 */

/** 单次查询最多返回多少个点（超过就自动降采样） */
export const MAX_POINTS_PER_SERIES = 120;
/** 单次查询最多返回多少条序列 */
export const MAX_SERIES = 20;
/** 查询时间跨度上限（毫秒）—— 默认 7 天，与分析场景匹配 */
export const MAX_RANGE_MS = 7 * 86_400_000;

/**
 * 校验并规范化 AI 传来的查询参数。
 *
 * @param {object} args
 * @param {string} args.query PromQL
 * @param {number|string} [args.start] 起始（毫秒或秒时间戳，或 "-1h" 这种相对）
 * @param {number|string} [args.end]
 * @param {number} [args.step] 步长（毫秒）
 * @param {number} [nowMs]
 * @returns {{ok:boolean, error?:string, query?:string, start?:number, end?:number, step?:number}}
 */
export function validateQueryArgs(args, nowMs = Date.now()) {
  const query = String(args?.query || '').trim();
  if (!query) return { ok: false, error: '缺少 query 参数（PromQL 表达式）' };
  if (query.length > 2000) return { ok: false, error: '查询过长（上限 2000 字符）' };

  // 拒绝明显会拖垮服务的写法
  // 子查询步长过小：`x[1h:1s]` = 3601 步，每步一次 DB 查询
  const subMatch = /\[\s*([0-9]+(?:ms|s|m|h|d|w|y))?\s*:\s*([0-9]+(?:ms|s|m|h|d|w|y))?\s*\]/.exec(query);
  if (subMatch) {
    const step = subMatch[2] ? parseDurationMs(subMatch[2]) : 60_000;
    if (Number.isFinite(step) && step > 0 && step < 1000) {
      return { ok: false, error: `子查询步长 ${subMatch[2]} 太小（下限 1s），会拖垮服务` };
    }
  }
  // 全表扫：正则匹配所有指标名
  if (/\{\s*__name__\s*=~\s*"\.\*"\s*\}/.test(query)) {
    return { ok: false, error: '不支持 {__name__=~".*"} 全表扫，请指定指标名' };
  }

  const end = parseTimeArg(args?.end, nowMs) ?? nowMs;
  const start = parseTimeArg(args?.start, nowMs) ?? (end - 3_600_000); // 默认看最近 1 小时
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return { ok: false, error: 'start / end 必须是时间戳或相对写法（如 -1h）' };
  }
  if (end <= start) return { ok: false, error: 'end 必须晚于 start' };
  if (end - start > MAX_RANGE_MS) {
    return { ok: false, error: `时间跨度超过上限 ${MAX_RANGE_MS / 86_400_000} 天，请缩小范围` };
  }

  // step 缺省：把区间切成不超过 MAX_POINTS_PER_SERIES 个点
  const autoStep = Math.max(1000, Math.ceil((end - start) / MAX_POINTS_PER_SERIES));
  const step = Number.isFinite(Number(args?.step)) && Number(args.step) >= 1000
    ? Number(args.step)
    : autoStep;

  return { ok: true, query, start, end, step };
}

/** 解析时间参数：数字（秒或毫秒）、"-1h" 相对、ISO 字符串 */
export function parseTimeArg(v, nowMs = Date.now()) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return null;
    // 10 位当秒，13 位当毫秒
    return v > 1e11 ? v : v * 1000;
  }
  const s = String(v).trim();
  // 相对写法：-1h / -30m / -7d
  const rel = /^-(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/.exec(s);
  if (rel) {
    const ms = parseDurationMs(`${rel[1]}${rel[2]}`);
    return ms === null ? null : nowMs - ms;
  }
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return n > 1e11 ? n : n * 1000;
  }
  const d = Date.parse(s);
  return Number.isNaN(d) ? null : d;
}

function parseDurationMs(str) {
  const total = (() => {
    const UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, y: 31_536_000_000 };
    let i = 0;
    let sum = 0;
    let matched = false;
    while (i < str.length) {
      const start = i;
      while (i < str.length && /[0-9.]/.test(str[i])) i += 1;
      if (i === start) return null;
      const n = Number(str.slice(start, i));
      let unit = null;
      for (const u of ['ms', 's', 'm', 'h', 'd', 'w', 'y']) if (str.startsWith(u, i)) { unit = u; break; }
      if (!unit) return null;
      i += unit.length;
      sum += n * UNITS[unit];
      matched = true;
    }
    return matched ? sum : null;
  })();
  return total;
}

/**
 * 把 PromQL 查询结果整理成「模型能直接读」的摘要。
 *
 * @param {{resultType:string, result:Array, error?:object}} r 引擎返回
 * @param {object} [opts]
 * @param {number} [opts.maxSeries]
 * @returns {object}
 */
export function summarizeQueryResult(r, opts = {}) {
  const maxSeries = Number(opts.maxSeries) > 0 ? Number(opts.maxSeries) : MAX_SERIES;

  if (r?.error) {
    return { ok: false, error: r.error.message || String(r.error), hint: explainQueryError(r.error.message) };
  }

  if (r.resultType === 'scalar') {
    return { ok: true, type: 'scalar', value: r.result[1], timestamp: Number(r.result[0]) };
  }

  const list = Array.isArray(r.result) ? r.result : [];
  if (list.length === 0) {
    return {
      ok: true,
      type: r.resultType,
      seriesCount: 0,
      note: '查询没有返回任何数据。可能原因：指标名拼写不对、该时间段没有采集到数据、或者标签过滤条件太严。',
    };
  }

  if (r.resultType === 'matrix') {
    const series = list.slice(0, maxSeries).map((item) => summarizeSeries(item.metric, item.values));
    return {
      ok: true,
      type: 'matrix',
      seriesCount: list.length,
      truncated: list.length > maxSeries,
      series,
    };
  }

  // instant vector
  const series = list.slice(0, maxSeries).map((item) => ({
    labels: item.metric,
    value: Number(item.value[1]),
    timestamp: Number(item.value[0]),
  }));
  return {
    ok: true,
    type: 'vector',
    seriesCount: list.length,
    truncated: list.length > maxSeries,
    series,
  };
}

/**
 * 单条序列的统计摘要。
 *
 * 为什么给这些字段：模型要回答「高不高」「涨没涨」「什么时候异常」，
 * 分别需要 max/min、first→last 的变化、以及峰值出现的时刻。
 * 只给一堆数字它还得自己算，容易算错。
 */
export function summarizeSeries(labels, values) {
  // Prometheus 的时间戳是**秒**，内部统一换成毫秒：
  // isoOf 与 spanSec 都按毫秒算，混用会让 maxAt 显示成 1970 年、趋势判断失真。
  const pts = (values || [])
    .map((v) => ({ ts: Number(v[0]) * 1000, value: Number(v[1]) }))
    .filter((p) => Number.isFinite(p.ts) && Number.isFinite(p.value));

  if (pts.length === 0) return { labels, points: 0 };

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let maxAt = pts[0].ts;
  let minAt = pts[0].ts;
  for (const p of pts) {
    if (p.value > max) { max = p.value; maxAt = p.ts; }
    if (p.value < min) { min = p.value; minAt = p.ts; }
    sum += p.value;
  }
  const first = pts[0];
  const last = pts[pts.length - 1];
  const spanSec = (last.ts - first.ts) / 1000;

  // 趋势：按「每秒变化 / 均值」归一化，避免大数值指标的斜率看起来吓人
  const mean = sum / pts.length;
  const slopePerSec = spanSec > 0 ? (last.value - first.value) / spanSec : 0;
  let trend = 'flat';
  const rel = mean !== 0 ? Math.abs(slopePerSec * spanSec) / Math.abs(mean) : 0;
  if (rel > 0.05) trend = slopePerSec > 0 ? 'rising' : 'falling';

  return {
    labels,
    points: pts.length,
    from: isoOf(first.ts),
    to: isoOf(last.ts),
    first: round(first.value),
    last: round(last.value),
    min: round(min),
    max: round(max),
    avg: round(mean),
    maxAt: isoOf(maxAt),
    minAt: isoOf(minAt),
    trend,
  };
}

function round(v) {
  if (!Number.isFinite(v)) return null;
  const abs = Math.abs(v);
  if (abs >= 1000) return Math.round(v);
  if (abs >= 1) return Math.round(v * 100) / 100;
  return Math.round(v * 10000) / 10000;
}

function isoOf(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return null;
  return new Date(n).toISOString();
}

/** 把常见的查询错误翻译成「模型能据此纠正」的提示 */
export function explainQueryError(message) {
  const m = String(message || '');
  if (/未知函数/.test(m)) return '检查函数名拼写。可用函数见 deploy/README-tsdb.md 的函数表。';
  if (/步数|超过上限/.test(m)) return '把子查询的 step 调大（如 [1h:5m] 而不是 [1h:1s]），或缩小时间范围。';
  if (/区间只能用于向量选择器/.test(m)) return '对表达式取区间要用子查询写法：expr[5m:1m]。';
  if (/子查询/.test(m)) return '子查询写法是 expr[range:step]，例如 rate(sum(x)[5m:1m])。';
  if (/未知的 AST|无法解析/.test(m)) return '检查括号是否配对、引号是否闭合。';
  if (/db 未就绪|schema 未就绪/.test(m)) return '时序库未初始化，检查 /api/tsdb/status。';
  return '';
}

/**
 * 给模型的工具定义（OpenAI function calling 格式）。
 */
export const METRICS_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'query_metrics',
    description: '查询时序库（PromQL）。用来回答「CPU/内存/磁盘/GPU 过去怎样」「某个指标的趋势与峰值」这类问题。返回每条序列的 min/max/avg/首末值与趋势，不是原始点。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'PromQL 表达式。例：openlog_cpu_usage_percent、sum by (job) (rate(http_requests_total[5m]))、max_over_time(openlog_memory_usage_percent[1h])',
        },
        start: { type: 'string', description: '起始时间：-1h / -30m / -7d 这样的相对写法，或 unix 时间戳' },
        end: { type: 'string', description: '结束时间，默认现在' },
        step: { type: 'string', description: '步长（毫秒或 30s 这种）。不填会按数据量自动选' },
      },
      required: ['query'],
    },
  },
};

/** 列出指标名的工具定义（模型先探有哪些指标，再查具体值） */
export const LIST_METRICS_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'list_metrics',
    description: '列出时序库里所有的指标名，或某个标签的全部取值。不知道指标叫什么时先调这个。',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: '留空则列出全部指标名；填标签名（如 instance / job / mount）则列出该标签的所有取值' },
      },
    },
  },
};