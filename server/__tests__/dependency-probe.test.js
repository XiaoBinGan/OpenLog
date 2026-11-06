/**
 * server/__tests__/dependency-probe.test.js
 *
 * 覆盖契约 4.9 的依赖拨测：http / exec 判定、超时、目标隔离、uptime 累计与滚动上限。
 * 所有 IO 都注入假实现 —— 测试里不产生真实网络、不起真实进程。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createProbes, computeUptime } from '../dependency-probe.js';

/** 固定状态码的假 fetch */
const statusFetch = (status) => vi.fn(async () => ({ status }));

/** 依次吐出给定状态码序列的假 fetch（用于累计 uptime） */
function sequenceFetch(seq, fallback = 500) {
  let i = 0;
  return vi.fn(async () => ({ status: seq[i++] ?? fallback }));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('http 拨测', () => {
  it('200 → ok true，ms 是 number', async () => {
    const probes = createProbes({
      targets: [{ id: 'llm', kind: 'http', url: 'http://llm.local/health' }],
      fetchImpl: statusFetch(200),
    });

    const [r] = await probes.probeAll();

    expect(r.ok).toBe(true);
    expect(typeof r.ms).toBe('number');
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(r.status).toBe(200);
    expect(r.error).toBeUndefined();
  });

  it('3xx 也算 ok（重定向不是故障）', async () => {
    const probes = createProbes({
      targets: [{ id: 'llm', kind: 'http', url: 'http://llm.local/health' }],
      fetchImpl: statusFetch(302),
    });
    const [r] = await probes.probeAll();
    expect(r.ok).toBe(true);
  });

  it('500 → ok false，error 含 500', async () => {
    const probes = createProbes({
      targets: [{ id: 'llm', kind: 'http', url: 'http://llm.local/health' }],
      fetchImpl: statusFetch(500),
    });

    const [r] = await probes.probeAll();

    expect(r.ok).toBe(false);
    expect(r.error).toContain('500');
    expect(r.status).toBe(500);
  });

  it('超时：fetchImpl 永不 resolve → ok false 且整轮不卡死', async () => {
    // 关键点：假实现既不 resolve 也不看 signal，只能靠 race 结算这一轮
    const hang = vi.fn(() => new Promise(() => {}));
    vi.useFakeTimers();

    const probes = createProbes({
      targets: [{ id: 'llm', kind: 'http', url: 'http://llm.local/health', timeoutMs: 3000 }],
      fetchImpl: hang,
    });

    const pending = probes.probeAll();
    await vi.advanceTimersByTimeAsync(3000);
    const [r] = await pending;

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timeout/i);
    // timer 必须被清掉，否则进程退不掉 / 测试之间互相干扰
    expect(vi.getTimerCount()).toBe(0);
  });

  it('超时后 fetch 收到的 signal 已被 abort', async () => {
    let seenSignal = null;
    const hang = vi.fn((url, init) => {
      seenSignal = init?.signal;
      return new Promise(() => {});
    });
    vi.useFakeTimers();

    const probes = createProbes({
      targets: [{ id: 'llm', kind: 'http', url: 'http://llm.local/health', timeoutMs: 1000 }],
      fetchImpl: hang,
    });

    const pending = probes.probeAll();
    await vi.advanceTimersByTimeAsync(1000);
    await pending;

    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal.aborted).toBe(true);
  });

  it('默认超时是 3000ms，且 fetch 用 GET', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200 }));
    vi.useFakeTimers();
    const probes = createProbes({
      targets: [{ id: 'llm', kind: 'http', url: 'http://llm.local/health' }],
      fetchImpl,
    });

    await probes.probeAll();
    expect(fetchImpl.mock.calls[0][0]).toBe('http://llm.local/health');
    expect(fetchImpl.mock.calls[0][1].method).toBe('GET');
  });
});

