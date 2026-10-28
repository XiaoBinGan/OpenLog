import { describe, it, expect, vi } from 'vitest';

const { createStatsScheduler } = await import('../stats-scheduler.js');

/** 造一个可控的调度器 */
function makeScheduler(overrides = {}) {
  const servers = overrides.servers ?? [
    { id: 's1', name: '机器1', status: 'connected' },
    { id: 's2', name: '机器2', status: 'connected' },
    { id: 's3', name: '机器3', status: 'disconnected' },
  ];
  const getStats = overrides.getStats ?? vi.fn(async (id) => ({ cpu: 10, gpus: [{ index: 0, util: 50 }], id }));
  const getMfu = overrides.getMfu ?? vi.fn(async (id) => ({ available: true, id }));
  const scheduler = createStatsScheduler({
    getServers: () => servers,
    getStats,
    getMfu,
    concurrency: overrides.concurrency ?? 4,
    intervalMs: overrides.intervalMs ?? 1000,
    mfuIntervalMs: overrides.mfuIntervalMs ?? 2000,
    onSnapshot: overrides.onSnapshot,
    now: overrides.now,
  });
  return { scheduler, servers, getStats, getMfu };
}

describe('createStatsScheduler —— 服务端集中采集', () => {
  it('一轮只采已连接的服务器（不采 disconnected）', async () => {
    const { scheduler, getStats } = makeScheduler();
    const res = await scheduler.pass();
    expect(res.total).toBe(2);
    expect(res.ok).toBe(2);
    expect(getStats).toHaveBeenCalledTimes(2);
    expect(getStats).not.toHaveBeenCalledWith('s3');
  });

  it('并发受限（不会一次打完所有服务器）', async () => {
    let active = 0;
    let peak = 0;
    const servers = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, name: `n${i}`, status: 'connected' }));
    const { scheduler } = makeScheduler({
      servers,
      concurrency: 5,
      getStats: async () => {
        active += 1; peak = Math.max(peak, active);
        await new Promise(r => setTimeout(r, 2));
        active -= 1;
        return { gpus: [] };
      },
    });
    await scheduler.pass();
    expect(peak).toBeLessThanOrEqual(5);
    expect(scheduler.cacheSize).toBe(40);
  });

  it('单台失败只影响该台（statsError 记录，其余成功）', async () => {
    const { scheduler } = makeScheduler({
      getStats: async (id) => {
        if (id === 's2') throw new Error('SSH 断开');
        return { gpus: [] };
      },
    });
    const res = await scheduler.pass();
    expect(res.ok).toBe(1);
    expect(res.failed).toBe(1);
    const snap = scheduler.snapshot();
    const s2 = snap.servers.find(x => x.serverId === 's2');
    expect(s2.statsError).toContain('SSH 断开');
    expect(s2.stats).toBeNull();
    expect(snap.servers.find(x => x.serverId === 's1').stats).toEqual({ gpus: [] });
  });

  it('快照包含全部已连接服务器与 meta', async () => {
    const { scheduler } = makeScheduler();
    await scheduler.pass();
    const snap = scheduler.snapshot();
    expect(snap.servers).toHaveLength(2);
    expect(snap.meta.total).toBe(2);
    expect(snap.meta.concurrency).toBe(4);
    expect(snap.meta.lastPass.ok).toBe(2);
  });

  it('缓存新鲜度：刚采过返回新鲜，超过阈值返回不新鲜', async () => {
    let t = 1000;
    const { scheduler } = makeScheduler({ now: () => t });
    await scheduler.pass();
    expect(scheduler.isFresh('s1', 5000)).toBe(true);
    t += 6000;
    expect(scheduler.isFresh('s1', 5000)).toBe(false);
  });

  it('ensure 只补采不新鲜的机器', async () => {
    let t = 1000;
    const { scheduler, getStats } = makeScheduler({ now: () => t });
    await scheduler.pass();
    getStats.mockClear();
    await scheduler.ensure(['s1', 's2'], 5000);
    expect(getStats).not.toHaveBeenCalled();      // 都新鲜
    t += 10_000;
    await scheduler.ensure(['s1'], 5000);
    expect(getStats).toHaveBeenCalledTimes(1);    // 只有 s1 过期
    expect(getStats).toHaveBeenCalledWith('s1');
  });

  it('不重叠执行：上一轮没跑完时再调 pass 直接返回', async () => {
    const pending = [];
    const { scheduler } = makeScheduler({
      getStats: () => new Promise((resolve) => { pending.push(resolve); }),
    });
    const first = scheduler.pass();          // 挂起，未完成
    const second = await scheduler.pass();   // 应立刻返回（不重复采集）
    expect(second).toBeNull();
    // 放行所有挂起的采集
    while (pending.length) pending.shift()({ gpus: [] });
    await first;
  });

  it('MFU 只采「stats 里有 GPU」的机器', async () => {
    const { scheduler, getMfu } = makeScheduler({
      getStats: async (id) => ({ gpus: id === 's1' ? [{ index: 0 }] : [] }),
    });
    await scheduler.pass();
    await scheduler.mfuPass();
    expect(getMfu).toHaveBeenCalledTimes(1);
    expect(getMfu).toHaveBeenCalledWith('s1');
    expect(scheduler.snapshot().servers.find(s => s.serverId === 's1').mfu).toEqual({ available: true, id: 's1' });
  });

  it('一轮耗时超过间隔 1.5 倍时自动放宽间隔', async () => {
    const { scheduler } = makeScheduler({
      intervalMs: 10,
      getStats: async () => { await new Promise(r => setTimeout(r, 40)); return { gpus: [] }; },
    });
    await scheduler.pass();
    expect(scheduler.effectiveInterval).toBeGreaterThan(10);
  });

  it('空闲（没有已连接服务器）时不报错', async () => {
    const { scheduler } = makeScheduler({ servers: [] });
    const res = await scheduler.pass();
    expect(res.total).toBe(0);
    expect(scheduler.snapshot().servers).toEqual([]);
  });

  it('onSnapshot 回调每轮触发（供 WS 广播）', async () => {
    const onSnapshot = vi.fn();
    const { scheduler } = makeScheduler({ onSnapshot });
    await scheduler.pass();
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(onSnapshot.mock.calls[0][0].servers).toHaveLength(2);
  });
});
