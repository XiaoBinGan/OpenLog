import { describe, it, expect, beforeEach, vi } from 'vitest';

// 隔离外部依赖：只验证「解析 + 归一化 + 换算」这些纯逻辑。
const holder = vi.hoisted(() => ({
  gpuConfigs: [],
  remoteStdout: '',
}));

vi.mock('../remote.js', () => ({
  execRemoteCommand: vi.fn(async () => ({ success: true, stdout: holder.remoteStdout, stderr: '' })),
}));
vi.mock('../gpu.js', () => ({
  loadGPUConfigs: vi.fn(() => holder.gpuConfigs),
}));

const {
  lookupPeakTflops, parseModelParamsB, parsePrometheus, sumMetric, normalizeMetrics,
  parseGpuInfo, buildMfuResult, parseSampleOutput, buildSampleScript, sanitizeUrl,
  discoverSources, getRemoteMfu, _resetCaches,
} = await import('../gpu-mfu.js');

beforeEach(() => { _resetCaches(); holder.gpuConfigs = []; holder.remoteStdout = ''; });

const MODEL_VLLM = 'Qwen3.8-27B-W4A16-AWQ-GPTQ';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

describe('GPU 峰值算力表', () => {
  it('常见型号（FP16 稠密）', () => {
    expect(lookupPeakTflops('NVIDIA GeForce RTX 4090')).toBe(165.2);
    expect(lookupPeakTflops('NVIDIA GeForce RTX 5090')).toBe(209.5);
    expect(lookupPeakTflops('NVIDIA A100-SXM4-80GB')).toBe(312);
    expect(lookupPeakTflops('Tesla T4')).toBe(65);
  });

  it('未知型号返回 null（不猜）', () => {
    expect(lookupPeakTflops('NVIDIA GeForce RTX 3060')).toBeNull();
    expect(lookupPeakTflops('')).toBeNull();
    expect(lookupPeakTflops(null)).toBeNull();
  });
});

describe('模型激活参数量解析', () => {
  it('MoE：35B-A3B 取激活值 3B', () => {
    expect(parseModelParamsB('Qwen3.5-35B-A3B-GPTQ-Int4')).toBe(3);
    expect(parseModelParamsB('Qwen3-235B-A22B-FP8')).toBe(22);
  });

  it('Flash-Next 名字里没有参数量 → 查表得 7.3B（由 GGUF 张量表算出）', () => {
    expect(parseModelParamsB('qwen3.8-flash-next-q2_0')).toBe(7.3);
    expect(parseModelParamsB('Qwen3.8-Flash-Next-GSQ-RCO')).toBe(7.3);
  });

  it('稠密模型按名字里的参数量', () => {
    expect(parseModelParamsB('Qwen3.8-27B-W4A16-AWQ-GPTQ')).toBe(27);
    expect(parseModelParamsB('Meta-Llama-3.1-8B-Instruct')).toBe(8);
  });

  it('解析不出返回 null', () => {
    expect(parseModelParamsB('llama-local-custom')).toBeNull();
    expect(parseModelParamsB('')).toBeNull();
  });
});

describe('Prometheus 解析', () => {
  it('带标签的指标行', () => {
    const rows = parsePrometheus([
      '# HELP vllm:prompt_tokens_total ...',
      `vllm:prompt_tokens_total{engine="0",model_name="${MODEL_VLLM}"} 148778643`,
      `vllm:generation_tokens_total{engine="0",model_name="${MODEL_VLLM}"} 1047026`,
      'bad line without number',
    ].join('\n'));
    expect(rows).toHaveLength(2);
    expect(rows[0].labels.model_name).toBe(MODEL_VLLM);
    expect(rows[0].value).toBe(148778643);
  });

  it('sumMetric 支持 label 过滤', () => {
    const rows = parsePrometheus([
      'vllm:prompt_tokens_by_source_total{source="local_compute"} 100',
      'vllm:prompt_tokens_by_source_total{source="local_cache_hit"} 900',
    ].join('\n'));
    expect(sumMetric(rows, 'vllm:prompt_tokens_by_source_total', l => l.source === 'local_compute')).toBe(100);
    expect(sumMetric(rows, 'vllm:prompt_tokens_by_source_total')).toBe(1000);
    expect(sumMetric(rows, 'not_exists')).toBeNull();
  });
});

