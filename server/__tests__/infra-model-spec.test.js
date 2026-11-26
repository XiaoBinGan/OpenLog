/**
 * infra/model-spec.js 测试。
 *
 * 核心用例来自真机 strata 模型的 GGUF 元数据（Qwen3.8-Flash-Next，qwen4exp 架构）：
 *   block_count 48 / head_count 24 / head_count_kv 2 / key_length 256 / value_length 256
 *   full_attention_interval 4 / compress_ratios 每 4 层一个 4 / --kv int8
 *
 * 经验值（256 KiB/token）对这个模型高估了约 80 倍 —— 这一组用例就是防止有人
 * 把"精确计算"改回"查表"。
 *
 * GGUF 二进制夹具是**真实 GGUF 编码**（手工拼字节），不是 mock：
 * 解析器的错位 bug（数组只读前 N 个元素导致后续 key 全错）只有真字节能测出来。
 */
import { describe, it, expect } from 'vitest';
import {
  parseGgufHeader,
  specFromGgufMeta,
  specFromHfConfig,
  kvBytesPerTokenExact,
  kvDtypeToBytes,
  kvDtypeFromArgs,
  ssmStateMiB,
  detectWeightOffload,
  KV_DTYPE_BYTES,
} from '../infra/model-spec.js';

/* ────────────────────────── GGUF 二进制构造 ────────────────────────── */

const T = { UINT32: 4, STRING: 8, ARRAY: 9, FLOAT32: 6, BOOL: 7, UINT64: 10 };

/** 拼一个最小的 GGUF 头部（v3：counts 为 u64） */
function buildGguf(entries, { version = 3, tensors = 0 } = {}) {
  const chunks = [];
  const str = (s) => {
    const b = Buffer.from(s, 'utf8');
    const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(b.length));
    return Buffer.concat([len, b]);
  };
  const val = (type, v) => {
    if (type === T.STRING) return str(v);
    if (type === T.UINT32) { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; }
    if (type === T.UINT64) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; }
    if (type === T.FLOAT32) { const b = Buffer.alloc(4); b.writeFloatLE(v); return b; }
    if (type === T.BOOL) { const b = Buffer.alloc(1); b.writeUInt8(v ? 1 : 0); return b; }
    if (type === T.ARRAY) {
      const elemType = Buffer.alloc(4); elemType.writeUInt32LE(v.elemType);
      const n = Buffer.alloc(8); n.writeBigUInt64LE(BigInt(v.values.length));
      return Buffer.concat([elemType, n, ...v.values.map((x) => val(v.elemType, x))]);
    }
    throw new Error('unsupported');
  };
  chunks.push(Buffer.from('GGUF', 'latin1'));
  const ver = Buffer.alloc(4); ver.writeUInt32LE(version); chunks.push(ver);
  const nt = Buffer.alloc(8); nt.writeBigUInt64LE(BigInt(tensors)); chunks.push(nt);
  const nkv = Buffer.alloc(8); nkv.writeBigUInt64LE(BigInt(entries.length)); chunks.push(nkv);
  for (const [key, type, value] of entries) {
    chunks.push(str(key));
    const t = Buffer.alloc(4); t.writeUInt32LE(type); chunks.push(t);
    chunks.push(val(type, value));
  }
  return Buffer.concat(chunks);
}

/** 真机 strata 模型的元数据（从 GGUF 里读出来的真实值） */
const STRATA_ENTRIES = [
  ['general.architecture', T.STRING, 'qwen4exp'],
  ['general.name', T.STRING, 'Qwen3.8-Flash-Next GSQ-RCO'],
  ['general.size_label', T.STRING, '512x56B'],
  ['qwen4exp.block_count', T.UINT32, 48],
  ['qwen4exp.attention.head_count', T.UINT32, 24],
  ['qwen4exp.attention.head_count_kv', T.UINT32, 2],
  ['qwen4exp.attention.key_length', T.UINT32, 256],
  ['qwen4exp.attention.value_length', T.UINT32, 256],
  ['qwen4exp.embedding_length', T.UINT32, 2560],
  ['qwen4exp.context_length', T.UINT32, 262144],
  ['qwen4exp.full_attention_interval', T.UINT32, 4],
  ['qwen4exp.attention.compress_ratios', T.ARRAY, { elemType: T.UINT32, values: [0, 0, 0, 4, 0, 0, 0, 4] }],
  ['qwen4exp.expert_count', T.UINT32, 512],
  ['qwen4exp.expert_used_count', T.UINT32, 10],
  ['qwen4exp.ssm.inner_size', T.UINT32, 6144],
  ['qwen4exp.ssm.state_size', T.UINT32, 128],
  ['qwen4exp.ssm.conv_kernel', T.UINT32, 4],
  ['qwen4exp.ssm.group_count', T.UINT32, 16],
  ['qwen4exp.rope.freq_base', T.FLOAT32, 10000000],
];

