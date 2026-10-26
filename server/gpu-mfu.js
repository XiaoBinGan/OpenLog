/**
 * MFU（Model FLOPs Utilization，模型算力利用率）采集。
 *
 * 设计目标：**不绑定 vLLM，也不需要人工配置引擎地址与密钥**。
 *
 * 流程（全部经已有 SSH 连接在目标机本地完成，不新增远端端口/服务）：
 *  1. 发现：扫本机监听端口 + `docker ps` 暴露的端口，逐个取 /metrics 正文，
 *     按内容识别引擎格式；遇到 401/403 时，从本机容器的 KEY/TOKEN/SECRET
 *     环境变量里取候选密钥重试。同一台机器上的多个引擎（如 vLLM + Strata）都会被采集。
 *  2. 归一化：把各引擎的指标统一成 prompt/generation token 计数（或 FLOPs 计数）。
 *  3. 差分：两次采样求导数 → tokens/s 或 FLOPs/s。冷启动在同一个远端命令里隔 2s
 *     取两次；热采样复用上一次请求的采样（窗口上限 90s，避免旧窗口被当成当前值）。
 *  4. 换算：MFU = 2 × 激活参数量 × tokens/s ÷ GPU 峰值算力（按引擎所在显卡的型号查表）。
 *
 * 已支持：vLLM / Strata / SGLang / TGI / llama.cpp / 任意带
 * `<前缀>prompt_tokens_total` 的 OpenAI 兼容服务（Prometheus）。
 *
 * 模型参数量：先按模型名解析（MoE 取 -A3B 这类激活值），再查内置表；
 * 仍未知时该引擎不显示 MFU（不猜），可通过设置页手动覆盖。
 */

import { execRemoteCommand } from './remote.js';
import { loadGPUConfigs } from './gpu.js';

// ─── 模型激活参数量（B）─────────────────────────────────────────────────────
// Flash-Next 的 7.3B 由 GGUF 张量表算出：总 125.7B（不含 PLE 查表），
// 512 experts 每 token 用 10 个 → dense 4.95B + 120.8B×10/512 ≈ 7.3B。
const MODEL_ACTIVE_PARAMS_B = [
  { pattern: /qwen3\.8[-_]?flash[-_]?next/i, activeB: 7.3, totalB: 125.7 },
  { pattern: /qwen3\.6[-_]?35b[-_]?a3b/i, activeB: 3, totalB: 35 },
  { pattern: /qwen3\.8[-_]?27b/i, activeB: 27, totalB: 27 },
  { pattern: /qwen3\.6[-_]?27b/i, activeB: 27, totalB: 27 },
];

// ─── GPU 峰值算力（FP16/BF16 稠密 TFLOPS；FP8 仅列有意义的型号）──────────────
const GPU_PEAK_FLOPS = [
  { pattern: /RTX\s*5090/i, fp16: 209.5, fp8: 419 },
  { pattern: /RTX\s*5080/i, fp16: 112.6, fp8: 225 },
  { pattern: /RTX\s*4090/i, fp16: 165.2, fp8: 330.3 },
  { pattern: /RTX\s*4080/i, fp16: 97.5, fp8: 195 },
  { pattern: /RTX\s*3090/i, fp16: 71, fp8: null },
  { pattern: /RTX\s*3080/i, fp16: 59.5, fp8: null },
  { pattern: /H200/i, fp16: 989, fp8: 1979 },
  { pattern: /H100/i, fp16: 989, fp8: 1979 },
  { pattern: /H800/i, fp16: 989, fp8: 1979 },
  { pattern: /A100/i, fp16: 312, fp8: null },
  { pattern: /L40S/i, fp16: 362, fp8: 733 },
  { pattern: /L40\b/i, fp16: 181, fp8: 362 },
  { pattern: /A6000/i, fp16: 154.8, fp8: null },
  { pattern: /A5000/i, fp16: 54.5, fp8: null },
  { pattern: /L4\b/i, fp16: 121, fp8: 242 },
  { pattern: /T4\b/i, fp16: 65, fp8: null },
  { pattern: /V100/i, fp16: 125, fp8: null },
  { pattern: /H20/i, fp16: 148, fp8: 296 },
];