describe('normalizeMetrics —— 多引擎归一化（不绑定 vLLM）', () => {
  it('vLLM：优先 local_compute（不含 prefix cache 命中）', () => {
    const body = [
      `vllm:prompt_tokens_total{model_name="${MODEL_VLLM}"} 1000`,
      `vllm:prompt_tokens_by_source_total{model_name="${MODEL_VLLM}",source="local_compute"} 300`,
      `vllm:generation_tokens_total{model_name="${MODEL_VLLM}"} 200`,
      `vllm:num_requests_running{model_name="${MODEL_VLLM}"} 2`,
      `vllm:estimated_flops_per_gpu_total{model_name="${MODEL_VLLM}"} 0`,
    ].join('\n');
    const m = normalizeMetrics(body);
    expect(m.engine).toBe('vllm');
    expect(m.promptTokens).toBe(300); // 不是 1000
    expect(m.generationTokens).toBe(200);
    expect(m.running).toBe(2);
    expect(m.model).toBe(MODEL_VLLM);
  });

  it('vLLM：没有 by_source 时退回 prompt_tokens_total', () => {
    const body = `vllm:prompt_tokens_total{model_name="${MODEL_VLLM}"} 500\nvllm:generation_tokens_total{model_name="${MODEL_VLLM}"} 50`;
    expect(normalizeMetrics(body).promptTokens).toBe(500);
  });

  it('Strata：JSON 统计（engine/totals/live/hardware_static）', () => {
    const body = JSON.stringify({
      engine: { model: 'qwen3.8-flash-next-q2_0' },
      live: { state: 'idle', queued: 0, tok_s: 0 },
      totals: { since: 1, requests: 686, prompt_tokens: 94311, output_tokens: 130450 },
      hardware_static: { gpu_name: 'NVIDIA GeForce RTX 5090' },
    });
    const m = normalizeMetrics(body);
    expect(m.engine).toBe('strata');
    expect(m.model).toBe('qwen3.8-flash-next-q2_0');
    expect(m.promptTokens).toBe(94311);
    expect(m.generationTokens).toBe(130450);
    expect(m.gpuName).toBe('NVIDIA GeForce RTX 5090');
    expect(m.running).toBe(0);
  });

  it('Strata：live 非 idle 时 running=1', () => {
    const body = JSON.stringify({
      engine: { model: 'm' }, live: { state: 'decode' }, totals: { prompt_tokens: 0, output_tokens: 0 },
    });
    expect(normalizeMetrics(body).running).toBe(1);
  });

  it('自定义 JSON 契约（手写 transformer 服务）：字段别名都能识别', () => {
    const m = normalizeMetrics(JSON.stringify({
      model: 'my-transformer-7b',
      prompt_tokens: 1234,
      generation_tokens: 56,
      gpu: 'NVIDIA GeForce RTX 4090',
    }));
    expect(m.engine).toBe('custom');
    expect(m.model).toBe('my-transformer-7b');
    expect(m.promptTokens).toBe(1234);
    expect(m.generationTokens).toBe(56);
    expect(m.gpuName).toBe('NVIDIA GeForce RTX 4090');
  });

  it('自定义 JSON：input_tokens/output_tokens 别名 + model_name/gpu_name', () => {
    const m = normalizeMetrics(JSON.stringify({
      model_name: 'mine', input_tokens: 10, output_tokens: 20, gpu_name: 'RTX 5090',
    }));
    expect(m.promptTokens).toBe(10);
    expect(m.generationTokens).toBe(20);
    expect(m.model).toBe('mine');
    expect(m.gpuName).toBe('RTX 5090');
  });

  it('自定义 JSON：直接报 flops_total（最准）', () => {
    const m = normalizeMetrics(JSON.stringify({ model: 'x', flops_total: 1.5e13 }));
    expect(m.engine).toBe('custom');
    expect(m.flopsTotal).toBe(1.5e13);
  });

  it('SGLang / TGI / llama.cpp', () => {
    expect(normalizeMetrics('sglang:prompt_tokens_total 10\nsglang:generation_tokens_total 20').engine).toBe('sglang');
    expect(normalizeMetrics('tgi_request_input_length_sum 10\ntgi_request_generated_tokens_sum 20').engine).toBe('tgi');
    expect(normalizeMetrics('llamacpp:prompt_tokens_total 10\nllamacpp:tokens_predicted_total 20').engine).toBe('llamacpp');
  });

  it('通用 Prometheus（任意 OpenAI 兼容服务）', () => {
    const m = normalizeMetrics('myengine:prompt_tokens_total 11\nmyengine:generation_tokens_total 22');
    expect(m.engine).toBe('generic');
    expect(m.promptTokens).toBe(11);
    expect(m.generationTokens).toBe(22);
  });

  it('无法识别 / 空 / HTML 返回 null', () => {
    expect(normalizeMetrics('')).toBeNull();
    expect(normalizeMetrics('<html><body>hi</body></html>')).toBeNull();
    expect(normalizeMetrics('{"foo":"bar"}')).toBeNull();
    expect(normalizeMetrics('some random text')).toBeNull();
  });
});