describe('GGUF 解析（真字节，不是 mock）', () => {
  it('解析出真机 strata 模型的全部关键字段', () => {
    const r = parseGgufHeader(buildGguf(STRATA_ENTRIES));
    expect(r.ok).toBe(true);
    expect(r.version).toBe(3);
    expect(r.meta['qwen4exp.block_count']).toBe(48);
    expect(r.meta['qwen4exp.attention.head_count_kv']).toBe(2);
    expect(r.meta['general.architecture']).toBe('qwen4exp');
  });

  it('数组必须完整消费：compress_ratios 后面还有 key 时不能错位', () => {
    // compress_ratios 是 8 元素数组，后面还跟着 expert_count —— 早期版本只读前几个元素就直接崩
    const r = parseGgufHeader(buildGguf(STRATA_ENTRIES));
    expect(r.ok).toBe(true);
    expect(r.meta['qwen4exp.attention.compress_ratios']).toHaveLength(8);
    // 数组之后的所有 key 都必须正确（这就是错位检测）
    expect(r.meta['qwen4exp.expert_count']).toBe(512);
    expect(r.meta['qwen4exp.ssm.state_size']).toBe(128);
    expect(r.meta['qwen4exp.rope.freq_base']).toBeCloseTo(1e7, 0);
  });

  it('大数组（48 个元素，模拟真实 compress_ratios）也不错位', () => {
    const big = Array.from({ length: 48 }, (_, i) => (i % 4 === 3 ? 4 : 0));
    const r = parseGgufHeader(buildGguf([
      ['arch.block_count', T.UINT32, 48],
      ['arch.attention.compress_ratios', T.ARRAY, { elemType: T.UINT32, values: big }],
      ['arch.expert_count', T.UINT32, 512],
    ]));
    expect(r.ok).toBe(true);
    expect(r.meta['arch.attention.compress_ratios']).toHaveLength(48);
    expect(r.meta['arch.expert_count']).toBe(512);
  });

  it('魔数不对 → 明确报错而不是抛异常', () => {
    const bad = Buffer.from('NOPE0000000000000000', 'latin1');
    const r = parseGgufHeader(bad);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('不是 GGUF');
  });

  it('缓冲被截断（只读了一部分）→ 报"缓冲不足"而不是错位', () => {
    const full = buildGguf(STRATA_ENTRIES);
    const r = parseGgufHeader(full.subarray(0, 120));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('缓冲不足');
  });

  it('bool 类型（7）能解析 —— 真机元数据里确实有 bool 字段', () => {
    const r = parseGgufHeader(buildGguf([
      ['a.flag', T.BOOL, true],
      ['a.block_count', T.UINT32, 48],
    ]));
    expect(r.ok).toBe(true);
    expect(r.meta['a.flag']).toBe(true);
    expect(r.meta['a.block_count']).toBe(48);
  });

  it('v1 的 32 位计数也能解析', () => {
    const chunks = [];
    chunks.push(Buffer.from('GGUF', 'latin1'));
    const ver = Buffer.alloc(4); ver.writeUInt32LE(1); chunks.push(ver);
    const nt = Buffer.alloc(4); nt.writeUInt32LE(0); chunks.push(nt);
    const nkv = Buffer.alloc(4); nkv.writeUInt32LE(1); chunks.push(nkv);
    const key = Buffer.from('a.b', 'utf8');
    const klen = Buffer.alloc(8); klen.writeBigUInt64LE(3n);
    chunks.push(klen, key);
    const t = Buffer.alloc(4); t.writeUInt32LE(T.UINT32); chunks.push(t);
    const v = Buffer.alloc(4); v.writeUInt32LE(7); chunks.push(v);
    const r = parseGgufHeader(Buffer.concat(chunks));
    expect(r.ok).toBe(true);
    expect(r.meta['a.b']).toBe(7);
  });
});

