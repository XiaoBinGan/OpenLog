#!/usr/bin/env node
/**
 * scripts/infra-bench-verify.mjs —— 推理服务基准「真机对拍」脚本（派工单 B6）。
 *
 * 干什么：对**已经跑起来的**推理服务跑一轮 bench（并发 × 输入长度矩阵），把
 * 实测结果交给 `recommendQuota()` 反推配额，再和这个服务**实际申请的**配额逐项对拍，
 * 给出「扩容 / 可回收 / 保持」的判定。
 *
 * 不干什么（和契约 B6 一致，越界即返工）：
 *   · 不启动 Pod、不改 Deployment、不写 k8s、不碰网关 —— 全程只有 HTTP 请求；
 *   · 不重复实现压测逻辑 —— 并发控制、安全阀、TTFT 统计、配额反推全部复用
 *     `server/infra/bench.js` 的 `runBenchmark()` / `recommendQuota()`；
 *   · 不自己编阈值 —— 安全阀默认值来自 bench 的 `DEFAULT_LIMITS`，本脚本只做展示与
 *     拒绝非法矩阵（矩阵超限时 bench 会**静默夹取**，那样出来的报告会失真）。
 *
 * 退出码（文档 docs/INFRA-BENCH.md §2 有表）：
 *   0 = 跑完并且至少拿到一个有效组合
 *   1 = 脚本自身失败（写文件失败、bench 抛异常等）
 *   2 = 参数非法（矩阵越界、缺 --url/--model、--applied-* 越界）
 *   3 = 服务不可达（探活失败或整轮全是 network 错误）
 *   4 = 被安全阀中止（仍会打印已完成组合的结论）
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  runBenchmark,
  recommendQuota,
  normalizeLimits,
  buildEndpoint,
  DEFAULT_LIMITS,
  DEFAULT_MATRIX,
} from '../server/infra/bench.js';

/** 退出码：给 CI / 人看都明确，不要用「有没有输出」猜结果 */
export const EXIT = Object.freeze({
  OK: 0,
  INTERNAL: 1,
  USAGE: 2,
  UNREACHABLE: 3,
  ABORTED: 4,
});

/**
 * bench.js 里的 `DEFAULT_ROUNDS = 4` **没有导出**，这里镜像一份，只用于 dry-run 里
 * 「预计请求数」的展示。真正的请求数由 bench 内部决定（`clamp(并发 × 轮数, 1, maxRequestsPerCell)`），
 * 所以这里展示的是**估算**，不等价于实际跑数。若 bench 改了轮数，这个数会偏小，不会导致误判。
 */
const BENCH_DEFAULT_ROUNDS = 4;

/**
 * 单调时钟。**必须显式传给 bench**（见 main 里的说明）：bench.js 主循环第 880 行写的是
 * `now()` 而不是 `clockNow()`，不注入 `now` 时会抛 `TypeError: now is not a function`。
 * 这里镜像 bench 自己的 defaultNow（performance.now 优先，退回 Date.now），
 * 保证在任何补丁落地前后的行为一致。
 *
 * @returns {number} 毫秒时间戳（单调优先）
 */