describe('parseGpuInfo / parseSampleOutput（多引擎）', () => {
  it('解析 nvidia-smi 行', () => {
    const info = parseGpuInfo([
      'MFU:GPU:0, NVIDIA GeForce RTX 4090, 00000000:01:00.0',
      'MFU:GPU:1, NVIDIA GeForce RTX 5090, 00000000:02:00.0',
      'MFU:PROC:00000000:01:00.0, 794809, VLLM::EngineCore',
      'MFU:PROC:00000000:02:00.0, 3937512, /opt/strata/components/engine/strata',
    ].join('\n'));
    expect(info.gpus).toHaveLength(2);
    expect(info.gpus[1]).toMatchObject({ index: 1, name: 'NVIDIA GeForce RTX 5090' });
    expect(info.procs[0]).toMatchObject({ pid: 794809, name: 'VLLM::EngineCore' });
  });

  it('采样输出按来源分组（同机两个引擎）', () => {
    const vllmBody = (t) => `vllm:prompt_tokens_total{model_name="${MODEL_VLLM}"} ${t}\nvllm:generation_tokens_total{model_name="${MODEL_VLLM}"} 0`;
    const strataBody = (p, g) => JSON.stringify({
      engine: { model: 'qwen3.8-flash-next-q2_0' }, live: { state: 'idle' },
      totals: { prompt_tokens: p, output_tokens: g },
      hardware_static: { gpu_name: 'NVIDIA GeForce RTX 5090' },
    });
    const out = [
      'MFU:BEGIN:0:1000000000', b64(vllmBody(100)), '', 'MFU:END:0',
      'MFU:BEGIN:1:1000000000', b64(strataBody(10, 20)), '', 'MFU:END:1',
      'MFU:BEGIN:0:3000000000', b64(vllmBody(300)), '', 'MFU:END:0',
      'MFU:BEGIN:1:3000000000', b64(strataBody(30, 60)), '', 'MFU:END:1',
      'MFU:GPU:0, NVIDIA GeForce RTX 4090, 00000000:01:00.0',
      'MFU:GPU:1, NVIDIA GeForce RTX 5090, 00000000:02:00.0',
      'MFU:PROC:00000000:01:00.0, 1, VLLM::EngineCore',
      'MFU:PROC:00000000:02:00.0, 2, /opt/strata/components/engine/strata',
    ].join('\n');
    const parsed = parseSampleOutput(out);
    expect(parsed.samplesBySource.get(0)).toHaveLength(2);
    expect(parsed.samplesBySource.get(1)).toHaveLength(2);
    expect(parsed.samplesBySource.get(0)[1].metrics.promptTokens).toBe(300);
    expect(parsed.samplesBySource.get(1)[1].metrics.generationTokens).toBe(60);
    expect(parsed.gpus).toHaveLength(2);
  });
});

const GPU4090 = { index: 0, name: 'NVIDIA GeForce RTX 4090', busId: '00000000:01:00.0' };
const GPU5090 = { index: 1, name: 'NVIDIA GeForce RTX 5090', busId: '00000000:02:00.0' };