describe('GGUF → 规格（混合架构识别）', () => {
  const spec = specFromGgufMeta(parseGgufHeader(buildGguf(STRATA_ENTRIES)).meta);

  it('48 层里只有 12 层是全注意力（interval=4）', () => {
    expect(spec.ok).toBe(true);
    expect(spec.layerCount).toBe(48);
    expect(spec.fullAttentionLayers).toBe(12);
    expect(spec.linearLayers).toBe(36);
    expect(spec.fullAttentionInterval).toBe(4);
    expect(spec.notes.join()).toContain('混合架构');
  });

  it('KV 头数 2、head_dim 256（GQA）', () => {
    expect(spec.kvHeadCount).toBe(2);
    expect(spec.headDim).toBe(256);
    expect(spec.valueDim).toBe(256);
    expect(spec.headCount).toBe(24);
  });

  it('compress_ratios 的平均压缩比被算出来（8 个元素里 2 个是 4）', () => {
    // [0,0,0,4, 0,0,0,4] → 4→1, 4→4 ⇒ (1+1+1+4+1+1+1+4)/8 = 1.75
    expect(spec.avgCompressRatio).toBe(1.75);
  });

  it('缺 block_count → 明确失败', () => {
    const r = specFromGgufMeta({ 'general.architecture': 'x' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('block_count');
  });

  it('缺 head_count_kv → 明确失败（不能用 head_count 瞎顶）', () => {
    const r = specFromGgufMeta({ 'general.architecture': 'x', 'x.block_count': 32 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('head_count_kv');
  });
});

describe('传 Transformer（非混合）不应该被少算层', () => {
  it('没有 full_attention_interval 时全层都是全注意力', () => {
    const r = specFromGgufMeta({
      'general.architecture': 'llama',
      'llama.block_count': 32,
      'llama.attention.head_count': 32,
      'llama.attention.head_count_kv': 8,
      'llama.attention.key_length': 128,
      'llama.attention.value_length': 128,
    });
    expect(r.fullAttentionLayers).toBe(32);
    expect(r.linearLayers).toBe(0);
    expect(r.fullAttentionInterval).toBe(1);
  });
});

describe('KV 精确计算（与本项目真机对账）', () => {
  const spec = specFromGgufMeta(parseGgufHeader(buildGguf(STRATA_ENTRIES)).meta);

  it('strata 模型 int8 KV：约 3 KiB/token（经验值 256 KiB 高估 80 倍）', () => {
    const r = kvBytesPerTokenExact(spec, { kvDtype: 'int8' });
    expect(r.ok).toBe(true);
    // 12 层 × 2 头 × (256+256) × 1B ÷ 1.75 = 7021 B ≈ 6.9 KiB
    expect(r.bytesPerToken).toBeGreaterThan(6000);
    expect(r.bytesPerToken).toBeLessThan(8000);
    const kib = r.bytesPerToken / 1024;
    expect(kib).toBeLessThan(256 / 4); // 至少比经验值小 4 倍以上
  });

  it('fp16 KV 是 int8 的两倍', () => {
    const i8 = kvBytesPerTokenExact(spec, { kvDtype: 'int8' }).bytesPerToken;
    const f16 = kvBytesPerTokenExact(spec, { kvDtype: 'fp16' }).bytesPerToken;
    expect(f16 / i8).toBeCloseTo(2, 5);
  });

  it('公式串能直接贴给用户看', () => {
    const r = kvBytesPerTokenExact(spec, { kvDtype: 'int8' });
    expect(r.formula).toContain('12 层');
    expect(r.formula).toContain('2 KV头');
    expect(r.formula).toContain('÷ 1.75');
  });

  it('精度认不出 → 失败并列出支持的写法', () => {
    const r = kvBytesPerTokenExact(spec, { kvDtype: 'mystery' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('认不出来');
  });

  it('规格不可用 → 失败而不是给 0', () => {
    expect(kvBytesPerTokenExact({ ok: false }).ok).toBe(false);
  });
});

describe('HF config.json 路径', () => {
  it('Qwen2.5-VL-32B 形状（含 text_config 嵌套）', () => {
    const r = specFromHfConfig({
      model_type: 'qwen2_5_vl',
      text_config: {
        num_hidden_layers: 64,
        num_attention_heads: 40,
        num_key_value_heads: 8,
        head_dim: 128,
        max_position_embeddings: 128000,
      },
    });
    expect(r.ok).toBe(true);
    expect(r.layerCount).toBe(64);
    expect(r.kvHeadCount).toBe(8);
    expect(r.headDim).toBe(128);
    // 64 × 8 × 256 × 2B = 256 KiB/token（这个模型确实接近经验值 —— 说明经验值不是全错，是分模型）
    const kv = kvBytesPerTokenExact(r, { kvDtype: 'fp16' }).bytesPerToken;
    expect(kv / 1024).toBeCloseTo(256, 0);
  });

  it('缺 num_key_value_heads → 按 MHA 用 num_attention_heads', () => {
    const r = specFromHfConfig({ num_hidden_layers: 12, num_attention_heads: 12, hidden_size: 768 });
    expect(r.kvHeadCount).toBe(12);
    expect(r.headDim).toBe(64);
  });

  it('layer_types 标明混合架构', () => {
    const types = Array.from({ length: 48 }, (_, i) => (i % 4 === 3 ? 'full_attention' : 'linear_attention'));
    const r = specFromHfConfig({ num_hidden_layers: 48, num_attention_heads: 24, num_key_value_heads: 2, head_dim: 256, layer_types: types });
    expect(r.fullAttentionLayers).toBe(12);
    expect(r.linearLayers).toBe(36);
  });

  it('缺层数 → 失败', () => {
    expect(specFromHfConfig({}).ok).toBe(false);
    expect(specFromHfConfig(null).ok).toBe(false);
  });
});

describe('KV 精度解析', () => {
  it('kvDtypeToBytes 覆盖常见写法', () => {
    expect(kvDtypeToBytes('fp16')).toBe(2);
    expect(kvDtypeToBytes('BF16')).toBe(2);
    expect(kvDtypeToBytes('int8')).toBe(1);
    expect(kvDtypeToBytes('fp8_e4m3')).toBe(1);
    expect(kvDtypeToBytes('fp32')).toBe(4);
    expect(kvDtypeToBytes('')).toBeNull();
    expect(kvDtypeToBytes('nonsense')).toBeNull();
    expect(KV_DTYPE_BYTES.fp16).toBe(2);
  });

  it('kvDtypeFromArgs 认 --kv / --kv-cache-dtype 两种写法', () => {
    expect(kvDtypeFromArgs(['--kv', 'int8']).dtype).toBe('int8');
    expect(kvDtypeFromArgs(['--kv=int8']).dtype).toBe('int8');
    expect(kvDtypeFromArgs(['--kv-cache-dtype', 'fp8']).dtype).toBe('fp8');
    expect(kvDtypeFromArgs(['--other']).dtype).toBeNull();
    expect(kvDtypeFromArgs(undefined).dtype).toBeNull();
  });
});

describe('SSM 常量状态', () => {
  const parsed = parseGgufHeader(buildGguf(STRATA_ENTRIES));
  const spec = specFromGgufMeta(parsed.meta);

  it('36 层线性注意力的常量状态被估出来（与上下文无关）', () => {
    const r = ssmStateMiB(spec, parsed.meta);
    expect(r.miB).toBeGreaterThan(0);
    expect(r.reason).toContain('与上下文无关');
  });

  it('没有 SSM 元数据 → 0 并说明可能低估', () => {
    const r = ssmStateMiB(spec, {});
    expect(r.miB).toBe(0);
    expect(r.reason).toContain('可能被低估');
  });
});

describe('MoE 卸载检测（权重≠文件大小）', () => {
  it('strata 的 --expert-cache / --ple-io 被识别为卸载', () => {
    const r = detectWeightOffload({ engineType: 'strata', args: ['--expert-cache', 'auto', '--ple-io', 'ram'] });
    expect(r.offloads).toBe(true);
    expect(r.reasons.join()).toContain('expert-cache');
    expect(r.hint).toContain('权重项建议用实测值');
  });

  it('llama.cpp 默认 mmap 视为卸载', () => {
    const r = detectWeightOffload({ engineType: 'llama.cpp', args: [] });
    expect(r.offloads).toBe(true);
  });

  it('vLLM 常规启动不算卸载', () => {
    const r = detectWeightOffload({ engineType: 'vllm', args: ['--gpu-memory-utilization', '0.9'] });
    expect(r.offloads).toBe(false);
    expect(r.hint).toBeNull();
  });

  it('vLLM --cpu-offload-gb 也算卸载', () => {
    const r = detectWeightOffload({ engineType: 'vllm', args: ['--cpu-offload-gb', '20'] });
    expect(r.offloads).toBe(true);
  });
});

/* ─────────── 白名单完整性（这一课已经踩了四次） ─────────── */
describe('ModelService 白名单必须包含所有会被上层用到的模型字段', () => {
  it('足迹/规格相关字段全都透传（踩过四次：autoscale/cache/sizeMiB/specPath/fileSizeMiB）', async () => {
    const { validateModelService } = await import('../infra/model.js');
    const r = validateModelService({
      name: 'wl-check',
      namespace: 'infra-test',
      model: {
        source: 'hostPath',
        path: '/container/path',
        specPath: '/host/path',
        sizeMiB: 20237,
        fileSizeMiB: 64500,
        parametersB: 32,
        quantization: 'awq',
        contextLength: 32768,
        maxConcurrency: 4,
        measuredMemMiB: 13330,
        measuredContextLength: 32768,
        measuredMaxConcurrency: 1,
        measuredAt: '2026-11-26T13:30:00.000Z',
        benchInputTokens: [64, 512],
      },
      engine: { type: 'strata', image: 'i' },
      resources: { accelerators: 1, memoryMiB: 14336, coresPercent: 50 },
      replicas: 1,
      ports: [{ name: 'http', containerPort: 8080 }],
      health: { path: '/health' },
    });
    expect(r.ok).toBe(true);
    const m = r.value.model;
    // 任何一个被丢掉，上层就会静默降级到错误的估算 —— 逐个钉住
    expect(m.specPath).toBe('/host/path');
    expect(m.sizeMiB).toBe(20237);
    expect(m.fileSizeMiB).toBe(64500);
    expect(m.parametersB).toBe(32);
    expect(m.maxConcurrency).toBe(4);
    expect(m.measuredMemMiB).toBe(13330);
    expect(m.measuredContextLength).toBe(32768);
    expect(m.measuredMaxConcurrency).toBe(1);
    expect(m.measuredAt).toBe('2026-11-26T13:30:00.000Z');
    expect(m.benchInputTokens).toEqual([64, 512]);
  });

  it('非法值被拒（负数 / 穿越路径 / 坏时间）', async () => {
    const { validateModelService } = await import('../infra/model.js');
    const base = {
      name: 'bad', namespace: 'infra-test',
      engine: { type: 'vllm', image: 'i' },
      resources: { accelerators: 1, memoryMiB: 4096, coresPercent: 10 },
      replicas: 1, ports: [{ name: 'http', containerPort: 8000 }], health: { path: '/' },
    };
    const bad = (model) => validateModelService({ ...base, model: { source: 'hostPath', path: '/a', ...model } });
    expect(bad({ measuredMemMiB: -1 }).ok).toBe(false);
    expect(bad({ fileSizeMiB: 0 }).ok).toBe(false);
    expect(bad({ specPath: '../etc/passwd' }).ok).toBe(false);
    expect(bad({ specPath: 'relative/path' }).ok).toBe(false);
    expect(bad({ measuredAt: 'not-a-date' }).ok).toBe(false);
  });
});
