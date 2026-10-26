/**
 * MFU（Model FLOPs Utilization，模型算力利用率）采集与计算。
 *
 * 定义：MFU = 模型实际产生的 FLOPs/s ÷ GPU「该精度稠密峰值」FLOPs
 *
 * 数据来源（远端 vLLM 的 Prometheus /metrics，经已有 SSH 连接读取）：
 *  1) vllm:estimated_flops_per_gpu_total —— vLLM 自带的每卡 FLOPs 计数器
 *     （部分版本/配置恒为 0，只能当首选，不能当唯一来源）
 *  2) vllm:prompt_tokens_total / vllm:generation_tokens_total —— 兜底：
 *     FLOPs ≈ 2 × 激活参数量 ×（prompt + generation tokens）
 *     激活参数量从 model_name 解析（MoE 取「-A3B」里的激活值，保证 MFU 不被总参数量夸大）
 *
 * 采样方式：对同一台服务器缓存上一次计数器，两次采样求差分。首次（冷）采样在
 * 一次远端命令里 sleep 2s 取两次；之后（热）只取一次，用上次请求的采样做差分，
 * 这样监控页 30s 轮询的额外开销只有一次 curl。
 *
 * 峰值算力表只收录「FP16/BF16 dense（不含稀疏加速）」数值：vLLM 的 FLOPs 是稠密
 * 口径，用稀疏标称值会让 MFU 虚高一倍。表里没有的型号不猜，直接标记不可用。
 */

import { errorMessage } from './errors.js';
import { execRemoteCommand } from './remote.js';

/** 常见 NVIDIA GPU 的 FP16/BF16 稠密张量算力（TFLOPS，不含 sparsity） */
const GPU_PEAK_FLOPS_TABLE = [
  // 消费级
  { pattern: /RTX\s*5090/i, tflops: 209.5 },
  { pattern: /RTX\s*5080/i, tflops: 112.6 },
  { pattern: /RTX\s*4090/i, tflops: 165.2 },
  { pattern: /RTX\s*4080/i, tflops: 97.5 },
  { pattern: /RTX\s*3090/i, tflops: 71.0 },
  { pattern: /RTX\s*3080/i, tflops: 59.5 },
  // 数据中心 / 专业卡
  { pattern: /H200/i, tflops: 989.0 },
  { pattern: /H100/i, tflops: 989.0 },
  { pattern: /H800/i, tflops: 989.0 },
  { pattern: /A100/i, tflops: 312.0 },
  { pattern: /L40S/i, tflops: 362.0 },
  { pattern: /L40/i, tflops: 181.0 },
  { pattern: /A6000/i, tflops: 154.8 },
  { pattern: /A5000/i, tflops: 54.5 },
  { pattern: /L4\b/i, tflops: 121.0 },
  { pattern: /T4\b/i, tflops: 65.0 },
  { pattern: /V100/i, tflops: 125.0 },
  { pattern: /H20/i, tflops: 148.0 },
];

/** vLLM 指标探针端口（OpenAI 兼容服务的 /metrics 常见端口） */
const DEFAULT_METRICS_PORTS = [8000, 8001, 8002, 8080, 9000, 30000, 30001];

/** 引擎进程名（nvidia-smi 里通常显示为 VLLM::EngineCore 等） */
const ENGINE_PROCESS_PATTERN = /vllm|enginecore|sglang|lmdeploy/i;

/** 端点探测结果缓存时长：5 分钟 */
const ENDPOINT_TTL_MS = 5 * 60 * 1000;
/** 端点不存在时，3 分钟内不重复探测（避免每次轮询都扫端口） */
const ENDPOINT_MISS_TTL_MS = 3 * 60 * 1000;
/** 上次采样超过 5 分钟就丢弃（跨天的旧差分没有意义） */
const SAMPLE_TTL_MS = 5 * 60 * 1000;

/** serverId → { endpoint, ts, miss? } */
const endpointCache = new Map();
/** serverId → { ts, timeMs, metrics } */
const lastSample = new Map();
/** serverId → Promise（并发去重） */
const inFlight = new Map();
/** serverId → 最近一次成功结果（端点暂时不可用时回退展示） */
const lastResult = new Map();

const EMPTY_METRICS = () => ({ flopsTotal: 0, promptTokens: 0, generationTokens: 0, models: {} });