describe('buildMfuResult —— MFU 换算', () => {
  it('vLLM token 差分：2×27B×100tok/s ÷ 165.2T ≈ 3.27%', () => {
    const r = buildMfuResult({
      prev: { timeMs: 1000, promptTokens: 0, generationTokens: 0, flopsTotal: 0, model: MODEL_VLLM },
      cur: { timeMs: 3000, promptTokens: 100, generationTokens: 100, flopsTotal: 0, model: MODEL_VLLM },
      gpus: [GPU4090, GPU5090],
      procs: [{ busId: GPU4090.busId, pid: 1, name: 'VLLM::EngineCore' }],
      paramsB: 27,
      engine: 'vllm',
    });
    expect(r.available).toBe(true);
    expect(r.mfu).toBeCloseTo((2 * 27e9 * 100 / 165.2e12) * 100, 2);
    expect(r.gpuIndexes).toEqual([0]); // 只算引擎所在卡
    expect(r.method).toBe('tokens_x_active_params');
    expect(r.tokensPerSec).toBe(100);
    expect(r.windowSec).toBe(2);
  });

  it('引擎自报 FLOPs 计数器优先', () => {
    const r = buildMfuResult({
      prev: { timeMs: 1000, promptTokens: 0, generationTokens: 0, flopsTotal: 0 },
      cur: { timeMs: 3000, promptTokens: 0, generationTokens: 0, flopsTotal: 1.652e14 },
      gpus: [GPU4090],
      procs: [{ busId: GPU4090.busId, pid: 1, name: 'VLLM::EngineCore' }],
      paramsB: 27,
      engine: 'vllm',
    });
    expect(r.method).toBe('engine_flops_counter');
    expect(r.mfu).toBeCloseTo(50, 1);
  });

  it('Strata：JSON 计数 + 型号匹配显卡 + Flash-Next 激活参数 7.3B', () => {
    // RTX 5090 峰值 209.5T；2×7.3B×200tok/s = 2.92TFLOP/s → 1.39%
    const r = buildMfuResult({
      prev: { timeMs: 1000, promptTokens: 0, generationTokens: 0, model: 'qwen3.8-flash-next-q2_0', gpuName: 'NVIDIA GeForce RTX 5090' },
      cur: { timeMs: 21000, promptTokens: 2000, generationTokens: 2000, model: 'qwen3.8-flash-next-q2_0', gpuName: 'NVIDIA GeForce RTX 5090' },
      gpus: [GPU4090, GPU5090],
      procs: [{ busId: GPU5090.busId, pid: 3937512, name: '/opt/strata/components/engine/strata' }],
      paramsB: 7.3,
      engine: 'strata',
    });
    expect(r.available).toBe(true);
    expect(r.engine).toBe('strata');
    expect(r.gpuIndexes).toEqual([1]);
    expect(r.peakTflops).toBe(209.5);
    expect(r.mfu).toBeCloseTo((2 * 7.3e9 * 200 / 209.5e12) * 100, 2);
  });

  it('Strata 进程名对不上时用引擎自报 GPU 型号兜底', () => {
    const r = buildMfuResult({
      prev: { timeMs: 1000, promptTokens: 0, generationTokens: 0, gpuName: 'NVIDIA GeForce RTX 5090' },
      cur: { timeMs: 3000, promptTokens: 0, generationTokens: 100, gpuName: 'NVIDIA GeForce RTX 5090' },
      gpus: [GPU4090, GPU5090],
      procs: [], // 进程名认不出
      paramsB: 7.3,
      engine: 'strata',
    });
    expect(r.available).toBe(true);
    expect(r.gpuIndexes).toEqual([1]);
  });

  it('未知 GPU 型号 → 不可用且说明原因', () => {
    const r = buildMfuResult({
      prev: { timeMs: 1000, promptTokens: 0, generationTokens: 0 },
      cur: { timeMs: 3000, promptTokens: 0, generationTokens: 100 },
      gpus: [{ index: 0, name: 'NVIDIA GeForce RTX 3060', busId: 'b' }],
      procs: [],
      paramsB: 27,
      engine: 'vllm',
    });
    expect(r.available).toBe(false);
    expect(r.reason).toContain('未知 GPU 型号');
  });

  it('解析不出参数量且无 FLOPs 计数 → 不可用且说明原因', () => {
    const r = buildMfuResult({
      prev: { timeMs: 1000, promptTokens: 0, generationTokens: 0 },
      cur: { timeMs: 3000, promptTokens: 0, generationTokens: 100, model: 'llama-local-custom' },
      gpus: [GPU4090],
      procs: [],
      paramsB: null,
      engine: 'vllm',
    });
    expect(r.available).toBe(false);
    expect(r.reason).toContain('参数量');
  });

  it('空闲（计数不增长）→ MFU 0%，不是错误', () => {
    const r = buildMfuResult({
      prev: { timeMs: 1000, promptTokens: 500, generationTokens: 500 },
      cur: { timeMs: 31000, promptTokens: 500, generationTokens: 500 },
      gpus: [GPU4090],
      procs: [{ busId: GPU4090.busId, pid: 1, name: 'VLLM::EngineCore' }],
      paramsB: 27,
      engine: 'vllm',
    });
    expect(r.available).toBe(true);
    expect(r.mfu).toBe(0);
    expect(r.tokensPerSec).toBe(0);
  });

  it('计数器回退（服务重启）不会算出负 MFU', () => {
    const r = buildMfuResult({
      prev: { timeMs: 1000, promptTokens: 1000, generationTokens: 1000 },
      cur: { timeMs: 3000, promptTokens: 10, generationTokens: 10 },
      gpus: [GPU4090],
      procs: [{ busId: GPU4090.busId, pid: 1, name: 'VLLM::EngineCore' }],
      paramsB: 27,
      engine: 'vllm',
    });
    expect(r.available).toBe(true);
    expect(r.mfu).toBe(0);
  });
});

