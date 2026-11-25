/**
 * server/infra/gate.js
 *
 * 基准门禁（派工单 B5）：**没有跑过基准的配置不许上线**。
 *
 * 背景：`server/infra/bench.js` 只负责「测 + 反推推荐配额」，它给出的
 * `summary.recommended` 本质是建议 —— 建议没人执行就等于没有。门禁把建议变成
 * 闸门：一次变更必须带着基准结果来，逐项对着阈值过一遍，不达标就不许 apply，
 * 并且产出一份可以直接贴进 PR / 变更单的 markdown 报告留痕。
 *
 * 设计约束（与 /tmp/infra-contract2.md 一致）：
 *
 *   1. **纯函数**：不联网、不读盘、不读环境变量、不抛异常。所有输入靠参数注入，
 *      阈值 / baseline / 时钟都可替换，测试不需要真集群也不需要真推理服务。
 *   2. **不抛异常**：非法输入一律「记问题 + 给可执行的中文文案」，
 *      因为门禁本身挂掉会让变更流程卡死，比放行一次更糟糕。
 *   3. **半截数据不算结论**：`benchResult.aborted === true` 或 `ok === false` 时
 *      直接判不通过并说明原因 —— 中止的基准只能证明「服务当时不正常」，
 *      它的 TTFT / 吞吐不能拿来当上线依据。
 *   4. **显存置信度只降级为 warning**：`confidence === 'estimated'` 说明没读到
 *      实测显存峰值（推理引擎没暴露 /metrics，或读数适配层没接），此时显存建议
 *      是「按已知信息估算」的。把它判死不通过，会让所有没接 metrics 的引擎
 *      永远上不了线 —— 但报告里必须显式标注「显存建议为估算值」，让人去手工核对。
 *      取舍的完整理由见 `DEFAULT_THRESHOLDS.confidenceIsWarning` 上方的注释。
 *   5. **权重显式**：`score` 只用来给「快通过了」和「差得远」一个可比的刻度，
 *      权重写在 `GATE_WEIGHTS` 里并逐项注明理由，不搞隐式加权。
 *
 * 术语：
 *   - **cell**：基准矩阵里的一个 (并发, 上下文长度) 组合，来自 bench.js 的 results[i]。
 *   - **实测值**：所有 cell 聚合后的单值（见 `collectBenchMetrics`），
 *     取「最差 p95 / 最差错误率 / 最好吞吐」——门禁看的是最坏情况，不是平均值。
 *   - **基线（baseline）**：上一次通过门禁并记录下来的数字，用来做回归对比。
 */

import { serviceKey as toServiceKey } from './model.js';

/* ─────────────────────────────── 默认阈值 ─────────────────────────────── */

/**
 * 默认阈值。每一条都能被 `evaluateGate({ thresholds })` 覆盖，
 * 覆盖结果会写进 `gate.warnings`（报告里要能看出「这次用的是哪套数字」）。
 */
export const DEFAULT_THRESHOLDS = Object.freeze({
  /** p95 首 token 延迟上限（ms）。3000ms 是「用户还能接受」的临界：超过就是排队，不是推理慢。 */
  ttftP95Ms: 3000,
  /** 错误率上限（0-1）。1% 是变更允许的抖动天花板；再高说明服务本身不健康。 */
  errorRate: 0.01,
  /** 吞吐回归容忍度：不得低于 baseline × 0.8。20% 以内是噪声/邻居干扰，超过就是真回退。 */
  tokensPerSecRatio: 0.8,
  /** 吞吐绝对下限（tokens/s）；null = 不设绝对下限，只看 baseline 比值。 */
  tokensPerSec: null,
  /** 显存上限（MiB）；null = 用 `service.resources.memoryMiB`（推荐值不得超过实际申请）。 */
  memMiB: null,
  /** TTFT 回归容忍度：比 baseline 差超过 25% 只给 warning（延迟受邻居算力挤占，不宜直接判死）。 */
  ttftRegressionRatio: 0.25,
  /** 显存需求相比 baseline 上涨告警线：超过 25% 提醒人工复核（vGPU 份额不够会 OOM）。 */
  memGrowthRatio: 0.25,
});

/**
 * 评分权重（总和 100）。理由：
 *
 *   - **TTFT 30**：唯一「用户能直接感知」的指标（第一个字什么时候出来），
 *     超标就是体感事故，权重最高。
 *   - **errorRate 25**：正确性 / 稳定性。一次 5xx 在线上就是事故，
 *     但它是二值型指标（0 或爆），给比 TTFT 略低的权重避免抖动主导分数。
 *   - **tokensPerSec 25**：唯一横向（跨版本 / 跨机型）可比项，抗回归主力。
 *     权重不压过 TTFT，因为吞吐受同卡邻居干扰大（HAMi 算力隔离实测仅 ~26%）。
 *   - **memMiB 20**：账目正确性（不能偷偷超卖）。违反即必须阻塞，
 *     但它不直接影响 SLO 体感，所以分数上给最低权重。
 *
 * 某几项无法评估时（无 baseline → 无吞吐回归项；无显存读数 → 无显存项），
 * 权重在剩余项上**重新归一**，而不是把缺项当满分 —— 否则「什么都没测」也能拿 100。
 */
export const GATE_WEIGHTS = Object.freeze({
  ttftP95Ms: 30,
  errorRate: 25,
  tokensPerSec: 25,
  memMiB: 20,
});

/* ─────────────────────────────── 小工具 ─────────────────────────────── */

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function round2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** 数字 → 展示字符串（null / NaN 一律 '—'，报告里不能出现 NaN） */
function fmtNum(value, digits = 1) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

