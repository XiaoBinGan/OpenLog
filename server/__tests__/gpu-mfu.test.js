import { describe, it, expect, beforeEach } from 'vitest';

const {
  lookupPeakTflops, parseModelParamsB, parseVllmMetrics, computeMfu,
  parseMfuProbeOutput, buildMfuResult, _resetMfuCaches,
} = await import('../gpu-mfu.js');

beforeEach(() => { _resetMfuCaches(); });

const MODEL = 'Qwen3.8-27B-W4A16-AWQ-GPTQ';

const FLOP_LINE = (v, model = MODEL, engine = '0') =>
  `vllm:estimated_flops_per_gpu_total{engine="${engine}",model_name="${model}"} ${v}`;
const PROMPT_LINE = (v, model = MODEL) =>
  `vllm:prompt_tokens_total{engine="0",model_name="${model}"} ${v}`;
const GEN_LINE = (v, model = MODEL) =>
  `vllm:generation_tokens_total{engine="0",model_name="${model}"} ${v}`;

describe('lookupPeakTflops', () => {
  it('常见型号的 FP16/BF16 稠密算力', () => {
    expect(lookupPeakTflops('NVIDIA GeForce RTX 4090')).toEqual({ tflops: 165.2 });
    expect(lookupPeakTflops('NVIDIA GeForce RTX 5090')).toEqual({ tflops: 209.5 });
    expect(lookupPeakTflops('NVIDIA A100-SXM4-80GB')).toEqual({ tflops: 312 });
    expect(lookupPeakTflops('NVIDIA H100 80GB HBM3')).toEqual({ tflops: 989 });
    expect(lookupPeakTflops('NVIDIA L40S')).toEqual({ tflops: 362 });
    expect(lookupPeakTflops('Tesla T4')).toEqual({ tflops: 65 });
  });

  it('未知型号/空值返回 null（不猜）', () => {
    expect(lookupPeakTflops('NVIDIA GeForce RTX 3060')).toBeNull();
    expect(lookupPeakTflops('')).toBeNull();
    expect(lookupPeakTflops(null)).toBeNull();
  });
});

describe('parseModelParamsB（模型名 → 激活参数量）', () => {
  it('稠密模型取总参数量', () => {
    expect(parseModelParamsB('Qwen3.8-27B-W4A16-AWQ-GPTQ')).toBe(27);
    expect(parseModelParamsB('Qwen3.5-27B-FP8')).toBe(27);
    expect(parseModelParamsB('Meta-Llama-3.1-8B-Instruct')).toBe(8);
    expect(parseModelParamsB('Qwen3.6-27B-FP8')).toBe(27);
  });

  it('MoE 取激活参数量（A3B → 3，而不是 35）', () => {
    expect(parseModelParamsB('Qwen3.5-35B-A3B-GPTQ-Int4')).toBe(3);
    expect(parseModelParamsB('Qwen3-235B-A22B-FP8')).toBe(22);
  });

  it('解析不出时返回 null', () => {
    expect(parseModelParamsB('llama-local')).toBeNull();
    expect(parseModelParamsB('')).toBeNull();
    expect(parseModelParamsB(null)).toBeNull();
  });
});

describe('parseVllmMetrics', () => {
  it('解析 FLOPs 与 token 计数（按模型聚合）', () => {
    const text = [
      FLOP_LINE(0),
      PROMPT_LINE(1.48e8),
      GEN_LINE(1.03e6),
      '# HELP 其它行',
    ].join('\n');
    const r = parseVllmMetrics(text);
    expect(r.flopsTotal).toBe(0);
    expect(r.promptTokens).toBeCloseTo(1.48e8, 0);
    expect(r.generationTokens).toBeCloseTo(1.03e6, 0);
    expect(r.modelNames).toEqual([MODEL]);
    expect(r.models[MODEL].generationTokens).toBeCloseTo(1.03e6, 0);
  });

  it('多模型求和并分别记录', () => {
    const text = [
      FLOP_LINE(100, 'model-a'),
      FLOP_LINE(250, 'model-b'),
      PROMPT_LINE(10, 'model-a'),
      PROMPT_LINE(20, 'model-b'),
      GEN_LINE(30, 'model-a'),
      GEN_LINE(40, 'model-b'),
    ].join('\n');
    const r = parseVllmMetrics(text);
    expect(r.flopsTotal).toBe(350);
    expect(r.promptTokens).toBe(30);
    expect(r.generationTokens).toBe(70);
    expect(r.modelNames.sort()).toEqual(['model-a', 'model-b']);
  });

  it('空 / 无关行 / 非法数值 → 0', () => {
    expect(parseVllmMetrics('').flopsTotal).toBe(0);
    expect(parseVllmMetrics('vllm:num_requests_running{engine="0"} 3').flopsTotal).toBe(0);
    expect(parseVllmMetrics(FLOP_LINE('abc')).flopsTotal).toBe(0);
  });
});

