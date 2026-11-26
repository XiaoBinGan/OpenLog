/**
 * infra/footprint.js 测试。
 *
 * 判据来自 2026-11-26 的真机三次尝试（Qwen2.5-VL-32B-Instruct-AWQ，4090）：
 *   配额 21504 MiB → CUDA OOM（AWQ 反量化暂存不够）
 *   配额 23284 MiB → vLLM 报 KV cache 剩 -0.73 GiB
 *   配额 28672 MiB → 正常服务，实测进程占用 25076 MiB
 * 所以下面「真实三档」那组是这几个数字的回归锁：估算器必须把前两档判成放不下/勉强。
 */
import { describe, it, expect } from 'vitest';
import {
  estimateModelFootprint,
  bitsPerWeight,
  parseParamsB,
  kvBytesPerToken,
  ENGINE_OVERHEAD_MIB,
} from '../infra/footprint.js';

/** 真机那个 32B AWQ 模型的形状 */
function qwen32b(resources) {
  return {
    model: { sizeMiB: 20237, quantization: 'awq', parametersB: 32, contextLength: 2048 },
    engine: { type: 'vllm', args: ['--gpu-memory-utilization', '0.92'] },
    resources,
  };
}

describe('真实三档回归（32B-AWQ 在 4090 上）', () => {
  it('配额 21504 MiB（真机 OOM 那档）→ 必须判 insufficient', () => {
    const r = estimateModelFootprint(qwen32b({ memoryMiB: 21504 }));
    expect(r.verdict).toBe('insufficient');
    expect(r.requiredMiB).toBeGreaterThan(21504);
    expect(r.reasons.join(' ')).toContain('放不下');
  });

  it('配额 23284 MiB（真机 KV cache -0.73 GiB 那档）→ 必须判 insufficient', () => {
    const r = estimateModelFootprint(qwen32b({ memoryMiB: 23284 }));
    expect(r.verdict).toBe('insufficient');
  });

  it('配额 28672 MiB（真机能起来那档）→ 必须判 fits', () => {
    const r = estimateModelFootprint(qwen32b({ memoryMiB: 28672 }));
    expect(r.verdict).toBe('fits');
    expect(r.headroomMiB).toBeGreaterThan(0);
    // 估算值应接近真机观测的 25076 MiB（±15%）
    expect(r.requiredMiB).toBeGreaterThan(25076 * 0.85);
    expect(r.requiredMiB).toBeLessThan(25076 * 1.15);
  });
});

describe('权重口径', () => {
  it('优先用 sizeMiB（实测），不按参数量重算', () => {
    const r = estimateModelFootprint({
      model: { sizeMiB: 20000, parametersB: 32, quantization: 'awq', contextLength: 2048 },
      engine: { type: 'vllm' },
      resources: { memoryMiB: 32768 },
    });
    expect(r.breakdown.weightsMiB).toBe(20000);
  });

  it('只有参数量 + 量化 → 按位宽推算并告警', () => {
    const r = estimateModelFootprint({
      model: { parametersB: 8, quantization: 'fp16', contextLength: 4096 },
      engine: { type: 'vllm' },
      resources: { memoryMiB: 32768 },
    });
    expect(r.breakdown.weightsMiB).toBeCloseTo((8e9 * 2 * 1.05) / (1024 * 1024), 0); // 8B × 2 bytes × 1.05
    expect(r.warnings.join()).toContain('按参数量推算');
  });

  it('参数量但没量化 → 按 fp16 推算并明确告警"会偏保守"', () => {
    const r = estimateModelFootprint({
      model: { parametersB: 32, contextLength: 2048 },
      engine: { type: 'vllm' },
      resources: { memoryMiB: 65536 },
    });
    expect(r.breakdown.weightsMiB).toBeCloseTo((32e9 * 2 * 1.05) / (1024 * 1024), 0);
    expect(r.warnings.join()).toContain('fp16');
  });

  it('sizeMiB 与"参数量×位宽"严重不一致 → 告警但采信 sizeMiB', () => {
    const r = estimateModelFootprint({
      model: { sizeMiB: 20237, parametersB: 32, quantization: 'fp16', contextLength: 2048 },
      engine: { type: 'vllm' },
      resources: { memoryMiB: 32768 },
    });
    expect(r.breakdown.weightsMiB).toBe(20237);
    expect(r.warnings.join()).toContain('权重口径不一致');
  });

  it('什么都不知道 → verdict unknown，不编数字', () => {
    const r = estimateModelFootprint({ model: {}, engine: { type: 'vllm' }, resources: { memoryMiB: 8192 } });
    expect(r.verdict).toBe('unknown');
    expect(r.requiredMiB).toBeNull();
    expect(r.reasons.join()).toContain('无法判断');
  });
});