function fmtMs(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${fmtNum(value)} ms` : '—';
}

function fmtPct(value, digits = 2) {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${(value * 100).toFixed(digits)}%`
    : '—';
}

function fmtTps(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${fmtNum(value, 2)} tokens/s` : '—';
}

function fmtMiB(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${fmtNum(value)} MiB` : '—';
}

/** 服务名（报告标题用）；service 缺失也绝不抛错 */
function serviceKeyOf(service) {
  if (!service || typeof service !== 'object') return null;
  try {
    return toServiceKey(service);
  } catch {
    return null;
  }
}

/* ─────────────────────────── 基准结果聚合 ─────────────────────────── */

/**
 * 把 bench.js 的 `results[]` 聚合成门禁要看的**单值**。
 *
 * 聚合口径（保守，偏「最坏情况」）：
 *   - `ttftP95Ms`：所有 cell 的 p95 取**最大值**。门禁关心的是「最慢那一档
 *     用户还能不能忍」，平均 p95 会把 8 并发那档的排队藏起来。
 *   - `errorRate`：`Σerrors / (Σsamples + Σerrors)`。分母用**实际完成数**
 *     （成功 + 失败），不用 `requests`（计划数）—— 中止时请求没发完，
 *     用计划数当分母会把错误率稀释成假低值。
 *   - `tokensPerSec`：所有「有样本且 ok」的 cell 里取**最大值**（峰值吞吐），
 *     与 bench.js `recommendQuota` 的取法保持一致，否则两边的数对不上。
 *   - 若调用方已经在 benchResult 顶层给了聚合值（`ttftP95Ms` / `errorRate` /
 *     `tokensPerSec`），优先信顶层：路由层可能把多轮基准合并后再送进门禁。
 *
 * @param {object} benchResult `bench.js#runBenchmark` 的返回值
 * @returns {{ttftP95Ms: number|null, errorRate: number|null, tokensPerSec: number|null,
 *   samples: number, errors: number, done: number, requests: number, cells: number,
 *   memoryMiB: number|null, coresPercent: number|null, confidence: string,
 *   best: object|null, recommended: object|null}}
 */
export function collectBenchMetrics(benchResult) {
  const src = benchResult && typeof benchResult === 'object' ? benchResult : {};
  const results = Array.isArray(src.results)
    ? src.results.filter((r) => r && typeof r === 'object')
    : [];

  let samples = 0;
  let errors = 0;
  let requests = 0;
  let ttft = null;
  let tps = null;

  for (const cell of results) {
    const cellSamples = Math.max(0, Math.floor(finiteNumber(cell.samples) ?? 0));
    const cellErrors = Math.max(0, Math.floor(finiteNumber(cell.errors) ?? 0));
    const cellRequests = Math.max(0, Math.floor(finiteNumber(cell.requests) ?? 0));
    samples += cellSamples;
    errors += cellErrors;
    requests += cellRequests;

    const p95 = finiteNumber(cell?.ttftMs?.p95);
    if (cellSamples > 0 && p95 !== null && p95 >= 0) {
      ttft = ttft === null ? p95 : Math.max(ttft, p95);
    }

    const cellTps = finiteNumber(cell.tokensPerSec);
    if (cellSamples > 0 && cellTps !== null && cellTps > 0) {
      tps = tps === null ? cellTps : Math.max(tps, cellTps);
    }
  }

  const recommended = src?.summary?.recommended && typeof src.summary.recommended === 'object'
    ? src.summary.recommended
    : null;
  const best = src?.summary?.best && typeof src.summary.best === 'object' ? src.summary.best : null;
  const done = samples + errors;

  return {
    ttftP95Ms: finiteNumber(src.ttftP95Ms) ?? ttft,
    errorRate: finiteNumber(src.errorRate) ?? (done > 0 ? round2(errors / done) : null),
    tokensPerSec: finiteNumber(src.tokensPerSec) ?? tps,
    samples,
    errors,
    done,
    requests,
    cells: results.length,
    memoryMiB: finiteNumber(recommended?.memoryMiB),
    coresPercent: finiteNumber(recommended?.coresPercent),
    confidence: typeof recommended?.confidence === 'string' ? recommended.confidence : 'estimated',
    best,
    recommended,
  };
}

/* ─────────────────────────── 阈值归一 ─────────────────────────── */

/**
 * 读一个可覆盖的数字阈值。非法值（负数、NaN、超范围）不抛错：
 * 回落默认值 + 记一条 warning —— 让门禁继续跑，但报告里能看出「这个数是兜底的」。
 *
 * @param {any} raw 用户给的值
 * @param {number} fallback 默认值
 * @param {{min: number, max: number, minText?: string, maxText?: string, label: string}} spec 范围与标签
 * @param {string[]} warnings 收集 warning 的数组
 * @returns {number} 生效值
 */
function readThreshold(raw, fallback, spec, warnings) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < spec.min || value > spec.max) {
    const range = `${spec.minText ?? spec.min} ~ ${spec.maxText ?? spec.max}`;
    warnings.push(
      `阈值 ${spec.label}=${JSON.stringify(raw)} 非法（允许 ${range}），已回落到默认值 ${fallback}`,
    );
    return fallback;
  }
  return value;
}

/**
 * 归一阈值：默认 → 显式便宜 → 从 service 推导。
 *
 * 显存上限的来源优先级：
 *   1. `thresholds.memMiB`（显式覆盖，压测报告里常用）；
 *   2. `service.resources.memoryMiB`（合同要求的口径：推荐值不得超过**实际申请**，
 *      否则等于偷偷超卖 vGPU 份额，邻居会被 OOM 掉）；
 *   3. `thresholds.memoryMiB`（别名，方便前端直接把字段名透传）。
 *
 * @param {object} thresholds 用户阈值
 * @param {{service?: object}} ctx 上下文
 * @returns {{values: object, overridden: string[]}} 生效阈值 + 被覆盖的键
 */