describe('discoverSources —— 自动发现（含密钥与多引擎）', () => {
  it('解析发现结果：同机两个引擎都能拿到 url/engine/key', async () => {
    const vllmBody = `vllm:prompt_tokens_total{model_name="${MODEL_VLLM}"} 1`;
    const strataBody = JSON.stringify({ engine: { model: 'qwen3.8-flash-next-q2_0' }, totals: { prompt_tokens: 1, output_tokens: 1 } });
    holder.remoteStdout = [
      `SRC:${b64('http://127.0.0.1:30000/metrics')}|vllm|${b64('')}|${b64(vllmBody)}`,
      `SRC:${b64('http://127.0.0.1:8899/metrics')}|strata|${b64('secret-key-123')}|${b64(strataBody)}`,
    ].join('\n');
    const sources = await discoverSources('srv-1');
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({ engine: 'vllm', url: 'http://127.0.0.1:30000/metrics' });
    expect(sources[1]).toMatchObject({ engine: 'strata', key: 'secret-key-123' });
  });

  it('跳过格式无法识别的端点（如 HTML 页面）', async () => {
    holder.remoteStdout = `SRC:${b64('http://127.0.0.1:8000/metrics')}|generic|${b64('')}|${b64('<html>hi</html>')}`;
    expect(await discoverSources('srv-2')).toEqual([]);
  });

  it('没有命中端点返回空数组', async () => {
    holder.remoteStdout = 'NO_SOURCE';
    expect(await discoverSources('srv-3')).toEqual([]);
  });

  it('配置了 metricsUrl/apiKey 时通过配置下发', async () => {
    holder.gpuConfigs = [{ serverId: 'srv-4', metricsUrl: 'http://127.0.0.1:9000/metrics', apiKey: 'cfg-key-12345' }];
    holder.remoteStdout = `SRC:${b64('http://127.0.0.1:9000/metrics')}|vllm|${b64('cfg-key-12345')}|${b64('vllm:prompt_tokens_total 1')}`;
    const sources = await discoverSources('srv-4');
    expect(sources).toHaveLength(1);
    expect(sources[0].key).toBe('cfg-key-12345');
  });
});

