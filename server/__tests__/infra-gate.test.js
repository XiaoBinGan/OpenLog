/**
 * server/__tests__/infra-gate.test.js
 *
 * B5 基准门禁的单测。铁律：**纯函数测试，不联网、不碰集群、不读真实配置**。
 *   - `benchResult` 全部是手搓夹具（形状与 `bench.js#runBenchmark` 一致）；
 *   - `baseline` 是扁平对象（形状与 `buildBaseline` 一致）；
 *   - 时间通过 `now` 注入，报告里的时间戳可断言。
 *
 * 覆盖：全绿 / TTFT 超标 / 错误率超标 / 吞吐回归 / 显存超卖 / 中止 / ok:false /
 * 无 baseline 的 warning / confidence=estimated 的 warning / 自定义阈值 /
 * 阈值非法回落 / score 单调性 / 报告 markdown / buildBaseline 字段 / 边界值。
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateGate,
  renderGateReport,
  buildBaseline,
  collectBenchMetrics,
  DEFAULT_THRESHOLDS,
  GATE_WEIGHTS,
} from '../infra/gate.js';

/* ───────────────────────────── 夹具 ───────────────────────────── */

/** 一个基准 cell（形状对齐 bench.js 的 result） */
function cell({
  concurrency = 1,
  inputTokens = 512,
  samples = 4,
  errors = 0,
  p95 = 800,
  tokensPerSec = 120,
} = {}) {
  return {
    concurrency,
    requestedConcurrency: concurrency,
    inputTokens,
    requests: samples + errors,
    samples,
    ok: errors === 0 && samples > 0,
    ttftMs: p95 === null ? { p50: null, p95: null, max: null } : { p50: p95 * 0.6, p95, max: p95 * 1.3 },
    tokensPerSec,
    rps: 1,
    errors,
    errorKinds: { http: 0, timeout: 0, network: 0, empty: 0 },
    wallMs: 500,
    aborted: false,
    startedAtMs: 0,
  };
}

/** 一个基准结果（形状对齐 runBenchmark 返回值） */
function makeBench({
  cells,
  ok,
  aborted = false,
  reason = null,
  memoryMiB = 8192,
  coresPercent = 50,
  confidence = 'measured',
} = {}) {
  const results = cells ?? [cell()];
  return {
    ok: ok ?? (!aborted && results.every((r) => r.ok)),
    aborted,
    reason,
    results,
    summary: {
      best: results[0] ?? null,
      bestKey: results[0] ? `${results[0].concurrency}/${results[0].inputTokens}` : null,
      recommended: { memoryMiB, coresPercent, confidence, basis: {}, notes: [] },
    },
  };
}

function makeService({ memoryMiB = 8192, coresPercent = 100 } = {}) {
  return {
    namespace: 'inference',
    name: 'qwen3-8b',
    resources: { accelerators: 1, memoryMiB, coresPercent },
  };
}

/** 上一轮通过门禁后固化的基线 */
function makeBaseline(overrides = {}) {
  return {
    at: '2026-11-01T00:00:00.000Z',
    serviceKey: 'inference/qwen3-8b',
    memoryMiB: 8192,
    coresPercent: 50,
    ttftP95Ms: 800,
    tokensPerSec: 120,
    errorRate: 0,
    confidence: 'measured',
    ...overrides,
  };
}

const BASELINE = makeBaseline();

/* ───────────────────────────── 用例 ───────────────────────────── */

