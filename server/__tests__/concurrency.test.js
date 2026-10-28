import { describe, it, expect, vi } from 'vitest';

const { mapLimit, createLimiter } = await import('../concurrency.js');

describe('mapLimit —— 限并发（1000 台扇出的基础）', () => {
  it('结果顺序与输入一致', async () => {
    const out = await mapLimit([3, 1, 2], 2, async (n) => {
      await new Promise(r => setTimeout(r, n * 5));
      return n * 10;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  it('并发数不超过上限', async () => {
    let active = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 50 }, (_, i) => i), 4, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 1));
      active -= 1;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it('空数组 / 非数组安全', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
    expect(await mapLimit(null, 4, async () => 1)).toEqual([]);
  });

  it('limit 非法值退化为 1（串行）', async () => {
    let peak = 0;
    let active = 0;
    await mapLimit([1, 2, 3], 0, async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 1));
      active -= 1;
    });
    expect(peak).toBe(1);
  });

  it('某个任务抛错会向上传播（不静默吞掉）', async () => {
    await expect(mapLimit([1, 2], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    })).rejects.toThrow('boom');
  });

  it('1000 个任务在限并发下全部完成', async () => {
    const items = Array.from({ length: 1000 }, (_, i) => i);
    const out = await mapLimit(items, 16, async (n) => n + 1);
    expect(out).toHaveLength(1000);
    expect(out[999]).toBe(1000);
  });
});

describe('createLimiter —— 信号量', () => {
  it('同时最多执行 limit 个', async () => {
    const limiter = createLimiter(2);
    let active = 0;
    let peak = 0;
    const job = () => limiter.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 5));
      active -= 1;
    });
    await Promise.all([job(), job(), job(), job()]);
    expect(peak).toBe(2);
    expect(limiter.active).toBe(0);
  });

  it('任务抛错后仍能继续排空队列', async () => {
    const limiter = createLimiter(1);
    await expect(limiter.run(async () => { throw new Error('x'); })).rejects.toThrow('x');
    await expect(limiter.run(async () => 'ok')).resolves.toBe('ok');
  });
});