/** 单次差分窗口的上下限：过大丢弃旧窗口，过小视为无效采样 */
const MIN_WINDOW_MS = 200;
const MAX_WINDOW_MS = 90 * 1000;
/** 端点发现缓存时长 */
const SOURCE_TTL_MS = 5 * 60 * 1000;
/** 采样缓存时长 */
const SAMPLE_TTL_MS = 5 * 60 * 1000;
/** 单台服务器最多采集的引擎数（避免极端环境下探测过久） */
const MAX_ENGINES_PER_HOST = 4;

/** 引擎进程名 → 用来把 MFU 挂到具体显卡（custom/generic 不猜进程名） */
const ENGINE_PROCESS_PATTERNS = {
  vllm: /vllm|enginecore/i,
  strata: /strata/i,
  sglang: /sglang/i,
  tgi: /tgi|text[-_]?generation/i,
  llamacpp: /llama/i,
};

/** serverId → { sources: [{url,key,engine}], ts } */
const sourceCache = new Map();
/** serverId → { ts, samples: Map<url, sample> } */
const sampleCache = new Map();
/** serverId → Promise（并发去重） */
const inFlight = new Map();

export function lookupPeakTflops(gpuName, dtype = 'fp16') {
  if (typeof gpuName !== 'string' || !gpuName) return null;
  for (const e of GPU_PEAK_FLOPS) {
    if (e.pattern.test(gpuName)) return e[dtype] ?? e.fp16;
  }
  return null;
}

/** 模型名 → 激活参数量（B） */
export function parseModelParamsB(modelName) {
  if (typeof modelName !== 'string' || !modelName) return null;
  const moe = modelName.match(/-A(\d+(?:\.\d+)?)B/i);
  if (moe) return Number.parseFloat(moe[1]) || null;
  for (const e of MODEL_ACTIVE_PARAMS_B) {
    if (e.pattern.test(modelName)) return e.activeB;
  }
  const m = modelName.match(/(?:^|[^\dA-Za-z])(\d+(?:\.\d+)?)B(?![A-Za-z0-9])/);
  return m ? Number.parseFloat(m[1]) : null;
}

/** Prometheus 文本 → [{ name, labels, value }] */
export function parsePrometheus(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([-+0-9.eE]+)/);
    if (!m) continue;
    const value = Number.parseFloat(m[3]);
    if (!Number.isFinite(value)) continue;
    const labels = {};
    if (m[2]) for (const kv of m[2].matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="([^"]*)"/g)) labels[kv[1]] = kv[2];
    out.push({ name: m[1], labels, value });
  }
  return out;
}

/** 按名字求和（可附加 label 过滤）；没有该指标返回 null */
export function sumMetric(rows, name, filter) {
  let sum = 0, found = false;
  for (const row of rows) {
    if (row.name !== name) continue;
    if (filter && !filter(row.labels)) continue;
    sum += row.value;
    found = true;
  }
  return found ? sum : null;
}

/**
 * 把任意引擎的指标正文归一化成统一采样值。
 * @returns {null | { engine, model, promptTokens, generationTokens, flopsTotal, running, gpuName }}
 */