/**
 * 查 GPU 的峰值 FP16/BF16 稠密算力。
 * @returns {{ tflops: number } | null}
 */
export function lookupPeakTflops(gpuName) {
  if (typeof gpuName !== 'string' || !gpuName) return null;
  for (const entry of GPU_PEAK_FLOPS_TABLE) {
    if (entry.pattern.test(gpuName)) return { tflops: entry.tflops };
  }
  return null;
}

/**
 * 从模型名解析「激活参数量（B）」。
 * 例：Qwen3.8-27B-W4A16-AWQ-GPTQ → 27；Qwen3.5-35B-A3B-GPTQ → 3（MoE 取激活值）
 * @returns {number | null}
 */
export function parseModelParamsB(modelName) {
  if (typeof modelName !== 'string' || !modelName) return null;
  // MoE：35B-A3B / 35B_A3B 里的 A3B 才是参与计算的激活参数
  const moe = modelName.match(/(\d+(?:\.\d+)?)\s*B[-_ ]?A(\d+(?:\.\d+)?)\s*B/i);
  if (moe) {
    const active = Number.parseFloat(moe[2]);
    return Number.isFinite(active) && active > 0 ? active : null;
  }
  const dense = modelName.match(/(\d+(?:\.\d+)?)\s*B(?![A-Za-z0-9])/i);
  if (!dense) return null;
  const params = Number.parseFloat(dense[1]);
  return Number.isFinite(params) && params > 0 ? params : null;
}

/**
 * 解析 vLLM /metrics 里 MFU 相关的四类指标（按 model_name 聚合）。
 * @returns {{ flopsTotal: number, promptTokens: number, generationTokens: number,
 *             models: Record<string, { flops: number, promptTokens: number, generationTokens: number }>,
 *             modelNames: string[] }}
 */
export function parseVllmMetrics(text) {
  const out = { ...EMPTY_METRICS(), modelNames: [] };
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    const parsed = line.match(/^vllm:(estimated_flops_per_gpu_total|prompt_tokens_total|generation_tokens_total)\{([^}]*)\}\s+([-+0-9.eE]+)\s*$/);
    if (!parsed) continue;
    const [, metric, labels, rawValue] = parsed;
    const value = Number.parseFloat(rawValue);
    if (!Number.isFinite(value) || value < 0) continue;
    const model = (labels.match(/model_name="([^"]*)"/) || [])[1] || '';
    if (!out.models[model]) out.models[model] = { flops: 0, promptTokens: 0, generationTokens: 0 };
    if (metric === 'estimated_flops_per_gpu_total') {
      out.flopsTotal += value;
      out.models[model].flops += value;
    } else if (metric === 'prompt_tokens_total') {
      out.promptTokens += value;
      out.models[model].promptTokens += value;
    } else {
      out.generationTokens += value;
      out.models[model].generationTokens += value;
    }
  }
  out.modelNames = Object.keys(out.models);
  return out;
}

/**
 * MFU 百分比。
 * @returns {number | null} null = 参数不足以计算
 */
export function computeMfu(flopsPerSec, peakTflops) {
  if (!Number.isFinite(flopsPerSec) || flopsPerSec < 0) return null;
  if (!Number.isFinite(peakTflops) || peakTflops <= 0) return null;
  return (flopsPerSec / (peakTflops * 1e12)) * 100;
}

/** 解析 `nvidia-smi --query-gpu=index,name,gpu_bus_id` 行 */
function parseGpuLines(lines) {
  const gpus = [];
  for (const raw of lines) {
    const parts = raw.split(',').map(s => s.trim());
    const index = Number.parseInt(parts[0], 10);
    if (!Number.isInteger(index)) continue;
    gpus.push({ index, name: parts[1] || 'Unknown', busId: parts[2] || '' });
  }
  return gpus;
}

/** 解析 `nvidia-smi --query-compute-apps=gpu_bus_id,pid,process_name` 行 */
function parseProcessLines(lines) {
  const procs = [];
  for (const raw of lines) {
    const parts = raw.split(',').map(s => s.trim());
    if (parts.length < 3) continue;
    procs.push({
      busId: parts[0],
      pid: Number.parseInt(parts[1], 10) || 0,
      name: parts.slice(2).join(',').trim(),
    });
  }
  return procs;
}