function normalizeThresholds(thresholds, { service } = {}) {
  const src = thresholds && typeof thresholds === 'object' ? thresholds : {};
  const warnings = [];
  const overridden = [];
  const values = {};

  const numSpecs = [
    ['ttftP95Ms', DEFAULT_THRESHOLDS.ttftP95Ms, { min: 1, max: 600000, minText: '>0', maxText: '600000', label: 'ttftP95Ms' }],
    ['errorRate', DEFAULT_THRESHOLDS.errorRate, { min: 0, max: 1, minText: '0', maxText: '1', label: 'errorRate' }],
    ['tokensPerSecRatio', DEFAULT_THRESHOLDS.tokensPerSecRatio, { min: 0, max: 1, minText: '0', maxText: '1', label: 'tokensPerSecRatio' }],
    ['ttftRegressionRatio', DEFAULT_THRESHOLDS.ttftRegressionRatio, { min: 0, max: 10, minText: '0', maxText: '10', label: 'ttftRegressionRatio' }],
    ['memGrowthRatio', DEFAULT_THRESHOLDS.memGrowthRatio, { min: 0, max: 10, minText: '0', maxText: '10', label: 'memGrowthRatio' }],
  ];

  for (const [key, fallback, spec] of numSpecs) {
    values[key] = readThreshold(src[key], fallback, spec, warnings);
    if (src[key] !== undefined && src[key] !== null && values[key] !== fallback) overridden.push(key);
  }
  // 阈值显式给但等于默认值，也算「用过自定义阈值」，便于报告说明来源
  for (const [key] of numSpecs) {
    if (src[key] !== undefined && src[key] !== null && !overridden.includes(key)) overridden.push(key);
  }

  // 吞吐绝对下限：null 表示不设（只看 baseline 比值）
  if (src.tokensPerSec !== undefined && src.tokensPerSec !== null && src.tokensPerSec !== '') {
    const v = readThreshold(src.tokensPerSec, null, { min: 1, max: 10000000, minText: '>0', maxText: '10000000', label: 'tokensPerSec' }, warnings);
    values.tokensPerSec = v === null ? null : v;
    overridden.push('tokensPerSec');
  } else {
    values.tokensPerSec = null;
  }

  // 显存上限：显式 > service.resources.memoryMiB > 别名
  const explicitMem = src.memMiB ?? src.memoryMiB;
  const serviceMem = finiteNumber(service?.resources?.memoryMiB);
  if (explicitMem !== undefined && explicitMem !== null && explicitMem !== '') {
    values.memMiB = readThreshold(
      explicitMem,
      null,
      { min: 0, max: 1048576, minText: '0', maxText: '1048576', label: 'memMiB' },
      warnings,
    );
    overridden.push('memMiB');
    values.memMiBSource = 'thresholds.memMiB';
  } else if (serviceMem !== null) {
    values.memMiB = serviceMem;
    values.memMiBSource = 'service.resources.memoryMiB';
  } else {
    values.memMiB = null;
    values.memMiBSource = null;
  }

  // 权重覆盖（可选）：只在显式给且合法时生效
  const weightOverride = src.weights && typeof src.weights === 'object' ? src.weights : null;
  if (weightOverride) {
    values.weights = { ...GATE_WEIGHTS };
    for (const key of Object.keys(GATE_WEIGHTS)) {
      const raw = finiteNumber(weightOverride[key]);
      if (raw !== null && raw >= 0 && raw <= 100) {
        values.weights[key] = raw;
        overridden.push(`weights.${key}`);
      }
    }
  } else {
    values.weights = { ...GATE_WEIGHTS };
  }

  return { values, warnings, overridden };
}

/* ─────────────────────────── 评分 ─────────────────────────── */

/**
 * 「越小越好」指标的满足度：`limit / actual`，夹到 [0,1]。
 * actual 恰好等于 limit → 1（边界值算通过，而且给满分，避免「卡线」被扣分误导）。
 */
function upperSatisfaction(actual, limit) {
  if (actual === null) return 0;
  if (!(actual > 0)) return 1;
  if (!(limit > 0)) return 0;
  return clamp(limit / actual, 0, 1);
}

/** 「越大越好」指标的满足度：`actual / floor`，夹到 [0,1]。 */
function lowerSatisfaction(actual, floor) {
  if (actual === null) return 0;
  if (!(floor > 0)) return 1;
  if (!(actual > 0)) return 0;
  return clamp(actual / floor, 0, 1);
}

/**
 * 加权评分：`100 × Σ(wᵢ × sᵢ) / Σwᵢ`，只统计**参与了判定**的项。
 *
 * 缺项（无 baseline 的吞吐回归、无显存读数的显存项）从分母里去掉而不是记 0 或记 1：
 *   - 记 0：第一次跑就永远不及格，门禁变成摆设；
 *   - 记 1：什么都没测也能 100，分数失去区分度。
 * 所以「重新归一 + 报告里列进未验证项」是唯一诚实的做法。
 */
function computeScore(checks, weights) {
  let sumWeight = 0;
  let sumScore = 0;
  for (const check of checks) {
    if (!check.scored) continue;
    const weight = finiteNumber(weights?.[check.metric]) ?? 0;
    if (weight <= 0) continue;
    sumWeight += weight;
    sumScore += weight * check.satisfaction;
  }
  if (sumWeight <= 0) return 0;
  return Math.round(clamp((sumScore / sumWeight) * 100, 0, 100));
}

/* ─────────────────────────── 门禁主逻辑 ─────────────────────────── */

