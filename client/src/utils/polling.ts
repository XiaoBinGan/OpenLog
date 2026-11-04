/**
 * client/src/utils/polling.ts —— 统一的轮询工具
 *
 * 现状问题（实测）：
 *   - GlobalStatusBar 每 5s 拉一次设备状态、DeviceContext 每 30s、RemoteContext 每 30s
 *     又每 10s 拉一次远程统计、GPU 页每 30s、Monitor 页每 5s…… 后台标签页也照跑；
 *   - 一个浏览器窗口开着 3 个标签页，服务器就要承受 3 倍的轮询压力；
 *   - 页面不可见时刷新毫无意义（用户看不见），纯属浪费带宽和 CPU。
 *
 * 这里提供：
 *   - `shouldPoll()`：页面是否可见（禁用状态下不轮询）
 *   - `createPoller(fn, ms, opts)`：可见时按间隔跑、不可见时暂停、变可见立刻补一次
 *   - `usePolling(cb, ms, deps)` —— 见 usePolling.ts（放单独文件，避免本文件依赖 React）
 */

/** 页面是否可见（headless/node 环境下没有 document，默认 true 便于测试） */
export function isPageVisible(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): boolean {
  if (!doc) return true;
  if (typeof doc.visibilityState === 'string') return doc.visibilityState !== 'hidden';
  // 老浏览器兜底
  return !(doc as unknown as { hidden?: boolean }).hidden;
}

export interface Poller {
  /** 主动停止 */
  stop: () => void;
  /** 立即执行一次（不受间隔限制） */
  trigger: () => void;
  /** 当前是否在跑 */
  isRunning: () => boolean;
  /** 已执行的轮询次数（测试用） */
  ticks: () => number;
}

export interface PollerOptions {
  /** 是否在页面不可见时暂停（默认 true） */
  pauseWhenHidden?: boolean;
  /** 立即执行一次（默认 true） */
  immediate?: boolean;
  /** 目标 document（测试注入用） */
  doc?: Document;
  /** 定时器实现（测试注入用） */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
}

/**
 * 创建「可见才跑」的轮询器。
 *
 * - 页面隐藏：清掉定时器（省电省流量）
 * - 页面可见：立刻补跑一次（用户切回来看到的是最新数据），然后恢复定时
 * - 回调里抛异常不会中断轮询
 *
 * @param fn 每次轮询要执行的操作（可以是异步）
 * @param intervalMs 间隔毫秒
 */
export function createPoller(
  fn: () => void | Promise<void>,
  intervalMs: number,
  opts: PollerOptions = {},
): Poller {
  const pauseWhenHidden = opts.pauseWhenHidden !== false;
  const immediate = opts.immediate !== false;
  const doc = opts.doc ?? (typeof document === 'undefined' ? undefined : document);
  const setTimer = opts.setTimer ?? ((f: () => void, ms: number) => setTimeout(f, ms));
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const ms = Math.max(250, Number(intervalMs) || 5000);

  let handle: unknown = null;
  let stopped = false;
  let tickCount = 0;

  const run = () => {
    if (stopped) return;
    if (pauseWhenHidden && !isPageVisible(doc)) return;
    tickCount += 1;
    try {
      const result = fn();
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch(() => { /* 单次失败不影响下一次 */ });
      }
    } catch { /* 同步异常也不打断轮询 */ }
  };

  const schedule = () => {
    if (stopped || handle !== null) return;
    handle = setTimer(() => {
      handle = null;
      if (stopped) return;
      run();
      schedule();
    }, ms);
  };

  const onVisibility = () => {
    if (stopped) return;
    if (isPageVisible(doc)) {
      // 切回来：立刻补一次，再恢复定时
      run();
      schedule();
    } else {
      // 切走：停掉定时器
      if (handle !== null) { clearTimer(handle); handle = null; }
    }
  };

  if (immediate) run();
  schedule();
  // 只有需要「隐藏时暂停」才监听可见性变化；否则完全不受标签页切换影响
  if (pauseWhenHidden) doc?.addEventListener?.('visibilitychange', onVisibility);

  return {
    stop: () => {
      stopped = true;
      if (handle !== null) { clearTimer(handle); handle = null; }
      if (pauseWhenHidden) doc?.removeEventListener?.('visibilitychange', onVisibility);
    },
    trigger: () => run(),
    isRunning: () => !stopped,
    ticks: () => tickCount,
  };
}