/** 把采样输出（MFU: 前缀行）解析成结构化数据 */
export function parseMfuProbeOutput(stdout) {
  const out = {
    endpoint: null,
    times: [],
    samples: [], // [{ timeMs, metrics: { flopsTotal, promptTokens, generationTokens, models, modelNames } }]
    gpus: [],
    procs: [],
    noEndpoint: false,
  };
  let pending = null; // 当前样本（等时间戳 / 指标行）

  const flush = () => {
    if (!pending) return;
    // 时间用两端中点的平均值，抵消单次 curl 的耗时
    const timeMs = pending.times.length >= 2
      ? (pending.times[0] + pending.times[1]) / 2
      : pending.times[0];
    out.samples.push({ timeMs, metrics: pending.metrics });
    pending = null;
  };

  for (const rawLine of String(stdout || '').split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('MFU:NOENDPOINT')) { out.noEndpoint = true; continue; }
    if (line.startsWith('MFU:ENDPOINT=')) { out.endpoint = line.slice('MFU:ENDPOINT='.length).trim(); continue; }
    const tMatch = line.match(/^MFU:T(\d+)=([0-9]+)$/);
    if (tMatch) {
      const idx = Number.parseInt(tMatch[1], 10);
      const ns = Number.parseInt(tMatch[2], 10);
      if (!Number.isFinite(ns)) continue;
      if (idx % 2 === 1) {
        // T1/T3：一次采样的开始
        flush();
        pending = { times: [ns / 1e6], metrics: EMPTY_METRICS() };
      } else if (pending) {
        pending.times.push(ns / 1e6);
      }
      continue;
    }
    const sampleMatch = line.match(/^MFU:S(\d+):(.*)$/);
    if (sampleMatch && pending) {
      const parsed = parseVllmMetrics(sampleMatch[2]);
      const m = pending.metrics;
      m.flopsTotal += parsed.flopsTotal;
      m.promptTokens += parsed.promptTokens;
      m.generationTokens += parsed.generationTokens;
      for (const [name, stat] of Object.entries(parsed.models)) {
        if (!m.models[name]) m.models[name] = { flops: 0, promptTokens: 0, generationTokens: 0 };
        m.models[name].flops += stat.flops;
        m.models[name].promptTokens += stat.promptTokens;
        m.models[name].generationTokens += stat.generationTokens;
      }
      continue;
    }
    if (line.startsWith('MFU:GPU:')) { out.gpus.push(line.slice('MFU:GPU:'.length)); continue; }
    if (line.startsWith('MFU:PROC:')) { out.procs.push(line.slice('MFU:PROC:'.length)); continue; }
  }
  flush();

  out.gpus = parseGpuLines(out.gpus);
  out.procs = parseProcessLines(out.procs);
  for (const s of out.samples) {
    s.metrics.modelNames = Object.keys(s.metrics.models);
  }
  return out;
}

/**
 * 由采样数据 + 峰值表得出 MFU 结果。
 * @param {{ samples: Array, gpus: Array, procs: Array, endpoint: string|null }} parsed
 * @param {{ previousSample?: { timeMs: number, metrics: object } | null }} options
 */
