/**
 * client/src/utils/polling.test.ts
 *
 * 轮询工具的测试。重点是「页面隐藏时暂停、切回来补一次」——
 * 之前所有页面在后台标签页仍按 5s/30s 轮询，白白消耗服务器和带宽。
 */
import { describe, it, expect, vi } from 'vitest';
import { createPoller, isPageVisible } from './polling';

/** 可控的假 document + 定时器 */
function fakeEnv(initialVisibility: 'visible' | 'hidden' = 'visible') {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: initialVisibility,
    hidden: initialVisibility === 'hidden',
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  let nextId = 1;
  const timers = new Map<number, () => void>();
  const fakeSetTimer = (fn: () => void) => {
    const id = nextId++;
    timers.set(id, fn);
    return id;
  };
  const fakeClearTimer = (id: unknown) => { timers.delete(id as number); };
  /** 模拟真实 setTimeout：到点后该定时器即失效，只执行当前挂着的那些 */
  const fire = () => {
    const pending = [...timers.values()];
    timers.clear();
    for (const fn of pending) fn();
  };
  const setVisibility = (v: 'visible' | 'hidden') => {
    doc.visibilityState = v;
    doc.hidden = v === 'hidden';
    for (const fn of [...listeners]) fn();
  };
  return { doc, timers, fire, setVisibility, setTimer: fakeSetTimer, clearTimer: fakeClearTimer, listeners };
}

describe('isPageVisible', () => {
  it('visible → true，hidden → false', () => {
    expect(isPageVisible({ visibilityState: 'visible' } as any)).toBe(true);
    expect(isPageVisible({ visibilityState: 'hidden' } as any)).toBe(false);
  });
  it('没有 document（node/测试环境）默认可见', () => {
    expect(isPageVisible(undefined)).toBe(true);
  });
  it('老浏览器用 hidden 属性兜底', () => {
    expect(isPageVisible({ hidden: true } as any)).toBe(false);
    expect(isPageVisible({ hidden: false } as any)).toBe(true);
  });
});

describe('createPoller —— 可见才轮询', () => {
  it('创建时立即执行一次', () => {
    const env = fakeEnv();
    const fn = vi.fn();
    const p = createPoller(fn, 5000, { ...env, doc: env.doc as any });
    expect(fn).toHaveBeenCalledTimes(1);
    p.stop();
  });

  it('按间隔重复执行', () => {
    const env = fakeEnv();
    const fn = vi.fn();
    const p = createPoller(fn, 5000, { ...env, doc: env.doc as any });
    env.fire();
    env.fire();
    expect(fn).toHaveBeenCalledTimes(3);
    p.stop();
  });

  it('页面隐藏后停止定时器（不再继续发请求）', () => {
    const env = fakeEnv();
    const fn = vi.fn();
    const p = createPoller(fn, 5000, { ...env, doc: env.doc as any });
    expect(fn).toHaveBeenCalledTimes(1);
    env.setVisibility('hidden');
    expect(env.timers.size).toBe(0); // 定时器被清掉
    env.fire(); // 就算有残留也不该跑
    expect(fn).toHaveBeenCalledTimes(1);
    p.stop();
  });

  it('切回可见：立刻补一次，然后恢复定时', () => {
    const env = fakeEnv('hidden');
    const fn = vi.fn();
    const p = createPoller(fn, 5000, { ...env, doc: env.doc as any });
    // 初始隐藏 → 不执行
    expect(fn).toHaveBeenCalledTimes(0);
    env.setVisibility('visible');
    expect(fn).toHaveBeenCalledTimes(1); // 补跑
    expect(env.timers.size).toBe(1);     // 定时恢复
    env.fire();
    expect(fn).toHaveBeenCalledTimes(2);
    p.stop();
  });

  it('stop 之后彻底停下', () => {
    const env = fakeEnv();
    const fn = vi.fn();
    const p = createPoller(fn, 5000, { ...env, doc: env.doc as any });
    p.stop();
    expect(p.isRunning()).toBe(false);
    env.fire();
    expect(fn).toHaveBeenCalledTimes(1); // 只有创建时那一次
    expect(env.listeners.size).toBe(0);   // 监听已解绑
  });

  it('回调抛异常不会中断轮询', () => {
    const env = fakeEnv();
    const fn = vi.fn(() => { throw new Error('boom'); });
    const p = createPoller(fn, 5000, { ...env, doc: env.doc as any });
    env.fire();
    expect(fn).toHaveBeenCalledTimes(2);
    p.stop();
  });

  it('异步回调 reject 被吞掉，不影响后续', async () => {
    const env = fakeEnv();
    const fn = vi.fn(async () => { throw new Error('async boom'); });
    const p = createPoller(fn as any, 5000, { ...env, doc: env.doc as any });
    await Promise.resolve();
    env.fire();
    expect(fn).toHaveBeenCalledTimes(2);
    p.stop();
  });

  it('间隔有下限（避免误传 0 导致死循环）', () => {
    const env = fakeEnv();
    const fn = vi.fn();
    const p = createPoller(fn, 0, { ...env, doc: env.doc as any });
    expect(fn).toHaveBeenCalledTimes(1);
    p.stop();
  });

  it('可以关掉「隐藏暂停」', () => {
    const env = fakeEnv();
    const fn = vi.fn();
    const p = createPoller(fn, 5000, { ...env, doc: env.doc as any, pauseWhenHidden: false });
    env.setVisibility('hidden');
    env.fire();
    expect(fn).toHaveBeenCalledTimes(2);
    p.stop();
  });
});