/**
 * 判定一次变更能不能上线。
 *
 * 判定顺序（先硬后软，先重后轻）：
 *   1. `benchResult.aborted === true` → 不通过（半截数据不能当结论）；
 *   2. `benchResult.ok === false` → 不通过（基准自身没跑绿）；
 *   3. 一个成功样本都没有 → 不通过（无从判定）；
 *   4. TTFT p95、errorRate、吞吐回归、显存建议 vs 实际申请 逐项比对；
 *   5. confidence / 无 baseline / 显存上涨 等只记 warning，不影响 pass。
 *
 * 判定规则（**边界值算通过**）：`actual <= threshold` / `actual >= floor` 即通过，
 * 用严格大于/小于判失败，避免浮点抖动把刚好卡线的配置判死。
 *
 * @param {object} input 输入
 * @param {object} input.benchResult `bench.js#runBenchmark` 的返回值（**必填**）
 * @param {object|null} [input.baseline] `buildBaseline` 的产物；无则只按绝对阈值判
 * @param {object} [input.thresholds] 阈值覆盖，见 DEFAULT_THRESHOLDS
 * @param {object} [input.service] 模型服务（用 `resources.memoryMiB` 作显存上限）
 * @returns {{pass: boolean, failures: Array<{metric: string, actual: any, threshold: any, message: string}>,
 *   warnings: string[], score: number, metrics: object, thresholds: object, checks: Array<object>,
 *   baselineUsed: boolean, baseline: object|null}} 判定结果
 */
