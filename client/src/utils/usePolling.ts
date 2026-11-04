/**
 * client/src/utils/usePolling.ts —— createPoller 的 React 封装
 *
 * 用法（替换原来的 useEffect+setInterval）：
 *   usePolling(fetchStats, 5000, [selectedDevice.id, isRemote]);
 * 行为：页面可见时按间隔跑，隐藏时暂停，切回来立刻补一次。
 */
import { useEffect, useRef } from 'react';
import { createPoller } from './polling';

export function usePolling(
  callback: () => void | Promise<void>,
  intervalMs: number,
  deps: unknown[] = [],
  opts: { immediate?: boolean; pauseWhenHidden?: boolean } = {},
): void {
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(() => {
    const poller = createPoller(() => cbRef.current(), intervalMs, opts);
    return () => poller.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, ...deps]);
}