export function normalizeMetrics(body) {
  const text = String(body || '');
  const head = text.trimStart();

  // JSON 正文：
  //  a) Strata 原生格式（engine/live/totals/hardware_static）
  //  b) 自定义/手写服务的通用格式（见 README「接入自定义推理服务」）：
  //     { "model": "...", "prompt_tokens": N, "generation_tokens": N, "gpu": "RTX 4090" }
  //     也接受 generation_tokens / output_tokens、prompt_tokens / input_tokens 等别名
  if (head.startsWith('{')) {
    let json;
    try { json = JSON.parse(text); } catch { return null; }
    if (!json || typeof json !== 'object') return null;

    if (json.totals && typeof json.totals === 'object') {
      const liveState = json.live?.state;
      return {
        engine: 'strata',
        model: json.engine?.model || null,
        promptTokens: Number(json.totals.prompt_tokens) || 0,
        generationTokens: Number(json.totals.output_tokens) || 0,
        flopsTotal: null,
        running: liveState && liveState !== 'idle' ? 1 : 0,
        gpuName: json.hardware_static?.gpu_name || null,
      };
    }

    const num = (v) => {
      const n = typeof v === 'string' ? Number.parseFloat(v) : Number(v);
      return Number.isFinite(n) && n >= 0 ? n : null;
    };
    const pickNum = (...keys) => {
      for (const k of keys) {
        const v = num(json[k]);
        if (v !== null) return v;
      }
      return null;
    };
    const promptTokens = pickNum('prompt_tokens', 'promptTokens', 'input_tokens', 'inputTokens', 'prefill_tokens');
    const generationTokens = pickNum('generation_tokens', 'generationTokens', 'output_tokens', 'outputTokens', 'completion_tokens', 'decode_tokens');
    const flopsTotal = pickNum('flops_total', 'flopsTotal', 'flops');
    if (promptTokens === null && generationTokens === null && flopsTotal === null) return null;
    return {
      engine: typeof json.engine_name === 'string' ? json.engine_name : 'custom',
      model: json.model || json.model_name || null,
      promptTokens: promptTokens ?? 0,
      generationTokens: generationTokens ?? 0,
      flopsTotal,
      running: num(json.running) ?? num(json.active_requests) ?? null,
      gpuName: json.gpu || json.gpu_name || json.device || null,
    };
  }

  const rows = parsePrometheus(text);
  if (!rows.length) return null;
  const model = rows.find(r => r.labels.model_name)?.labels.model_name
    || rows.find(r => r.labels.model)?.labels.model
    || null;
  const read = (...names) => {
    for (const n of names) {
      const v = sumMetric(rows, n);
      if (v !== null) return v;
    }
    return null;
  };

  if (rows.some(r => r.name.startsWith('vllm:'))) {
    // vLLM 的 prompt_tokens_total 含 prefix cache 命中（不产生 FLOPs），优先 local_compute
    const localCompute = sumMetric(rows, 'vllm:prompt_tokens_by_source_total', l => l.source === 'local_compute');
    return {
      engine: 'vllm',
      model,
      promptTokens: localCompute ?? read('vllm:prompt_tokens_total') ?? 0,
      generationTokens: read('vllm:generation_tokens_total') ?? 0,
      flopsTotal: read('vllm:estimated_flops_per_gpu_total'),
      running: read('vllm:num_requests_running'),
      gpuName: null,
    };
  }

  if (rows.some(r => r.name.startsWith('sglang:'))) {
    return {
      engine: 'sglang',
      model,
      promptTokens: read('sglang:prompt_tokens_total') ?? 0,
      generationTokens: read('sglang:generation_tokens_total') ?? 0,
      flopsTotal: null,
      running: read('sglang:num_running_reqs', 'sglang:num_requests_running'),
      gpuName: null,
    };
  }

  if (rows.some(r => r.name.startsWith('tgi_'))) {
    return {
      engine: 'tgi',
      model,
      promptTokens: read('tgi_request_input_length_sum') ?? 0,
      generationTokens: read('tgi_request_generated_tokens_sum') ?? 0,
      flopsTotal: null,
      running: read('tgi_request_count'),
      gpuName: null,
    };
  }

  if (rows.some(r => r.name.startsWith('llamacpp:'))) {
    return {
      engine: 'llamacpp',
      model,
      promptTokens: read('llamacpp:prompt_tokens_total', 'llamacpp:tokens_evaluated_total') ?? 0,
      generationTokens: read('llamacpp:tokens_predicted_total') ?? 0,
      flopsTotal: null,
      running: read('llamacpp:requests_processing'),
      gpuName: null,
    };
  }

  // 通用 Prometheus：找 prompt/generation token 计数
  const promptRow = rows.find(r => /(prompt|input)_tokens_total$/.test(r.name));
  const genRow = rows.find(r => /(generation|output|predicted)_tokens_total$/.test(r.name));
  if (!promptRow && !genRow) return null;
  return {
    engine: 'generic',
    model,
    promptTokens: promptRow ? sumMetric(rows, promptRow.name) ?? 0 : 0,
    generationTokens: genRow ? sumMetric(rows, genRow.name) ?? 0 : 0,
    flopsTotal: null,
    running: null,
    gpuName: null,
  };
}

