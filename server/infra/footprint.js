/**
 * 模型足迹估算 —— 回答「这个模型放得进我申请的配额吗」。
 *
 * 为什么需要它（真机教训）：
 *   `capacity.js` 的预检回答的是「配额放得进这张卡」（quota ≤ 卡剩余显存），
 *   它**回答不了**「模型放得进这个配额」。2026-11-26 实测 Qwen2.5-VL-32B-AWQ：
 *     · 配额 21504 MiB → CUDA OOM（AWQ 反量化还要额外 1.05 GiB 暂存）
 *     · 配额 23284 MiB（4090 剩余全部）→ vLLM 报 KV cache 剩 **-0.73 GiB**
 *     · 配额 28672 MiB → 正常起服务，实测进程占用 25076 MiB
 *   三次尝试里前两次都是「预检说 fits、实际起不来」，排查成本很高。
 *
 * 估算口径（三块相加）：
 *   weights  权重：优先用 model.sizeMiB（用户实测值）；否则 参数量 × 位宽/8 × 1.05（索引/对齐）
 *   overhead 运行时开销：CUDA context + 引擎暂存（AWQ 反量化的 unpack 缓冲就在这里）
 *   kvCache  KV cache：每 token 字节 × 上下文 × 目标并发
 *
 * 诚实边界：这是**估算**，不是实测。误差来源有三处，都写进 warnings：
 *   1. 权重只有参数量没有量化位宽时按 fp16 算，可能差一倍
 *   2. KV 每 token 字节依赖层数/KV 头数/head_dim，模型没提供时用同类模型的经验值
 *   3. 引擎自身（vLLM 的 gpu_memory_utilization 预分配、SGLang 的 radix cache）会额外占
 * 所以结论分三档：fits（余量充足）/ tight（勉强够，风险高）/ insufficient（放不下）。
 */

import { QUANT_BITS_PER_WEIGHT } from './model-cache.js';

/**
 * 从引擎启动参数里取 `--gpu-memory-utilization`（vLLM/SGLang 都有）。
 *
 * 这个值不是"要用多少"，而是"最多只用配额的百分之多少"：
 * vLLM 把 util × 配额 当作可用显存。所以配额必须 ≥ 需求 / util ——
 * 真机上 23284 MiB 配额报「KV cache 剩 -0.73 GiB」就是这么来的：
 * 可用只有 23284×0.92 = 21421 MiB，而权重就要 19.5 GiB。
 */
export function parseGpuMemUtilization(args) {
  const list = Array.isArray(args) ? args.map(String) : [];
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    let raw = null;
    if (a.startsWith('--gpu-memory-utilization=')) raw = a.split('=')[1];
    else if (a === '--gpu-memory-utilization' || a === '--gpu_memory_utilization') raw = list[i + 1];
    if (raw !== null && raw !== undefined) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0 && n <= 1) return n;
    }
  }
  return null;
}

/** 各引擎的固定开销（MiB）。数值来自真机观测 + 官方文档的保守取值。 */
export const ENGINE_OVERHEAD_MIB = Object.freeze({
  vllm: 1536,      // CUDA context + AWQ/GPTQ 反量化暂存（实测 1.05 GiB 峰值）+ 调度器
  sglang: 1792,    // 比 vLLM 多一份 radix cache 元数据
  'llama.cpp': 768,
  strata: 1024,
  tgi: 1024,
});

/** 每 token 的 KV cache 字节数经验值（fp16 KV）：按参数量档位给。 */
export const KV_BYTES_PER_TOKEN = Object.freeze([
  { maxParamsB: 1, bytes: 24 * 1024 },
  { maxParamsB: 4, bytes: 64 * 1024 },
  { maxParamsB: 9, bytes: 128 * 1024 },
  { maxParamsB: 15, bytes: 192 * 1024 },
  { maxParamsB: 35, bytes: 256 * 1024 },   // 30B 级：64 层 × 2 × 8 KV头 × 128 head_dim × 2B ≈ 256 KiB
  { maxParamsB: 80, bytes: 512 * 1024 },
  { maxParamsB: Infinity, bytes: 1024 * 1024 },
]);