describe('evaluateGate · 通过路径', () => {
  it('全绿：全项满足 → pass=true、failures 为空、score=100', () => {
    const gate = evaluateGate({
      benchResult: makeBench(),
      baseline: BASELINE,
      service: makeService(),
    });

    expect(gate.pass).toBe(true);
    expect(gate.failures).toEqual([]);
    expect(gate.warnings).toEqual([]);
    expect(gate.score).toBe(100);
    expect(gate.baselineUsed).toBe(true);
    // 五项里四项参与评分；吞吐有 baseline 所以也参与
    expect(gate.checks.every((c) => c.pass)).toBe(true);
    expect(gate.checks.filter((c) => c.scored).map((c) => c.metric).sort())
      .toEqual(['errorRate', 'memMiB', 'tokensPerSec', 'ttftP95Ms']);
  });

  it('边界值：每个指标都刚好落在阈值上（= 阈值）仍算通过', () => {
    const gate = evaluateGate({
      // errorRate 恰好 0.01（1/100），tps 恰好 96 = 120 × 0.8，p95 恰好 3000
      benchResult: makeBench({
        ok: true,
        cells: [cell({ samples: 99, errors: 1, p95: 3000, tokensPerSec: 96 })],
      }),
      baseline: BASELINE,
      service: makeService({ memoryMiB: 8192 }),
    });

    const byMetric = Object.fromEntries(gate.checks.map((c) => [c.metric, c]));
    expect(byMetric.ttftP95Ms.actual).toBe(3000);
    expect(byMetric.errorRate.actual).toBe(0.01);
    expect(byMetric.tokensPerSec.threshold).toBe(96);
    expect(byMetric.memMiB.actual).toBe(8192);
    expect(gate.failures).toEqual([]);
    expect(gate.pass).toBe(true);
  });

  it('collectBenchMetrics：取最差 p95 / 最差错误率 / 最好吞吐', () => {
    const metrics = collectBenchMetrics(makeBench({
      cells: [
        cell({ concurrency: 1, samples: 4, errors: 0, p95: 500, tokensPerSec: 80 }),
        cell({ concurrency: 8, samples: 6, errors: 2, p95: 1800, tokensPerSec: 240 }),
      ],
    }));

    expect(metrics.ttftP95Ms).toBe(1800);
    expect(metrics.samples).toBe(10);
    expect(metrics.errors).toBe(2);
    expect(metrics.done).toBe(12);
    expect(metrics.errorRate).toBe(0.17);
    expect(metrics.tokensPerSec).toBe(240);
  });
});

describe('evaluateGate · 硬性前置条件', () => {
  it('aborted：直接不通过，failure 里带中止原因，score=0', () => {
    const reason = '8 并发时错误率 25.0%（5/20）超过阈值 20.0%，已中止以免把无效数据算进推荐配额';
    const gate = evaluateGate({
      benchResult: makeBench({ aborted: true, ok: false, reason, cells: [cell()] }),
      baseline: BASELINE,
      service: makeService(),
    });

    expect(gate.pass).toBe(false);
    expect(gate.score).toBe(0);
    expect(gate.failures.map((f) => f.metric)).toContain('aborted');
    expect(gate.failures[0].message).toContain(reason);
    expect(gate.warnings.join('\n')).toContain('不构成上线依据');
  });

  it('ok:false：不通过，且不把数值指标当结论', () => {
    const gate = evaluateGate({
      benchResult: makeBench({ ok: false, cells: [cell({ errors: 4, samples: 0, p95: null })] }),
      service: makeService(),
    });

    expect(gate.pass).toBe(false);
    expect(gate.failures.map((f) => f.metric)).toContain('ok');
    expect(gate.score).toBe(0);
  });

  it('没有 benchResult：不通过且不抛错（门禁自己不能崩）', () => {
    const gate = evaluateGate({});
    expect(gate.pass).toBe(false);
    expect(gate.failures[0].metric).toBe('benchResult');
    expect(gate.failures[0].message).toContain('没有基准结果');
    expect(gate.score).toBe(0);
    expect(() => renderGateReport({ service: null, benchResult: null, gate })).not.toThrow();
  });
});