describe('computeMfu', () => {
  it('FLOPs/s ÷ 峰值算力 → 百分比', () => {
    // 82.6 TFLOPS 实际 / 165.2 峰值 = 50%
    expect(computeMfu(82.6e12, 165.2)).toBeCloseTo(50, 6);
    expect(computeMfu(0, 165.2)).toBe(0);
  });

  it('参数非法返回 null', () => {
    expect(computeMfu(NaN, 165.2)).toBeNull();
    expect(computeMfu(-1, 165.2)).toBeNull();
    expect(computeMfu(1e12, 0)).toBeNull();
  });
});

const PROBE_COLD = [
  'MFU:ENDPOINT=http://127.0.0.1:30000/metrics',
  'MFU:T1=1000000000',
  'MFU:T2=1001000000',
  `MFU:S1:${PROMPT_LINE(100)}`,
  `MFU:S1:${GEN_LINE(0)}`,
  'MFU:T3=3000000000',
  'MFU:T4=3001000000',
  `MFU:S2:${PROMPT_LINE(200)}`,
  `MFU:S2:${GEN_LINE(100)}`,  // 共 200 tokens / 2s = 100 tok/s
  'MFU:GPU:0, NVIDIA GeForce RTX 4090, 00000000:01:00.0',
  'MFU:GPU:1, NVIDIA GeForce RTX 5090, 00000000:02:00.0',
  'MFU:PROC:00000000:01:00.0, 1234, VLLM::EngineCore',
].join('\n');

describe('parseMfuProbeOutput', () => {
  it('解析端点、两次采样、GPU 与进程', () => {
    const p = parseMfuProbeOutput(PROBE_COLD);
    expect(p.noEndpoint).toBe(false);
    expect(p.endpoint).toBe('http://127.0.0.1:30000/metrics');
    expect(p.samples).toHaveLength(2);
    // T1/T2 中点 = 1000.5ms；T3/T4 中点 = 3000.5ms
    expect(p.samples[0].timeMs).toBeCloseTo(1000.5, 3);
    expect(p.samples[1].timeMs).toBeCloseTo(3000.5, 3);
    expect(p.samples[1].metrics.promptTokens).toBeCloseTo(200, 0);
    expect(p.samples[1].metrics.generationTokens).toBeCloseTo(100, 0);
    expect(p.samples[1].metrics.modelNames).toEqual([MODEL]);
    expect(p.gpus).toHaveLength(2);
    expect(p.gpus[1]).toMatchObject({ index: 1, name: 'NVIDIA GeForce RTX 5090' });
    expect(p.procs[0]).toMatchObject({ busId: '00000000:01:00.0', pid: 1234, name: 'VLLM::EngineCore' });
  });

  it('没有端点 → noEndpoint', () => {
    const p = parseMfuProbeOutput('MFU:NOENDPOINT');
    expect(p.noEndpoint).toBe(true);
    expect(p.endpoint).toBeNull();
    expect(p.samples).toHaveLength(0);
  });
});