const MIB = 1024 * 1024;
const DEFAULT_CONTEXT = 4096;
/** 目标并发：没声明就按 1 算（保守——按 1 算出来的足迹偏小，结论会偏乐观，所以单独告警） */
const DEFAULT_MAX_CONCURRENCY = 1;
/** 余量阈值：总需求 × 1.1 仍小于配额才算 fits；介于 1.0~1.1 算 tight */
const SAFETY_RATIO = 1.1;

function round1(n) {
  return Math.round(n * 10) / 10;
}

function toMiB(bytes) {
  return round1(bytes / MIB);
}

/** 从量化名取每权重位数；认不出返回 null（调用方据此发现"没说清量化"）。 */
export function bitsPerWeight(quantization) {
  if (typeof quantization !== 'string' || !quantization.trim()) return null;
  const lowered = quantization.trim().toLowerCase();
  // 先按原文查（表里有 q2_0 这种带下划线的键），再按去掉分隔符的形式查（Q4-K-M → q4km）
  if (Object.prototype.hasOwnProperty.call(QUANT_BITS_PER_WEIGHT, lowered)) return QUANT_BITS_PER_WEIGHT[lowered];
  const key = lowered.replace(/[-_\s]/g, '');
  if (Object.prototype.hasOwnProperty.call(QUANT_BITS_PER_WEIGHT, key)) return QUANT_BITS_PER_WEIGHT[key];
  // Q4_K_M / q4km 这类后缀：取前缀 q4
  const m = key.match(/^(q\d+|fp\d+|w\d+a\d+|int\d+)/);
  if (m && Object.prototype.hasOwnProperty.call(QUANT_BITS_PER_WEIGHT, m[1])) {
    return QUANT_BITS_PER_WEIGHT[m[1]];
  }
  return null;
}