function monotonicNow() {
  return (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();
}

/** ModelService.resources 的合法区间（来源：server/infra/model.js 的白名单校验） */
const APPLIED_MEM_MAX = 65536;
const APPLIED_CORES_MAX = 100;

/** 输入长度超过这个值只告警不拒绝：多数引擎默认上下文装不下，跑出来会全是 400 */
const LONG_CONTEXT_WARN_TOKENS = 32768;

/** 探活超时：只证明「端口上有人回话」，不需要等生成 */
const PREFLIGHT_TIMEOUT_MS = 5000;

/* ─────────────────────────────── 排版小工具 ─────────────────────────────── */

// 中日韩字符在终端里占两列，不按宽度算会把中文表格排歪
const WIDE_CHAR_RE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/;

/**
 * 显示宽度：CJK 算 2 列，其余算 1 列。
 * @param {string} text 文本
 * @returns {number} 终端列宽
 */
export function textWidth(text) {
  let w = 0;
  for (const ch of String(text ?? '')) w += WIDE_CHAR_RE.test(ch) ? 2 : 1;
  return w;
}

function padCell(text, width, align) {
  const s = String(text ?? '');
  const gap = Math.max(0, width - textWidth(s));
  return align === 'right' ? ' '.repeat(gap) + s : s + ' '.repeat(gap);
}

/**
 * 渲染一张 markdown 风格的对齐表格（终端里直接能看，粘进 issue 也不走样）。
 * @param {string[]} headers 表头
 * @param {Array<Array<string|number>>} rows 行
 * @param {Array<'left'|'right'>} [aligns] 每列对齐方式
 * @returns {string} 多行文本
 */
export function renderTable(headers, rows, aligns = []) {
  const body = (Array.isArray(rows) ? rows : []).map((r) => r.map((c) => String(c ?? '')));
  const widths = headers.map((h, i) => (
    Math.max(textWidth(h), ...body.map((r) => textWidth(r[i] ?? '')))
  ));
  const line = (cells) => `| ${cells.map((c, i) => padCell(c, widths[i], aligns[i] ?? 'left')).join(' | ')} |`;
  const sep = `|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`;
  return [line(headers.map((h) => String(h))), sep, ...body.map(line)].join('\n');
}

/** 毫秒：null / 非有限值一律「—」（没数据就写没数据，不拿 0 冒充） */
function fmtMs(v) {
  if (!Number.isFinite(v)) return '—';
  return `${Math.round(v)} ms`;
}

function fmtTps(v) {
  if (!Number.isFinite(v)) return '—';
  return v >= 100 ? v.toFixed(0) : v.toFixed(2);
}

function fmtRate(v) {
  if (!Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

/* ─────────────────────────────── 网络错误解释 ─────────────────────────────── */

/** 常见网络错误的**可操作**解释（只说「连不上」等于没说） */
const NET_HINTS = {
  ECONNREFUSED: '端口上没有服务在监听（Pod 还没 Ready / 端口写错 / 网关没起）',
  ENOTFOUND: '域名解析不到（DNS 或服务名写错）',
  EAI_AGAIN: 'DNS 临时解析失败（重试一次；持续失败查 CoreDNS）',
  ECONNRESET: '连接被对端重置（服务进程崩了，或被中间件/网关掐断）',
  EHOSTUNREACH: '主机不可达（路由或 NetworkPolicy 挡了）',
  ETIMEDOUT: '连接超时（防火墙丢包，或服务假死不再 accept）',
  UND_ERR_CONNECT_TIMEOUT: '连接超时（客户端侧超时）',
  CERT_HAS_EXPIRED: 'TLS 证书过期',
  DEPTH_ZERO_SELF_SIGNED_CERT: '自签证书不被信任（本地对拍用 Node 的 NODE_EXTRA_CA_CERTS 指定 CA）',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '证书链不完整（缺中间证书）',
  ABORT: '探活超时（服务在，但 5s 内没回一行响应头）',
  BAD_PORT: '端口在 fetch 规范的禁用端口表里（1、7、9 这类），undici/浏览器直接拒绝连接 —— 换一个真实端口',
};

/**
 * 沿 cause / AggregateError.errors 往里翻，找第一个认识的错误码。
 * 这一步不能省：Node 的 fetch 只抛 `TypeError: fetch failed`，真正的
 * `ECONNREFUSED` / `ENOTFOUND` 藏在 `err.cause.code` 里，不翻出来用户只会看到
 * 「fetch failed」，等于没报错。
 *
 * @param {any} err 异常
 * @param {number} [depth] 递归深度
 * @returns {{code: string|null, detail: string|null}} 错误码与最内层原始信息
 */
function walkError(err, depth = 0) {
  if (!err || depth > 4) return { code: null, detail: null };
  const detail = err.message ? String(err.message) : null;
  if (err.name === 'AbortError') return { code: 'ABORT', detail };
  const rawCode = typeof err.code === 'string' ? err.code : null;
  if (rawCode && NET_HINTS[rawCode]) return { code: rawCode, detail };
  if (rawCode === 'UND_ERR_CONNECT_TIMEOUT') return { code: rawCode, detail };
  for (const inner of Array.isArray(err.errors) ? err.errors : []) {
    const hit = walkError(inner, depth + 1);
    if (hit.code) return hit;
  }
  if (err.cause) {
    const hit = walkError(err.cause, depth + 1);
    if (hit.code) return hit;
    if (hit.detail) return hit;
  }
  if (detail && /bad port/i.test(detail)) return { code: 'BAD_PORT', detail };
  return { code: rawCode, detail };
}

/**
 * 把 fetch 抛出的错误翻成人话。
 * @param {any} err 异常
 * @returns {{code: string|null, hint: string, detail: string|null}} 错误码 + 可操作提示 + 原始信息
 */
export function describeNetError(err) {
  const { code, detail } = walkError(err);
  const fallback = detail || (err && err.message ? String(err.message) : '未知网络错误');
  const hint = code && NET_HINTS[code] ? NET_HINTS[code] : fallback;
  return { code, hint, detail: detail && detail !== hint ? detail : null };
}

/* ───────────────────────────────── 参数解析 ───────────────────────────────── */

/** 参数表：白名单式，未知 flag 直接拒绝（不猜用户想干什么） */
const SPEC = new Map([
  ['--url', { key: 'url', type: 'string' }],
  ['--model', { key: 'model', type: 'string' }],
  ['--api-key', { key: 'apiKey', type: 'string' }],
  ['--concurrency', { key: 'concurrency', type: 'list' }],
  ['--tokens', { key: 'tokens', type: 'list' }],
  ['--applied-mem', { key: 'appliedMem', type: 'number' }],
  ['--applied-cores', { key: 'appliedCores', type: 'number' }],
  ['--matrix', { key: 'matrix', type: 'boolean' }],
  ['--out', { key: 'out', type: 'string' }],
  ['--max-total-ms', { key: 'maxTotalMs', type: 'number' }],
  ['--max-p95-ttft-ms', { key: 'maxP95TtftMs', type: 'number' }],
  ['--max-error-rate', { key: 'maxErrorRate', type: 'number' }],
  ['--max-requests-per-cell', { key: 'maxRequestsPerCell', type: 'number' }],
  ['--rounds', { key: 'rounds', type: 'number' }],
  ['--peak-mem-mib', { key: 'peakMemMiB', type: 'number' }],
  ['--memory-headroom', { key: 'memoryHeadroom', type: 'number' }],
  ['--cores-per-concurrency', { key: 'coresPerConcurrency', type: 'number' }],
  ['--dry-run', { key: 'dryRun', type: 'boolean' }],
  ['--skip-preflight', { key: 'skipPreflight', type: 'boolean' }],
  ['--help', { key: 'help', type: 'boolean' }],
  ['-h', { key: 'help', type: 'boolean' }],
]);

/**
 * 解析 argv（支持 `--flag value` 与 `--flag=value` 两种写法）。
 * @param {string[]} argv 不含 node/脚本名的参数
 * @returns {{ok: true, value: object}|{ok: false, error: string}} 结果
 */
export function parseArgs(argv = []) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = String(argv[i]);
    if (!raw.startsWith('-')) {
      return { ok: false, error: `多余的参数 ${raw}：本脚本只接受 --flag 形式的参数，用 --help 看清单` };
    }
    const eq = raw.indexOf('=');
    const name = eq > 0 ? raw.slice(0, eq) : raw;
    const inline = eq > 0 ? raw.slice(eq + 1) : null;
    if (name === '--help' || name === '-h') {
      out.help = true;
      continue;
    }
    const spec = SPEC.get(name);
    if (!spec) return { ok: false, error: `未知参数 ${name}：用 --help 看支持的参数（不支持拼写近似匹配）` };
    if (spec.type === 'boolean') {
      if (inline !== null) return { ok: false, error: `${name} 是开关，不接受取值=${inline}` };
      out[spec.key] = true;
      continue;
    }
    const value = inline !== null ? inline : argv[i + 1];
    if (value === undefined) return { ok: false, error: `${name} 缺少取值` };
    if (inline === null) i += 1;
    if (spec.type === 'string') {
      out[spec.key] = String(value);
    } else if (spec.type === 'list') {
      out[spec.key] = String(value);
    } else {
      const n = Number(value);
      if (!Number.isFinite(n)) return { ok: false, error: `${name} 需要数字，收到 ${value}` };
      out[spec.key] = n;
    }
  }
  return { ok: true, value: out };
}

/** `1,4,8` / `1 4 8` / `1;4;8` → [1,4,8]（保持顺序，交给 buildPlan 去重） */
function parseList(raw) {
  return String(raw ?? '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s));
}

/* ─────────────────────────── 计划构建（含矩阵拒绝逻辑） ─────────────────────────── */

function warnClamped(name, requested, effective) {
  return `${name} 给的是 ${requested}，bench 的 normalizeLimits 会夹到 ${effective}（超出上下限的值不会生效，报告按 ${effective} 走）`;
}

/**
 * 校验参数并算出「将要执行的计划」。**不发任何请求**（dry-run 与真实运行共用这一段）。
 *
 * 拒绝而不是夹取的三种情况（任务要求）：
 *   · 并发 > bench 的 `DEFAULT_LIMITS.maxConcurrency`（默认 8）—— 矩阵写 16，bench 只会
 *     按 8 发，报告却标着 16，等于拿一份错数据去定配额，不如直接拒绝；
 *   · 输入 tokens < 1；
 *   · 显存 / 算力越出 ModelService 的合法区间（0..65536 MiB、0..100%）。
 *
 * @param {object} opts parseArgs 的值
 * @returns {{ok: true, plan: object}|{ok: false, error: string}} 计划或中文错误
 */
export function buildPlan(opts = {}) {
  const url = String(opts.url ?? '').trim();
  const model = String(opts.model ?? '').trim();
  if (!url) return { ok: false, error: '缺少 --url：需要推理服务的 OpenAI 兼容端点（例如 http://10.0.0.12:8000/v1/chat/completions）' };
  if (!model) return { ok: false, error: '缺少 --model：推理引擎按模型名路由，缺了一定 404' };
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) {
      return { ok: false, error: `--url 只支持 http/https，收到 ${parsed.protocol}` };
    }
  } catch {
    return { ok: false, error: `--url 不是合法地址：${url}` };
  }

  const limitsRequested = {};
  for (const key of ['maxTotalMs', 'maxP95TtftMs', 'maxErrorRate', 'maxRequestsPerCell']) {
    if (opts[key] !== undefined) limitsRequested[key] = opts[key];
  }
  const limits = normalizeLimits(limitsRequested);
  const warnings = [];
  for (const [flag, key] of [
    ['--max-total-ms', 'maxTotalMs'],
    ['--max-p95-ttft-ms', 'maxP95TtftMs'],
    ['--max-requests-per-cell', 'maxRequestsPerCell'],
  ]) {
    if (limitsRequested[key] !== undefined && limitsRequested[key] !== limits[key]) {
      warnings.push(warnClamped(flag, limitsRequested[key], limits[key]));
    }
  }
  if (limitsRequested.maxErrorRate !== undefined
    && Number(limitsRequested.maxErrorRate) !== limits.maxErrorRate) {
    warnings.push(warnClamped('--max-error-rate', limitsRequested.maxErrorRate, limits.maxErrorRate));
  }

  // ── 矩阵 ──
  let concurrencyRaw = opts.concurrency === undefined ? null : parseList(opts.concurrency);
  let tokensRaw = opts.tokens === undefined ? null : parseList(opts.tokens);
  if (opts.matrix) {
    concurrencyRaw = [...(concurrencyRaw ?? []), ...DEFAULT_MATRIX.concurrencies];
    tokensRaw = [...(tokensRaw ?? []), ...DEFAULT_MATRIX.inputTokens];
  }
  if (concurrencyRaw === null) concurrencyRaw = [...DEFAULT_MATRIX.concurrencies];
  if (tokensRaw === null) tokensRaw = [...DEFAULT_MATRIX.inputTokens];

  const uniq = (list) => {
    const seen = new Set();
    const out = [];
    for (const v of list) {
      if (!seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
    return out.sort((a, b) => a - b);
  };

  for (const c of concurrencyRaw) {
    if (!Number.isInteger(c) || c < 1) {
      return { ok: false, error: `--concurrency 只接受 ≥1 的整数，收到 ${c}：并发是一批同时发出的请求数，0 或小数没有意义` };
    }
    if (c > limits.maxConcurrency) {
      return {
        ok: false,
        error: `并发 ${c} 超过上限 ${limits.maxConcurrency}（来源：server/infra/bench.js 的 DEFAULT_LIMITS.maxConcurrency=${DEFAULT_LIMITS.maxConcurrency}，normalizeLimits 允许的上限是 256，但矩阵默认夹在 ${DEFAULT_LIMITS.maxConcurrency}）。`
          + `bench 会把 ${c} 静默夹成 ${limits.maxConcurrency} 去发，报告却标着 ${c} —— 那样的数据不能用来定配额。`
          + `请把并发拆成多轮（例如分两次跑 1,4,8 与 8），或先给 HAMi 侧加隔离再放开上限；本脚本不提供绕过开关。`,
      };
    }
  }
  for (const t of tokensRaw) {
    if (!Number.isInteger(t) || t < 1) {
      return { ok: false, error: `--tokens 只接受 ≥1 的整数（输入 token 数），收到 ${t}` };
    }
    if (t > LONG_CONTEXT_WARN_TOKENS) {
      warnings.push(`输入 ${t} tokens 超过 ${LONG_CONTEXT_WARN_TOKENS}：多数引擎默认 max-model-len 装不下，可能整轮 400，建议先确认 --max-model-len`);
    }
  }

  const concurrencies = uniq(concurrencyRaw);
  const inputTokens = uniq(tokensRaw);

  // ── 实际申请配额 ──
  const appliedMem = opts.appliedMem;
  const appliedCores = opts.appliedCores;
  if (appliedMem !== undefined) {
    if (!Number.isInteger(appliedMem) || appliedMem < 0 || appliedMem > APPLIED_MEM_MAX) {
      return { ok: false, error: `--applied-mem 必须是 0..${APPLIED_MEM_MAX} 的整数（MiB），收到 ${appliedMem}：这是 ModelService.resources.memoryMiB 的合法区间（server/infra/model.js），0 表示整卡独占` };
    }
  }
  if (appliedCores !== undefined) {
    if (!Number.isInteger(appliedCores) || appliedCores < 0 || appliedCores > APPLIED_CORES_MAX) {
      return { ok: false, error: `--applied-cores 必须是 0..${APPLIED_CORES_MAX} 的整数（百分点），收到 ${appliedCores}：这是 ModelService.resources.coresPercent 的合法区间（server/infra/model.js），0 表示不限算力` };
    }
  }

  // ── 轮数 / 每组合请求数（只用于估算展示，真实值由 bench 决定） ──
  let rounds = BENCH_DEFAULT_ROUNDS;
  if (opts.rounds !== undefined) {
    if (!Number.isInteger(opts.rounds) || opts.rounds < 1) {
      return { ok: false, error: `--rounds 必须是 ≥1 的整数（每个 worker 跑几轮），收到 ${opts.rounds}` };
    }
    rounds = opts.rounds;
  }
  let requestsPerCell = null;
  if (opts.maxRequestsPerCell !== undefined) requestsPerCell = limits.maxRequestsPerCell;

  const requestsFor = (concurrency) => {
    const wanted = requestsPerCell !== null
      ? requestsPerCell
      : Math.max(concurrency, concurrency * rounds);
    return Math.min(Math.max(1, Math.floor(wanted)), limits.maxRequestsPerCell);
  };

  const cells = [];
  for (const concurrency of concurrencies) {
    for (const tokens of inputTokens) {
      cells.push({ concurrency, inputTokens: tokens, requests: requestsFor(concurrency) });
    }
  }

  const endpoint = buildEndpoint({ url, path: undefined });
  const warningsOut = [...warnings];
  if (endpoint !== url.replace(/\/+$/, '')) {
    warningsOut.push(`请求会打到 ${endpoint}（bench 的 buildEndpoint 会自动补 /v1/chat/completions；如果引擎路径不同，请把完整端点写进 --url）`);
  }

  return {
    ok: true,
    plan: {
      target: { url, model, apiKey: opts.apiKey ?? null },
      endpoint,
      concurrencies,
      inputTokens,
      cells,
      totalRequests: cells.reduce((a, c) => a + c.requests, 0),
      limits,
      rounds,
      requestsPerCell,
      applied: { memoryMiB: appliedMem ?? null, coresPercent: appliedCores ?? null },
      peakGpuMemMiB: Number.isFinite(opts.peakMemMiB) ? opts.peakMemMiB : null,
      memoryHeadroom: Number.isFinite(opts.memoryHeadroom) ? opts.memoryHeadroom : 1.25,
      coresPerConcurrency: Number.isFinite(opts.coresPerConcurrency) ? opts.coresPerConcurrency : 10,
      out: opts.out ? path.resolve(process.cwd(), opts.out) : null,
      dryRun: Boolean(opts.dryRun),
      skipPreflight: Boolean(opts.skipPreflight),
      warnings: warningsOut,
    },
  };
}

/* ─────────────────────────────── 配额对拍 ─────────────────────────────── */

/** 「建议 > 申请」→ 扩容；「建议 < 申请 × 0.6」→ 可回收；其余算匹配 */
export const RECLAIM_RATIO = 0.6;

/**
 * 逐项比较推荐值与实际申请值。
 *
 * 三种「不能比」的情形必须显式说出来，而不是算出一个假偏差：
 *   · 推荐值是 null（没读到实测显存 / 没有成功样本）；
 *   · 实际申请值没给（--applied-* 缺省）；
 *   · 实际申请值是 0（显存 0 = 整卡独占，算力 0 = 不限算力，和 vGPU 份额不是同一口径）。
 *
 * @param {object} args 参数
 * @param {object} args.recommended recommendQuota() 的输出
 * @param {number|null} [args.appliedMemMiB] 实际申请的 memoryMiB
 * @param {number|null} [args.appliedCoresPercent] 实际申请的 coresPercent
 * @returns {Array<object>} 每项 { key, label, applied, recommended, delta, deltaText, judgment:{state,text} }
 */
export function compareQuota({ recommended, appliedMemMiB = null, appliedCoresPercent = null }) {
  const rec = recommended ?? {};
  const build = ({
    key, label, unit, applied, recValue, zeroNote, growNote, reclaimNote,
  }) => {
    const item = {
      key,
      label,
      unit,
      applied: Number.isFinite(applied) ? applied : null,
      recommended: Number.isFinite(recValue) ? recValue : null,
      delta: null,
      deltaText: '—',
      judgment: { state: 'unknown', text: '' },
    };
    if (item.recommended === null) {
      item.judgment = {
        state: 'unknown',
        text: '无法判定：推荐值缺失（没有实测显存或缺成功样本），先 --peak-mem-mib 补实测值或接引擎 /metrics 重跑',
      };
      return item;
    }
    if (item.applied === null) {
      item.judgment = { state: 'unknown', text: '无法判定：没给实际申请值（--applied-mem / --applied-cores），这里只列出推荐值' };
      return item;
    }
    if (item.applied === 0) {
      item.judgment = { state: 'note', text: `${zeroNote}：与 vGPU 份额不是同一口径，不做比值判定` };
      return item;
    }
    const delta = item.recommended - item.applied;
    item.delta = delta;
    const sign = delta > 0 ? '+' : delta < 0 ? '-' : '±';
    const absPct = Math.abs(delta) / item.applied * 100;
    const pctText = absPct >= 10 ? absPct.toFixed(0) : absPct.toFixed(1);
    item.deltaText = delta === 0
      ? `±0${unit}`
      : `${sign}${Math.abs(delta)}${unit}（${sign}${pctText}%）`;
    if (delta > 0) {
      item.judgment = { state: 'grow', text: growNote };
    } else if (item.recommended < item.applied * RECLAIM_RATIO) {
      item.judgment = { state: 'reclaim', text: reclaimNote };
    } else {
      item.judgment = { state: 'match', text: '基本匹配，保持现值' };
    }
    return item;
  };

  return [
    build({
      key: 'memory',
      label: '显存 memoryMiB',
      unit: ' MiB',
      applied: appliedMemMiB,
      recValue: rec.memoryMiB,
      zeroNote: '实际申请 0 = 整卡独占',
      growNote: '需要扩容，否则高峰期会 OOM/排队（显存：KV cache 随并发线性涨，涨过申请值就是 OOMKilled）',
      reclaimNote: '可回收，空转占卡（先按峰值再压一轮确认，别用单次基准一键缩）',
    }),
    build({
      key: 'cores',
      label: '算力 coresPercent',
      unit: ' pp',
      applied: appliedCoresPercent,
      recValue: rec.coresPercent,
      zeroNote: '实际申请 0 = 不限算力',
      growNote: '需要扩容，否则高峰期会 OOM/排队（算力：排队发生在调度器侧，表现为 TTFT p95 飙升）',
      reclaimNote: '可回收，空转占卡（算力份额收多了会让 p95 TTFT 反弹，收完必须复测）',
    }),
  ];
}

/**
 * 把逐项判定汇总成一句人话结论。
 * @param {Array<object>} comparisons compareQuota 的输出
 * @returns {string} 结论
 */
export function summarizeVerdict(comparisons = []) {
  const grow = comparisons.filter((c) => c.judgment.state === 'grow').map((c) => c.label);
  const reclaim = comparisons.filter((c) => c.judgment.state === 'reclaim').map((c) => c.label);
  const unknown = comparisons.filter((c) => c.judgment.state === 'unknown' || c.judgment.state === 'note');
  if (grow.length === 0 && reclaim.length === 0) {
    if (unknown.length === comparisons.length) return '没有可对比的项：推荐值和实际申请值至少要各有一个，才能对拍。';
    return '配额与实际负载基本匹配：没有需要扩容的项，也没有明显空转的项。';
  }
  const parts = [];
  if (grow.length > 0) parts.push(`${grow.join('、')}需要扩容（改 resources 后必须重建 Pod，按 docs/INFRA.md §4.2 排窗口）`);
  if (reclaim.length > 0) parts.push(`${reclaim.join('、')}可回收（先确认业务峰值，回收后必须复测 p95 TTFT）`);
  const tail = unknown.length > 0 ? `；${unknown.map((c) => c.label).join('、')}本次无法判定` : '';
  return `${parts.join('；')}${tail}。`;
}

/* ─────────────────────────────── 报告渲染 ─────────────────────────────── */

/**
 * 组合结果表（每个 (并发, 输入长度) 一行）。
 * @param {Array<object>} results runBenchmark().results
 * @returns {string} 表格文本
 */
export function formatResultTable(results = []) {
  const rows = results.map((r) => {
    const done = (r.samples ?? 0) + (r.errors ?? 0);
    const errorRate = done > 0 ? (r.errors ?? 0) / done : null;
    return [
      r.concurrency,
      r.inputTokens,
      `${r.samples}/${done}`,
      fmtMs(r.ttftMs?.p50),
      fmtMs(r.ttftMs?.p95),
      fmtTps(r.tokensPerSec),
      fmtRate(errorRate),
      r.ok ? (r.aborted ? '中止' : 'OK') : '不合格',
    ];
  });
  return renderTable(
    ['并发', '输入 tokens', '成功/请求', 'TTFT p50', 'TTFT p95', 'tokens/s', '错误率', '状态'],
    rows,
    ['right', 'right', 'right', 'right', 'right', 'right', 'right', 'left'],
  );
}

/**
 * 推荐配额 vs 实际申请对照表。
 * @param {Array<object>} comparisons compareQuota 的输出
 * @returns {string} 表格文本
 */
export function formatQuotaTable(comparisons = []) {
  const rows = comparisons.map((c) => [
    c.label,
    c.applied === null ? '未提供' : `${c.applied}${c.unit}`,
    c.recommended === null ? '无法推导' : `${c.recommended}${c.unit}`,
    c.deltaText,
    c.judgment.text,
  ]);
  return renderTable(
    ['项', '实际申请', '推荐值', '偏差（推荐 − 申请）', '判定'],
    rows,
    ['left', 'right', 'right', 'right', 'left'],
  );
}

/** 安全阀一行的展示（让读者知道这次是在什么阀值下跑的） */
function formatLimitsLine(limits) {
  return `maxConcurrency=${limits.maxConcurrency} · maxRequestsPerCell=${limits.maxRequestsPerCell}`
    + ` · maxTotalMs=${limits.maxTotalMs}ms · maxErrorRate=${(limits.maxErrorRate * 100).toFixed(0)}%`
    + ` · maxP95TtftMs=${limits.maxP95TtftMs}ms · maxTokensPerSec=${limits.maxTokensPerSec}`;
}

/**
 * dry-run 的计划展示：**只打印将要执行的矩阵与目标，不发任何请求**。
 * @param {object} plan buildPlan().plan
 * @returns {string} 多行文本
 */
export function formatPlan(plan) {
  const out = [];
  out.push('== infra-bench-verify · DRY RUN（不发任何请求） ==');
  out.push('');
  out.push(`目标端点    ${plan.endpoint}`);
  out.push(`模型名      ${plan.target.model}`);
  out.push(`鉴权        ${plan.target.apiKey ? 'Bearer ***（已给 --api-key）' : '未给 --api-key（服务若开启鉴权会全 401）'}`);
  out.push(`安全阀      ${formatLimitsLine(plan.limits)}（默认值来自 bench 的 DEFAULT_LIMITS）`);
  out.push(`矩阵        ${plan.concurrencies.length} 档并发 × ${plan.inputTokens.length} 档输入 = ${plan.cells.length} 个组合，串行执行`);
  out.push(`预计请求数  约 ${plan.totalRequests} 次（估算：每 worker ${plan.rounds} 轮，单组合上限 ${plan.limits.maxRequestsPerCell}）`);
  out.push(`显存来源    ${plan.peakGpuMemMiB === null ? '未给 --peak-mem-mib → 推荐显存会是 null，confidence=estimated' : `${plan.peakGpuMemMiB} MiB（--peak-mem-mib）`}`);
  out.push(`实际申请    显存 ${plan.applied.memoryMiB === null ? '未提供' : `${plan.applied.memoryMiB} MiB`}`
    + ` · 算力 ${plan.applied.coresPercent === null ? '未提供' : `${plan.applied.coresPercent}%`}`);
  out.push(`结果落盘    ${plan.out ?? '无（只打到 stdout，加 --out result.json 才有 JSON）'}`);
  out.push('');
  out.push('将要执行的组合：');
  out.push('');
  out.push(renderTable(
    ['#', '并发', '输入 tokens', '预计请求数'],
    plan.cells.map((c, i) => [i + 1, c.concurrency, c.inputTokens, c.requests]),
    ['right', 'right', 'right', 'right'],
  ));
  if (plan.warnings.length > 0) {
    out.push('');
    out.push('注意：');
    for (const w of plan.warnings) out.push(`  · ${w}`);
  }
  out.push('');
  out.push('真跑时去掉 --dry-run。压测会占用 GPU，同卡邻居会被拖慢（HAMi 算力隔离实测仅约 26% 有效）。');
  return out.join('\n');
}

/**
 * 完整报告（真实运行结束后）。
 * @param {object} args 参数
 * @param {object} args.plan buildPlan().plan
 * @param {object} args.bench runBenchmark() 的返回
 * @param {Array<object>} args.comparisons compareQuota 的输出
 * @param {object} args.consistency 自检结果 { consistent, note }
 * @returns {string} 多行文本
 */
export function formatReport({
  plan, bench, comparisons, consistency,
}) {
  const out = [];
  out.push('== infra-bench-verify · 真机对拍报告 ==');
  out.push('');
  out.push(`目标端点    ${plan.endpoint}`);
  out.push(`模型名      ${plan.target.model}`);
  out.push(`矩阵        ${plan.cells.length} 个组合（并发 ${plan.concurrencies.join(',')} × 输入 ${plan.inputTokens.join(',')}）`);
  out.push(`安全阀      ${formatLimitsLine(plan.limits)}`);
  out.push('');

  if (bench.reason) {
    out.push('!! 基准被安全阀中止');
    out.push(`   原因：${bench.reason}`);
    out.push(`   已完成的组合：${bench.results.length} 个 —— 下面的结论只基于这些，样本不足时不要拿它定配额。`);
    out.push('');
  }

  out.push('[1] 组合结果');
  out.push('');
  out.push(bench.results.length > 0 ? formatResultTable(bench.results) : '（没有任何组合产出结果）');
  out.push('');

  const best = bench.summary?.best;
  if (best) {
    out.push(`最优点：${best.concurrency} 并发 / ${best.inputTokens} tokens —— ${fmtTps(best.tokensPerSec)} tokens/s，p95 TTFT ${fmtMs(best.ttftMs?.p95)}`);
  } else {
    out.push('最优点：无（没有任何 ok 且有样本的组合）');
  }
  out.push('');

  out.push('[2] 推荐配额 vs 实际申请');
  out.push('');
  out.push(formatQuotaTable(comparisons));
  out.push('');
  const rec = bench.summary?.recommended ?? {};
  out.push(`置信度：confidence=${rec.confidence ?? 'estimated'}`
    + `（${rec.confidence === 'measured' ? '有实测显存峰值' : '没有实测显存峰值，显存建议为空或只能按权重估'}）`);
  out.push('');

  out.push('[3] 判定');
  out.push('');
  out.push(summarizeVerdict(comparisons));
  if (!consistency.consistent) {
    out.push('');
    out.push(`!! 自检不一致：${consistency.note}`);
  }
  out.push('');

  const notes = Array.isArray(rec.notes) ? rec.notes : [];
  if (notes.length > 0) {
    out.push('[4] bench 的推导备注');
    out.push('');
    for (const n of notes) out.push(`  · ${n}`);
    out.push('');
  }

  if (Array.isArray(plan.warnings) && plan.warnings.length > 0) {
    out.push('[5] 参数告警');
    out.push('');
    for (const w of plan.warnings) out.push(`  · ${w}`);
    out.push('');
  }

  out.push(`退出码：${exitCodeFor({ bench })}（0 正常完成 / 3 不可达 / 4 被中止）`);
  return out.join('\n');
}

/**
 * 根据 bench 结果决定退出码。
 * @param {object} args 参数
 * @param {object} args.bench runBenchmark() 的返回
 * @param {boolean} [args.unreachable] 探活失败
 * @returns {number} 退出码
 */
export function exitCodeFor({ bench, unreachable = false }) {
  if (unreachable) return EXIT.UNREACHABLE;
  const samples = (bench.results ?? []).reduce((a, r) => a + (r.samples ?? 0), 0);
  const netErrors = (bench.results ?? []).reduce((a, r) => a + (r.errorKinds?.network ?? 0), 0);
  if (samples === 0 && netErrors > 0) return EXIT.UNREACHABLE;
  if (bench.aborted) return EXIT.ABORTED;
  if (samples === 0) return EXIT.INTERNAL;
  return EXIT.OK;
}

/* ─────────────────────────────── 探活 ─────────────────────────────── */

/**
 * 探活：确认「端点上有东西在回话」。**不产生生成流量**（一个 GET，不等模型输出）。
 * 只要拿到 HTTP 状态码就算可达 —— 404/405 同样证明端口/网关是通的。
 * dry-run 不会调用本函数。
 *
 * @param {object} args 参数
 * @param {string} args.url 完整端点
 * @param {string|null} [args.apiKey] Bearer token
 * @param {number} [args.timeoutMs] 超时
 * @param {Function} [args.fetchImpl] 注入的 fetch（默认 globalThis.fetch）
 * @returns {Promise<{ok: boolean, status?: number, code?: string|null, hint?: string, detail?: string|null}>} 结果
 */
export async function preflightEndpoint({
  url, apiKey = null, timeoutMs = PREFLIGHT_TIMEOUT_MS, fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    return { ok: false, code: 'NO_FETCH', hint: '运行环境没有 fetch（需要 Node 18+）' };
  }
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), Math.max(500, timeoutMs)) : null;
  if (timer && typeof timer.unref === 'function') timer.unref();
  try {
    const res = await fetchImpl(url, { method: 'GET', headers, ...(controller ? { signal: controller.signal } : {}) });
    const status = Number(res?.status ?? 0);
    try {
      await res?.body?.cancel?.();
    } catch { /* 探活不关心响应体，取消失败也无所谓 */ }
    return { ok: true, status };
  } catch (err) {
    return { ok: false, ...describeNetError(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ─────────────────────────────── 落盘 ─────────────────────────────── */

function writeJson(outPath, payload) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

/* ─────────────────────────────── 帮助 ─────────────────────────────── */

/** @returns {string} 帮助文本 */
export function formatHelp() {
  return [
    'infra-bench-verify —— 推理服务基准真机对拍（复用 server/infra/bench.js）',
    '',
    '用法：',
    '  node scripts/infra-bench-verify.mjs --url URL --model NAME [options]',
    '',
    '必填：',
    '  --url URL                OpenAI 兼容端点，如 http://10.0.0.12:8000/v1/chat/completions',
    '  --model NAME             服务里的模型名（引擎按它路由）',
    '',
    '矩阵：',
    `  --concurrency LIST       并发档位，逗号分隔，默认 ${DEFAULT_MATRIX.concurrencies.join(',')}，上限 ${DEFAULT_LIMITS.maxConcurrency}`,
    `  --tokens LIST            输入 token 档位，逗号分隔，默认 ${DEFAULT_MATRIX.inputTokens.join(',')}`,
    '  --matrix                 额外并入 bench 默认矩阵（与上面两档合并去重）',
    '  --rounds N               每个 worker 跑几轮（只影响请求数，默认 4）',
    '  --max-requests-per-cell N 单组合请求数上限（默认 20）',
    '',
    '对拍：',
    '  --applied-mem MiB        服务实际申请的显存（ModelService.resources.memoryMiB，0..65536）',
    '  --applied-cores PP       服务实际申请的算力（coresPercent，0..100）',
    '  --peak-mem-mib MiB       手工提供实测显存峰值（没有引擎 /metrics 时用；给了 confidence 才是 measured）',
    '  --memory-headroom R      显存余量系数（默认 1.25）',
    '  --cores-per-concurrency N 每 N% 算力承载 1 路并发的假设（默认 10）',
    '',
    '安全阀 / 输出：',
    '  --max-total-ms MS        整轮墙钟上限（默认 120000）',
    '  --max-p95-ttft-ms MS     p95 TTFT 超阈值即中止（默认 30000）',
    '  --max-error-rate R       错误率超阈值即中止（0-1，默认 0.2）',
    '  --out FILE               结果落 JSON',
    '  --dry-run                只打印计划，不发任何请求',
    '  --skip-preflight         跳过探活（端点对 GET 反应异常时用）',
    '  --api-key KEY            Bearer token（不会写进 --out 的 JSON）',
    '  --help                   本帮助',
    '',
    '退出码：0 正常 / 1 内部错误 / 2 参数非法 / 3 不可达 / 4 被安全阀中止',
    '',
    '文档：docs/INFRA-BENCH.md',
  ].join('\n');
}

/* ─────────────────────────────── 主流程 ─────────────────────────────── */

/**
 * CLI 主流程。
 * @param {string[]} argv 参数（不含 node 与脚本名）
 * @param {object} [io] 注入点（测试用）
 * @param {Function} [io.fetchImpl] fetch
 * @param {Function} [io.run] runBenchmark 替身
 * @param {Function} [io.log] stdout 输出
 * @param {Function} [io.error] stderr 输出
 * @returns {Promise<number>} 退出码
 */
export async function main(argv = [], io = {}) {
  const log = io.log ?? ((s) => process.stdout.write(`${s}\n`));
  const error = io.error ?? ((s) => process.stderr.write(`${s}\n`));
  const fetchImpl = io.fetchImpl ?? globalThis.fetch;
  const run = io.run ?? runBenchmark;

  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    error(`✗ ${parsed.error}`);
    return EXIT.USAGE;
  }
  if (parsed.value.help) {
    log(formatHelp());
    return EXIT.OK;
  }

  const built = buildPlan(parsed.value);
  if (!built.ok) {
    error(`✗ ${built.error}`);
    return EXIT.USAGE;
  }
  const plan = built.plan;

  if (plan.dryRun) {
    log(formatPlan(plan));
    return EXIT.OK;
  }

  if (typeof fetchImpl !== 'function') {
    error('✗ 运行环境没有 fetch：需要 Node 18+ 才能对拍');
    return EXIT.INTERNAL;
  }

  // ── 探活：不可达要在压测之前就说清楚，别让它伪装成「错误率 100%」 ──
  if (!plan.skipPreflight) {
    const probe = await preflightEndpoint({
      url: plan.endpoint, apiKey: plan.target.apiKey, fetchImpl,
    });
    if (!probe.ok) {
      error(`✗ 目标服务不可达：${plan.endpoint}`);
      error(`  错误码：${probe.code ?? '未知'} —— ${probe.hint}`);
      if (probe.detail) error(`  底层报错：${probe.detail}`);
      error('  常见原因：Pod 还没 Ready / --url 端口或路径写错 / 网关没起 / NetworkPolicy 挡了本机。');
      error(`  自查：curl -sS -m 5 -X POST '${plan.endpoint}' -H 'Content-Type: application/json' -d '{"model":"${plan.target.model}","stream":false,"max_tokens":8,"messages":[{"role":"user","content":"ping"}]}'`);
      error('  确认可达后重跑；若端点对 GET 反应异常但 POST 正常，加 --skip-preflight。');
      return EXIT.UNREACHABLE;
    }
    log(`探活：${plan.endpoint} 回 HTTP ${probe.status}（可达）`);
  }

  let bench;
  try {
    bench = await run({
      target: { url: plan.target.url, model: plan.target.model, ...(plan.target.apiKey ? { apiKey: plan.target.apiKey } : {}) },
      matrix: { concurrencies: plan.concurrencies, inputTokens: plan.inputTokens },
      limits: plan.limits,
      fetchImpl,
      // bench.js 的主循环用裸 `now` 而非归一后的时钟：不注入就会抛
      // 「now is not a function」（真机与 HTTP 路由都会撞上）。这里显式给一个，
      // 语义与 bench 的 defaultNow 相同（performance.now 优先）。
      now: monotonicNow,
      ...(plan.peakGpuMemMiB !== null ? { gpuMemPeakMiB: plan.peakGpuMemMiB } : {}),
      ...(plan.requestsPerCell !== null ? { requestsPerCell: plan.requestsPerCell } : {}),
      rounds: plan.rounds,
      memoryHeadroom: plan.memoryHeadroom,
      coresPerConcurrency: plan.coresPerConcurrency,
    });
  } catch (err) {
    error(`✗ 基准执行失败：${err && err.message ? err.message : String(err)}`);
    return EXIT.INTERNAL;
  }

  if (!bench || !Array.isArray(bench.results)) {
    error('✗ 基准没有返回 results：bench.runBenchmark 的返回结构变了，脚本需要同步');
    return EXIT.INTERNAL;
  }

  // 整轮全是 network 错误 = 打到一半服务没了，同样按不可达处理（不要静默成功）
  if (exitCodeFor({ bench }) === EXIT.UNREACHABLE) {
    error(`✗ 目标服务不可达：${plan.endpoint}（${bench.results.length} 个组合全部是网络错误，没有拿到任何样本）`);
    error('  这与「服务在但模型报错」不同：先确认 Pod 状态与 --url，再重跑。');
    return EXIT.UNREACHABLE;
  }

  // ── 配额对拍 ──
  const recommended = bench.summary?.recommended ?? {
    memoryMiB: null, coresPercent: null, confidence: 'estimated', notes: [],
  };
  // 显式重算一遍：参数与 bench 内部完全一致，用来做「脚本没走样」的自检。
  const recomputed = recommendQuota({
    results: bench.results,
    best: bench.summary?.best ?? null,
    peakGpuMemMiB: recommended.basis?.peakGpuMemMiB ?? null,
    memoryHeadroom: plan.memoryHeadroom,
    coresPerConcurrency: plan.coresPerConcurrency,
  });
  const consistent = recomputed.memoryMiB === recommended.memoryMiB
    && recomputed.coresPercent === recommended.coresPercent;
  const consistency = {
    consistent,
    note: consistent
      ? '脚本重算的推荐值与 bench.summary.recommended 一致'
      : `脚本重算（memory=${recomputed.memoryMiB}, cores=${recomputed.coresPercent}）与 bench.summary.recommended`
        + `（memory=${recommended.memoryMiB}, cores=${recommended.coresPercent}）不一致：说明两侧参数不同源，以 bench 内部结果为准并检查 --memory-headroom/--cores-per-concurrency`,
  };

  const comparisons = compareQuota({
    recommended,
    appliedMemMiB: plan.applied.memoryMiB,
    appliedCoresPercent: plan.applied.coresPercent,
  });

  log(formatReport({ plan, bench, comparisons, consistency }));

  if (plan.out) {
    const payload = {
      tool: 'infra-bench-verify',
      version: 1,
      generatedAt: new Date().toISOString(),
      target: {
        endpoint: plan.endpoint,
        url: plan.target.url,
        model: plan.target.model,
        apiKey: plan.target.apiKey ? '***' : null,
      },
      matrix: { concurrencies: plan.concurrencies, inputTokens: plan.inputTokens, cells: plan.cells },
      limits: plan.limits,
      assumptions: {
        rounds: plan.rounds,
        requestsPerCell: plan.requestsPerCell,
        peakGpuMemMiB: plan.peakGpuMemMiB,
        memoryHeadroom: plan.memoryHeadroom,
        coresPerConcurrency: plan.coresPerConcurrency,
      },
      applied: plan.applied,
      bench: {
        ok: bench.ok,
        aborted: bench.aborted,
        reason: bench.reason,
        results: bench.results,
        summary: bench.summary,
      },
      quota: {
        recommended,
        recomputed: {
          memoryMiB: recomputed.memoryMiB,
          coresPercent: recomputed.coresPercent,
          confidence: recomputed.confidence,
        },
        consistent,
        comparisons,
        verdict: summarizeVerdict(comparisons),
      },
      exitCode: exitCodeFor({ bench }),
    };
    try {
      writeJson(plan.out, payload);
      log(`结果已写入 ${plan.out}`);
    } catch (err) {
      error(`✗ 写结果文件失败（${plan.out}）：${err && err.message ? err.message : String(err)}`);
      return EXIT.INTERNAL;
    }
  }

  return exitCodeFor({ bench });
}

/* ─────────────────────────────── 入口 ─────────────────────────────── */

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
      // 兜底：若还有 keep-alive 连接让事件循环不退出，2s 后强制退出（unref 后不影响正常退出）
      const guard = setTimeout(() => process.exit(code), 2000);
      if (typeof guard.unref === 'function') guard.unref();
    })
    .catch((err) => {
      process.stderr.write(`✗ 未捕获异常：${err && err.stack ? err.stack : String(err)}\n`);
      process.exit(EXIT.INTERNAL);
    });
}