export function evaluateGate(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const { benchResult = null, baseline = null, thresholds = null, service = null } = src;

  const failures = [];
  const warnings = [];
  const checks = [];
  const metrics = collectBenchMetrics(benchResult);
  const norm = normalizeThresholds(thresholds, { service });
  warnings.push(...norm.warnings);
  const thr = norm.values;
  const hasBaseline = Boolean(baseline && typeof baseline === 'object');

  const finish = (pass, extra = {}) => {
    // 数值不达标但基准本身成立时仍然给分（例如 92 分代表「差一项」），
    // 只有基准不成立（中止 / 未跑绿 / 无样本）才因为没有可评项而自然得 0。
    const scored = computeScore(checks, thr.weights);
    return {
      pass,
      failures,
      warnings,
      score: scored,
      metrics,
      thresholds: {
        ttftP95Ms: thr.ttftP95Ms,
        errorRate: thr.errorRate,
        tokensPerSecRatio: thr.tokensPerSecRatio,
        tokensPerSec: thr.tokensPerSec,
        memMiB: thr.memMiB,
        memMiBSource: thr.memMiBSource,
        ttftRegressionRatio: thr.ttftRegressionRatio,
        memGrowthRatio: thr.memGrowthRatio,
        weights: { ...thr.weights },
      },
      checks,
      baselineUsed: hasBaseline,
      baseline: hasBaseline ? baseline : null,
      ...extra,
    };
  };

  // ── 0. 输入本身不可用 ──
  if (!benchResult || typeof benchResult !== 'object') {
    failures.push({
      metric: 'benchResult',
      actual: 'missing',
      threshold: 'runBenchmark() 的返回值',
      message: '没有基准结果：先跑 POST /api/infra/bench 拿到 { ok, results, summary }，再送进门禁。没有基准的配置只能算「未验证」，不能上线。',
    });
    checks.push({ metric: 'benchResult', label: '基准结果', actual: 'missing', threshold: '必填', pass: false, satisfaction: 0, scored: false });
    return finish(false);
  }

  if (norm.overridden.length > 0) {
    warnings.push(`本次使用自定义阈值：${norm.overridden.join('、')}（其余走默认值）`);
  }

  // ── 1. 中止：半截数据不能当结论 ──
  const abortReason = typeof benchResult.reason === 'string' && benchResult.reason.trim()
    ? benchResult.reason.trim()
    : '基准被安全阀中止（未给出原因）';
  if (benchResult.aborted === true) {
    failures.push({
      metric: 'aborted',
      actual: true,
      threshold: false,
      message: `基准被中止，已拿到的 ${metrics.cells} 个组合不足以支撑上线结论：${abortReason} 处置：降低并发/上下文长度后重跑完整矩阵，或先排查服务侧的排队与错误，再重新跑一轮。`,
    });
    checks.push({ metric: 'aborted', label: '基准中止', actual: '已中止', threshold: '完整跑完', pass: false, satisfaction: 0, scored: false });
  }

  // ── 2. 基准自身没跑绿 ──
  if (benchResult.ok === false) {
    const reason = benchResult.reason ? `（${benchResult.reason}）` : '';
    failures.push({
      metric: 'ok',
      actual: false,
      threshold: true,
      message: `基准没有跑绿${reason}：至少有一个组合没产出有效样本，或全部组合都失败。处置：先确认推理服务在 ${metrics.cells} 个组合下都能正常返回，再重跑。`,
    });
    checks.push({ metric: 'ok', label: '基准结论', actual: '未通过', threshold: 'ok=true', pass: false, satisfaction: 0, scored: false });
  }

  if (failures.length > 0) {
    warnings.push('基准本身不成立（中止 / 未跑绿）：数值指标未参与判定，报告里的实测值仅供参考，不构成上线依据。');
    return finish(false);
  }

  // ── 3. 一个成功样本都没有 ──
  if (metrics.samples <= 0 || metrics.ttftP95Ms === null) {
    failures.push({
      metric: 'samples',
      actual: metrics.samples,
      threshold: '>= 1',
      message: `没有任何可用的成功样本 / TTFT 读数（成功 ${metrics.samples} 个 / 失败 ${metrics.errors} 个）：无法计算 TTFT 与吞吐，这次基准不能证明任何事。处置：确认 target.url/model 正确、服务已就绪（/health 通过）后重跑基准。`,
    });
    checks.push({ metric: 'samples', label: '有效样本', actual: metrics.samples, threshold: '>= 1', pass: false, satisfaction: 0, scored: false });
    return finish(false);
  }

  // ── 4. TTFT p95 ──
  {
    const actual = metrics.ttftP95Ms;
    const limit = thr.ttftP95Ms;
    const ok = actual <= limit;
    checks.push({
      metric: 'ttftP95Ms',
      label: 'TTFT p95',
      actual,
      threshold: limit,
      pass: ok,
      satisfaction: upperSatisfaction(actual, limit),
      scored: true,
    });
    if (!ok) {
      failures.push({
        metric: 'ttftP95Ms',
        actual,
        threshold: limit,
        message: `p95 TTFT ${fmtMs(actual)} 超过上限 ${fmtMs(limit)}：用户会明显感到「卡在开头上」。处置：降 ctx/并发，或提高算力配额（coresPercent）后重跑；不要靠调高阈值过关。`,
      });
    }
    if (hasBaseline) {
      const baseTtft = finiteNumber(baseline.ttftP95Ms);
      if (baseTtft !== null && baseTtft > 0) {
        const allowed = baseTtft * (1 + thr.ttftRegressionRatio);
        if (actual > allowed) {
          warnings.push(
            `TTFT p95 相比基线回退 ${fmtNum(((actual / baseTtft) - 1) * 100)}%（基线 ${fmtMs(baseTtft)} → 本次 ${fmtMs(actual)}，容忍 +${Math.round(thr.ttftRegressionRatio * 100)}%）：可能只是同卡邻居挤占，也可能新配置真变慢了，建议在低负载时段复测一次。`,
          );
        }
      }
    }
  }

  // ── 5. 错误率 ──
  {
    const actual = metrics.errorRate ?? 0;
    const limit = thr.errorRate;
    const ok = actual <= limit;
    checks.push({
      metric: 'errorRate',
      label: '错误率',
      actual,
      threshold: limit,
      pass: ok,
      satisfaction: upperSatisfaction(actual, limit),
      scored: true,
    });
    if (!ok) {
      failures.push({
        metric: 'errorRate',
        actual,
        threshold: limit,
        message: `错误率 ${fmtPct(actual)} 超过上限 ${fmtPct(limit)}（${metrics.errors} 失败 / ${metrics.done} 完成）：带着会报错的配置上线等于把故障引到线上。处置：看 benchResult.results[].errorKinds（http / timeout / network / empty）定位是哪类失败，修好再重跑。`,
      });
    }
  }

  // ── 6. 吞吐回归 ──
  {
    const actual = metrics.tokensPerSec;
    const baseTps = hasBaseline ? finiteNumber(baseline.tokensPerSec) : null;
    const floor = thr.tokensPerSec !== null
      ? thr.tokensPerSec
      : (baseTps !== null && baseTps > 0 ? round2(baseTps * thr.tokensPerSecRatio) : null);

    if (floor === null) {
      warnings.push('首次运行：仅记录基线，未做回归对比（setup 里没有可用的 baseline.tokensPerSec，吞吐回归项未参与判定）');
      checks.push({
        metric: 'tokensPerSec',
        label: '吞吐',
        actual,
        threshold: null,
        pass: true,
        satisfaction: 1,
        scored: false,
      });
    } else {
      const ok = actual !== null && actual >= floor;
      checks.push({
        metric: 'tokensPerSec',
        label: '吞吐',
        actual,
        threshold: floor,
        pass: ok,
        satisfaction: lowerSatisfaction(actual, floor),
        scored: true,
      });
      if (!ok) {
        const basisText = thr.tokensPerSec !== null
          ? `自定义绝对下限 ${fmtTps(thr.tokensPerSec)}`
          : `基线 ${fmtTps(baseTps)} × ${thr.tokensPerSecRatio} = ${fmtTps(floor)}`;
        failures.push({
          metric: 'tokensPerSec',
          actual,
          threshold: floor,
          message: `吞吐 ${fmtTps(actual)} 低于下限 ${fmtTps(floor)}（${basisText}）：这是真回归，不是噪声。处置：对照上一次通过的配置查引擎参数（batch / max_num_seqs / 量化档），确认不是被邻居抢了算力后重跑。`,
        });
      }
    }
  }

  // ── 7. 显存建议 vs 实际申请（不许偷偷超卖） ──
  {
    const recommendedMiB = metrics.memoryMiB;
    const limit = thr.memMiB;
    if (limit === null) {
      warnings.push('未验证：没有拿到服务的实际显存申请（service.resources.memoryMiB），无法核对「推荐显存是否超过申请值」——超卖检查本次跳过。');
      checks.push({
        metric: 'memMiB',
        label: '显存建议',
        actual: recommendedMiB,
        threshold: null,
        pass: true,
        satisfaction: 1,
        scored: false,
      });
    } else if (limit === 0) {
      warnings.push('服务申请的是整卡显存（memoryMiB=0，不限），显存超卖检查不适用：HAMi 下 0 表示不切分份额，整卡归该 Pod 独占。');
      checks.push({
        metric: 'memMiB',
        label: '显存建议',
        actual: recommendedMiB,
        threshold: 0,
        pass: true,
        satisfaction: 1,
        scored: false,
      });
    } else if (recommendedMiB === null) {
      warnings.push('未验证：本次没有实测显存峰值（未注入 readGpuMem / gpuMemPeakMiB），显存建议值为空，无法与申请值比对；请按「模型权重 + KV cache（上下文 × 并发）」手工估算后填入 resources.memoryMiB。');
      checks.push({
        metric: 'memMiB',
        label: '显存建议',
        actual: null,
        threshold: limit,
        pass: true,
        satisfaction: 1,
        scored: false,
      });
    } else {
      const ok = recommendedMiB <= limit;
      checks.push({
        metric: 'memMiB',
        label: '显存建议',
        actual: recommendedMiB,
        threshold: limit,
        pass: ok,
        satisfaction: upperSatisfaction(recommendedMiB, limit),
        scored: true,
      });
      if (!ok) {
        failures.push({
          metric: 'memMiB',
          actual: recommendedMiB,
          threshold: limit,
          message: `推荐显存 ${fmtMiB(recommendedMiB)} 超过服务实际申请 ${fmtMiB(limit)}（缺 ${fmtMiB(recommendedMiB - limit)}）：按实际申请跑一定会 OOM 或被迫降 batch。处置：把 resources.memoryMiB 提到推荐值（注意同卡总份额），或降低 ctx/并发后重测。`,
        });
      }
      const baseMem = hasBaseline ? finiteNumber(baseline.memoryMiB) : null;
      if (baseMem !== null && baseMem > 0 && recommendedMiB > baseMem * (1 + thr.memGrowthRatio)) {
        warnings.push(
          `显存建议相比基线涨到 ${fmtMiB(recommendedMiB)}（基线 ${fmtMiB(baseMem)}，+${Math.round(((recommendedMiB / baseMem) - 1) * 100)}%）：确认是配置变了（更长上下文 / 更大 batch）而不是显存泄漏，否则同卡其他服务会被挤掉。`,
        );
      }
    }
  }

  // ── 8. 置信度：只降级为 warning ──
  if (metrics.confidence !== 'measured') {
    warnings.push('显存建议为估算值（confidence=estimated）：本次没有读到推理引擎的实测显存峰值，memoryMiB 不能当硬事实用，上线前请人工核对是否够 KV cache 用（或接上引擎 /metrics 后重跑）。');
  }

  const pass = failures.length === 0;
  return finish(pass);
}