/** 解析 nvidia-smi 前缀输出（GPU 列表 + 占用进程） */
export function parseGpuInfo(stdout) {
  const gpus = [], procs = [];
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('MFU:GPU:')) {
      const p = line.slice(8).split(',').map(s => s.trim());
      const index = Number.parseInt(p[0], 10);
      if (Number.isInteger(index)) gpus.push({ index, name: p[1] || 'Unknown', busId: p[2] || '' });
    } else if (line.startsWith('MFU:PROC:')) {
      const p = line.slice(9).split(',').map(s => s.trim());
      if (p.length >= 3) procs.push({ busId: p[0], pid: Number.parseInt(p[1], 10) || 0, name: p.slice(2).join(',') });
    }
  }
  return { gpus, procs };
}

/**
 * 单引擎 MFU 换算（纯函数）。
 * @param {object} p
 * @param {{timeMs:number, promptTokens:number, generationTokens:number, flopsTotal:number|null, model:string|null, gpuName:string|null}|null} p.prev
 * @param {object} p.cur
 * @param {Array} p.gpus
 * @param {Array} p.procs
 * @param {number|null} p.paramsB
 * @param {string} p.engine
 * @param {string} p.dtype
 */
export function buildMfuResult({ prev, cur, gpus, procs, paramsB, engine, dtype = 'fp16', processPattern = null }) {
  if (!cur) return { available: false, reason: '未读到推理指标' };
  const dtMs = prev ? cur.timeMs - prev.timeMs : 0;
  const dtSec = dtMs / 1000;
  const windowSec = Math.round(dtMs / 100) / 10;

  const dPrompt = Math.max(0, (cur.promptTokens ?? 0) - (prev?.promptTokens ?? 0));
  const dGen = Math.max(0, (cur.generationTokens ?? 0) - (prev?.generationTokens ?? 0));
  const dFlops = (cur.flopsTotal != null && prev?.flopsTotal != null) ? cur.flopsTotal - prev.flopsTotal : null;

  // 1) 引擎自报 FLOPs 计数（per GPU）：只有正增长才用；部分 vLLM 版本该计数恒为 0
  let totalFlopsPerSec = null;
  let method = null;
  if (dFlops != null && dFlops > 0 && dtSec > 0) {
    totalFlopsPerSec = dFlops / dtSec;
    method = 'engine_flops_counter';
  }

  // 2) token 差分 → FLOPs
  const tokensPerSec = dtSec > 0 ? (dPrompt + dGen) / dtSec : 0;

  // 引擎所在 GPU：自定义进程正则/内置进程名 → bus_id → index；
  // 对不上时用引擎自报的 GPU 型号兜底；再对不上就按「占满本机全部卡」处理。
  const busToGpu = new Map(gpus.map(g => [g.busId, g]));
  const pattern = processPattern instanceof RegExp ? processPattern : ENGINE_PROCESS_PATTERNS[engine];
  let engineGpus = pattern
    ? [...new Set(procs
      .filter(p => pattern.test(p.name))
      .map(p => busToGpu.get(p.busId)?.index)
      .filter(Number.isInteger))]
    : [];
  if (engineGpus.length === 0) {
    const reported = (cur.gpuName || '').trim();
    if (reported) {
      engineGpus = gpus
        .filter(g => g.name && (g.name === reported || g.name.includes(reported) || reported.includes(g.name)))
        .map(g => g.index);
    }
  }
  const targetGpus = engineGpus.length > 0 ? gpus.filter(g => engineGpus.includes(g.index)) : gpus;
  if (targetGpus.length === 0) return { available: false, reason: '未识别到 GPU', engine, model: cur.model || null };

  const gpuCount = Math.max(1, targetGpus.length);
  if (totalFlopsPerSec == null) {
    if (!paramsB) {
      return {
        available: false,
        reason: `无法解析模型参数量（model=${cur.model || '未知'}）`,
        engine,
        model: cur.model || null,
        tokensPerSec,
        windowSec,
      };
    }
    totalFlopsPerSec = (2 * paramsB * 1e9 * tokensPerSec) / gpuCount;
    method = 'tokens_x_active_params';
  }

  const peaks = targetGpus.map(g => lookupPeakTflops(g.name, dtype)).filter(Boolean);
  if (peaks.length === 0) {
    return {
      available: false,
      reason: `未知 GPU 型号「${targetGpus[0].name}」的峰值算力`,
      engine,
      model: cur.model || null,
      tokensPerSec,
      windowSec,
    };
  }
  const peak = Math.min(...peaks);
  const mfu = (totalFlopsPerSec / (peak * 1e12)) * 100;

  return {
    available: true,
    engine,
    model: cur.model || null,
    mfu: Math.round(mfu * 100) / 100,
    gpuIndexes: targetGpus.map(g => g.index),
    peakTflops: peak,
    paramsB: paramsB ?? null,
    tokensPerSec: Math.round(tokensPerSec * 10) / 10,
    windowSec,
    method,
    sampleCount: prev ? 1 : 2,
  };
}