export function buildMfuResult(parsed, options = {}) {
  const { samples, gpus, procs, endpoint } = parsed;
  const previous = options.previousSample || null;

  if (!endpoint) {
    return { available: false, reason: '未检测到 vLLM /metrics 端点' };
  }
  const current = samples[samples.length - 1];
  if (!current) {
    return { available: false, reason: '未读到 vLLM 推理指标' };
  }

  // 冷采样 → 用同一请求内的两次采样；热采样 → 用上一次请求的采样
  const base = previous
    ?? (samples.length >= 2 ? samples[samples.length - 2] : null);
  if (!base) return { available: false, reason: '首次采样中，稍后重试' };

  const dtSec = (current.timeMs - base.timeMs) / 1000;
  if (!(dtSec > 0.2)) return { available: false, reason: '采样间隔过短' };

  // 引擎 GPU 映射（compute-apps 的 bus_id ↔ GPU bus_id）
  const busToGpu = new Map(gpus.map(g => [g.busId, g]));
  const engineGpuIndexes = [...new Set(procs
    .filter(p => ENGINE_PROCESS_PATTERN.test(p.name))
    .map(p => busToGpu.get(p.busId)?.index)
    .filter(v => Number.isInteger(v)))];
  const targetGpus = engineGpuIndexes.length > 0
    ? gpus.filter(g => engineGpuIndexes.includes(g.index))
    : gpus;

  const peak = targetGpus.map(g => lookupPeakTflops(g.name)).find(Boolean);
  if (!peak) {
    return {
      available: false,
      reason: targetGpus.length > 0
        ? `未知 GPU 型号「${targetGpus[0].name}」的峰值算力`
        : '未识别到 GPU',
      model: (current.metrics.modelNames[0] || null),
    };
  }

  const deltaFlops = current.metrics.flopsTotal - base.metrics.flopsTotal;
  const gpuCount = Math.max(1, targetGpus.length);
  let flopsPerSec = null;
  let method = null;
  let paramsB = null;

  if (deltaFlops > 0) {
    // 首选：vLLM 自带 per-GPU FLOPs 计数器
    flopsPerSec = deltaFlops / dtSec;
    method = 'estimated_flops';
  } else {
    // 兜底：2 × 激活参数量 × tokens/s（按引擎 GPU 数折算到每卡）
    let totalFlopsPerSec = 0;
    let usedModels = 0;
    for (const [name, stat] of Object.entries(current.metrics.models)) {
      const prevStat = base.metrics.models[name] || { flops: 0, promptTokens: 0, generationTokens: 0 };
      const tokens = Math.max(0,
        (stat.promptTokens - prevStat.promptTokens) + (stat.generationTokens - prevStat.generationTokens));
      const params = parseModelParamsB(name);
      if (params === null) continue;
      totalFlopsPerSec += 2 * params * 1e9 * (tokens / dtSec);
      usedModels++;
    }
    if (usedModels > 0) {
      flopsPerSec = totalFlopsPerSec / gpuCount;
      method = 'tokens_x_params';
      paramsB = Object.keys(current.metrics.models)
        .map(parseModelParamsB)
        .filter(v => v !== null)[0] ?? null;
    }
  }

  if (flopsPerSec === null) {
    return {
      available: false,
      reason: 'vLLM 未提供 FLOPs 计数，且无法从模型名解析参数量',
      model: (current.metrics.modelNames[0] || null),
    };
  }

  const mfu = computeMfu(flopsPerSec, peak.tflops);
  if (mfu === null) return { available: false, reason: '无法计算 MFU' };

  return {
    available: true,
    mfu: Math.round(mfu * 100) / 100,
    model: current.metrics.modelNames.join(', ') || null,
    gpuIndexes: targetGpus.map(g => g.index),
    peakTflops: peak.tflops,
    flopsPerSec,
    paramsB,
    method,
    endpoint,
    sampledAt: new Date(current.timeMs).toISOString(),
    sampleCount: previous ? 1 : samples.length,
  };
}

/**
 * 构建远端 shell 采样命令（MFU: 前缀输出，便于解析）。
 * @param {string|null} endpoint 已知的 /metrics 地址；null = 先探测端口
 * @param {{ cold?: boolean }} options cold=true 时取两次采样（间隔 2s），
 *   否则只取一次（与上一次请求的采样做差分，省掉 2 秒等待）
 */
function buildProbeScript(endpoint, { cold = true } = {}) {
  const url = endpoint || null;
  const curl = 'curl -s -m 2 ';
  const grab = 'grep -E \'^vllm:(estimated_flops_per_gpu_total|prompt_tokens_total|generation_tokens_total)\'';
  const lines = [];
  if (url) {
    lines.push(`echo "MFU:ENDPOINT=${url}"`);
    lines.push('T1=$(date +%s%N)');
    lines.push(`S1=$(${curl}"${url}" | ${grab})`);
    lines.push('T2=$(date +%s%N)');
    lines.push('echo "MFU:T1=$T1"');
    lines.push('echo "MFU:T2=$T2"');
    lines.push('printf \'%s\\n\' "$S1" | sed \'s/^/MFU:S1:/\'');
    if (cold) {
      lines.push('sleep 2');
      lines.push('T3=$(date +%s%N)');
      lines.push(`S2=$(${curl}"${url}" | ${grab})`);
      lines.push('T4=$(date +%s%N)');
      lines.push('echo "MFU:T3=$T3"');
      lines.push('echo "MFU:T4=$T4"');
      lines.push('printf \'%s\\n\' "$S2" | sed \'s/^/MFU:S2:/\'');
    }
  } else {
    // 探测：扫一遍常见端口，找到有 vLLM 指标的就停
    lines.push(`for p in ${DEFAULT_METRICS_PORTS.join(' ')}; do`);
    lines.push('  body=$(curl -s -m 1 "http://127.0.0.1:$p/metrics" 2>/dev/null)');
    lines.push('  case "$body" in *vllm:generation_tokens_total*) echo "MFU:ENDPOINT=http://127.0.0.1:$p/metrics"; exit 0;; esac');
    lines.push('done');
    lines.push('echo "MFU:NOENDPOINT"');
    return lines.join('\n');
  }

  lines.push('nvidia-smi --query-gpu=index,name,gpu_bus_id --format=csv,noheader,nounits 2>/dev/null | sed \'s/^/MFU:GPU:/\'');
  lines.push('nvidia-smi --query-compute-apps=gpu_bus_id,pid,process_name --format=csv,noheader,nounits 2>/dev/null | sed \'s/^/MFU:PROC:/\'');
  return lines.join('\n');
}