/* ─────────────────────────── 生成基线 ─────────────────────────── */

/**
 * 把一次**通过门禁**的基准结果固化成 baseline，供下次做回归对比。
 *
 * 字段刻意扁平（而不是直接存 benchResult）：baseline 会被写进 settings / 审计，
 * 存整份 results 会让配置膨胀几十倍，而门禁只需要 5 个数字 + 置信度。
 *
 * `now` 可注入（Date / 毫秒时间戳 / () => Date），测试不需要真实时钟。
 *
 * @param {object} input 输入
 * @param {object} input.benchResult `bench.js#runBenchmark` 的返回值
 * @param {object} [input.service] 模型服务（用于生成 serviceKey）
 * @param {Date|number|string|(() => Date|number|string)} [input.now] 时间来源
 * @returns {{at: string, serviceKey: string|null, memoryMiB: number|null, coresPercent: number|null,
 *   ttftP95Ms: number|null, tokensPerSec: number|null, errorRate: number|null,
 *   confidence: 'measured'|'estimated', bestKey: string|null, samples: number, cells: number}}
 */
export function buildBaseline({ benchResult, service = null, now } = {}) {
  const metrics = collectBenchMetrics(benchResult);
  return {
    at: toIsoTime(now),
    serviceKey: serviceKeyOf(service),
    memoryMiB: metrics.memoryMiB,
    coresPercent: metrics.coresPercent,
    ttftP95Ms: metrics.ttftP95Ms,
    tokensPerSec: metrics.tokensPerSec,
    errorRate: metrics.errorRate,
    confidence: metrics.confidence === 'measured' ? 'measured' : 'estimated',
    bestKey: typeof benchResult?.summary?.bestKey === 'string' ? benchResult.summary.bestKey : null,
    samples: metrics.samples,
    cells: metrics.cells,
  };
}

/**
 * 时间来源归一成 ISO 字符串。
 * 支持 Date / 时间戳 / ISO 字符串 / 返回它们的函数；拿不到就用当前时间。
 *
 * @param {Date|number|string|Function} [now] 时间来源
 * @returns {string} ISO 时间（UTC）
 */
function toIsoTime(now) {
  let raw = typeof now === 'function' ? now() : now;
  if (raw === undefined || raw === null) raw = Date.now();
  if (raw instanceof Date) {
    const t = raw.getTime();
    return Number.isFinite(t) ? raw.toISOString() : new Date().toISOString();
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) return new Date(raw).toISOString();
  if (typeof raw === 'string' && raw.trim()) {
    const t = Date.parse(raw);
    return Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString();
  }
  return new Date().toISOString();
}

/* ─────────────────────────── 报告渲染 ─────────────────────────── */

/** 一个「通过 / 不通过 / 未验证」的直观标记（纯文本，贴进 PR 也不会丢） */
function verdictMark(pass, scored) {
  if (!scored) return '⚠️ 未验证';
  return pass ? '✅ 通过' : '❌ 不通过';
}

function thresholdText(check) {
  if (check.metric === 'ttftP95Ms') return `≤ ${fmtMs(check.threshold)}`;
  if (check.metric === 'errorRate') return `≤ ${fmtPct(check.threshold)}`;
  if (check.metric === 'tokensPerSec') {
    if (check.threshold === null) return '无基线，不做回归对比';
    return `≥ ${fmtTps(check.threshold)}`;
  }
  if (check.metric === 'memMiB') {
    if (check.threshold === null) return '无实际申请值';
    if (check.threshold === 0) return '整卡（不限）';
    return `≤ ${fmtMiB(check.threshold)}`;
  }
  return String(check.threshold ?? '—');
}