// ─── 端点发现 ───────────────────────────────────────────────────────────────

/**
 * 发现脚本：扫候选端口取 /metrics，401/403 时用容器里的候选密钥重试。
 * 每命中一个可识别的引擎输出一行：
 *   SRC:<b64url>|<engine>|<b64key>|<b64body>
 */
function buildDiscoveryScript(configuredUrl = '', configuredKey = '') {
  const urlB64 = Buffer.from(configuredUrl || '', 'utf8').toString('base64');
  const keyB64 = Buffer.from(configuredKey || '', 'utf8').toString('base64');
  return `
set +e
CONFIGURED=$(printf '%s' '${urlB64}' | base64 -d 2>/dev/null)
CONFIGURED_KEY=$(printf '%s' '${keyB64}' | base64 -d 2>/dev/null)
PORTS=$( { docker ps --format '{{.Ports}}' 2>/dev/null | grep -oE '0\\.0\\.0\\.0:[0-9]+' | cut -d: -f2; echo 8000 8001 8002 8003 8080 8081 8899 9000 30000 30001 11434; } | sort -un )
KEYS=$( for c in $(docker ps --format '{{.Names}}' 2>/dev/null); do
  docker inspect "$c" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null
done | awk -F= 'toupper($1) ~ /(KEY|TOKEN|SECRET)/ && length($2) >= 8 {print $2}' | sort -u | head -20 )
[ -n "$CONFIGURED_KEY" ] && KEYS="$CONFIGURED_KEY $KEYS"
b64() { base64 -w0 2>/dev/null || base64 | tr -d '\\n'; }

classify() {
  local body="$1"
  case "$body" in
    vllm:*) echo vllm; return 0;;
  esac
  case "$body" in
    *vllm:estimated_flops_per_gpu_total*|*vllm:prompt_tokens_total*) echo vllm; return 0;;
    *'"totals"'*'"hardware_static"'*) echo strata; return 0;;
    *sglang:*) echo sglang; return 0;;
    *tgi_request_input_length*|*tgi_request_generated*) echo tgi; return 0;;
    *llamacpp:*) echo llamacpp; return 0;;
    *prompt_tokens_total*) echo generic; return 0;;
    # 自定义服务 JSON 契约（见 README「接入自定义推理服务」）
    *'"prompt_tokens"'*|*'"input_tokens"'*|*'"generation_tokens"'*|*'"output_tokens"'*|*'"flops_total"'*) echo custom; return 0;;
  esac
  return 1
}

FOUND=0
emit() {
  local url="$1" key="$2" body="$3" engine
  engine=$(classify "$body") || return 0
  echo "SRC:$(printf '%s' "$url" | b64)|$engine|$(printf '%s' "$key" | b64)|$(printf '%s' "$body" | b64)"
  FOUND=$((FOUND+1))
}

try_url() {
  local url="$1" key="$2" body code
  if [ -n "$key" ]; then
    body=$(curl -s -4 -m 2 -H "Authorization: Bearer $key" "$url" 2>/dev/null)
    code=$(curl -s -4 -m 2 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $key" "$url" 2>/dev/null)
    [ "$code" = "200" ] && [ -n "$body" ] && emit "$url" "$key" "$body"
    return 0
  fi
  body=$(curl -s -4 -m 2 "$url" 2>/dev/null)
  code=$(curl -s -4 -m 2 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)
  if [ "$code" = "200" ] && [ -n "$body" ]; then
    if classify "$body" >/dev/null; then emit "$url" "" "$body"; return 0; fi
  elif [ "$code" = "401" ] || [ "$code" = "403" ]; then
    for k in $KEYS; do
      body=$(curl -s -4 -m 2 -H "Authorization: Bearer $k" "$url" 2>/dev/null)
      code=$(curl -s -4 -m 2 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $k" "$url" 2>/dev/null)
      if [ "$code" = "200" ] && [ -n "$body" ]; then emit "$url" "$k" "$body"; return 0; fi
    done
  fi
  return 0
}

if [ -n "$CONFIGURED" ]; then
  try_url "$CONFIGURED" "$CONFIGURED_KEY"
fi
for p in $PORTS; do
  [ -z "$p" ] && continue
  case "$p" in
    *:*) : ;;
    *) try_url "http://127.0.0.1:$p/metrics" "" ;;
  esac
  [ "$FOUND" -ge ${MAX_ENGINES_PER_HOST} ] && break
done
[ "$FOUND" -ge ${MAX_ENGINES_PER_HOST} ] && exit 0
echo "NO_SOURCE"
`;
}