describe('buildMfuResult', () => {
  it('优先用 vLLM 自带 FLOPs 计数器：1.652e14 / 2s ÷ 165.2T ≈ 50%', () => {
    const probe = [
      'MFU:ENDPOINT=http://127.0.0.1:30000/metrics',
      'MFU:T1=1000000000',
      'MFU:T2=1001000000',
      `MFU:S1:${FLOP_LINE(0)}`,
      'MFU:T3=3000000000',
      'MFU:T4=3001000000',
      `MFU:S2:${FLOP_LINE(165200000000000)}`,
      'MFU:GPU:0, NVIDIA GeForce RTX 4090, 00000000:01:00.0',
      'MFU:GPU:1, NVIDIA GeForce RTX 5090, 00000000:02:00.0',
      'MFU:PROC:00000000:01:00.0, 1234, VLLM::EngineCore',
    ].join('\n');
    const r = buildMfuResult(parseMfuProbeOutput(probe));
    expect(r.available).toBe(true);
    expect(r.mfu).toBeCloseTo(50, 1);
    expect(r.method).toBe('estimated_flops');
    expect(r.gpuIndexes).toEqual([0]); // 引擎在 GPU0，5090 不参与
    expect(r.peakTflops).toBe(165.2);
    expect(r.model).toContain('Qwen3.8-27B');
  });

  it('FLOPs 计数器恒为 0 时退回 token×参数估算（真实 vLLM 场景）', () => {
    // 200 tokens / 2s = 100 tok/s；27B 稠密 → 2*27e9*100 = 5.4e12 FLOPs/s
    // 5.4e12 / 165.2e12 ≈ 3.27%
    const r = buildMfuResult(parseMfuProbeOutput(PROBE_COLD));
    expect(r.available).toBe(true);
    expect(r.method).toBe('tokens_x_params');
    expect(r.paramsB).toBe(27);
    expect(r.mfu).toBeCloseTo((2 * 27e9 * 100 / 165.2e12) * 100, 1);
    expect(r.gpuIndexes).toEqual([0]);
  });

  it('token 估算按引擎 GPU 数折算到每卡', () => {
    // 两张卡都跑引擎 → 模型总 FLOPs 平均摊到每卡（每卡减半）
    const two = PROBE_COLD
      .replace('MFU:PROC:00000000:01:00.0, 1234, VLLM::EngineCore',
        'MFU:PROC:00000000:01:00.0, 1234, VLLM::EngineCore\nMFU:PROC:00000000:02:00.0, 5678, VLLM::EngineCore');
    const r = buildMfuResult(parseMfuProbeOutput(two));
    expect(r.gpuIndexes).toEqual([0, 1]);
    // 峰值取第一个匹配（4090:165.2），100 tok/s 的模型均摊 2 卡
    expect(r.mfu).toBeCloseTo((2 * 27e9 * 100 / 2 / 165.2e12) * 100, 2);
  });

  it('热采样：用上一次采样做差分', () => {
    const p = parseMfuProbeOutput(PROBE_COLD);
    const current = p.samples[p.samples.length - 1];
    // 30s 前的采样：prompt token 少 3000（=100 tok/s）
    const r = buildMfuResult(p, {
      previousSample: {
        timeMs: current.timeMs - 30000,
        metrics: {
          flopsTotal: 0,
          promptTokens: current.metrics.promptTokens - 3000,
          generationTokens: current.metrics.generationTokens,
          models: { [MODEL]: {
            flops: 0,
            promptTokens: current.metrics.models[MODEL].promptTokens - 3000,
            generationTokens: current.metrics.models[MODEL].generationTokens,
          } },
        },
      },
    });
    expect(r.available).toBe(true);
    expect(r.sampleCount).toBe(1);
    expect(r.mfu).toBeCloseTo((2 * 27e9 * 100 / 165.2e12) * 100, 1);
  });

  it('未知 GPU 型号 → 不可用且说明原因', () => {
    const gpus = [{ index: 0, name: 'NVIDIA GeForce RTX 3060', busId: '00000000:01:00.0' }];
    const base = parseMfuProbeOutput(PROBE_COLD);
    const r = buildMfuResult({ ...base, gpus, procs: [] });
    expect(r.available).toBe(false);
    expect(r.reason).toContain('未知 GPU 型号');
  });

  it('没有端点 / 没有采样 / 指标不增长 → 不可用', () => {
    expect(buildMfuResult({ endpoint: null, samples: [], gpus: [], procs: [] }).available).toBe(false);
    const noSample = buildMfuResult({ endpoint: 'http://x/metrics', samples: [], gpus: [], procs: [] });
    expect(noSample.available).toBe(false);

    // 两次采样完全没变化（模型空闲且有 FLOPs 计数为 0）→ 无法算出正数
    const idle = PROBE_COLD.replace(PROMPT_LINE(200), PROMPT_LINE(100)).replace(GEN_LINE(100), GEN_LINE(0));
    const r = buildMfuResult(parseMfuProbeOutput(idle));
    expect(r.available).toBe(true); // 空闲时 MFU=0 是真实结果，不是错误
    expect(r.mfu).toBe(0);
  });

  it('模型名解析不出参数量且无 FLOPs 计数 → 说明原因', () => {
    const noParams = PROBE_COLD.replaceAll(MODEL, 'llama-local-custom');
    const r = buildMfuResult(parseMfuProbeOutput(noParams));
    expect(r.available).toBe(false);
    expect(r.reason).toContain('参数量');
  });

  it('识别不到引擎进程时覆盖全部 GPU（单机单模型兜底）', () => {
    const p = parseMfuProbeOutput(PROBE_COLD.replace('MFU:PROC:00000000:01:00.0, 1234, VLLM::EngineCore', ''));
    const r = buildMfuResult(p);
    expect(r.available).toBe(true);
    expect(r.gpuIndexes).toEqual([0, 1]);
  });
});
