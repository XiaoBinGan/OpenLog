import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const remote = await import('../remote.js');
const {
  nextRetryAt, runReconnectPass, _getRetryState, _setServersForTest, _retryTiming,
} = remote;
const { RETRY_BASE_MS, RETRY_MAX_MS } = _retryTiming;

function server(id, overrides = {}) {
  return {
    id,
    name: `srv-${id}`,
    host: '10.0.0.1',
    port: 22,
    username: 'u',
    password: 'p',
    status: 'error',
    ...overrides,
  };
}

describe('nextRetryAt —— 指数退避', () => {
  it('第 1 次 5s，之后翻倍', () => {
    const now = 1_000_000;
    expect(nextRetryAt(1, now) - now).toBe(RETRY_BASE_MS);          // 5s
    expect(nextRetryAt(2, now) - now).toBe(RETRY_BASE_MS * 2);      // 10s
    expect(nextRetryAt(3, now) - now).toBe(RETRY_BASE_MS * 4);      // 20s
    expect(nextRetryAt(4, now) - now).toBe(RETRY_BASE_MS * 8);      // 40s
  });

  it('封顶 5 分钟，不会无限增长', () => {
    const now = 0;
    expect(nextRetryAt(20, now)).toBe(RETRY_MAX_MS);
    expect(nextRetryAt(100, now)).toBe(RETRY_MAX_MS);
  });

  it('count 非法值按第 1 次处理', () => {
    expect(nextRetryAt(0, 0)).toBe(RETRY_BASE_MS);
    expect(nextRetryAt(-5, 0)).toBe(RETRY_BASE_MS);
  });
});

describe('runReconnectPass —— 自动重连', () => {
  beforeEach(() => _setServersForTest([]));
  afterEach(() => _setServersForTest([]));

  it('只重试 error 状态的机器，不碰 connected/disconnected', async () => {
    _setServersForTest([
      server('a', { status: 'error' }),
      server('b', { status: 'connected' }),
      server('c', { status: 'disconnected' }),
    ]);
    const tried = [];
    const results = await runReconnectPass(Date.now(), async (id) => { tried.push(id); });
    expect(tried).toEqual(['a']);
    expect(results).toEqual([{ id: 'a', name: 'srv-a', ok: true }]);
  });

  it('成功后清空重试状态', async () => {
    _setServersForTest([server('a')]);
    await runReconnectPass(Date.now(), async () => { throw new Error('ECONNREFUSED'); });
    expect(_getRetryState('a')).toBeTruthy();

    await runReconnectPass(Date.now() + 10_000, async () => { /* 成功 */ });
    expect(_getRetryState('a')).toBeNull();
  });

  it('失败后记录次数与下次时间，下次时间未到不重试', async () => {
    _setServersForTest([server('a')]);
    const now = 1_000_000;
    await runReconnectPass(now, async () => { throw new Error('EHOSTUNREACH'); });

    const st = _getRetryState('a');
    expect(st.count).toBe(1);
    expect(st.nextAt).toBe(now + RETRY_BASE_MS);

    // 未到时间：不再尝试
    const tried = [];
    const r2 = await runReconnectPass(now + 1000, async (id) => { tried.push(id); });
    expect(tried).toEqual([]);
    expect(r2).toEqual([]);

    // 到时间：再试，次数 +1
    await runReconnectPass(now + RETRY_BASE_MS, async () => { throw new Error('EHOSTUNREACH'); });
    expect(_getRetryState('a').count).toBe(2);
  });

  it('失败原因会写进结果，供日志/UI 使用', async () => {
    _setServersForTest([server('a')]);
    const results = await runReconnectPass(Date.now(), async () => { throw new Error('All configured authentication methods failed'); });
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain('authentication');
  });

  it('多台同时失败互不影响（各自独立退避）', async () => {
    _setServersForTest([server('a'), server('b')]);
    const now = 5000;
    await runReconnectPass(now, async (id) => { throw new Error(id === 'a' ? 'A-down' : 'B-down'); });
    expect(_getRetryState('a').count).toBe(1);
    expect(_getRetryState('b').count).toBe(1);
    expect(_getRetryState('a').nextAt).toBe(now + RETRY_BASE_MS);
  });

  it('没有 error 机器时不做事', async () => {
    _setServersForTest([server('a', { status: 'connected' })]);
    const tried = [];
    const results = await runReconnectPass(Date.now(), async (id) => { tried.push(id); });
    expect(tried).toEqual([]);
    expect(results).toEqual([]);
  });

  it('一台成功不影响另一台继续重试', async () => {
    _setServersForTest([server('a'), server('b')]);
    const now = 1000;
    const results = await runReconnectPass(now, async (id) => {
      if (id === 'a') return;
      throw new Error('b down');
    });
    expect(results.find(r => r.id === 'a').ok).toBe(true);
    expect(results.find(r => r.id === 'b').ok).toBe(false);
    expect(_getRetryState('a')).toBeNull();
    expect(_getRetryState('b').count).toBe(1);
  });
});

describe('getServers —— 暴露失败原因与重试信息', () => {
  it('连不上的机器返回 lastError / retryCount，UI 才能说清原因', async () => {
    _setServersForTest([{
      ...server('a'),
      lastError: 'connect ECONNREFUSED 100.100.179.160:40022',
      lastErrorAt: '2026-10-27T02:00:00.000Z',
    }]);
    await runReconnectPass(Date.now(), async () => { throw new Error('ECONNREFUSED'); });
    const [s] = remote.getServers();
    expect(s.lastError).toContain('ECONNREFUSED');
    expect(s.retryCount).toBe(1);
    expect(typeof s.nextRetryAt).toBe('number');
  });
});
