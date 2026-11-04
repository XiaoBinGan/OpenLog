/**
 * server/__tests__/short-cache.test.js
 *
 * `/api/docker/containers` 短缓存（3 秒）的测试。
 * 实测：该接口 224~322ms / 73KB（82 容器），顶栏/Docker 页/远程页/多开标签页会同时拉，
 * 缓存把并发尖峰合并成一次真实查询。
 */
import { describe, it, expect, vi } from 'vitest';
import { createShortCache, cached } from '../short-cache.js';

function fakeClock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('createShortCache —— 基础行为', () => {
  it('未命中返回 undefined，写入后可命中', () => {
    const clock = fakeClock();
    const c = createShortCache({ ttlMs: 3000, now: clock.now });
    expect(c.get('k')).toBeUndefined();
    c.set('k', { a: 1 });
    expect(c.get('k')).toEqual({ a: 1 });
  });

  it('过期后不再命中（TTL 生效）', () => {
    const clock = fakeClock();
    const c = createShortCache({ ttlMs: 3000, now: clock.now });
    c.set('k', 1);
    clock.advance(2999);
    expect(c.get('k')).toBe(1);
    clock.advance(2);
    expect(c.get('k')).toBeUndefined();
  });

  it('不同 key 互不影响', () => {
    const clock = fakeClock();
    const c = createShortCache({ ttlMs: 3000, now: clock.now });
    c.set('a', 1);
    c.set('b', 2);
    expect(c.get('a')).toBe(1);
    expect(c.get('b')).toBe(2);
  });

  it('invalidate 单个 key / 全部', () => {
    const clock = fakeClock();
    const c = createShortCache({ ttlMs: 3000, now: clock.now });
    c.set('a', 1);
    c.set('b', 2);
    c.invalidate('a');
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBe(2);
    c.invalidate();
    expect(c.get('b')).toBeUndefined();
  });

  it('容量上限：超了丢最老的', () => {
    const clock = fakeClock();
    const c = createShortCache({ ttlMs: 3000, now: clock.now, maxEntries: 2 });
    c.set('a', 1);
    clock.advance(10);
    c.set('b', 2);
    clock.advance(10);
    c.set('c', 3);
    expect(c.stats().size).toBe(2);
    expect(c.get('a')).toBeUndefined();
    expect(c.get('c')).toBe(3);
  });

  it('统计命中/未命中次数', () => {
    const clock = fakeClock();
    const c = createShortCache({ ttlMs: 3000, now: clock.now });
    c.get('x');           // miss
    c.set('x', 1);
    c.get('x');           // hit
    c.get('x');           // hit
    const s = c.stats();
    expect(s.hits).toBe(2);
    expect(s.misses).toBe(1);
  });

  it('ttl 非法值有下限（不能配成 0 导致完全失效）', () => {
    const c = createShortCache({ ttlMs: 0 });
    expect(c.stats().ttlMs).toBeGreaterThanOrEqual(100);
  });
});

describe('cached() —— 包装异步取数', () => {
  it('第一次调用 loader，第二次命中缓存不再调用', async () => {
    const clock = fakeClock();
    const c = createShortCache({ ttlMs: 3000, now: clock.now });
    const loader = vi.fn(async () => ({ v: 1 }));
    expect(await cached(c, 'k', loader)).toEqual({ v: 1 });
    expect(await cached(c, 'k', loader)).toEqual({ v: 1 });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('过期后会重新调用 loader', async () => {
    const clock = fakeClock();
    const c = createShortCache({ ttlMs: 3000, now: clock.now });
    const loader = vi.fn(async () => ({ v: Date.now() }));
    await cached(c, 'k', loader);
    clock.advance(4000);
    await cached(c, 'k', loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('loader 抛错不写缓存（失败立刻可见，不做负缓存）', async () => {
    const clock = fakeClock();
    const c = createShortCache({ ttlMs: 3000, now: clock.now });
    const loader = vi.fn(async () => { throw new Error('boom'); });
    await expect(cached(c, 'k', loader)).rejects.toThrow('boom');
    expect(c.get('k')).toBeUndefined();
    // 第二次仍会重试（不是缓存了错误）
    await expect(cached(c, 'k', loader)).rejects.toThrow('boom');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('loader 返回 null/undefined 不写缓存', async () => {
    const clock = fakeClock();
    const c = createShortCache({ ttlMs: 3000, now: clock.now });
    const loader = vi.fn(async () => null);
    await cached(c, 'k', loader);
    await cached(c, 'k', loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe('接线 —— 容器列表接口用了短缓存', () => {
  it('docker 路由里创建缓存并在容器操作后失效', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'routes', 'docker.js'), 'utf8');
    expect(src).toContain('createShortCache');
    expect(src).toContain("cached(containersCache, 'containers'");
    expect(src).toContain("containersCache.invalidate('containers')");
    // 支持强制刷新（排查时不想等 3 秒）
    expect(src).toContain("refresh === '1'");
  });
});