describe('KV cache 与并发', () => {
  it('并发越高足迹越大（每多一路多一份 KV）', () => {
    const one = estimateModelFootprint({
      model: { sizeMiB: 20000, parametersB: 32, contextLength: 4096, maxConcurrency: 1 },
      engine: { type: 'vllm' },
      resources: { memoryMiB: 32768 },
    });
    const four = estimateModelFootprint({
      model: { sizeMiB: 20000, parametersB: 32, contextLength: 4096, maxConcurrency: 4 },
      engine: { type: 'vllm' },
      resources: { memoryMiB: 32768 },
    });
    expect(four.requiredMiB).toBeGreaterThan(one.requiredMiB);
  });

  it('未声明并发 → 按 1 路算并告警"结论会偏乐观"', () => {
    const r = estimateModelFootprint({
      model: { sizeMiB: 20000, parametersB: 32, contextLength: 4096 },
      engine: { type: 'vllm' },
      resources: { memoryMiB: 32768 },
    });
    expect(r.inputs.maxConcurrency).toBe(1);
    expect(r.warnings.join()).toContain('偏乐观');
  });

  it('未声明上下文 → 按 4096 估算并告警', () => {
    const r = estimateModelFootprint({
      model: { sizeMiB: 20000, parametersB: 32 },
      engine: { type: 'vllm' },
      resources: { memoryMiB: 32768 },
    });
    expect(r.inputs.contextLength).toBe(4096);
    expect(r.warnings.join()).toContain('未声明 model.contextLength');
  });

  it('上下文越长 KV 越大', () => {
    const short = estimateModelFootprint({
      model: { sizeMiB: 20000, parametersB: 32, contextLength: 2048 },
      engine: { type: 'vllm' }, resources: { memoryMiB: 65536 },
    });
    const long = estimateModelFootprint({
      model: { sizeMiB: 20000, parametersB: 32, contextLength: 32768 },
      engine: { type: 'vllm' }, resources: { memoryMiB: 65536 },
    });
    expect(long.breakdown.kvCacheMiB).toBeGreaterThan(short.breakdown.kvCacheMiB);
  });
});

describe('引擎开销', () => {
  it('不同引擎开销不同，vLLM 与 sglang 都被计入', () => {
    const base = { model: { sizeMiB: 10000, parametersB: 8, contextLength: 2048 }, resources: { memoryMiB: 16384 } };
    const v = estimateModelFootprint({ ...base, engine: { type: 'vllm' } });
    const s = estimateModelFootprint({ ...base, engine: { type: 'sglang' } });
    expect(v.breakdown.overheadMiB).toBe(ENGINE_OVERHEAD_MIB.vllm);
    expect(s.breakdown.overheadMiB).toBe(ENGINE_OVERHEAD_MIB.sglang);
    expect(s.requiredMiB).toBeGreaterThan(v.requiredMiB);
  });

  it('未知引擎按 vLLM 的开销保守估计', () => {
    const r = estimateModelFootprint({
      model: { sizeMiB: 10000, parametersB: 8, contextLength: 2048 },
      engine: { type: 'mystery-engine' }, resources: { memoryMiB: 16384 },
    });
    expect(r.breakdown.overheadMiB).toBe(ENGINE_OVERHEAD_MIB.vllm);
  });
});

describe('判定阈值', () => {
  it('刚好够需求但不足 10% 余量 → tight 而不是 fits', () => {
    const r0 = estimateModelFootprint(qwen32b({ memoryMiB: 28672 }));
    const need = r0.requiredMiB;
    // 配额正好等于需求：能装下，但没有余量
    const exact = estimateModelFootprint(qwen32b({ memoryMiB: Math.ceil(need) }));
    expect(exact.verdict).toBe('tight');
  });

  it('配额远超需求 → fits 且提示空转占卡', () => {
    const r = estimateModelFootprint(qwen32b({ memoryMiB: 65536 }));
    expect(r.verdict).toBe('fits');
    expect(r.reasons.join(' ')).toContain('空转');
  });

  it('memoryMiB=0（整卡模式）→ tight 并给出"估计需要多少"', () => {
    const r = estimateModelFootprint(qwen32b({ memoryMiB: 0 }));
    expect(r.verdict).toBe('tight');
    expect(r.headroomMiB).toBeNull();
    expect(r.reasons.join(' ')).toContain('整卡模式');
  });

  it('缺口数字出现在文案里（方便直接照抄改配额）', () => {
    const r = estimateModelFootprint(qwen32b({ memoryMiB: 21504 }));
    expect(r.reasons.join(' ')).toMatch(/至少提到 \d+ MiB/);
  });
});

describe('工具函数', () => {
  it('bitsPerWeight 覆盖常见写法', () => {
    expect(bitsPerWeight('awq')).toBeTruthy();
    expect(bitsPerWeight('Q4_K_M')).toBeTruthy();
    expect(bitsPerWeight('fp16')).toBe(16);
    expect(bitsPerWeight('q2_0')).toBeTruthy();
    expect(bitsPerWeight('')).toBeNull();
    expect(bitsPerWeight('whatever')).toBeNull();
  });

  it('parseParamsB 认 32B / 7b / 0.6B / 1T / 纯数字', () => {
    expect(parseParamsB('32B')).toBe(32);
    expect(parseParamsB('7b')).toBe(7);
    expect(parseParamsB('0.6B')).toBe(0.6);
    expect(parseParamsB('1T')).toBe(1000);
    expect(parseParamsB(13)).toBe(13);
    expect(parseParamsB('abc')).toBeNull();
    expect(parseParamsB('')).toBeNull();
  });

  it('kvBytesPerToken 随参数量单调不减', () => {
    const sizes = [0.5, 3, 8, 13, 32, 70, 200];
    const values = sizes.map((s) => kvBytesPerToken(s));
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
    }
  });
});