function actualText(check) {
  if (check.metric === 'ttftP95Ms') return fmtMs(check.actual);
  if (check.metric === 'errorRate') return fmtPct(check.actual);
  if (check.metric === 'tokensPerSec') return fmtTps(check.actual);
  if (check.metric === 'memMiB') return fmtMiB(check.actual);
  return String(check.actual ?? '—');
}

/**
 * 渲染一份给**人**看的门禁报告（markdown）。可直接贴 PR 描述 / 变更单 / 群里。
 *
 * 包含：结论、逐项指标（实测 vs 阈值）、推荐配额 vs 实际申请、未验证项、
 * 与基线的对比（有 baseline 时）、阻断项与处置建议。
 *
 * @param {object} input 输入
 * @param {object} [input.service] 模型服务（标题与「实际申请」列用）
 * @param {object} input.benchResult `bench.js#runBenchmark` 的返回值
 * @param {object} input.gate `evaluateGate` 的返回值
 * @returns {string} markdown
 */
export function renderGateReport({ service = null, benchResult = null, gate = null } = {}) {
  const g = gate && typeof gate === 'object' ? gate : evaluateGate({ benchResult, service });
  const metrics = g.metrics && typeof g.metrics === 'object' ? g.metrics : collectBenchMetrics(benchResult);
  const thresholds = g.thresholds && typeof g.thresholds === 'object'
    ? g.thresholds
    : { ...DEFAULT_THRESHOLDS };
  const checks = Array.isArray(g.checks) ? g.checks : [];
  const failures = Array.isArray(g.failures) ? g.failures : [];
  const warnings = Array.isArray(g.warnings) ? g.warnings : [];
  const baseline = g.baseline && typeof g.baseline === 'object' ? g.baseline : null;
  const svcKey = serviceKeyOf(service) ?? (baseline && baseline.serviceKey) ?? '（未提供 service）';
  const pass = g.pass === true;

  const lines = [];
  const push = (line = '') => lines.push(line);

  push(`## 基准门禁报告 · ${svcKey}`);
  push('');
  push(`**结论：${pass ? '✅ 通过（可以上线）' : '❌ 不通过（不许上线）'}** 评分 ${fmtNum(g.score)}/100`);
  push('');
  push(`- 基准：${fmtNum(metrics.cells)} 个组合 / 成功样本 ${fmtNum(metrics.samples)} / 失败 ${fmtNum(metrics.errors)}`
    + ` / 中止 ${benchResult?.aborted === true ? '是' : '否'} / ok=${benchResult?.ok === true}`);
  push(`- 基线：${baseline ? `有（${baseline.at ?? '时间未知'}，由 ${baseline.serviceKey ?? '未知服务'} 记录）` : '无（本次为首次运行，只记录基线，不做回归对比）'}`);
  push(`- 报告生成器：\`server/infra/gate.js\`（阈值 / 权重见下表，全部可在 \`thresholds\` 覆盖）`);
  push('');

  push('### 逐项指标');
  push('');
  push('| 指标 | 实测 | 阈值 | 判定 |');
  push('| --- | --- | --- | --- |');
  const rows = checks.length > 0 ? checks : fallbackChecks(metrics, thresholds, failures);
  for (const check of rows) {
    push(`| ${check.label ?? check.metric} | ${actualText(check)} | ${thresholdText(check)} | ${verdictMark(check.pass !== false, check.scored !== false)} |`);
  }
  push('');

  // 推荐配额 vs 实际申请
  const actualMem = finiteNumber(service?.resources?.memoryMiB);
  const actualCores = finiteNumber(service?.resources?.coresPercent);
  const recMem = metrics.memoryMiB;
  const recCores = metrics.coresPercent;
  push('### 推荐配额 vs 实际申请');
  push('');
  push('| 项 | 推荐值 | 实际申请 | 偏差 | 说明 |');
  push('| --- | --- | --- | --- | --- |');
  push(`| 显存 (MiB) | ${fmtMiB(recMem)} | ${actualMem === null ? '—' : (actualMem === 0 ? '整卡不限' : fmtMiB(actualMem))} | ${deltaText(recMem, actualMem)} | ${memVerdict(recMem, actualMem)} |`);
  push(`| 算力 (coresPercent) | ${recCores === null ? '—' : `${fmtNum(recCores)}%`} | ${actualCores === null ? '—' : (actualCores === 0 ? '不限' : `${fmtNum(actualCores)}%`)} | ${deltaText(recCores, actualCores)} | ${coresVerdict(recCores, actualCores)} |`);
  push(`| 置信度 | ${metrics.confidence === 'measured' ? 'measured（有实测显存峰值）' : 'estimated（**显存建议为估算值**）'} | — | — | ${metrics.confidence === 'measured' ? '可直接采信' : '需人工核对 KV cache 余量'} |`);
  push('');

  push('### 阻断项（必须修掉才能上线）');
  push('');
  if (failures.length === 0) {
    push('无。所有门槛项均满足。');
  } else {
    for (const fail of failures) {
      push(`- \`${fail.metric}\`：${fail.message}`);
    }
  }
  push('');

  push('### 未验证项 / 需人工确认');
  push('');
  if (warnings.length === 0) {
    push('无。');
  } else {
    for (const warning of warnings) push(`- ${warning}`);
  }
  push('');

  if (baseline) {
    push('### 与基线对比');
    push('');
    push('| 指标 | 基线 | 本次 | 变化 |');
    push('| --- | --- | --- | --- |');
    push(`| TTFT p95 (ms) | ${fmtNum(baseline.ttftP95Ms)} | ${fmtNum(metrics.ttftP95Ms)} | ${changeText(metrics.ttftP95Ms, baseline.ttftP95Ms, true)} |`);
    push(`| 吞吐 (tokens/s) | ${fmtNum(baseline.tokensPerSec, 2)} | ${fmtNum(metrics.tokensPerSec, 2)} | ${changeText(metrics.tokensPerSec, baseline.tokensPerSec, false)} |`);
    push(`| 错误率 | ${fmtPct(baseline.errorRate)} | ${fmtPct(metrics.errorRate)} | ${changeText(metrics.errorRate, baseline.errorRate, true)} |`);
    push(`| 显存建议 (MiB) | ${fmtNum(baseline.memoryMiB)} | ${fmtNum(metrics.memoryMiB)} | ${changeText(metrics.memoryMiB, baseline.memoryMiB, true)} |`);
    push(`| 算力建议 (%) | ${fmtNum(baseline.coresPercent)} | ${fmtNum(metrics.coresPercent)} | ${changeText(metrics.coresPercent, baseline.coresPercent, true)} |`);
    push('');
  }

  push('### 阈值与权重');
  push('');
  push('| 阈值 | 取值 | 权重 |');
  push('| --- | --- | --- |');
  const weights = thresholds.weights ?? GATE_WEIGHTS;
  push(`| TTFT p95 | ≤ ${fmtMs(thresholds.ttftP95Ms ?? DEFAULT_THRESHOLDS.ttftP95Ms)} | ${weights.ttftP95Ms ?? GATE_WEIGHTS.ttftP95Ms} |`);
  push(`| 错误率 | ≤ ${fmtPct(thresholds.errorRate ?? DEFAULT_THRESHOLDS.errorRate)} | ${weights.errorRate ?? GATE_WEIGHTS.errorRate} |`);
  push(`| 吞吐 | ≥ 基线 × ${thresholds.tokensPerSecRatio ?? DEFAULT_THRESHOLDS.tokensPerSecRatio}（另可设绝对下限） | ${weights.tokensPerSec ?? GATE_WEIGHTS.tokensPerSec} |`);
  push(`| 显存建议 | ≤ 实际申请（${thresholds.memMiBSource ?? '未提供'}） | ${weights.memMiB ?? GATE_WEIGHTS.memMiB} |`);
  push('');
  push('---');
  push('');
  push('> 复核方式：门禁只判「这次基准是否达标」，不判断基准本身是否可信到足以代表生产（矩阵覆盖面、时段负载、同卡邻居影响都要人看）。'
    + '离线对拍脚本：`scripts/infra-bench-verify.mjs`；判读说明：`docs/INFRA-BENCH.md`。');

  return lines.join('\n');
}

