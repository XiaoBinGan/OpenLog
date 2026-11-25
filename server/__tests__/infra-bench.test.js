/**
 * server/__tests__/infra-bench.test.js
 *
 * A6 基准引擎的单测。铁律：**一次真实网络都不发**。
 *   - 所有请求走注入的 `fetchImpl`（假实现，自己造 SSE 响应）；
 *   - 时间走注入的 `now`/`sleep`（虚拟时钟），所以百分位、吞吐、墙钟都可精确断言；
 *   - 没有任何 kubectl / docker / ssh / 真机地址。
 *
 * 虚拟时钟的两种假 fetch：
 *   - `batchFetch`：同一批（同一波）请求**集体**完成，墙钟只前进一个 delay。
 *     这才能模拟「并发确实缩短了墙钟」——如果每个请求各自推时钟，C=8 的墙钟
 *     会和 C=1 一样长，吞吐比较就退化成恒等式了。
 *   - `scriptFetch`：按预设脚本逐个给耗时，用于精确断言百分位（配 C=1 串行跑）。
 */
import { describe, it, expect } from 'vitest';
import {
  runBenchmark,
  recommendQuota,
  percentile,
  estimateTokens,
  makePaddingText,
  normalizeLimits,
  normalizeMatrix,
  buildEndpoint,
  DEFAULT_LIMITS,
  DEFAULT_MATRIX,
} from '../infra/bench.js';

/* ───────────────────────────── 测试夹具 ───────────────────────────── */

function makeClock(start = 0) {
  const clock = { t: start };
  clock.now = () => clock.t;
  clock.advance = (ms) => {
    clock.t += Math.max(0, Number(ms) || 0);
    return clock.t;
  };
  return clock;
}

/** 永远不 resolve 的 sleep：不参与超时竞速，避免默认 60s 计时器干扰断言 */
const noSleep = () => new Promise(() => {});