describe('evaluateGate · 绝对阈值', () => {
  it('TTFT 超标：失败项 metric=ttftP95Ms，给出实测与阈值，分数不归零（部分得分）', () => {
    const gate = evaluateGate({
      benchResult: makeBench({ cells: [cell({ p95: 5000 })] }),
      baseline: BASELINE,
      service: makeService(),
    });

    const fail = gate.failures.find((f) => f.metric === 'ttftP95Ms');
    expect(gate.pass).toBe(false);
    expect(fail).toBeTruthy();
    expect(fail.actual).toBe(5000);
    expect(fail.threshold).toBe(3000);
    expect(fail.message).toContain('超过上限');
    // 3000/5000 = 0.6 的满足度：30*0.6 + 25 + 25 + 20 = 88
    expect(gate.score).toBe(88);
  });

  it('错误率超标：失败项 metric=errorRate（bench 允许 20% 错误，门禁只允许 1%）', () => {
    const gate = evaluateGate({
      benchResult: makeBench({
        ok: true,
        cells: [cell({ samples: 18, errors: 2 })],
      }),
      baseline: BASELINE,
      service: makeService(),
    });

    const fail = gate.failures.find((f) => f.metric === 'errorRate');
    expect(gate.pass).toBe(false);
    expect(fail.actual).toBe(0.1);
    expect(fail.threshold).toBe(0.01);
    expect(fail.message).toContain('错误率');
  });

  it('自定义 thresholds 可以覆盖默认值（且报告里注明用了自定义阈值）', () => {
    const bench = makeBench({ cells: [cell({ p95: 800 })] });

    const strict = evaluateGate({
      benchResult: bench,
      service: makeService(),
      thresholds: { ttftP95Ms: 500 },
    });
    expect(strict.failures.map((f) => f.metric)).toContain('ttftP95Ms');
    expect(strict.warnings.join('\n')).toContain('自定义阈值');

    const loose = evaluateGate({
      benchResult: makeBench({ ok: true, cells: [cell({ samples: 18, errors: 2 })] }),
      service: makeService(),
      thresholds: { errorRate: 0.5, weights: { errorRate: 0 } },
    });
    expect(loose.failures.map((f) => f.metric)).not.toContain('errorRate');
  });

  it('阈值非法（0 / NaN / 超范围）回落默认值并给 warning，不抛错', () => {
    const gate = evaluateGate({
      benchResult: makeBench(),
      service: makeService(),
      thresholds: { ttftP95Ms: 0, errorRate: Number.NaN, tokensPerSecRatio: 5 },
    });

    const text = gate.warnings.join('\n');
    expect(text).toContain('ttftP95Ms');
    expect(text).toContain('已回落到默认值');
    expect(gate.thresholds.ttftP95Ms).toBe(DEFAULT_THRESHOLDS.ttftP95Ms);
    expect(gate.thresholds.errorRate).toBe(DEFAULT_THRESHOLDS.errorRate);
    expect(gate.thresholds.tokensPerSecRatio).toBe(DEFAULT_THRESHOLDS.tokensPerSecRatio);
    expect(gate.pass).toBe(true);
  });

  it('吞吐绝对下限：thresholds.tokensPerSec 优先于 baseline 比值', () => {
    const gate = evaluateGate({
      benchResult: makeBench({ cells: [cell({ tokensPerSec: 120 })] }),
      baseline: BASELINE,
      service: makeService(),
      thresholds: { tokensPerSec: 200 },
    });

    const fail = gate.failures.find((f) => f.metric === 'tokensPerSec');
    expect(fail).toBeTruthy();
    expect(fail.threshold).toBe(200);
  });
});

describe('evaluateGate · 回归与显存', () => {
  it('吞吐低于 baseline × 0.8：判失败', () => {
    const gate = evaluateGate({
      benchResult: makeBench({ cells: [cell({ tokensPerSec: 90 })] }),
      baseline: makeBaseline({ tokensPerSec: 120 }),
      service: makeService(),
    });

    const fail = gate.failures.find((f) => f.metric === 'tokensPerSec');
    expect(gate.pass).toBe(false);
    expect(fail.actual).toBe(90);
    expect(fail.threshold).toBe(96); // 120 × 0.8
    expect(fail.message).toContain('低于下限');
  });

  it('推荐显存超过实际申请：判失败（不许偷偷超卖 vGPU 份额）', () => {
    const gate = evaluateGate({
      benchResult: makeBench({ memoryMiB: 16384 }),
      baseline: BASELINE,
      service: makeService({ memoryMiB: 8192 }),
    });

    const fail = gate.failures.find((f) => f.metric === 'memMiB');
    expect(gate.pass).toBe(false);
    expect(fail.actual).toBe(16384);
    expect(fail.threshold).toBe(8192);
    expect(fail.message).toContain('超过服务实际申请');
  });

  it('memoryMiB=0（整卡不限）时跳过超卖检查并给 warning', () => {
    const gate = evaluateGate({
      benchResult: makeBench(),
      baseline: BASELINE,
      service: makeService({ memoryMiB: 0 }),
    });

    expect(gate.pass).toBe(true);
    expect(gate.warnings.join('\n')).toContain('整卡');
    expect(gate.checks.find((c) => c.metric === 'memMiB').scored).toBe(false);
  });

  it('没有实测显存峰值（recommended.memoryMiB=null）：显存项跳过，只给 warning', () => {
    const gate = evaluateGate({
      benchResult: makeBench({ memoryMiB: null, confidence: 'estimated' }),
      service: makeService(),
      thresholds: { memMiB: 8192 },
    });

    const text = gate.warnings.join('\n');
    expect(gate.pass).toBe(true);
    expect(text).toContain('没有实测显存峰值');
    expect(text).toContain('估算值');
    expect(gate.checks.find((c) => c.metric === 'memMiB').actual).toBe(null);
  });
});