function decodeBase64(value) {
  try { return Buffer.from(value, 'base64').toString('utf8'); } catch { return ''; }
}

/**
 * 找出某台服务器上的推理引擎指标端点（带缓存，支持同机多引擎）。
 * @returns {Promise<Array<{url:string,key:string,engine:string}>>}
 */
export async function discoverSources(serverId) {
  const cached = sourceCache.get(serverId);
  if (cached && cached.sources.length > 0 && Date.now() - cached.ts < SOURCE_TTL_MS) return cached.sources;

  const cfg = (loadGPUConfigs() || []).find(c => c && (c.serverId === serverId || c.id === serverId));
  const res = await execRemoteCommand(serverId, buildDiscoveryScript(cfg?.metricsUrl || '', cfg?.apiKey || ''));
  if (res.error) throw new Error(res.error);
  const stdout = String(res.stdout || '');

  const sources = [];
  const seen = new Set();
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('SRC:')) continue;
    const parts = t.slice(4).split('|');
    if (parts.length < 4) continue;
    const url = decodeBase64(parts[0]);
    const engine = parts[1];
    const key = decodeBase64(parts[2]);
    const body = decodeBase64(parts[3]);
    if (!url || seen.has(url)) continue;
    if (!normalizeMetrics(body)) continue; // 二次确认，避免 classify 误判
    seen.add(url);
    sources.push({ url, key, engine });
  }

  if (sources.length > 0) sourceCache.set(serverId, { sources, ts: Date.now() });
  return sources;
}

// ─── 采样 ───────────────────────────────────────────────────────────────────