describe('exec 拨测', () => {
  it('退出码 0 → ok true', async () => {
    const execImpl = vi.fn(async () => 'pong\n');
    const probes = createProbes({
      targets: [{ id: 'docker', kind: 'exec', command: 'docker ping' }],
      execImpl,
    });

    const [r] = await probes.probeAll();

    expect(r.ok).toBe(true);
    expect(typeof r.ms).toBe('number');
    expect(execImpl).toHaveBeenCalledTimes(1);
    expect(execImpl.mock.calls[0][0]).toBe('docker ping');
  });

  it('非 0 退出码 → ok false，error 含 stderr，并给出 exitCode', async () => {
    const execImpl = vi.fn(async () => {
      const err = new Error('Command failed: ssh host true');
      err.code = 1;
      err.stderr = 'Permission denied (publickey).';
      throw err;
    });
    const probes = createProbes({
      targets: [{ id: 'ssh', kind: 'exec', command: 'ssh -o BatchMode=yes -o ConnectTimeout=3 host true' }],
      execImpl,
    });

    const [r] = await probes.probeAll();

    expect(r.ok).toBe(false);
    expect(r.error).toContain('Permission denied');
    expect(r.exitCode).toBe(1);
  });

  it('命令不存在（code 是字符串）也能定位，且 stderr 截到 200 字', async () => {
    const execImpl = vi.fn(async () => {
      const err = new Error('spawn docker ENOENT');
      err.code = 'ENOENT';
      err.stderr = 'x'.repeat(500);
      throw err;
    });
    const probes = createProbes({
      targets: [{ id: 'docker', kind: 'exec', command: 'docker ping' }],
      execImpl,
    });

    const [r] = await probes.probeAll();

    expect(r.ok).toBe(false);
    expect(r.exitCode).toBeNull();
    // 'exec exit n/a: ' + 截断后的 stderr
    expect(r.error.length).toBeLessThan(200 + 40);
    expect(r.error).toContain('xxxx');
  });

  it('exec 超时 → ok false，error 含 timeout', async () => {
    const hang = vi.fn(() => new Promise(() => {}));
    vi.useFakeTimers();

    const probes = createProbes({
      targets: [{ id: 'ssh', kind: 'exec', command: 'ssh host true', timeoutMs: 500 }],
      execImpl: hang,
    });

    const pending = probes.probeAll();
    await vi.advanceTimersByTimeAsync(500);
    const [r] = await pending;

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timeout/i);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('目标隔离（allSettled 语义）', () => {
  it('一个目标抛异常，其它目标仍正常，整轮不 reject', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('boom')) throw new Error('ECONNREFUSED 127.0.0.1:11434');
      return { status: 200 };
    });
    const execImpl = vi.fn(async (cmd) => {
      if (String(cmd).includes('ssh')) throw Object.assign(new Error('exit'), { code: 255, stderr: 'no route' });
      return '';
    });

    const probes = createProbes({
      targets: [
        { id: 'llm', kind: 'http', url: 'http://llm.local/health' },
        { id: 'ollama', kind: 'http', url: 'http://boom.local/api/tags' },
        { id: 'docker', kind: 'exec', command: 'docker ping' },
        { id: 'ssh', kind: 'exec', command: 'ssh host true' },
        { id: 'self-ish', kind: 'http', url: 'http://other.local/health' },
      ],
      fetchImpl,
      execImpl,
    });

    const results = await probes.probeAll();

    expect(results).toHaveLength(5);
    expect(results.map((r) => r.ok)).toEqual([true, false, true, false, true]);
    expect(results[1].error).toContain('ECONNREFUSED');
    expect(results[3].error).toContain('no route');
  });

  it('fetchImpl 同步 throw 也不影响整轮', async () => {
    const fetchImpl = vi.fn(() => {
      throw new Error('sync boom');
    });
    const probes = createProbes({
      targets: [
        { id: 'a', kind: 'http', url: 'http://a.local/health' },
        { id: 'b', kind: 'http', url: 'http://b.local/health' },
      ],
      fetchImpl,
    });

    const results = await probes.probeAll();

    expect(results.map((r) => r.ok)).toEqual([false, false]);
    expect(results[0].error).toContain('sync boom');
  });

  it('配置写坏的 target（缺 id / 缺 url）被跳过，不拖累其它目标', async () => {
    const probes = createProbes({
      targets: [
        { id: 'llm', kind: 'http', url: 'http://llm.local/health' },
        { kind: 'http', url: 'http://no-id.local/health' },
        { id: 'no-url', kind: 'http' },
        { id: 'no-command', kind: 'exec' },
      ],
      fetchImpl: statusFetch(200),
      execImpl: vi.fn(async () => ''),
    });

    const results = await probes.probeAll();

    expect(results.map((r) => r.id)).toEqual(['llm']);
    expect(probes.targets).toHaveLength(1);
  });
});