function sseChunks({ tokens = 8, content = 'hello world' } = {}) {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { completion_tokens: tokens } })}\n\n`,
    'data: [DONE]\n\n',
  ];
}

function fakeResponse({ status = 200, chunks }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'text/event-stream' },
    body: (async function* emit() {
      for (const chunk of chunks) yield chunk;
    })(),
  };
}

/**
 * 同批并发请求集体完成：墙钟只前进一次 delayMs。
 * @param {object} clock 虚拟时钟
 * @param {{delayMs?: number, tokens?: number, status?: number}} [opts] 配置
 */
function batchFetch(clock, opts = {}) {
  const { delayMs = 100, tokens = 10, status = 200 } = opts;
  const calls = [];
  let waiters = [];
  let timer = null;
  let active = 0;
  let peak = 0;

  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    active += 1;
    peak = Math.max(peak, active);
    const done = new Promise((resolve) => {
      waiters.push(() => {
        active -= 1;
        resolve(fakeResponse({ status, chunks: sseChunks({ tokens }) }));
      });
    });
    if (timer === null) {
      timer = setTimeout(() => {
        timer = null;
        clock.advance(delayMs);
        const batch = waiters;
        waiters = [];
        for (const release of batch) release();
      }, 0);
    }
    return done;
  };

  return { fn, calls, stats: () => ({ peak, calls: calls.length }) };
}

/**
 * 按脚本逐个给耗时/状态；脚本耗尽后用 defaultDelay。
 * @param {object} clock 虚拟时钟
 * @param {Array<{delayMs?: number, tokens?: number, kind?: 'http'|'network', status?: number}>} script 脚本
 */
function scriptFetch(clock, script, { defaultDelay = 10, tokens = 8 } = {}) {
  const calls = [];
  let index = 0;
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const spec = script[index] ?? { delayMs: defaultDelay };
    index += 1;
    // 先让同一波的请求都登记完，再推时钟，保证 C>1 时也是「一批一个 delay」
    await new Promise((resolve) => setTimeout(resolve, 0));
    clock.advance(spec.delayMs ?? defaultDelay);
    if (spec.kind === 'network') throw new Error('ECONNRESET');
    if (spec.kind === 'http') {
      return {
        ok: false,
        status: spec.status ?? 503,
        headers: { get: () => 'application/json' },
        body: (async function* emit() { yield '{"error":"overloaded"}'; })(),
      };
    }
    return fakeResponse({ chunks: sseChunks({ tokens: spec.tokens ?? tokens }) });
  };
  return { fn, calls };
}

const TARGET = { url: 'http://gpu-fixture-1:8000', model: 'qwen2.5-7b-instruct' };

/* ────────────────────────────── 工具函数 ────────────────────────────── */

describe('token 近似与填充文本', () => {
  it('estimateTokens：空串为 0，CJK 按字计，ascii 按 4 字符 1 token 折算', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens('中文')).toBe(2);
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  it('makePaddingText：确定性、不超目标、且尽量贴近目标', () => {
    const a = makePaddingText(512);
    const b = makePaddingText(512);
    expect(a).toBe(b); // 同输入必须同输出，否则跨批次结果不可比
    const est = estimateTokens(a);
    expect(est).toBeLessThanOrEqual(512);
    expect(est).toBeGreaterThan(500); // 裁剪只允许极小的欠冲

    const big = estimateTokens(makePaddingText(4096));
    expect(big).toBeLessThanOrEqual(4096);
    expect(big).toBeGreaterThan(4000);

    expect(makePaddingText(0)).toBe('');
  });

  it('percentile：nearest-rank，无插值；空样本为 null', () => {
    expect(percentile([], 0.95)).toBeNull();
    expect(percentile([5], 0.95)).toBe(5);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 0.95)).toBe(4);
    expect(percentile([100, 10, 50], 0)).toBe(10); // 乱序输入也要先排序
  });
});

describe('矩阵 / 安全阀 / 端点归一', () => {
  it('normalizeLimits：非法值与越界值回落到默认/夹取', () => {
    expect(normalizeLimits({})).toEqual({ ...DEFAULT_LIMITS });
    expect(normalizeLimits({ maxErrorRate: 5 }).maxErrorRate).toBe(1);
    expect(normalizeLimits({ maxErrorRate: -1 }).maxErrorRate).toBe(0);
    expect(normalizeLimits({ maxConcurrency: 0 }).maxConcurrency).toBe(DEFAULT_LIMITS.maxConcurrency);
    expect(normalizeLimits({ maxConcurrency: 'abc' }).maxConcurrency).toBe(DEFAULT_LIMITS.maxConcurrency);
    expect(normalizeLimits({ maxP95TtftMs: 10 }).maxP95TtftMs).toBe(100); // 下限夹到 100ms
  });

  it('DEFAULT_LIMITS 是冻结的保守默认值，不会被调用方改坏', () => {
    expect(Object.isFrozen(DEFAULT_LIMITS)).toBe(true);
    expect(DEFAULT_LIMITS).toMatchObject({
      maxConcurrency: 8,
      maxRequestsPerCell: 20,
      maxTotalMs: 120000,
      maxErrorRate: 0.2,
      maxP95TtftMs: 30000,
      maxTokensPerSec: 100000,
    });
    expect(DEFAULT_MATRIX).toEqual({ concurrencies: [1, 4, 8], inputTokens: [512, 4096] });
  });

  it('normalizeMatrix：保留给定顺序、去重、丢非法值，笛卡尔积展开', () => {
    const m = normalizeMatrix({ concurrencies: [4, 1, 4, 0, -2], inputTokens: [512, 'abc'] });
    expect(m.concurrencies).toEqual([4, 1]);
    expect(m.inputTokens).toEqual([512]);
    expect(m.cells).toEqual([
      { concurrency: 4, inputTokens: 512 },
      { concurrency: 1, inputTokens: 512 },
    ]);
  });

  it('buildEndpoint：不会拼出双 /v1/chat/completions', () => {
    expect(buildEndpoint({ url: 'http://h:8000' })).toBe('http://h:8000/v1/chat/completions');
    expect(buildEndpoint({ url: 'http://h:8000/' })).toBe('http://h:8000/v1/chat/completions');
    expect(buildEndpoint({ url: 'http://h:8000/v1/chat/completions' })).toBe('http://h:8000/v1/chat/completions');
    expect(buildEndpoint({ url: 'http://h:8000', path: '/api/generate' })).toBe('http://h:8000/api/generate');
  });
});

/* ────────────────────────────── 主流程 ────────────────────────────── */

describe('runBenchmark —— 单组合与统计口径', () => {
  it('单组合成功：结构、样本数、TTFT、吞吐、rps 都对得上', async () => {
    const clock = makeClock();
    const f = batchFetch(clock, { delayMs: 100, tokens: 10 });
    const out = await runBenchmark({
      target: TARGET,
      matrix: { concurrencies: [1], inputTokens: [512] },
      limits: { maxRequestsPerCell: 4 },
      requestsPerCell: 4,
      fetchImpl: f.fn,
      now: clock.now,
      sleep: noSleep,
    });

    expect(out.ok).toBe(true);
    expect(out.aborted).toBe(false);
    expect(out.reason).toBeNull();
    expect(out.results).toHaveLength(1);

    const r = out.results[0];
    expect(r.concurrency).toBe(1);
    expect(r.inputTokens).toBe(512);
    expect(r.requests).toBe(4);
    expect(r.samples).toBe(4);
    expect(r.errors).toBe(0);
    expect(r.ok).toBe(true);
    expect(r.ttftMs).toEqual({ p50: 100, p95: 100, max: 100 });
    // 4 请求 × 10 token = 40 token，墙钟 4 × 100ms = 400ms
    expect(r.tokensPerSec).toBe(100);
    expect(r.rps).toBe(10);
    expect(r.wallMs).toBe(400);
    expect(r.errorKinds).toEqual({ http: 0, timeout: 0, network: 0, empty: 0 });
    expect(out.summary.best).toBe(r);
    expect(out.summary.bestKey).toBe('1/512');
  });

  it('请求体 OpenAI 兼容：model/stream/messages/usage，且填充文本长度贴近 inputTokens', async () => {
    const clock = makeClock();
    const f = batchFetch(clock, { delayMs: 10, tokens: 4 });
    await runBenchmark({
      target: { ...TARGET, apiKey: 'sk-local-fixture' },
      matrix: { concurrencies: [1], inputTokens: [4096] },
      limits: { maxRequestsPerCell: 2 },
      requestsPerCell: 2,
      fetchImpl: f.fn,
      now: clock.now,
      sleep: noSleep,
    });

    expect(f.calls).toHaveLength(2);
    const call = f.calls[0];
    expect(call.url).toBe('http://gpu-fixture-1:8000/v1/chat/completions');
    expect(call.init.method).toBe('POST');
    expect(call.init.headers.Authorization).toBe('Bearer sk-local-fixture');
    expect(call.init.headers['Content-Type']).toBe('application/json');
    expect(call.body.model).toBe('qwen2.5-7b-instruct');
    expect(call.body.stream).toBe(true);
    expect(call.body.messages).toHaveLength(1);
    expect(call.body.messages[0].role).toBe('user');
    const approx = estimateTokens(call.body.messages[0].content);
    expect(approx).toBeLessThanOrEqual(4096);
    expect(approx).toBeGreaterThan(3800);
    // 同一组合内所有请求用同一段填充文本（可比性的前提）
    expect(f.calls[1].body.messages[0].content).toBe(call.body.messages[0].content);
  });

  it('TTFT 百分位：给定确定性耗时序列，p50/p95/max 精确', async () => {
    const clock = makeClock();
    const delays = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const f = scriptFetch(clock, delays.map((d) => ({ delayMs: d, tokens: 2 })));
    const out = await runBenchmark({
      target: TARGET,
      matrix: { concurrencies: [1], inputTokens: [128] },
      limits: { maxRequestsPerCell: 20 },
      requestsPerCell: 10,
      fetchImpl: f.fn,
      now: clock.now,
      sleep: noSleep,
    });

    const r = out.results[0];
    expect(r.samples).toBe(10);
    // nearest-rank：p50 → ceil(0.5×10)-1 = 4 → 50；p95 → ceil(9.5)-1 = 9 → 100
    expect(r.ttftMs).toEqual({ p50: 50, p95: 100, max: 100 });
    // 墙钟 = 各请求串行耗时之和 = 550ms；token = 10 × 2 = 20
    expect(r.wallMs).toBe(550);
    expect(r.tokensPerSec).toBe(36.36);
  });

  it('并发提升吞吐：同一填充长度下 C=4 的 tokens/s 明显高于 C=1', async () => {
    const clock = makeClock();
    const f = batchFetch(clock, { delayMs: 100, tokens: 10 });
    const out = await runBenchmark({
      target: TARGET,
      matrix: { concurrencies: [1, 4], inputTokens: [512] },
      limits: { maxRequestsPerCell: 4 },
      requestsPerCell: 4,
      fetchImpl: f.fn,
      now: clock.now,
      sleep: noSleep,
    });

    const [one, four] = out.results;
    expect(one.concurrency).toBe(1);
    expect(four.concurrency).toBe(4);
    expect(one.samples).toBe(4);
    expect(four.samples).toBe(4);
    expect(four.tokensPerSec).toBeGreaterThan(one.tokensPerSec * 2);
    expect(out.summary.best).toBe(four);
    // 并发没越过 maxConcurrency，且真的并发过（不是偷偷串行）
    expect(f.stats().peak).toBe(4);
  });

  it('矩阵组合顺序：外层并发、内层输入长度，且逐个串行跑', async () => {
    const clock = makeClock();
    const f = batchFetch(clock, { delayMs: 10, tokens: 4 });
    const out = await runBenchmark({
      target: TARGET,
      matrix: { concurrencies: [1, 4], inputTokens: [128, 512] },
      limits: { maxRequestsPerCell: 2 },
      requestsPerCell: 2,
      fetchImpl: f.fn,
      now: clock.now,
      sleep: noSleep,
    });

    expect(out.results.map((r) => `${r.concurrency}/${r.inputTokens}`))
      .toEqual(['1/128', '1/512', '4/128', '4/512']);
    // 串行：任何时刻在飞请求数不超过当前 cell 的并发数（两 cell 的 4 并发不会叠成 8）
    expect(f.stats().peak).toBeLessThanOrEqual(4);
  });

  it('并发上限夹取：矩阵写 16 也只按 maxConcurrency=8 发', async () => {
    const clock = makeClock();
    const f = batchFetch(clock, { delayMs: 10, tokens: 4 });
    const out = await runBenchmark({
      target: TARGET,
      matrix: { concurrencies: [16], inputTokens: [256] },
      limits: { maxConcurrency: 8, maxRequestsPerCell: 16 },
      requestsPerCell: 16,
      fetchImpl: f.fn,
      now: clock.now,
      sleep: noSleep,
    });

    expect(out.results[0].requestedConcurrency).toBe(16);
    expect(out.results[0].concurrency).toBe(8);
    expect(f.stats().peak).toBe(8);
  });

  it('每组合请求数上限夹取：requestsPerCell=100 也只发 maxRequestsPerCell=5 个', async () => {
    const clock = makeClock();
    const f = batchFetch(clock, { delayMs: 10, tokens: 4 });
    const out = await runBenchmark({
      target: TARGET,
      matrix: { concurrencies: [2], inputTokens: [256] },
      limits: { maxRequestsPerCell: 5 },
      requestsPerCell: 100,
      fetchImpl: f.fn,
      now: clock.now,
      sleep: noSleep,
    });

    expect(out.results[0].requests).toBe(5);
    expect(f.calls).toHaveLength(5);
  });
});

/* ────────────────────────────── 中止语义 ────────────────────────────── */

describe('runBenchmark —— 安全阀与中止', () => {
  it('错误率超限：立刻中止，reason 是中文且带数字，后续组合不跑', async () => {
    const clock = makeClock();
    const f = scriptFetch(clock, [{ kind: 'http', status: 503, delayMs: 10 }]);
    const out = await runBenchmark({
      target: TARGET,
      matrix: { concurrencies: [1, 4], inputTokens: [512] },
      limits: { maxErrorRate: 0.2, maxRequestsPerCell: 4 },
      requestsPerCell: 4,
      fetchImpl: f.fn,
      now: clock.now,
      sleep: noSleep,
    });

    expect(out.aborted).toBe(true);
    expect(out.reason).toContain('错误率');
    expect(out.reason).toContain('超过阈值');
    expect(out.results).toHaveLength(1);
    expect(out.results[0].aborted).toBe(true);
    expect(out.results[0].ok).toBe(false);
    expect(out.results[0].errorKinds.http).toBe(1);
    expect(out.summary.recommended.coresPercent).toBeNull();
  });

  it('p95 TTFT 超限：立刻中止并报出实测值与阈值', async () => {
    const clock = makeClock();
    const f = scriptFetch(clock, [{ delayMs: 42000, tokens: 4 }], { defaultDelay: 42000 });
    const out = await runBenchmark({
      target: TARGET,
      matrix: { concurrencies: [4], inputTokens: [4096] },
      limits: { maxP95TtftMs: 30000, maxRequestsPerCell: 20 },
      requestsPerCell: 8,
      fetchImpl: f.fn,
      now: clock.now,
      sleep: noSleep,
    });

    expect(out.aborted).toBe(true);
    expect(out.reason).toContain('p95 TTFT');
    expect(out.reason).toContain('超过阈值 30000ms');
    expect(out.results[0].ttftMs.p95).toBeGreaterThan(30000);
    expect(out.results).toHaveLength(1);
    expect(f.calls.length).toBeLessThan(8); // 第一波就掐掉了，没跑满
  });

  it('总时长超限：停止后续组合并保留已完成结果', async () => {
    const clock = makeClock();
    const f = scriptFetch(clock, [{ delayMs: 600, tokens: 4 }], { defaultDelay: 600 });
    const out = await runBenchmark({
      target: TARGET,
      matrix: { concurrencies: [1, 4], inputTokens: [512] },
      limits: { maxTotalMs: 1000, maxRequestsPerCell: 4 },
      requestsPerCell: 4,
      fetchImpl: f.fn,
      now: clock.now,
      sleep: noSleep,
    });

    expect(out.aborted).toBe(true);
    expect(out.reason).toContain('总耗时');
    expect(out.results).toHaveLength(1);
    expect(out.results[0].samples).toBeGreaterThan(0); // 已经拿到的样本不丢
    expect(out.summary.best).not.toBeNull();
  });

  it('吞吐超限（防跑飞）：tokens/s 异常大时中止', async () => {
    const clock = makeClock();
    const f = scriptFetch(clock, [{ delayMs: 1, tokens: 500000 }]);
    const out = await runBenchmark({
      target: TARGET,
      matrix: { concurrencies: [1], inputTokens: [128] },
      limits: { maxTokensPerSec: 100000, maxRequestsPerCell: 2 },
      requestsPerCell: 2,
      fetchImpl: f.fn,
      now: clock.now,
      sleep: noSleep,
    });

    expect(out.aborted).toBe(true);
    expect(out.reason).toContain('tokens/s');
    expect(out.reason).toContain('安全上限');
  });

  it('边界：错误率刚好等于 maxErrorRate 不中止', async () => {
    const clock = makeClock();
    // 累计口径：失败必须落在最后一个请求上，5 个里 1 个 = 刚好 0.2
    const f = scriptFetch(clock, [
      { delayMs: 10 }, { delayMs: 10 }, { delayMs: 10 }, { delayMs: 10 },
      { kind: 'http', status: 500, delayMs: 10 },
    ]);
    const out = await runBenchmark({
      target: TARGET,
      matrix: { concurrencies: [1], inputTokens: [512] },
      limits: { maxErrorRate: 0.2, maxRequestsPerCell: 5 },
      requestsPerCell: 5,
      fetchImpl: f.fn,
      now: clock.now,
      sleep: noSleep,
    });

    // 1/5 = 0.2，等于阈值（不超）→ 继续跑完
    expect(out.aborted).toBe(false);
    expect(out.reason).toBeNull();
    expect(out.results[0].errors).toBe(1);
    expect(out.results[0].samples).toBe(4);
    expect(out.results[0].ok).toBe(true);
    expect(out.summary.recommended.coresPercent).toBeGreaterThan(0);
  });

  it('边界：p95 刚好等于 maxP95TtftMs 不中止', async () => {
    const clock = makeClock();
    const f = scriptFetch(clock, [{ delayMs: 1000, tokens: 4 }], { defaultDelay: 1000 });
    const out = await runBenchmark({
      target: TARGET,
      matrix: { concurrencies: [1], inputTokens: [512] },
      limits: { maxP95TtftMs: 1000, maxRequestsPerCell: 4 },
      requestsPerCell: 4,
      fetchImpl: f.fn,
      now: clock.now,
      sleep: noSleep,
    });

    expect(out.aborted).toBe(false);
    expect(out.results[0].samples).toBe(4);
    expect(out.results[0].ttftMs.p95).toBe(1000);
    expect(out.results[0].ok).toBe(true);
  });

  it('非 2xx / 网络错误 / 超时都计入 errors，但不影响其它组合继续', async () => {
    const clock = makeClock();
    // 第 1 个：网络错误；第 2 个：503；其余正常
    const f = scriptFetch(clock, [
      { kind: 'network', delayMs: 10 },
      { kind: 'http', status: 503, delayMs: 10 },
      { delayMs: 10, tokens: 5 },
      { delayMs: 10, tokens: 5 },
    ]);
    const out = await runBenchmark({
      target: TARGET,
      matrix: { concurrencies: [1, 4], inputTokens: [256] },
      limits: { maxErrorRate: 1, maxRequestsPerCell: 4 },
      requestsPerCell: 4,
      fetchImpl: f.fn,
      now: clock.now,
      sleep: noSleep,
    });

    expect(out.aborted).toBe(false);
    expect(out.results).toHaveLength(2); // 第二个组合照跑
    expect(out.results[0].errors).toBe(2);
    expect(out.results[0].errorKinds.network).toBe(1);
    expect(out.results[0].errorKinds.http).toBe(1);
    expect(out.results[0].samples).toBe(2);
    expect(out.ok).toBe(true);
  });

  it('请求超时计入 errors.timeout，并且不会卡死整轮基准', async () => {
    const clock = makeClock();
    const hanging = { fn: async () => new Promise(() => {}) };
    const out = await runBenchmark({
      target: TARGET,
      matrix: { concurrencies: [1, 4], inputTokens: [256] },
      limits: { maxErrorRate: 1, maxRequestsPerCell: 2, maxTotalMs: 600000 },
      requestsPerCell: 2,
      requestTimeoutMs: 5000,
      fetchImpl: hanging.fn,
      now: clock.now,
      sleep: (ms) => { clock.advance(ms); return Promise.resolve(); },
    });

    expect(out.results).toHaveLength(2);
    expect(out.results.every((r) => r.errorKinds.timeout === 2)).toBe(true);
    expect(out.results.every((r) => r.samples === 0)).toBe(true);
    expect(out.ok).toBe(false);
  });

  it('全部失败：ok:false / samples:0 / 百分位为 null（不编造数据）', async () => {
    const clock = makeClock();
    const f = batchFetch(clock, { delayMs: 10, status: 500 });
    const out = await runBenchmark({
      target: TARGET,
      matrix: { concurrencies: [1], inputTokens: [512] },
      limits: { maxErrorRate: 1, maxRequestsPerCell: 3 },
      requestsPerCell: 3,
      fetchImpl: f.fn,
      now: clock.now,
      sleep: noSleep,
    });

    expect(out.ok).toBe(false);
    expect(out.aborted).toBe(false);
    const r = out.results[0];
    expect(r.ok).toBe(false);
    expect(r.samples).toBe(0);
    expect(r.errors).toBe(3);
    expect(r.ttftMs).toEqual({ p50: null, p95: null, max: null });
    expect(r.tokensPerSec).toBe(0);
    expect(out.summary.best).toBeNull();
    expect(out.summary.recommended.memoryMiB).toBeNull();
    expect(out.summary.recommended.notes.join('\n')).toContain('未产出有效样本');
  });
});

/* ─────────────────────────── 反例（入参非法） ─────────────────────────── */

describe('runBenchmark —— 反例：绝不偷偷连真机', () => {
  it('没注入 fetchImpl 直接 ok:false，并说清原因', async () => {
    const out = await runBenchmark({ target: TARGET, matrix: { concurrencies: [1], inputTokens: [512] } });
    expect(out.ok).toBe(false);
    expect(out.aborted).toBe(false);
    expect(out.results).toEqual([]);
    expect(out.reason).toContain('fetchImpl');
  });

  it('target 非法：缺 url / 缺 model', async () => {
    const clock = makeClock();
    const f = batchFetch(clock);
    const noUrl = await runBenchmark({ target: { model: 'm' }, fetchImpl: f.fn, now: clock.now });
    expect(noUrl.ok).toBe(false);
    expect(noUrl.reason).toContain('target.url');
    const noModel = await runBenchmark({ target: { url: 'http://h:8000' }, fetchImpl: f.fn, now: clock.now });
    expect(noModel.ok).toBe(false);
    expect(noModel.reason).toContain('target.model');
  });

  it('空矩阵 / 全非法矩阵：ok:false 且不发任何请求', async () => {
    const clock = makeClock();
    const f = batchFetch(clock);
    const out = await runBenchmark({
      target: TARGET,
      matrix: { concurrencies: [0, -1], inputTokens: ['x'] },
      fetchImpl: f.fn,
      now: clock.now,
      sleep: noSleep,
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('矩阵为空');
    expect(f.calls).toHaveLength(0);
  });
});

/* ─────────────────────────── 推荐配额推导 ─────────────────────────── */

describe('summary.recommended —— 配额反推规则', () => {
  function cell(overrides) {
    return {
      concurrency: 1,
      inputTokens: 512,
      requests: 4,
      samples: 4,
      ok: true,
      ttftMs: { p50: 100, p95: 120, max: 130 },
      tokensPerSec: 100,
      rps: 1,
      errors: 0,
      errorKinds: { http: 0, timeout: 0, network: 0, empty: 0 },
      wallMs: 4000,
      aborted: false,
      startedAtMs: 0,
      ...overrides,
    };
  }

  it('显存：峰值 × 1.25 后向上取整到 512 的整数倍', () => {
    const q1 = recommendQuota({ results: [cell()], peakGpuMemMiB: 5000 });
    expect(q1.memoryMiB).toBe(6656); // 6250 → 13 × 512
    const q2 = recommendQuota({ results: [cell()], peakGpuMemMiB: 4096 });
    expect(q2.memoryMiB).toBe(5120); // 5120 已是 512 整数倍，不再加
    const q3 = recommendQuota({ results: [cell()], peakGpuMemMiB: 20480 });
    expect(q3.memoryMiB).toBe(25600);
    expect(q1.confidence).toBe('measured');
    expect(q1.basis.peakGpuMemMiB).toBe(5000);
  });

  it('算力：取达到目标吞吐（峰值 90%）的最小并发，每 10% 算力对 1 路并发', () => {
    const results = [
      cell({ concurrency: 1, tokensPerSec: 100 }),
      cell({ concurrency: 4, tokensPerSec: 380 }),
      cell({ concurrency: 8, tokensPerSec: 400 }),
    ];
    const q = recommendQuota({ results, best: results[2] });
    expect(q.basis.peakThroughput).toBe(400);
    expect(q.basis.targetThroughput).toBe(360);
    expect(q.basis.minConcurrency).toBe(4); // C=4 的 380 已到 90% 线，C=8 是白给
    expect(q.coresPercent).toBe(40);
  });

  it('算力：吞吐线性上升时要一直加到最高档，且夹在 10-100', () => {
    const results = [
      cell({ concurrency: 1, tokensPerSec: 100 }),
      cell({ concurrency: 4, tokensPerSec: 400 }),
      cell({ concurrency: 8, tokensPerSec: 800 }),
    ];
    const q = recommendQuota({ results, best: results[2] });
    expect(q.basis.minConcurrency).toBe(8);
    expect(q.coresPercent).toBe(80);
    const capped = recommendQuota({
      results: [cell({ concurrency: 32, tokensPerSec: 900 })],
      coresPerConcurrency: 100,
    });
    expect(capped.coresPercent).toBe(100); // 100 是天花板
  });

  it('没有显存数据：memoryMiB=null、confidence=estimated、notes 说清怎么补', async () => {
    const clock = makeClock();
    const f = batchFetch(clock, { delayMs: 20, tokens: 8 });
    const out = await runBenchmark({
      target: TARGET,
      matrix: { concurrencies: [1], inputTokens: [512] },
      limits: { maxRequestsPerCell: 2 },
      requestsPerCell: 2,
      fetchImpl: f.fn,
      now: clock.now,
      sleep: noSleep,
    });

    const rec = out.summary.recommended;
    expect(rec.memoryMiB).toBeNull();
    expect(rec.confidence).toBe('estimated');
    expect(rec.notes.join('\n')).toContain('显存峰值');
    expect(rec.coresPercent).toBeGreaterThan(0); // 算力仍可估
  });

  it('注入 readGpuMem（异步、对象形状）→ measured，且取多轮采样的峰值', async () => {
    const clock = makeClock();
    const f = batchFetch(clock, { delayMs: 20, tokens: 8 });
    const readings = [{ peakMiB: 12000 }, { peakMiB: 18432 }, { peakMiB: 15000 }];
    let i = 0;
    const out = await runBenchmark({
      target: TARGET,
      matrix: { concurrencies: [1], inputTokens: [512] },
      limits: { maxRequestsPerCell: 2 },
      requestsPerCell: 2,
      fetchImpl: f.fn,
      now: clock.now,
      sleep: noSleep,
      readGpuMem: async () => readings[Math.min(i++, readings.length - 1)],
    });

    const rec = out.summary.recommended;
    expect(rec.confidence).toBe('measured');
    expect(rec.basis.peakGpuMemMiB).toBe(18432);
    expect(rec.memoryMiB).toBe(23040); // 18432 × 1.25 = 23040 → 45 × 512，正好对齐
  });

  it('readGpuMem 抛错：不炸基准，降级为 estimated 并把原因写进 notes', async () => {
    const clock = makeClock();
    const f = batchFetch(clock, { delayMs: 20, tokens: 8 });
    const out = await runBenchmark({
      target: TARGET,
      matrix: { concurrences: [1], inputTokens: [512] },
      limits: { maxRequestsPerCell: 2 },
      requestsPerCell: 2,
      fetchImpl: f.fn,
      now: clock.now,
      sleep: noSleep,
      readGpuMem: () => { throw new Error('metrics endpoint 503'); },
    });

    expect(out.ok).toBe(true);
    expect(out.summary.recommended.confidence).toBe('estimated');
    expect(out.summary.recommended.notes.join('\n')).toContain('metrics endpoint 503');
  });
});