describe('getRemoteMfu —— 端到端（mock 远端输出）', () => {
  it('同机 vLLM + Strata 各自算出 MFU，并映射到对应显卡', async () => {
    const vllmBody = (t) => `vllm:prompt_tokens_total{model_name="${MODEL_VLLM}"} ${t}\nvllm:generation_tokens_total{model_name="${MODEL_VLLM}"} 0`;
    const strataBody = (p, g) => JSON.stringify({
      engine: { model: 'qwen3.8-flash-next-q2_0' }, live: { state: 'idle' },
      totals: { prompt_tokens: p, output_tokens: g },
      hardware_static: { gpu_name: 'NVIDIA GeForce RTX 5090' },
    });
    // 第一次调用：发现 + 冷采样
    holder.remoteStdout = [
      `SRC:${b64('http://127.0.0.1:30000/metrics')}|vllm|${b64('')}|${b64(vllmBody(0))}`,
      `SRC:${b64('http://127.0.0.1:8899/metrics')}|strata|${b64('k')}|${b64(strataBody(0, 0))}`,
    ].join('\n');
    expect(await discoverSources('srv-e2e')).toHaveLength(2);

    holder.remoteStdout = [
      'MFU:BEGIN:0:1000', b64(vllmBody(0)), '', 'MFU:END:0',
      'MFU:BEGIN:1:1000', b64(strataBody(0, 0)), '', 'MFU:END:1',
      'MFU:BEGIN:0:3000', b64(vllmBody(200)), '', 'MFU:END:0',
      'MFU:BEGIN:1:3000', b64(strataBody(300, 300)), '', 'MFU:END:1',
      'MFU:GPU:0, NVIDIA GeForce RTX 4090, 00000000:01:00.0',
      'MFU:GPU:1, NVIDIA GeForce RTX 5090, 00000000:02:00.0',
      'MFU:PROC:00000000:01:00.0, 1, VLLM::EngineCore',
      'MFU:PROC:00000000:02:00.0, 2, /opt/strata/components/engine/strata',
    ].join('\n');

    const result = await getRemoteMfu('srv-e2e');
    expect(result.available).toBe(true);
    expect(result.engines).toHaveLength(2);

    const vllm = result.engines.find(e => e.engine === 'vllm');
    const strata = result.engines.find(e => e.engine === 'strata');
    // vLLM: 200 tok / 2s = 100 tok/s，27B，4090
    expect(vllm.mfu).toBeCloseTo((2 * 27e9 * 100 / 165.2e12) * 100, 2);
    expect(vllm.gpuIndexes).toEqual([0]);
    // Strata: 600 tok / 2s = 300 tok/s，Flash-Next 7.3B，5090
    expect(strata.mfu).toBeCloseTo((2 * 7.3e9 * 300 / 209.5e12) * 100, 2);
    expect(strata.gpuIndexes).toEqual([1]);
    // 每张卡各自的 MFU 映射
    expect(result.gpuMfu[0].engine).toBe('vllm');
    expect(result.gpuMfu[1].engine).toBe('strata');
  });

  it('没有任何引擎 → available=false 且给出原因', async () => {
    holder.remoteStdout = 'NO_SOURCE';
    const r = await getRemoteMfu('srv-none');
    expect(r.available).toBe(false);
    expect(r.reason).toContain('未发现推理引擎指标端点');
  });
});

describe('sanitizeUrl / buildSampleScript —— 防命令注入', () => {
  it('允许回环 http(s) 地址', () => {
    expect(sanitizeUrl('http://127.0.0.1:8899/metrics')).toBe('http://127.0.0.1:8899/metrics');
    expect(sanitizeUrl('http://localhost:8000/metrics')).toBe('http://localhost:8000/metrics');
  });

  it('拒绝外部地址与注入字符', () => {
    expect(sanitizeUrl('http://10.0.0.1:8000/metrics')).toBe('');
    expect(sanitizeUrl('http://127.0.0.1:8899/metrics; rm -rf /')).toBe('');
    expect(sanitizeUrl('http://127.0.0.1:8899/$(id)')).toBe('');
    expect(sanitizeUrl('file:///etc/passwd')).toBe('');
    expect(sanitizeUrl(null)).toBe('');
  });

  it('采样脚本里不出现原始 URL/密钥明文（都走 base64）', () => {
    const script = buildSampleScript([{ url: 'http://127.0.0.1:8899/metrics', key: 'topsecret123' }], { cold: false });
    expect(script).toContain('http://127.0.0.1:8899/metrics');
    expect(script).not.toContain('topsecret123');
    expect(script).not.toContain('sleep 2'); // 热采样不 sleep
    expect(buildSampleScript([{ url: 'http://127.0.0.1:8899/metrics', key: '' }], { cold: true })).toContain('sleep 2');
  });
});