function getEndpointFromCache(serverId) {
  const cached = endpointCache.get(serverId);
  if (!cached) return null;
  const age = Date.now() - cached.ts;
  if (cached.miss && age > ENDPOINT_MISS_TTL_MS) return null;
  if (!cached.miss && age > ENDPOINT_TTL_MS) return null;
  return cached;
}

/**
 * 读取某台远端服务器的 MFU（带缓存 / 并发去重 / 失败回退）。
 * @returns {Promise<{ available: boolean, reason?: string, mfu?: number, ... }>}
 */
export function getRemoteMfu(serverId) {
  if (inFlight.has(serverId)) return inFlight.get(serverId);
  const task = sampleServerMfu(serverId).finally(() => inFlight.delete(serverId));
  inFlight.set(serverId, task);
  return task;
}

async function execScript(serverId, script) {
  const res = await execRemoteCommand(serverId, script);
  if (res.error || res.success === false) {
    throw new Error(res.error || '远端命令执行失败');
  }
  return res.stdout || '';
}

async function sampleServerMfu(serverId) {
  const cached = getEndpointFromCache(serverId);
  let endpoint = cached && !cached.miss ? cached.endpoint : null;

  // 已有上一次采样（且未过期）→ 热采样，只取一次，用上次做差分；
  // 否则冷采样，在同一请求内取两次（间隔 2s）。
  const prev = lastSample.get(serverId);
  const usablePrev = prev && Date.now() - prev.ts < SAMPLE_TTL_MS
    ? { timeMs: prev.timeMs, metrics: prev.metrics }
    : null;

  try {
    // 第一阶段：端点未知时先探测（只扫端口，不采样）
    if (!endpoint) {
      const probe = parseMfuProbeOutput(await execScript(serverId, buildProbeScript(null)));
      if (probe.noEndpoint) {
        endpointCache.set(serverId, { miss: true, ts: Date.now() });
        return { available: false, reason: '未检测到 vLLM /metrics 端点（服务未启用 metrics）' };
      }
      if (!probe.endpoint) {
        return { available: false, reason: 'vLLM /metrics 端点探测失败' };
      }
      endpoint = probe.endpoint;
      endpointCache.set(serverId, { endpoint, ts: Date.now() });
    }

    // 第二阶段：采样（冷启动两次，热采样一次）
    const parsed = parseMfuProbeOutput(await execScript(serverId, buildProbeScript(endpoint, { cold: !usablePrev })));
    if (!parsed.endpoint) parsed.endpoint = endpoint;

    const result = buildMfuResult(parsed, { previousSample: usablePrev });
    const current = parsed.samples[parsed.samples.length - 1];
    if (current) {
      lastSample.set(serverId, { ts: Date.now(), timeMs: current.timeMs, metrics: current.metrics });
    }
    if (result.available) lastResult.set(serverId, result);
    return result;
  } catch (err) {
    // 端点可能已失效（服务重启/端口变化），下次重新探测
    endpointCache.delete(serverId);
    const fallback = lastResult.get(serverId);
    return {
      available: false,
      reason: `MFU 采样失败：${errorMessage(err)}`,
      ...(fallback ? { stale: fallback } : {}),
    };
  }
}

/** 仅供测试：清空内部缓存 */
export function _resetMfuCaches() {
  endpointCache.clear();
  lastSample.clear();
  inFlight.clear();
  lastResult.clear();
}

export const _internals = { GPU_PEAK_FLOPS_TABLE, DEFAULT_METRICS_PORTS };