/** 参数量解析：'32B' / 32 / '7b' / '0.6B' 都认；认不出 null。 */
export function parseParamsB(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  const m = text.match(/^([\d.]+)\s*(b|t)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return m[2] === 't' ? n * 1000 : n;
}

/** 按参数量查每 token KV 字节数。 */
export function kvBytesPerToken(paramsB) {
  const bucket = KV_BYTES_PER_TOKEN.find((x) => (paramsB ?? 0) <= x.maxParamsB) || KV_BYTES_PER_TOKEN[KV_BYTES_PER_TOKEN.length - 1];
  return bucket.bytes;
}

/**
 * 估算模型运行所需显存，并与申请配额比较。
 *
 * @param {object} input
 * @param {object} input.model      ModelService.model（sizeMiB / quantization / parametersB / contextLength）
 * @param {object} input.engine     ModelService.engine（type 决定固定开销）
 * @param {object} input.resources  ModelService.resources（memoryMiB / coresPercent）
 * @param {number} [input.replicas]
 * @returns {{
 *   verdict:'fits'|'tight'|'insufficient'|'unknown',
 *   quotaMiB:number, requiredMiB:number|null, headroomMiB:number|null,
 *   breakdown:{ weightsMiB:number|null, overheadMiB:number, kvCacheMiB:number|null, kvBytesPerToken:number|null },
 *   inputs:{ contextLength:number, maxConcurrency:number, bits:number|null, paramsB:number|null, engine:string },
 *   reasons:string[], warnings:string[], assumption:string
 * }}
 */
export function estimateModelFootprint({ model, engine, resources, replicas } = {}) {
  const warnings = [];
  const reasons = [];
  const m = model && typeof model === 'object' ? model : {};
  const r = resources && typeof resources === 'object' ? resources : {};
  const engineType = typeof engine?.type === 'string' && engine.type ? engine.type : 'vllm';
  const overheadMiB = ENGINE_OVERHEAD_MIB[engineType] ?? ENGINE_OVERHEAD_MIB.vllm;
  const quotaMiB = Number.isFinite(Number(r.memoryMiB)) ? Number(r.memoryMiB) : 0;

  // ── 1. 权重 ──
  const sizeMiB = Number(m.sizeMiB);
  const paramsB = parseParamsB(m.parametersB ?? m.parameters);
  const bits = bitsPerWeight(m.quantization);
  let weightsMiB = null;
  if (Number.isFinite(sizeMiB) && sizeMiB > 0) {
    weightsMiB = round1(sizeMiB);
    if (bits) {
      // 拿得到位宽就交叉校验一遍：差 30% 以上说明 sizeMiB 和 quantization 有一个是错的
      const implied = (paramsB ? paramsB * 1e9 * (bits / 8) : null);
      if (implied) {
        const impliedMiB = toMiB(implied);
        if (impliedMiB > 0 && Math.abs(impliedMiB - weightsMiB) / weightsMiB > 0.3) {
          warnings.push(
            `权重口径不一致：model.sizeMiB=${weightsMiB} MiB，但按 ${paramsB}B × ${m.quantization}(${bits}bit) 推算约 ${impliedMiB} MiB。`
            + '优先采信 sizeMiB（实测值），请确认 quantization 是否填错。',
          );
        }
      }
    }
  } else if (paramsB && bits) {
    weightsMiB = toMiB(paramsB * 1e9 * (bits / 8) * 1.05);
    warnings.push(
      `权重按参数量推算：${paramsB}B × ${m.quantization}(${bits}bit) × 1.05 ≈ ${weightsMiB} MiB（未提供 model.sizeMiB，误差可达 ±10%）`,
    );
  } else if (paramsB && !bits) {
    weightsMiB = toMiB(paramsB * 1e9 * (16 / 8) * 1.05);
    warnings.push(
      `未提供量化方式，权重按 fp16 推算 ${weightsMiB} MiB —— 若实际是 4bit 量化，真实值约为其 1/4，结论会偏保守`,
    );
  } else {
    warnings.push('既没有 model.sizeMiB 也没有 parametersB，无法估算权重占用：请至少填一个，否则"放不下"的判断无从做起');
  }

  // ── 2. KV cache ──
  const contextLength = Number.isFinite(Number(m.contextLength)) && Number(m.contextLength) > 0
    ? Number(m.contextLength)
    : DEFAULT_CONTEXT;
  if (!Number.isFinite(Number(m.contextLength)) || Number(m.contextLength) <= 0) {
    warnings.push(`未声明 model.contextLength，按 ${DEFAULT_CONTEXT} 估算 KV cache`);
  }
  const maxConcurrency = Number.isFinite(Number(m.maxConcurrency)) && Number(m.maxConcurrency) > 0
    ? Number(m.maxConcurrency)
    : DEFAULT_MAX_CONCURRENCY;
  if (maxConcurrency === DEFAULT_MAX_CONCURRENCY) {
    warnings.push(
      '未声明 model.maxConcurrency，KV cache 按 1 路并发估算；若线上实际并发更高，'
      + '这里算出的足迹偏小（每多一路约多 1 份 KV），结论会偏乐观',
    );
  }
  const kvPerToken = weightsMiB === null && paramsB === null ? null : kvBytesPerToken(paramsB);
  const kvCacheMiB = kvPerToken === null ? null : toMiB(kvPerToken * contextLength * maxConcurrency);

  // ── 3. 汇总 ──
  if (weightsMiB === null) {
    return {
      verdict: 'unknown',
      quotaMiB,
      requiredMiB: null,
      headroomMiB: null,
      breakdown: { weightsMiB: null, overheadMiB, kvCacheMiB, kvBytesPerToken: kvPerToken, rawNeedMiB: null },
      inputs: { contextLength, maxConcurrency, bits, paramsB, engine: engineType },
      reasons: ['缺少权重信息（model.sizeMiB 或 model.parametersB），无法判断模型是否放得进配额'],
      warnings,
      assumption: 'weights 未知 → 不推断',
    };
  }

  const rawNeedMiB = round1(weightsMiB + overheadMiB + (kvCacheMiB ?? 0));
  // gpu-memory-utilization 的语义：可用显存 = util × 配额。所以配额 ≥ rawNeed / util。
  const util = parseGpuMemUtilization(engine?.args)
    ?? ((engineType === 'vllm' || engineType === 'sglang') ? 0.9 : null);
  const requiredMiB = util ? round1(rawNeedMiB / util) : rawNeedMiB;
  if (util) {
    warnings.push(
      '已按 --gpu-memory-utilization=' + util + ' 换算：模型自身需要 ' + rawNeedMiB + ' MiB，'
      + '但引擎只会用配额的 ' + Math.round(util * 100) + '%，所以配额至少要 ' + requiredMiB + ' MiB',
    );
  }
  const headroomMiB = round1(quotaMiB - requiredMiB);

  // memoryMiB = 0 表示整卡不切分：没有配额概念，只能和"要多少"比一句
  if (quotaMiB === 0) {
    reasons.push(
      `整卡模式（未限显存）：模型估计需要 ${requiredMiB} MiB，请确认整卡容量足够`
      + `（权重 ${weightsMiB} + 运行时 ${overheadMiB} + KV ${kvCacheMiB ?? 0} MiB）`,
    );
    return {
      verdict: 'tight',
      quotaMiB,
      requiredMiB,
      headroomMiB: null,
      breakdown: { weightsMiB, overheadMiB, kvCacheMiB, kvBytesPerToken: kvPerToken, rawNeedMiB: weightsMiB === null ? null : rawNeedMiB },
      inputs: { contextLength, maxConcurrency, bits, paramsB, engine: engineType },
      reasons,
      warnings,
      assumption: `weights=${weightsMiB} + overhead=${overheadMiB} + kv=${kvCacheMiB ?? 0}`,
    };
  }

  const needed = Math.ceil(requiredMiB * SAFETY_RATIO);
  let verdict;
  if (quotaMiB < requiredMiB) {
    verdict = 'insufficient';
    reasons.push(
      `放不下：配额 ${quotaMiB} MiB < 估算需求 ${requiredMiB} MiB（缺口 ${Math.abs(headroomMiB)} MiB）。`
      + `明细：权重 ${weightsMiB} + ${engineType} 运行时 ${overheadMiB} + KV cache ${kvCacheMiB ?? 0}`
      + `（${contextLength} tokens × ${maxConcurrency} 路并发）。`
      + `建议把 resources.memoryMiB 至少提到 ${needed} MiB（含 10% 余量）。`,
    );
  } else if (quotaMiB < needed) {
    verdict = 'tight';
    reasons.push(
      `勉强够：配额 ${quotaMiB} MiB 刚过估算需求 ${requiredMiB} MiB，但低于含 10% 余量的 ${needed} MiB。`
      + '真机上这类配置容易出现 KV cache 不足或反量化暂存 OOM（实测 32B-AWQ 在 21 GiB 配额下就 OOM 过）。'
      + `建议提到 ${needed} MiB。`,
    );
  } else {
    verdict = 'fits';
    reasons.push(
      `放得下：配额 ${quotaMiB} MiB ≥ 估算需求 ${requiredMiB} MiB（余量 ${headroomMiB} MiB）。`
      + `明细：权重 ${weightsMiB} + ${engineType} 运行时 ${overheadMiB} + KV ${kvCacheMiB ?? 0} MiB。`,
    );
    if (quotaMiB > needed * 2) {
      reasons.push(
        `注意：配额是估算需求的 ${round1(quotaMiB / requiredMiB)} 倍，可能有较大空转占卡，`
        + '可用基准（bench）实测后再决定是否回收',
      );
    }
  }

  return {
    verdict,
    quotaMiB,
    requiredMiB,
    headroomMiB,
    breakdown: { weightsMiB, overheadMiB, kvCacheMiB, kvBytesPerToken: kvPerToken, rawNeedMiB: weightsMiB === null ? null : rawNeedMiB },
    inputs: { contextLength, maxConcurrency, bits, paramsB, engine: engineType },
    reasons,
    warnings,
    assumption: `weights=${weightsMiB} + overhead(${engineType})=${overheadMiB} + kv=${kvCacheMiB ?? 0}；判定阈值 ${SAFETY_RATIO}×`,
  };
}