describe('evaluateGate · warning 降级', () => {
  it('无 baseline：仅记录基线，吞吐回归项未参与判定，但仍可 pass', () => {
    const gate = evaluateGate({ benchResult: makeBench(), service: makeService() });

    const text = gate.warnings.join('\n');
    expect(gate.pass).toBe(true);
    expect(text).toContain('首次运行：仅记录基线，未做回归对比');
    expect(gate.baselineUsed).toBe(false);
    // 三项参与判定，权重重新归一 → 全满足仍是 100，而不是被缺项拉低
    expect(gate.score).toBe(100);
    expect(gate.checks.find((c) => c.metric === 'tokensPerSec').scored).toBe(false);
  });

  it('confidence=estimated：只 warning，不阻塞上线，且报告里显式标注估算值', () => {
    const bench = makeBench({ confidence: 'estimated', memoryMiB: 8192 });
    const gate = evaluateGate({ benchResult: bench, baseline: BASELINE, service: makeService() });

    expect(gate.pass).toBe(true);
    expect(gate.warnings.join('\n')).toContain('显存建议为估算值');
    const md = renderGateReport({ service: makeService(), benchResult: bench, gate });
    expect(md).toContain('显存建议为估算值');
    expect(md).toContain('未验证');
  });

  it('没有 service 时显存超卖检查跳过（不误判为通过）', () => {
    const gate = evaluateGate({ benchResult: makeBench({ memoryMiB: 99999 }), baseline: BASELINE });

    expect(gate.failures.map((f) => f.metric)).not.toContain('memMiB');
    expect(gate.warnings.join('\n')).toContain('没有拿到服务的实际显存申请');
  });
});

describe('score 计算', () => {
  it('权重表总和为 100 且覆盖四项指标', () => {
    const total = Object.values(GATE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBe(100);
    expect(Object.keys(GATE_WEIGHTS).sort()).toEqual(['errorRate', 'memMiB', 'tokensPerSec', 'ttftP95Ms']);
  });

  it('单调性：同一项指标越差，分数越低', () => {
    const scoreFor = (p95) => evaluateGate({
      benchResult: makeBench({ cells: [cell({ p95 })] }),
      baseline: BASELINE,
      service: makeService(),
    }).score;

    const scores = [1500, 4000, 6000, 12000].map(scoreFor);
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    }
    expect(scores[0]).toBe(100);
    expect(scores[scores.length - 1]).toBeLessThan(90);
  });

  it('单调性：错误率越高分越低；分数恒在 0..100', () => {
    const scoreForErrors = (errors, samples) => evaluateGate({
      benchResult: makeBench({ ok: true, cells: [cell({ errors, samples })] }),
      baseline: BASELINE,
      service: makeService(),
    }).score;

    const a = scoreForErrors(1, 99); // 1%
    const b = scoreForErrors(2, 18); // 10%
    const c = scoreForErrors(9, 1); // 90%
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
    for (const s of [a, b, c]) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
    }
  });

  it('整体越差分数越低（多指标同时恶化）', () => {
    const good = evaluateGate({
      benchResult: makeBench({ cells: [cell({ p95: 800, errorRate: 0, tokensPerSec: 130 })] }),
      baseline: BASELINE,
      service: makeService(),
    });
    const bad = evaluateGate({
      benchResult: makeBench({ ok: true, cells: [cell({ p95: 4000, samples: 18, errors: 2, tokensPerSec: 90 })] }),
      baseline: BASELINE,
      service: makeService(),
    });

    expect(good.score).toBeGreaterThan(bad.score);
  });
});