/** 只允许回环地址的 http(s) URL 进 shell，防止配置里塞入命令注入字符 */
export function sanitizeUrl(url) {
  if (typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?\/[A-Za-z0-9._~:/?#@!&%=+,*-]*$/.test(trimmed)) return '';
  return trimmed;
}

/**
 * 把设置页的「进程名正则」编译成 RegExp。
 * 手写服务（python train_server.py）默认无法和引擎进程名对上，可用它精确挂到某张卡。
 * 非法正则忽略（返回 null），不影响采集。
 */
export function compileProcessPattern(pattern) {
  if (typeof pattern !== 'string' || !pattern.trim()) return null;
  try {
    return new RegExp(pattern.trim(), 'i');
  } catch {
    return null;
  }
}

/** 生成采样脚本：对每个端点各取一次（冷采样取两轮，间隔 2s） */
export function buildSampleScript(sources, { cold = true } = {}) {
  const fetches = sources.map((s, i) => {
    const url = sanitizeUrl(s.url);
    const keyB64 = Buffer.from(s.key || '', 'utf8').toString('base64');
    return `
fetch_${i}() {
  local t s
  t=$(date +%s%3N)
  KEY${i}=$(printf '%s' '${keyB64}' | base64 -d 2>/dev/null)
  if [ -n "$KEY${i}" ]; then
    s=$(curl -s -4 -m 3 -H "Authorization: Bearer $KEY${i}" "${url}" 2>/dev/null)
  else
    s=$(curl -s -4 -m 3 "${url}" 2>/dev/null)
  fi
  echo "MFU:BEGIN:${i}:$t"
  printf '%s' "$s" | base64 -w0 2>/dev/null || printf '%s' "$s" | base64
  echo ""
  echo "MFU:END:${i}"
}`;
  }).join('\n');

  const round = sources.map((_, i) => `fetch_${i}`).join('\n');
  return `
set +e
${fetches}
${round}
${cold ? `sleep 2\n${round}` : ''}
nvidia-smi --query-gpu=index,name,gpu_bus_id --format=csv,noheader,nounits 2>/dev/null | sed 's/^/MFU:GPU:/'
nvidia-smi --query-compute-apps=gpu_bus_id,pid,process_name --format=csv,noheader,nounits 2>/dev/null | sed 's/^/MFU:PROC:/'
`;
}

/**
 * 解析采样输出。
 * @returns {{ samplesBySource: Map<number, Array<{timeMs:number, metrics:object}>>, gpus: Array, procs: Array }}
 */
export function parseSampleOutput(stdout) {
  const samplesBySource = new Map();
  const gpuLines = [];
  let pending = null; // { index, timeMs, bodyLines }
  let state = 'idle';

  for (const rawLine of String(stdout || '').split('\n')) {
    const line = rawLine.trim();
    const begin = line.match(/^MFU:BEGIN:(\d+):(\d+)$/);
    if (begin) {
      pending = { index: Number.parseInt(begin[1], 10), timeMs: Number.parseInt(begin[2], 10), bodyLines: [] };
      state = 'body';
      continue;
    }
    const end = line.match(/^MFU:END:(\d+)$/);
    if (end) {
      if (pending && state === 'body') {
        const metrics = normalizeMetrics(decodeBase64(pending.bodyLines.join('')));
        if (metrics) {
          const list = samplesBySource.get(pending.index) || [];
          list.push({ timeMs: pending.timeMs, metrics });
          samplesBySource.set(pending.index, list);
        }
      }
      pending = null;
      state = 'idle';
      continue;
    }
    if (state === 'body') { if (pending) pending.bodyLines.push(line); continue; }
    if (line.startsWith('MFU:GPU:') || line.startsWith('MFU:PROC:')) gpuLines.push(line);
  }
  const { gpus, procs } = parseGpuInfo(gpuLines.join('\n'));
  return { samplesBySource, gpus, procs };
}

/**
 * 采集某台服务器的 MFU（支持同机多引擎，带缓存 / 并发去重）。
 * @returns {Promise<{available:boolean, engines:Array, gpuMfu:Object, reason?:string}>}
 */
export function getRemoteMfu(serverId) {
  if (inFlight.has(serverId)) return inFlight.get(serverId);
  const task = sampleServerMfu(serverId).finally(() => inFlight.delete(serverId));
  inFlight.set(serverId, task);
  return task;
}

async function sampleServerMfu(serverId) {
  let sources;
  try {
    sources = await discoverSources(serverId);
  } catch (err) {
    return { available: false, engines: [], gpuMfu: {}, reason: `MFU 采集失败：${err.message}` };
  }
  if (!sources.length) {
    return { available: false, engines: [], gpuMfu: {}, reason: '未发现推理引擎指标端点（vLLM/Strata/SGLang/TGI/llama.cpp）' };
  }

  const cfg = (loadGPUConfigs() || []).find(c => c && (c.serverId === serverId || c.id === serverId));
  const prevCache = sampleCache.get(serverId);
  const reusePrev = (url) => {
    if (!prevCache) return null;
    const item = prevCache.samples.get(url);
    if (!item) return null;
    if (Date.now() - item.sample.timeMs > MAX_WINDOW_MS) return null;
    return item.sample;
  };
  const cold = sources.every(s => reusePrev(s.url) == null);

  const res = await execRemoteCommand(serverId, buildSampleScript(sources, { cold }));
  if (res.error) return { available: false, engines: [], gpuMfu: {}, reason: `采样失败：${res.error}` };

  const parsed = parseSampleOutput(res.stdout);
  const nextCache = { ts: Date.now(), samples: new Map() };
  const engines = [];
  const gpuMfu = {};

  sources.forEach((source, index) => {
    const list = parsed.samplesBySource.get(index) || [];
    if (list.length === 0) {
      engines.push({ engine: source.engine, available: false, reason: '指标端点无有效数据（引擎可能已停止）', endpoint: source.url });
      return;
    }
    const cur = list[list.length - 1];
    const prevFromCache = reusePrev(source.url);
    const prev = prevFromCache || (list.length >= 2 ? list[list.length - 2] : null);
    nextCache.samples.set(source.url, { ts: Date.now(), sample: cur });

    const dtMs = prev ? cur.timeMs - prev.timeMs : 0;
    if (!prev || dtMs < MIN_WINDOW_MS || dtMs > MAX_WINDOW_MS) {
      engines.push({
        engine: source.engine,
        available: false,
        reason: '正在建立采样窗口（下次刷新可见）',
        endpoint: source.url,
        model: cur.metrics.model || null,
      });
      return;
    }

    // 参数量优先级：模型名解析 → 设置页覆盖的 paramsB。
    // 覆盖值只补「名字解析不出」的模型（手写服务通常叫 my-transformer），
    // 避免一台机器上多个引擎共用同一个覆盖值而互相污染。
    const paramsB = parseModelParamsB(cur.metrics.model)
      ?? (cfg?.paramsB != null ? Number(cfg.paramsB) : null);
    const result = buildMfuResult({
      prev: { ...prev.metrics, timeMs: prev.timeMs },
      cur: { ...cur.metrics, timeMs: cur.timeMs },
      gpus: parsed.gpus,
      procs: parsed.procs,
      paramsB,
      engine: source.engine,
      dtype: cfg?.dtype === 'fp8' ? 'fp8' : 'fp16',
      processPattern: compileProcessPattern(cfg?.processPattern),
    });
    const enriched = { ...result, endpoint: source.url, sampledAt: new Date(cur.timeMs).toISOString() };
    engines.push(enriched);

    if (enriched.available) {
      for (const idx of enriched.gpuIndexes) {
        gpuMfu[idx] = { mfu: enriched.mfu, engine: enriched.engine, model: enriched.model, windowSec: enriched.windowSec };
      }
    }
  });

  sampleCache.set(serverId, nextCache);
  return {
    available: engines.some(e => e.available),
    engines,
    gpuMfu,
    reason: engines.every(e => !e.available) ? (engines[0]?.reason || null) : null,
  };
}

/** 测试用：清空缓存 */
export function _resetCaches() {
  sourceCache.clear();
  sampleCache.clear();
  inFlight.clear();
}

export const _internals = { GPU_PEAK_FLOPS, MODEL_ACTIVE_PARAMS_B, MAX_WINDOW_MS, MAX_ENGINES_PER_HOST };