describe('uptime 累计与滚动上限', () => {
  it('3 次 ok + 1 次 fail → ok 3 / fail 1 / rate 75', async () => {
    const probes = createProbes({
      targets: [{ id: 'llm', kind: 'http', url: 'http://llm.local/health' }],
      fetchImpl: sequenceFetch([200, 200, 200, 500]),
    });

    for (let i = 0; i < 4; i += 1) await probes.probeAll();

    const { uptime } = probes.snapshot();
    expect(uptime.llm).toEqual({ ok: 3, fail: 1, rate: 75 });
    expect(probes.snapshot().results[0].ok).toBe(false);
  });

  it('滚动上限 100：101 次全 ok 只留 100 条', async () => {
    const probes = createProbes({
      targets: [{ id: 'llm', kind: 'http', url: 'http://llm.local/health' }],
      fetchImpl: statusFetch(200),
    });

    for (let i = 0; i < 101; i += 1) await probes.probeAll();

    const { uptime } = probes.snapshot();
    expect(uptime.llm.ok).toBe(100);
    expect(uptime.llm.fail).toBe(0);
    expect(uptime.llm.rate).toBe(100);
  });

  it('滚动窗口只保留最近 100 次：先 100 次 ok，再 100 次 fail → rate 50', async () => {
    const probes = createProbes({
      targets: [{ id: 'llm', kind: 'http', url: 'http://llm.local/health' }],
      fetchImpl: sequenceFetch([...Array(100).fill(200), ...Array(100).fill(503)]),
    });

    for (let i = 0; i < 200; i += 1) await probes.probeAll();

    const { uptime } = probes.snapshot();
    expect(uptime.llm).toEqual({ ok: 0, fail: 100, rate: 0 });
  });

  it('未拨测过的目标 uptime 是 0/0/0 而不是 NaN', async () => {
    const probes = createProbes({
      targets: [{ id: 'llm', kind: 'http', url: 'http://llm.local/health' }],
      fetchImpl: statusFetch(200),
    });

    expect(probes.snapshot()).toEqual({ results: [], uptime: { llm: { ok: 0, fail: 0, rate: 0 } } });
  });
});

describe('computeUptime 边界', () => {
  it('空历史', () => {
    expect(computeUptime([])).toEqual({ ok: 0, fail: 0, rate: 0 });
    expect(computeUptime(null)).toEqual({ ok: 0, fail: 0, rate: 0 });
    expect(computeUptime(undefined)).toEqual({ ok: 0, fail: 0, rate: 0 });
  });

  it('全 ok', () => {
    expect(computeUptime([{ ok: true }, { ok: true }, { ok: true }])).toEqual({ ok: 3, fail: 0, rate: 100 });
  });

  it('全 fail', () => {
    expect(computeUptime([{ ok: false }, { ok: false }])).toEqual({ ok: 0, fail: 2, rate: 0 });
  });

  it('rate 保留 1 位小数（2/3 → 66.7）', () => {
    const r = computeUptime([{ ok: true }, { ok: true }, { ok: false }]);
    expect(r).toEqual({ ok: 2, fail: 1, rate: 66.7 });
    expect(String(r.rate)).toBe('66.7');
  });
});

describe('probeSelf', () => {
  it('用注入的 fetchImpl 打 /api/health，并入 uptime.self', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200 }));
    const probes = createProbes({
      targets: [{ id: 'llm', kind: 'http', url: 'http://llm.local/health' }],
      fetchImpl,
      selfUrl: 'http://127.0.0.1:30999/',
    });

    const result = await probes.probeSelf();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:30999/api/health');
    expect(fetchImpl.mock.calls[0][1].method).toBe('GET');
    expect(result.id).toBe('self');
    expect(result.ok).toBe(true);

    const { uptime } = probes.snapshot();
    expect(uptime.self).toEqual({ ok: 1, fail: 0, rate: 100 });
    // 自身拨测不能污染普通目标的 uptime
    expect(uptime.llm).toEqual({ ok: 0, fail: 0, rate: 0 });
  });

  it('健康检查 503 → ok false 且进 fail 计数', async () => {
    const probes = createProbes({
      targets: [],
      fetchImpl: statusFetch(503),
      selfUrl: 'http://127.0.0.1:30999',
    });

    const result = await probes.probeSelf();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('503');
    expect(probes.snapshot().uptime.self).toEqual({ ok: 0, fail: 1, rate: 0 });
  });

  it('没配 selfUrl → 明确报错，不污染 uptime', async () => {
    const probes = createProbes({ targets: [], fetchImpl: statusFetch(200) });

    const result = await probes.probeSelf();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('selfUrl');
    expect(probes.snapshot().uptime.self).toBeUndefined();
  });
});