describe('buildBaseline', () => {
  it('字段完整：at / serviceKey / 四项数值 / confidence', () => {
    const bench = makeBench({
      cells: [cell({ samples: 8, errors: 0, p95: 1200, tokensPerSec: 150 })],
      memoryMiB: 10240,
      coresPercent: 60,
      confidence: 'measured',
    });
    const baseline = buildBaseline({ benchResult: bench, service: makeService(), now: 1767225600000 });

    expect(baseline.at).toBe('2026-01-01T00:00:00.000Z');
    expect(baseline.serviceKey).toBe('inference/qwen3-8b');
    expect(baseline.memoryMiB).toBe(10240);
    expect(baseline.coresPercent).toBe(60);
    expect(baseline.ttftP95Ms).toBe(1200);
    expect(baseline.tokensPerSec).toBe(150);
    expect(baseline.errorRate).toBe(0);
    expect(baseline.confidence).toBe('measured');
    expect(baseline.samples).toBe(8);
    expect(baseline.cells).toBe(1);
    expect(baseline.bestKey).toBe('1/512');
  });

  it('没有实测显存时 confidence 降级为 estimated，且可注入 Date', () => {
    const baseline = buildBaseline({
      benchResult: makeBench({ memoryMiB: null, confidence: 'estimated' }),
      service: makeService(),
      now: () => new Date('2026-11-26T05:00:00.000Z'),
    });

    expect(baseline.confidence).toBe('estimated');
    expect(baseline.memoryMiB).toBe(null);
    expect(baseline.at).toBe('2026-11-26T05:00:00.000Z');
  });

  it('service 缺失时 serviceKey 为 null 但不抛错', () => {
    const baseline = buildBaseline({ benchResult: makeBench() });
    expect(baseline.serviceKey).toBe(null);
    expect(typeof baseline.at).toBe('string');
  });
});

describe('renderGateReport', () => {
  it('通过的报告：结论 + 关键区块 + 配额对比表', () => {
    const service = makeService({ memoryMiB: 8192, coresPercent: 100 });
    const bench = makeBench();
    const gate = evaluateGate({ benchResult: bench, baseline: BASELINE, service });
    const md = renderGateReport({ service, benchResult: bench, gate });

    expect(md).toContain('## 基准门禁报告');
    expect(md).toContain('inference/qwen3-8b');
    expect(md).toContain('通过（可以上线）');
    expect(md).toContain('评分 100/100');
    expect(md).toContain('### 逐项指标');
    expect(md).toContain('TTFT p95');
    expect(md).toContain('错误率');
    expect(md).toContain('吞吐');
    expect(md).toContain('显存');
    expect(md).toContain('### 推荐配额 vs 实际申请');
    expect(md).toContain('### 未验证项 / 需人工确认');
    expect(md).toContain('### 与基线对比');
    expect(md).toContain('2026-11-01T00:00:00.000Z');
    expect(md).toContain('### 阈值与权重');
  });

  it('不通过的方言：含 ❌、阻断项与可操作处置', () => {
    const service = makeService({ memoryMiB: 4096 });
    const bench = makeBench({ cells: [cell({ p95: 6000 })], memoryMiB: 16384 });
    const gate = evaluateGate({ benchResult: bench, baseline: BASELINE, service });
    const md = renderGateReport({ service, benchResult: bench, gate });

    expect(md).toContain('不通过（不许上线）');
    expect(md).toContain('❌');
    expect(md).toContain('### 阻断项（必须修掉才能上线）');
    expect(md).toContain('`ttftP95Ms`');
    expect(md).toContain('`memMiB`');
    expect(md).toContain('处置：');
    expect(md).toContain('申请值不足');
  });

  it('gate 缺省时会自己跑一遍判定（报告不会因为漏传 gate 而空）', () => {
    const md = renderGateReport({ service: makeService(), benchResult: makeBench() });
    expect(md).toContain('## 基准门禁报告');
    expect(md).toContain('首次运行');
  });
});