/** 没有 checks（人工拼出来的 gate）时，从 metrics + failures 兜底出一张表 */
function fallbackChecks(metrics, thresholds, failures) {
  const failed = new Set(failures.map((f) => f?.metric));
  return [
    {
      metric: 'ttftP95Ms',
      label: 'TTFT p95',
      actual: metrics.ttftP95Ms,
      threshold: thresholds.ttftP95Ms ?? DEFAULT_THRESHOLDS.ttftP95Ms,
      pass: !failed.has('ttftP95Ms'),
      scored: metrics.ttftP95Ms !== null,
    },
    {
      metric: 'errorRate',
      label: '错误率',
      actual: metrics.errorRate,
      threshold: thresholds.errorRate ?? DEFAULT_THRESHOLDS.errorRate,
      pass: !failed.has('errorRate'),
      scored: metrics.errorRate !== null,
    },
    {
      metric: 'tokensPerSec',
      label: '吞吐',
      actual: metrics.tokensPerSec,
      threshold: thresholds.tokensPerSec ?? null,
      pass: !failed.has('tokensPerSec'),
      scored: thresholds.tokensPerSec !== null,
    },
    {
      metric: 'memMiB',
      label: '显存建议',
      actual: metrics.memoryMiB,
      threshold: thresholds.memMiB ?? null,
      pass: !failed.has('memMiB'),
      scored: metrics.memoryMiB !== null,
    },
  ];
}

/** 「推荐 vs 实际」的偏差列 */
function deltaText(recommended, actual) {
  if (recommended === null || actual === null || actual === 0) return '—';
  const diff = recommended - actual;
  const pct = (diff / actual) * 100;
  const sign = diff > 0 ? '+' : '';
  return `${sign}${fmtNum(Math.round(diff))}（${sign}${fmtNum(pct)}%）`;
}

function memVerdict(recommended, actual) {
  if (actual === null) return '无实际申请值，超卖检查跳过';
  if (actual === 0) return '整卡不限，不适用';
  if (recommended === null) return '未测到显存峰值，需人工估算';
  return recommended <= actual ? '申请值够用' : '**申请值不足，会 OOM**';
}

function coresVerdict(recommended, actual) {
  if (recommended === null) return '无法推导（没有成功样本或未测吞吐）';
  if (actual === null) return '无实际申请值';
  if (actual === 0) return '不限算力，无需调整';
  if (recommended > actual) return `**偏低 ${fmtNum(recommended - actual)} 个百分点**：并发上来后 TTFT 会抖`;
  if (recommended < actual * 0.6) return '明显高于推荐值，可考虑回收（先观察邻居影响）';
  return '与推荐值基本一致';
}

/** 变化百分比（betterIsLower=true 时「下降」是好事，标 ✅） */
function changeText(current, base, betterIsLower) {
  if (typeof current !== 'number' || typeof base !== 'number' || !Number.isFinite(current) || !Number.isFinite(base) || base === 0) {
    return '—';
  }
  const pct = ((current - base) / base) * 100;
  const sign = pct > 0 ? '+' : '';
  const better = betterIsLower ? pct < 0 : pct > 0;
  if (Math.abs(pct) < 0.01) return '持平';
  return `${sign}${fmtNum(pct)}%（${better ? '变好' : '变差'}）`;
}

export default evaluateGate;
